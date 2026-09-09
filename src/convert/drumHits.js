/*
 * ドラム打点の共通コア — MML.Convert.DrumHits (2026-09-03)
 *
 * 「打楽器として鳴った1回」を形式非依存の打点(hit)として受け取り、
 *   ・DrumMap 用の観測列(どの太鼓が・いつ)
 *   ・2A03ノイズ疑似音程の「ドラムパート」1本(単音、直近の打点が勝つ)
 *   ・実サンプルをそのまま DMC へ焼く @DPCM<n>(同時発音はその瞬間の音をミックスした1クリップ)
 * を作る。VGMのサンプルPCM専用だった src/vgm2mml/expansion/dpcmDrums.js の中身を、
 * HES(DDA)/SPC(BRR)/NSF(DMC)/合成音ch(分離レンダリング)でも使えるようにここへ移した。
 * 各形式は「打点リストを作る」ことだけを担当し、その先(ミックス・重複排除・レート選択・
 * .dmc命名・ROM量)はここ1箇所で共有する。
 *
 * 打点 hit の形:
 *   key        … パッド/ドラム区画のキー(MML.Convert.DrumMap.key と同じ粒度。'c140:294064' / 'dda:4241' / 'brr:12')
 *   sampleKey  … (省略可)クリップ同定に使う細かいキー。同じパッドでも切り出し範囲が違えば別の音
 *                (VGMの 'kind:start:end')。無ければ key
 *   hash       … サンプル内容のハッシュ(サンプル単位設定 src/convert/drumSamples.js のキー)。無ければ設定なし
 *   pcm        … Float32Array(-1..1) そのサンプルの原音
 *   rate       … pcm の再生レート(Hz)。この打点で実際に鳴った速さ
 *   vol        … 打点の音量(0..1、打点の頭で決めて打点中は変えない)
 *   startFrame / endFrame … 鳴り始め/鳴り止み(次の打点・チャンネル停止)のフレーム
 *   name       … (省略可)表示名。無ければ DrumSamples の名前 → ROMアドレスの16進
 *
 * 設計上の要点は dpcmDrums.js 冒頭(2026-08-29)から引き継ぐ:
 *   ・DPCMチャンネルは1本しか無いので、打点の頭で区間を切り「その区間で鳴っている全打点を
 *     位相と音量つきで足した波形」を1クリップにする。区間の切れ目で必ず打ち直す
 *   ・定義爆発への備え: クリップの同一性キーは「(サンプル, 量子化した位相, 量子化した音量,
 *     再生レート)の集合 + 量子化した長さ」。繰り返しの多いドラムパターンが同じ定義に畳まれる
 *   ・打点1つの中では音量を変えない(サンプル自身の減衰を拾うと192分音符だらけになる)
 *   ・DMCレートはサンプル単位設定(パッド)が優先、「自動」なら DMC_RATE(ドラム(DPCM)パネル
 *     最下段、src/convert/options.js)。ミックス区間で複数の指定が衝突したら
 *     RATE_MIX('quality'=高い方 / 'size'=低い方)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  // 1クリップの上限(秒)。以前は VGM 向けに 1.5 秒で黙って切っていたが、DMC 1本の上限(4080バイト、
  // 33.1kHz で 0.98 秒)を超えるクリップは下の dpcm() が区間に分割して連続再生するようになった
  // (2026-09-09)ので、ここは「ストリーム再生としてどこまで載せるか」の歯止め。ROM量はパネルの
  // 合計表示(16KB=DMC領域)で見せる
  const MAX_CLIP_SEC = 10;
  const PHASE_QUANT_SEC = 1 / 480; // 位相の量子化(重複排除用。1/8フレーム)
  const VOL_QUANT = 16;            // 音量の量子化段数(重複排除用)
  const LEN_QUANT_SEC = 1 / 480;   // 長さの量子化(重複排除用)

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

  /** 打点がフレームfの時点で鳴っているか(サンプルの実長も考慮) */
  function soundingAt(hit, f, frameRate) {
    if (f < hit.startFrame || f >= hit.endFrame) return false;
    // exactEnd: endFrame が「実際に鳴り止んだフレーム」そのもの(HESのDDA=CPUの書込み範囲)。
    // サンプル長÷推定レートで切ると推定誤差ぶん1〜2フレームずれるので、範囲だけで判定する
    if (hit.exactEnd) return true;
    const elapsed = (f - hit.startFrame) / frameRate;
    return elapsed * hit.rate < hit.pcm.length;
  }

  /** 'c140:294064' / 'rom:294064:294500' → '47CF0'(パッドの既定ラベルと同じ、開始位置の16進) */
  function addrLabel(key) {
    const a = String(key || '').split(':')[1];
    const n = parseInt(a, 10);
    return Number.isFinite(n) ? n.toString(16).toUpperCase() : '';
  }

  /**
   * クリップの .dmc ファイル名。パッドで付けた表示名(drumSamples.js の name)をそのまま使う。
   * ミックスされた区間は鳴っている音を '+' で連ねる。
   * ★MMLの @DPCM 定義に文字列として入るので DrumSamples.sanitizeName を必ず通す。
   */
  function clipFileName(live, index, used, prefix) {
    const DS = MML.Convert.DrumSamples || null;
    const san = DS ? DS.sanitizeName : ((x) => String(x || '').replace(/[^0-9A-Za-z_.-]+/g, '_'));
    const parts = [];
    for (const h of live) {
      // 名前が無い/日本語などで sanitize すると空になる場合は、打点が持つ既定ラベル(label)、
      // それも無ければ開始位置の16進で埋める
      const n = (h.name ? san(h.name) : '') || (h.label ? san(h.label) : '') || addrLabel(h.key);
      if (n && parts.indexOf(n) < 0) parts.push(n);
    }
    let base = parts.slice(0, 3).join('+');
    if (parts.length > 3) base += '+etc';
    if (!base) base = `${prefix || 'drum'}_${index}`;
    let name = base + '.dmc';
    for (let i = 2; used.has(name); i++) name = base + '_' + i + '.dmc';
    used.add(name);
    return name;
  }

  /**
   * サンプル単位の設定(パッド)を打点へ反映した実効値を返す。
   * 「変換しない」なら null(打点そのものを落とす=その分は休符)。
   * hash が無い打点は設定なし(そのまま)。
   */
  function resolveHit(h) {
    const DS = MML.Convert.DrumSamples || null;
    if (!DS || !h.hash) return h;
    // ★同じサンプルでも打点ごとに rate が違う(SPCの音階演奏ドラム等)ので、resolve はキャッシュしない
    const st = DS.resolve(h.hash, h.pcm, h.rate);
    if (!st.enabled) return null;
    // 差し替え(インクルード)があれば pcm/レートごと入れ替わる。無ければ渡したものがそのまま返る
    // (dpcmDrums.js 時代と同じ意味論)
    const pcm = st.pcm, rate = st.srcRate;
    if (!pcm || !pcm.length || !(rate > 0)) return null;
    const ri = (st.rate !== 'auto' && st.rate !== null && st.rate !== undefined) ? (parseInt(st.rate, 10) | 0) : null;
    return Object.assign({}, h, {
      pcm, rate,
      vol: (h.vol || 0) * (st.gain != null ? st.gain : 1),
      name: h.name || st.name || null,
      rateIndex: h.rateIndex != null ? h.rateIndex : ri,
      // 手動の分割(パネル下段の分割ビュー、src/ui/dpcmSplitView.js)。単独で鳴っている区間にだけ効く(下 dpcm())
      split: st.split || null,
    });
  }

  /**
   * 打点リスト → @DPCM 定義/ファイル/イベント
   * @param {Array} hits  上記の打点
   * @param {number} frameRate
   * @param {object} opt { totalFrames, dmcRate(「自動」のサンプルに使うDMCレートindex、既定15),
   *                       rateMix, poly, rateIndex(強制), prefix(既定ファイル名の頭) }
   */
  function dpcm(hits, frameRate, opt) {
    opt = opt || {};
    const totalFrames = opt.totalFrames || 0;
    const table = MML.Dpcm.DMC_RATE_TABLE_NTSC;
    // パッドで「自動」のままのサンプルに使うレート(cmd.DMC_RATE)。範囲外・未指定は最高レート
    const autoRate = (opt.dmcRate >= 0 && opt.dmcRate < table.length) ? (opt.dmcRate | 0) : table.length - 1;
    const maxClipSec = opt.maxClipSec > 0 ? opt.maxClipSec : MAX_CLIP_SEC;
    // 重複排除キーの音量量子化。HESのDDAは$0804の音量が打点ごとに27〜31/31程度で揺れる
    // (1dB未満)ので、細かく刻むと同じ太鼓が定義を増やす。形式側が段数を指定できる
    const volQuant = opt.volQuant > 0 ? opt.volQuant : VOL_QUANT;
    const empty = { defs: [], files: [], events: [], stats: { clips: 0, bytes: 0, segments: 0, dropped: 0 } };
    if (!hits || !hits.length || !totalFrames || !frameRate) return empty;

    const live0 = [];
    for (const h of hits) {
      if (!h || !h.pcm || !h.pcm.length || !(h.rate > 0)) continue;
      const r = resolveHit(h);
      if (r) live0.push(r);
    }
    if (!live0.length) return empty;
    live0.sort((a, b) => a.startFrame - b.startFrame);

    // ── 曲全体の音量正規化(2026-09-09) ────────────────────────────────────
    // DMC(DPCM)チャンネルには音量指定が無く、焼いた波形の振幅がそのまま再生音量になる。
    // 素材の振幅は形式によって桁が違う: HESのDDAは5bit値を[-1,1]へ写すので常にほぼ全振幅、
    // SPCのBRRは実測でピーク中央値0.43、しかも vol はVOLレジスタ/127(中央値0.29)なので
    // 積は0.13程度にしかならず、DPCMのドラムだけ約18dB小さく聞こえていた(ユーザー報告)。
    // 曲内で最も大きい打点が全振幅に届くよう、曲全体へ同じゲインを掛ける(打点ごとの
    // 強弱の比は保つ)。既に全振幅の形式はゲイン1のまま=出力不変。持ち上げのみ(1未満に
    // しない。過剰な持ち上げで無音付近のノイズを増幅しないよう上限あり)
    const peakOf = new Map(); // 同じサンプルを何十回も叩く曲があるので pcm 配列ごとに1回だけ走査
    let maxHitPeak = 0;
    for (const h of live0) {
      let p = peakOf.get(h.pcm);
      if (p === undefined) {
        p = 0;
        for (let i = 0; i < h.pcm.length; i++) { const a = Math.abs(h.pcm[i]); if (a > p) p = a; }
        peakOf.set(h.pcm, p);
      }
      const v = p * (h.vol || 0);
      if (v > maxHitPeak) maxHitPeak = v;
    }
    // 正規化の方針(上限・不感帯)は焼き込み経路で共有する(src/dpcm/dpcmConverter.js)。
    // SPCの音階付きDPCM(spc2mml の brrToDpcm)も同じ関数を使う
    const normGain = MML.Dpcm.normGain(maxHitPeak);

    // 区間の切れ目 = 打点の頭
    const onsets = Array.from(new Set(live0.map(h => h.startFrame))).sort((a, b) => a - b);
    const defs = [], files = [], events = [];
    const clipIndexByKey = new Map(); // clipKey → 定義番号 | 分割クリップの台帳(下 splitClip)
    const usedNames = new Set();
    let dropped = 0, splitClips = 0, pieceDefs = 0;
    const MAX_BYTES = MML.Dpcm.MAX_ENCODED_BYTES || 4080;
    const MAX_SAMPLES = MML.Dpcm.MAX_ENCODED_SAMPLES || (MAX_BYTES * 8);
    const bytesForSamples = (s) => Math.ceil(s / 8 / 16) * 16 || 16;

    // ── DMC 1本の上限を超えるクリップ(ストリーム再生)の分割(2026-09-09) ──────────
    // 4080バイト(33.1kHzで0.98秒)を超える音は、実機でも1本のサンプルでは鳴らせない
    // (以前はコンパイル側が $4013=255 で頭打ちにして途中から無音になっていた)。
    // フレーム整数の区間へ分割し、区間ごとに @DPCM 定義と打点を作る。E チャンネルの
    // MML は `@5 c(59f) @6 c(59f) …` と並び、実機DMCは次のトリガーが来るまで鳴り続けるので
    // それだけで連続再生になる。
    //   ・区間長をフレームの整数倍にする: 次のトリガー(=次の音符の頭)が区間の終端に正確に
    //     重なる(半端だと最大0.5フレーム=8msの空白か食い込みが出る)
    //   ・区間の $4011 初期値(dac)は直前の区間を焼き終えたDACカウンタ(MML.Dpcm.endCounter):
    //     継ぎ目でDACが飛ばないのでプチ音が出ない
    //   ・ピーク正規化はクリップ全体で1回(区間ごとに掛けると継ぎ目でゲインが段になる)
    //   ・区間の打点イベントには exact:true を付け、出力側(mmlEmit.js)が音長の丸め(LEN_SNAP/LEN_DP)
    //     から外す(変換設定 DPCM_EXACT、既定ON)。丸めると継ぎ目に空白/食い込みが出る
    //   ・定義は必要になった区間まで(打点が次のオンセットで切られる場合、その先の区間は作らない)。
    //     区間 k を焼くには k-1 の終端DACが要るので順に焼く(台帳 cache.pieces に控える)
    //   ・手動の分割(manual、パネル下段の分割ビュー src/ui/dpcmSplitView.js で決めた
    //     {end, rate, used} の列)があればそれを区間にする。区間ごとにレートが違ってよく、未使用の区間は
    //     定義も打点も作らない(その間は休符=DMCは直前の区間の末尾で止まる)。手動で切った区間が
    //     それでも上限を超えていたら、その区間だけ均等に切り足す(<名前>_<k>_<j>.dmc)
    //   区間の並び(cache.plan): [{ f0(t0からのフレーム), frames, rate, used, no(表示番号 "3" / "3_2") }]
    function planPieces(lenSec, rateIndex, manual) {
      const spfOf = (ri) => table[ri] / frameRate;
      // 全長のフレーム数はサンプル数から(ceil(n/spf)、段階1と同じ式)。lenSec*frameRate を直接丸めると
      // 1フレーム違うことがあり、均等割りの配分が変わって出力(区間サイズ/DAC初期値)が揺れる
      const totalF = Math.max(1, Math.ceil(Math.max(1, Math.round(lenSec * table[rateIndex])) / spfOf(rateIndex)));
      const maxFramesOf = (ri) => Math.max(1, Math.floor(MAX_SAMPLES / spfOf(ri)));
      // [f0, f1) をそのレートの上限に収まる本数へ均等割り
      const evenly = (f0, f1, ri, used, no) => {
        const F = f1 - f0;
        const K = Math.max(1, Math.ceil(F / maxFramesOf(ri)));
        const base = Math.floor(F / K), extra = F - base * K;
        const out = [];
        let f = f0;
        for (let k = 0; k < K; k++) {
          const fk = base + (k < extra ? 1 : 0);
          if (fk > 0) out.push({ f0: f, frames: fk, rate: ri, used, no: K > 1 ? `${no}_${k + 1}` : String(no) });
          f += fk;
        }
        return out;
      };
      if (!manual) return evenly(0, totalF, rateIndex, true, '').map((p, k) => Object.assign(p, { no: String(k + 1) }));
      const plan = [];
      let prev = 0;
      manual.segs.forEach((s, k) => {
        // 境目は秒→フレーム整数へ(次のトリガーが区間終端に乗るように)。末尾の1フレーム以内なら末尾へ
        // 吸着。決めたときよりクリップが長ければ最後の境目から先は捨てる(未使用)、短ければ収まる区間まで
        let f1 = Math.round(Math.max(0, Number(s.end)) * frameRate);
        if (f1 >= totalF - 1) f1 = totalF;
        if (f1 <= prev) return;
        const ri = (s.rate == null || s.rate === 'auto') ? rateIndex : Math.max(0, Math.min(table.length - 1, s.rate | 0));
        plan.push(...evenly(prev, f1, ri, s.used !== false, k + 1));
        prev = f1;
      });
      return plan;
    }
    function splitClip(live, t0, lenSec, rateIndex, name0, manual) {
      const cache = { plan: planPieces(lenSec, rateIndex, manual), mixes: [], pieces: [], endDac: [], peakGain: 1,
                      stem: name0.replace(/\.dmc$/i, ''), live };
      let peak = 0;
      for (const p of cache.plan) {
        const dstRate = table[p.rate], spf = dstRate / frameRate;
        // 区間のサンプル範囲はフレーム境界×spf を丸めて(段階1と同じ)。末尾はクリップのサンプル数で止める
        const a = Math.round(p.f0 * spf);
        const b = Math.min(Math.round(lenSec * dstRate), Math.round((p.f0 + p.frames) * spf));
        const nk = Math.max(1, b - a);
        const mix = new Float32Array(nk);
        if (p.used) {
          for (const h of live) {
            const phase = (t0 + p.f0 - h.startFrame) / frameRate;
            resampleInto(mix, 0, nk, h.pcm, h.rate, dstRate, phase, h.vol * normGain);
          }
          for (let i = 0; i < nk; i++) { const v = Math.abs(mix[i]); if (v > peak) peak = v; }
        }
        cache.mixes.push(mix);
      }
      if (peak > 1) cache.peakGain = 1 / peak;
      return cache;
    }
    // 区間 k までを焼いて定義を作る(k-1 までは焼けている前提。順に呼ぶ)。未使用の区間は null
    function ensurePiece(cache, k) {
      for (let i = cache.pieces.length; i <= k; i++) {
        const p = cache.plan[i];
        if (!p.used) { cache.pieces.push(null); cache.endDac.push(null); continue; }
        const mix = cache.mixes[i];
        if (cache.peakGain !== 1) for (let j = 0; j < mix.length; j++) mix[j] *= cache.peakGain;
        // DACの引き継ぎは直前の区間が使用中(=連続して鳴る)のときだけ。未使用を挟んだら頭の値から
        const dac = (i > 0 && cache.endDac[i - 1] != null)
          ? cache.endDac[i - 1]
          : Math.max(0, Math.min(127, Math.round((mix[0] + 1) / 2 * 127)));
        const encoded = MML.Dpcm.encode(mix, table[p.rate], p.rate, { startCounter: dac });
        if (!encoded || !encoded.bytes || !encoded.bytes.length) { cache.pieces.push(null); cache.endDac.push(null); continue; }
        cache.endDac.push(MML.Dpcm.endCounter(encoded.bytes, encoded.sampleCount, encoded.startCounter));
        let name = `${cache.stem}_${p.no}.dmc`;
        for (let d = 2; usedNames.has(name); d++) name = `${cache.stem}_${p.no}_${d}.dmc`;
        usedNames.add(name);
        const index = defs.length;
        files.push({ name, bytes: encoded.bytes });
        defs.push({ index, file: name, freq: p.rate, size: encoded.bytes.length,
                    sampleCount: encoded.sampleCount, dac: encoded.startCounter, mode: 0, piece: p.no, pieces: cache.plan.length });
        cache.pieces.push(index);
        pieceDefs++;
      }
      return cache.pieces[k];
    }

    for (let oi = 0; oi < onsets.length; oi++) {
      const t0 = onsets[oi];
      const nextOnset = oi + 1 < onsets.length ? onsets[oi + 1] : totalFrames;
      let live = live0.filter(h => soundingAt(h, t0, frameRate));
      if (!live.length) continue;
      // poly:'mono' = ミックスしない(直近に叩かれた打点だけを鳴らす。ノイズ疑似音程の
      // ドラムパートと同じ読み方)。定義がサンプル数までしか増えないので容量制御に使う
      // (実測: NCS91002 は2chのDDAが重なり、ミックスだと54定義36KB、単音なら7定義)
      if (opt.poly === 'mono') {
        let pick = live[0];
        for (const h of live) if (h.startFrame >= pick.startFrame) pick = h;
        live = [pick];
      }
      let t1 = nextOnset;
      for (let f = t0 + 1; f < nextOnset; f++) {
        if (!live.some(h => soundingAt(h, f, frameRate))) { t1 = f; break; }
      }
      // ★単独の打点(この区間で鳴っているのがその頭から始まる1つだけ)は、次のオンセットで
      //   切られていても定義はサンプル全長にする。実機DMCは次のトリガーが来るまで鳴り続け、
      //   次の @<n> がそれを止めるので、短く切られた打点ごとに「途中まで」の別定義を作る必要が
      //   無い(HESの ClipRegistry の前方一致共有と同じ意味論。定義数がぐっと減る)。
      //   ミックス区間はその瞬間の音を焼くので従来どおり区間長。
      const single = live.length === 1 && live[0].startFrame === t0;
      // 手動の分割(パネル)は「単独で鳴っている区間」だけに効かせる。ミックス区間は自動。
      // 手動はパネルでサンプル全長を見て決めているので、1打点の上限(maxClipSec)は掛けない
      const manual = (single && live[0].split && live[0].split.segs && live[0].split.segs.length) ? live[0].split : null;
      let lenSec = single ? live[0].pcm.length / live[0].rate : (t1 - t0) / frameRate;
      if (!manual) lenSec = Math.min(lenSec, maxClipSec);
      if (!(lenSec > 0)) continue;

      // レートの優先順位: 形式側の強制 > パッドのサンプル単位指定(複数あれば RATE_MIX で高低を選ぶ)
      //                  > 「自動」のサンプル向け既定(DMC_RATE)
      const preferHigh = opt.rateMix !== 'size';
      let chanRate = null;
      for (const h of live) {
        if (h.rateIndex == null) continue;
        if (chanRate === null) chanRate = h.rateIndex;
        else chanRate = preferHigh ? Math.max(chanRate, h.rateIndex) : Math.min(chanRate, h.rateIndex);
      }
      const rateIndex = (opt.rateIndex != null && opt.rateIndex >= 0 && opt.rateIndex < table.length)
        ? opt.rateIndex
        : (chanRate !== null ? chanRate : autoRate);
      const dstRate = table[rateIndex];

      const parts = live.map(h => {
        const phase = (t0 - h.startFrame) / frameRate;
        return (h.sampleKey || h.key) + '@' + Math.round(phase / PHASE_QUANT_SEC) + 'v' + Math.round(h.vol * volQuant)
             + 'r' + Math.round(h.rate);
      }).sort();
      const clipKey = rateIndex + '|' + Math.round(lenSec / LEN_QUANT_SEC) + '|' + parts.join('+');

      const manualKey = manual ? '|m' + manual.segs.map(s => `${Math.round(s.end * 4096)}:${s.rate == null ? 'a' : s.rate}:${s.used !== false ? 1 : 0}`).join(',') : '';
      let index = clipIndexByKey.get(clipKey + manualKey);
      // ── 上限超え(ストリーム)か手動の分割: 区間に分割して区間ごとに打点を立てる(上 splitClip 参照) ──
      if (manual || bytesForSamples(Math.max(1, Math.round(lenSec * dstRate))) > MAX_BYTES) {
        let cache = index;
        if (cache === undefined) {
          cache = splitClip(live, t0, lenSec, rateIndex, clipFileName(live, defs.length, usedNames, opt.prefix), manual);
          clipIndexByKey.set(clipKey + manualKey, cache);
          if (cache.plan.length > 1) splitClips++;
        }
        const endF = Math.max(t0 + 1, t1); // 音が止まる/次のオンセットまで。その先の区間は作らない
        for (let k = 0; k < cache.plan.length; k++) {
          const p = cache.plan[k];
          const f = t0 + p.f0;
          if (f >= endF) break;
          const idx = ensurePiece(cache, k);
          if (idx == null) { if (p.used) dropped++; continue; } // 未使用の区間は休符(定義も打点も無し)
          // 手動分割で1区間だけ(=上限内)なら普通の打点と同じ扱い(exact にしない)
          events.push({ start: f, end: Math.min(f + p.frames, endF), note: 48, instrument: idx, exact: cache.plan.length > 1 });
        }
        continue;
      }
      if (index === undefined) {
        const n = Math.max(1, Math.round(lenSec * dstRate));
        const mix = new Float32Array(n);
        for (const h of live) {
          const phase = (t0 - h.startFrame) / frameRate;
          resampleInto(mix, 0, n, h.pcm, h.rate, dstRate, phase, h.vol * normGain);
        }
        let peak = 0;
        for (let i = 0; i < n; i++) { const a = Math.abs(mix[i]); if (a > peak) peak = a; }
        if (peak > 1) for (let i = 0; i < n; i++) mix[i] /= peak;
        const dac = Math.max(0, Math.min(127, Math.round((mix[0] + 1) / 2 * 127)));
        const encoded = MML.Dpcm.encode(mix, dstRate, rateIndex, { startCounter: dac });
        if (!encoded || !encoded.bytes || !encoded.bytes.length) { dropped++; continue; }
        index = defs.length;
        const name = clipFileName(live, index, usedNames, opt.prefix);
        files.push({ name, bytes: encoded.bytes });
        defs.push({ index, file: name, freq: rateIndex, size: encoded.bytes.length,
                    sampleCount: encoded.sampleCount, dac, mode: 0 });
        clipIndexByKey.set(clipKey, index);
      }
      events.push({ start: t0, end: Math.max(t0 + 1, t1), note: 48, instrument: index });
    }
    const bytes = files.reduce((a, f) => a + f.bytes.length, 0);
    return { defs, files, events, stats: { clips: defs.length, bytes, segments: events.length, dropped, normGain, splitClips, pieceDefs } };
  }

  /** 打点リスト → DrumMap.build 用の観測列 */
  function obs(hits, frameDur, out) {
    const res = out || [];
    for (const h of hits || []) if (h && h.key) res.push({ key: h.key, sec: h.startFrame * frameDur });
    return res;
  }

  /**
   * 打点リスト → 2A03ノイズ疑似音程の「ドラムパート」1本(共通イベント形式)。
   * 単音なので同時に鳴っている打点は「直近に叩かれた方」を採る(vgm2mml/expansion/opn.js
   * drumChannelOf と同じ読み方)。打点の音量は hit.vol 固定(打点の途中で変えない)。
   */
  function channel(hits, drumMap, totalFrames) {
    const DrumMap = MML.Convert.DrumMap;
    if (!drumMap || !DrumMap || !hits || !hits.length) return { events: [], hasVolume: true };
    const sorted = hits.filter(h => h && h.key).slice().sort((a, b) => a.startFrame - b.startFrame);
    const vrc7Vol = (att) => Math.max(0, Math.min(15, Math.round(att / 3)));
    const events = [];
    let cur = null, pos = 0;
    const active = [];
    for (let f = 0; f < totalFrames; f++) {
      while (pos < sorted.length && sorted[pos].startFrame <= f) active.push(sorted[pos++]);
      let pick = null;
      for (let i = active.length - 1; i >= 0; i--) {
        const h = active[i];
        if (f >= h.endFrame) { active.splice(i, 1); continue; }
        if (!pick || h.startFrame >= pick.startFrame) pick = h;
      }
      let st = null;
      if (pick) {
        const lane = drumMap.laneOf.has(pick.key) ? drumMap.laneOf.get(pick.key) : drumMap.otherLane;
        const note = DrumMap.noteOf(lane);
        if (note !== null) {
          const attDb = pick.vol > 0 ? Math.min(96, -20 * Math.log10(pick.vol)) : 96;
          st = { note, attDb, key: 'drum' + lane, hit: pick };
        }
      }
      const retrigger = !!(st && (!cur || cur.hit !== st.hit));
      const same = cur && st && !retrigger && st.note === cur.note && st.attDb === cur.attDb;
      if (same) continue;
      if (cur) { cur.end = f; if (cur.end > cur.start) events.push(cur); cur = null; }
      if (st) cur = { start: f, end: f, note: st.note, attDb: st.attDb, retrigger, key: st.key, hit: st.hit };
    }
    if (cur) { cur.end = totalFrames; if (cur.end > cur.start) events.push(cur); }
    return {
      events: events.map(ev => ({ start: ev.start, end: ev.end, note: ev.note, volume: vrc7Vol(ev.attDb),
                                  attDb: ev.attDb, retrigger: ev.retrigger })),
      hasVolume: true,
    };
  }

  MML.Convert.DrumHits = { dpcm, obs, channel, MAX_CLIP_SEC };
})(window);
