/*
 * VGMのサンプルPCM(打楽器) → @DPCM<n> 抽出
 *   MML.Vgm2MmlExpansion.dpcmDrums(sources, frameRate, opt) → { defs, files, events, stats }
 *
 * 考え方(2026-08-29):
 *   ドラムを2A03ノイズchの疑似音程で出すのではなく、実サンプルをDMC(DPCM)へ変換して
 *   本物の音で鳴らす。DPCHチャンネルは実機どおり1本しか無い(compiler.js
 *   CHIP_CHANNEL_COUNTS.dpcm=1)ので、
 *
 *     「複数のPCMチャンネルが同時に鳴っている区間は、その瞬間に鳴っている音を
 *       ミックスした1つの新しいサンプルとして焼き込む」
 *
 *   という方針で単音制約を回避する(ユーザー案)。具体的には打点の頭(オンセット)で
 *   タイムラインを区切り、各区間を「そのとき鳴っている全サンプルを、それぞれの再生位置
 *   (位相)と音量で足し合わせた波形」として1クリップにする。区間の切れ目で必ず打ち直す
 *   ので、DPCMの単音制約と矛盾しない。
 *
 * 入力 sources: [{ chip, snapshots, chans:[ch番号...], shape:'pcm'|'adpcmA', samples:{key→Float32Array} }]
 *   snapshots/samples は captureVgmSongAsync の戻り(src/emulator/vgmPlayer.js collectUsedSamples)。
 *   chans は「DPCMへ載せるチャンネル」= ユーザーが割当UIで選んだもの。
 *
 * 出力は HES の @DPCM 抽出(src/hes2mml/expansion/dpcm.js)と同じ {defs, files, events} 形。
 *   events: { start, end, note:48, instrument: clipIndex }
 *   ★実機DMCと同じくノート音高はレートに影響しない。常に基準ノート o4c(=48)で @<n> だけを
 *     選ぶ(nsf2mml buildDpcmEvents / hes2mml dpcm と同じ設計)。
 *
 * ★定義爆発への備え: HESで「実音10種以下なのに@DPCM定義が数百件」を踏んでいる
 *   ([[hes-dda-clip-boundary-frame-mixing]])。ミックスは組合せなので放置すると必ず再発する。
 *   ここではクリップの同一性キーを「(サンプル, 量子化した位相, 量子化した音量)の集合 +
 *   量子化した長さ」にして、繰り返しの多いドラムパターンが同じ定義に畳まれるようにする。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Vgm2MmlExpansion = MML.Vgm2MmlExpansion || {};

  const ADPCM_PITCH_CONF = 0.5;   // keyboard.js / opn.js と同じしきい値

  const MAX_CLIP_SEC = 1.5;       // 1クリップの上限(ROM容量の歯止め)
  const PHASE_QUANT_SEC = 1 / 480; // 位相の量子化(重複排除用。1/8フレーム)
  const VOL_QUANT = 16;           // 音量の量子化段数(重複排除用)
  const LEN_QUANT_SEC = 1 / 480;  // 長さの量子化(重複排除用)

  /** サンプル列を srcRate から dstRate へ線形補間でリサンプル(区間 [from, from+len) 秒ぶん) */
  function resampleInto(out, outOff, outLen, pcm, srcRate, dstRate, fromSec, gain) {
    const step = srcRate / dstRate;
    let pos = fromSec * srcRate;
    for (let i = 0; i < outLen; i++) {
      const idx = pos | 0;
      if (idx + 1 >= pcm.length) break;
      const frac = pos - idx;
      out[outOff + i] += (pcm[idx] * (1 - frac) + pcm[idx + 1] * frac) * gain;
      pos += step;
    }
  }

  /**
   * 選ばれたチャンネルの「打点」を集める。
   * 1打点 = キーオン(seq変化)から、そのチャンネルが鳴り止む/次のキーオンが来るまで。
   * 音量は打点の頭の値で固定する(打点の途中の減衰はサンプル自身が持っているため。
   * opn.js drumChannelOf と同じ理由)。
   */
  function collectHits(sources, totalFrames) {
    const DS = (MML.Convert && MML.Convert.DrumSamples) || null;
    const hits = [];
    for (const src of sources) {
      const getCh = (f, ch) => {
        const s = src.snapshots[f];
        if (!s) return null;
        return src.shape === 'adpcmA' ? (s.adpcmA && s.adpcmA[ch]) : s[ch];
      };
      for (const ch of src.chans) {
        let prevSeq = null, cur = null;
        for (let f = 0; f < totalFrames; f++) {
          const c = getCh(f, ch);
          const isKeyOn = c && c.seq !== prevSeq && c.seq > 0;
          if (c) prevSeq = c.seq;
          const sounding = !!(c && c.active && c.sample);
          // ★このチャンネルはユーザーが明示的にDPCMへ載せた先なので、音程が取れたサンプルも
          //   変換対象にする(DPCMで音律を奏でることもある。ユーザー指示)。
          //   以前は音程が取れると除外していたため、旋律を鳴らすPCM chをDPCMへ割り当てても
          //   何も出なかった。
          if (cur && (isKeyOn || !sounding)) { cur.endFrame = f; cur = null; }
          if (isKeyOn && sounding) {
            const key = c.sample.kind + ':' + c.sample.start + ':' + c.sample.end;
            if (src.samples[key]) {
              // ★設定はチャンネル単位ではなくサンプル単位(ドラム区画のパッド1枚)。
              //   src/convert/drumSamples.js。@DPCM<n>定義は元々サンプルごとにfreqを持てるうえ、
              //   プール式チップは同じ太鼓が毎回別スロットへ移るのでch単位だと指定が飛ぶ。
              const st = DS ? DS.resolve(c.sampleHash, src.samples[key], c.rate || 0)
                            : { enabled: true, rate: 'auto', gain: 1, name: null,
                                pcm: src.samples[key], srcRate: c.rate || 0 };
              // 「変換しない」サンプルは打点自体を作らない(MMLもその分が休符になる)
              if (st.enabled && st.pcm && st.pcm.length && st.srcRate > 0) {
                const ri = (st.rate !== 'auto' && st.rate !== null && st.rate !== undefined)
                  ? (parseInt(st.rate, 10) | 0) : null;
                // ★変換ボリューム(パッド設定)はチャンネル音量へ畳んで持つ。DPCMは実機で
                //   @vが効かないので、波形を小さくするのがそのまま音量調整になる
                const gain = st.gain != null ? st.gain : 1;
                cur = { key, hash: c.sampleHash || null, pcm: st.pcm, rate: st.srcRate,
                        vol: (c.vol || 0) * gain, name: st.name || null,
                        rateIndex: ri, startFrame: f, endFrame: totalFrames };
                hits.push(cur);
              }
            }
          }
        }
      }
    }
    hits.sort((a, b) => a.startFrame - b.startFrame);
    return hits;
  }

  /** 打点がフレームfの時点で鳴っているか(サンプルの実長も考慮) */
  function soundingAt(hit, f, frameRate) {
    if (f < hit.startFrame || f >= hit.endFrame) return false;
    const elapsed = (f - hit.startFrame) / frameRate;
    return elapsed * hit.rate < hit.pcm.length;
  }

  /**
   * @param {Array} sources 上記の形
   * @param {number} frameRate
   * @param {object} opt { totalFrames, pcmRate }
   */
  MML.Vgm2MmlExpansion.dpcmDrums = function (sources, frameRate, opt) {
    opt = opt || {};
    const totalFrames = opt.totalFrames || 0;
    const pcmRate = opt.pcmRate != null ? opt.pcmRate : 'max';
    const table = MML.Dpcm.DMC_RATE_TABLE_NTSC;
    const empty = { defs: [], files: [], events: [], stats: { clips: 0, bytes: 0, segments: 0, dropped: 0 } };
    if (!sources || !sources.length || !totalFrames) return empty;

    const hits = collectHits(sources, totalFrames);
    if (!hits.length) return empty;

    // ── 区間の切れ目 = 打点の頭 ──
    const onsets = Array.from(new Set(hits.map(h => h.startFrame))).sort((a, b) => a - b);

    const defs = [], files = [], events = [];
    const clipIndexByKey = new Map();
    const usedNames = new Set();
    let dropped = 0;

    for (let oi = 0; oi < onsets.length; oi++) {
      const t0 = onsets[oi];
      const nextOnset = oi + 1 < onsets.length ? onsets[oi + 1] : totalFrames;
      // この区間で鳴っている打点
      const live = hits.filter(h => soundingAt(h, t0, frameRate));
      if (!live.length) continue;
      // 区間の終わり: 次の打点の頭か、全部鳴り止むところの早い方
      let t1 = nextOnset;
      for (let f = t0 + 1; f < nextOnset; f++) {
        if (!live.some(h => soundingAt(h, f, frameRate))) { t1 = f; break; }
      }
      let lenSec = Math.min((t1 - t0) / frameRate, MAX_CLIP_SEC);
      if (!(lenSec > 0)) continue;

      // 出力レート: この区間で一番速いサンプルに合わせる(遅い方は補間で伸ばす)
      // opt.rateIndex(0-15)を明示指定できる。★PCM_RATEの「ソースレートのn倍」方式は、
      // サンプルPCMチップの再生レートがDMC最高レート(33.1kHz)以上のことが多く、ほぼ常に
      // 最高レートに張り付いて効かない(実測: C140/QSoundは max〜2 で同じ結果)。
      // 音質とROM容量を実際に取引できるよう、UIからはDMCレートを直接選べるようにする。
      const srcRateMax = Math.max(...live.map(h => h.rate));
      // ミックスは1つのサンプルに焼くのでレートは1つしか選べない。どちらを採るかは
      // 変換設定の RATE_MIX で選ぶ('quality'=最高音質を採る(既定) / 'size'=最低に合わせて容量優先)
      const preferHigh = opt.rateMix !== 'size';
      let chanRate = null;
      for (const h of live) {
        if (h.rateIndex == null) continue;
        if (chanRate === null) chanRate = h.rateIndex;
        else chanRate = preferHigh ? Math.max(chanRate, h.rateIndex) : Math.min(chanRate, h.rateIndex);
      }
      const rateIndex = (opt.rateIndex != null && opt.rateIndex >= 0 && opt.rateIndex < table.length)
        ? opt.rateIndex
        : (chanRate !== null ? chanRate : dmcRateIndexFor(srcRateMax, pcmRate, table));
      const dstRate = table[rateIndex];

      // ── 同一性キー(重複排除)。位相・音量・長さを量子化して、繰り返しパターンを畳む ──
      // ★再生レートもキーに含める。同じサンプルでもレートが違えば別の音(音階演奏)なので、
      //   含めないと違う音程のクリップが同じ定義に畳まれてしまう
      const parts = live.map(h => {
        const phase = (t0 - h.startFrame) / frameRate;
        return h.key + '@' + Math.round(phase / PHASE_QUANT_SEC) + 'v' + Math.round(h.vol * VOL_QUANT)
             + 'r' + Math.round(h.rate);
      }).sort();
      const clipKey = rateIndex + '|' + Math.round(lenSec / LEN_QUANT_SEC) + '|' + parts.join('+');

      let index = clipIndexByKey.get(clipKey);
      if (index === undefined) {
        const n = Math.max(1, Math.round(lenSec * dstRate));
        const mix = new Float32Array(n);
        for (const h of live) {
          const phase = (t0 - h.startFrame) / frameRate;
          resampleInto(mix, 0, n, h.pcm, h.rate, dstRate, phase, h.vol);
        }
        // 同時発音でクリップしないよう、超えた分だけ全体を下げる(音量比は保つ)
        let peak = 0;
        for (let i = 0; i < n; i++) { const a = Math.abs(mix[i]); if (a > peak) peak = a; }
        if (peak > 1) for (let i = 0; i < n; i++) mix[i] /= peak;

        // 初期DAC: 先頭サンプルを7bit化してエンコーダのカウンタ開始値に合わせる
        // (hes2mml/expansion/dpcm.js と同じ。ズレると頭に追従ランプ=クリックが乗る)
        const dac = Math.max(0, Math.min(127, Math.round((mix[0] + 1) / 2 * 127)));
        const encoded = MML.Dpcm.encode(mix, dstRate, rateIndex, { startCounter: dac });
        if (!encoded || !encoded.bytes || !encoded.bytes.length) { dropped++; continue; }
        index = defs.length;
        const name = clipFileName(live, index, usedNames);
        files.push({ name, bytes: encoded.bytes });
        defs.push({ index, file: name, freq: rateIndex, size: encoded.bytes.length,
                    sampleCount: encoded.sampleCount, dac, mode: 0 });
        clipIndexByKey.set(clipKey, index);
      }
      events.push({ start: t0, end: Math.max(t0 + 1, t1), note: 48, instrument: index });
    }

    const bytes = files.reduce((a, f) => a + f.bytes.length, 0);
    return { defs, files, events, stats: { clips: defs.length, bytes, segments: events.length, dropped } };
  };

  /**
   * クリップの .dmc ファイル名。パッドで付けた表示名(src/convert/drumSamples.js の name)を
   * そのまま使う(ユーザー指示)。ミックスされた区間は鳴っている音を '+' で連ねる。
   * ★MMLの @DPCM 定義に文字列として入るので DrumSamples.sanitizeName を必ず通す。
   *   日本語名などで空になったら従来の連番名へ落とす。
   */
  /** 'rom:294064:294500' → '47CF0'(ドラム区画の既定ラベルと同じ、開始アドレスの16進) */
  function addrLabel(key) {
    const a = String(key || '').split(':')[1];
    const n = parseInt(a, 10);
    return Number.isFinite(n) ? n.toString(16).toUpperCase() : '';
  }

  function clipFileName(live, index, used) {
    const DS = (MML.Convert && MML.Convert.DrumSamples) || null;
    const san = DS ? DS.sanitizeName : ((x) => String(x || '').replace(/[^0-9A-Za-z_.-]+/g, '_'));
    const parts = [];
    for (const h of live) {
      // ★名前が無い/日本語などで sanitize すると空になる場合は、そのサンプルのROMアドレス
      //   (パッドの既定ラベルと同じ)で埋める。ここで黙って落とすと、ミックスされたクリップが
      //   単独クリップと同じ名前になって取り違える
      const n = (h.name ? san(h.name) : '') || addrLabel(h.key);
      if (n && parts.indexOf(n) < 0) parts.push(n);
    }
    let base = parts.slice(0, 3).join('+');
    if (parts.length > 3) base += '+etc';
    if (!base) base = `vgm_dpcm_${index}`;
    // 同名衝突(別クリップが同じ顔ぶれ=位相/長さ違い)は連番で分ける
    let name = base + '.dmc';
    for (let i = 2; used.has(name); i++) name = base + '_' + i + '.dmc';
    used.add(name);
    return name;
  }

  // HESと同じ選び方(src/convert/options.js PCM_RATE)。'max'=常に最高レート、
  // 数値=ソースレートのn倍以上の最小レート、1=最も近いレート(データ最小)
  function dmcRateIndexFor(rateHz, pcmRate, table) {
    if (pcmRate === 'max' || pcmRate == null) return table.length - 1;
    const mult = typeof pcmRate === 'number' ? pcmRate : parseInt(pcmRate, 10) || 4;
    if (mult <= 1) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < table.length; i++) {
        const d = Math.abs(table[i] - rateHz);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }
    for (let i = 0; i < table.length; i++) if (table[i] >= rateHz * mult) return i;
    return table.length - 1;
  }
})(window);
