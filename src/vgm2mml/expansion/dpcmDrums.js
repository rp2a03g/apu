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
          // 音程が取れたチャンネルは音階楽器なので打楽器として扱わない
          const pitched = !!(c && c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0);
          if (cur && (isKeyOn || !sounding || pitched)) { cur.endFrame = f; cur = null; }
          if (isKeyOn && sounding && !pitched) {
            const key = c.sample.kind + ':' + c.sample.start + ':' + c.sample.end;
            if (src.samples[key]) {
              // rateIndex: そのチャンネルに割当UIで指定されたDMCレート(未指定はnull=自動)。
              // ★レートはEパート全体で1つではなく打点(クリップ)ごとに決まる。
              //   @DPCM<n>定義がそれぞれ freq を持てるため。
              cur = { key, pcm: src.samples[key], rate: c.rate || 0, vol: c.vol || 0,
                      rateIndex: (src.rates && src.rates[ch] != null) ? src.rates[ch] : null,
                      startFrame: f, endFrame: totalFrames };
              if (cur.rate > 0) hits.push(cur); else cur = null;
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
      // このクリップに寄与している打点のうち、指定レートがあればその最大(=最高音質)を使う。
      // ミックスは1つのサンプルに焼くので1つのレートしか選べない。低い方に合わせると
      // 「33kHzを指定したchの音まで4kHzになる」ので、高い方を採る(ユーザー報告の件)。
      let chanRate = null;
      for (const h of live) if (h.rateIndex != null && (chanRate === null || h.rateIndex > chanRate)) chanRate = h.rateIndex;
      const rateIndex = (opt.rateIndex != null && opt.rateIndex >= 0 && opt.rateIndex < table.length)
        ? opt.rateIndex
        : (chanRate !== null ? chanRate : dmcRateIndexFor(srcRateMax, pcmRate, table));
      const dstRate = table[rateIndex];

      // ── 同一性キー(重複排除)。位相・音量・長さを量子化して、繰り返しパターンを畳む ──
      const parts = live.map(h => {
        const phase = (t0 - h.startFrame) / frameRate;
        return h.key + '@' + Math.round(phase / PHASE_QUANT_SEC) + 'v' + Math.round(h.vol * VOL_QUANT);
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
        const name = `vgm_dpcm_${index}.dmc`;
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
