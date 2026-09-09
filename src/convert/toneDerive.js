/*
 * 借用先の音色を「元の音の波形」から作る共通層 — MML.Convert.ToneDerive (2026-09-07)
 *
 * 借用先がN163/FDS(波形メモリ音源)やVRC7の自作音色(@0)のとき、元チャンネルの種類に依らず
 * 波形を引っ張ってきて音色にする:
 *   ・FM(OPN 4op / OPM / OPLL / OPL 2op) → N163/FDS : 音色パラメータから定常状態の1周期を合成
 *     (OPN系は ym2612Nuked.js の簡易合成=鍵盤表示と同じ、OPLL/OPL系は vrc7ToneSolver.js の
 *      厳密モデル=Nuked-OPLLの演算そのもの)して32点4bitへ
 *   ・矩形波(AY/SN/PSG)/波形(SCC/PCMの1周期)/N163波形 → VRC7 @0 : 出力波形からの逆算
 *     (src/ui/vrc7ToneSolver.js、音色エディタの「出力波形から逆算」と同じ探索を同期で回す)
 *
 * 以前は FM→N163 は常に矩形波、非FM→VRC7 @0 は「@0 自作音色(元の音から変換)」を選んでも
 * 内蔵音色@1に落ちていた(選択肢だけあって中身が無かった)。
 *
 * 使い方(vgm2mml/converter.js と convert/borrow.js の adaptEvents から):
 *   TD.n163WaveForEvent(ev, s, regs)  → 32点(0-15) | null   ※nullなら呼び出し側が矩形波にする
 *   TD.vrc7BytesForEvent(ev, s, regs) → 自作音色8バイト | null
 *   regs = { n163WaveReg, vrc7ToneReg }(イベントの instrument / vrc7Tone が指す実体の引き当てに使う)
 *
 * 逆算は1波形あたり約0.4秒(coarseTop 20)かかるので、波形ごとに結果を覚えておく(曲を跨いでも
 * 同じ波形なら同じ答え。AY/SNの矩形波は全曲で1回だけ)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};
  const TD = MML.Convert.ToneDerive = {};

  const N163_LEN = 32;
  const N = 128; // 1周期の合成点数(vrc7ToneSolver.js / ym2612Nuked.js synthWave と同じ)

  const solver = () => MML.UI && MML.UI.Vrc7ToneSolver;
  const opllNuked = () => MML.Emu && MML.Emu.OPLLNuked;
  const opnSynth = () => MML.Emu && MML.Emu.YM2612Nuked && MML.Emu.YM2612Nuked.synthWave;

  // 平坦(＝全サンプル同値)な1周期は直流なので音にならない。N163/FDSへ載せると
  // toN163 の round((a+1)/2*15) が全部8になり、音量をいくら上げても鳴らないchができる。
  // VRC7の逆算にかけても倍音が無く、意味のある音色は出てこない。呼び出し側の矩形波/
  // プリセットのフォールバックへ落とすため、こう判定されたものは null 扱いにする。
  // ±1正規化の合成波形にも0-15の波形メモリにも同じ関数を使う(どちらも「差が無い＝平坦」)。
  function isFlatWave(w) {
    if (!w || !w.length) return true;
    let mn = Infinity, mx = -Infinity;
    for (const v of w) { if (v < mn) mn = v; if (v > mx) mx = v; }
    return (mx - mn) < 1e-3;
  }

  // ── 1周期波形の合成 ──────────────────────────────────────────────
  // OPN系4op音色(vgm2mml/expansion/opn.js の opnPatch: {AL, FB, ops[4]{TL, ML, SL, SR, …}})
  // → ±1 正規化128点。定常状態のオペレータレベルは TL + SL(持続レベル)。SR>0(減衰し続ける
  // 音)には定常状態が無いので同じ値を「減衰途中の代表」として使う。DTは無視(比だけ効く)。
  function opnSteadyWave(p) {
    const fn = opnSynth();
    if (!fn || !p || !p.ops || p.ops.length !== 4) return null;
    const pgInc = p.ops.map((o) => (o.ML & 15) === 0 ? 1 : (o.ML & 15) * 2);
    // SL(D1L)=15 は実機では「減衰しきる」(-93dB)指定なので、定常状態をそのまま採ると無音になる。
    // 撥弦系/リード系のFM音色ではごく普通の設定で、egOutが0x3FF(完全減衰)へ飽和した結果
    // 合成波形が全サンプル0 → 平坦な@N波形 → そのchだけ鳴らない、という事故になっていた
    // (Metal Slug 2 "Judgment" のYM2610 FM1が全編このパターンだった)。定常状態が無音に
    // なったときだけ、持続レベルを足さない TL のみ(=アタック直後の「実際に鳴っている瞬間」)で
    // 合成し直す。SL<15 の音色の出力はこれまでどおり一切変わらない。
    const egFor = (useSl) => p.ops.map((o) => Math.min(0x3ff, ((o.TL & 127) << 3)
      + (useSl ? (((o.SL & 15) === 15 ? 31 : (o.SL & 15)) << 5) : 0)));
    let w = fn(pgInc, egFor(true), p.AL & 7, p.FB & 7);
    if (isFlatWave(w)) w = fn(pgInc, egFor(false), p.AL & 7, p.FB & 7);
    return (w && w.length && !isFlatWave(w)) ? w : null;
  }
  // OPLL/VRC7/OPL(OPLL形式へ変換済み)の自作音色8バイト → ±1 正規化128点。
  // モジュレータの定常レベルは TL + 4×SL(EGT=1で持続する音のみ。EGT=0は減衰しきるので TL のみ)
  function opllSteadyWave(bytes) {
    const S = solver();
    if (!S || !bytes || bytes.length < 8) return null;
    const mlm = bytes[0] & 15, mlc = bytes[1] & 15;
    const egtM = !!(bytes[0] & 0x20);
    const tl = bytes[2] & 63;
    const fb = bytes[3] & 7, dm = (bytes[3] >> 3) & 1, dc = (bytes[3] >> 4) & 1;
    const slM = (bytes[6] >> 4) & 15;
    const tlEff = Math.min(63, tl + (egtM ? slM * 4 : 0));
    const c = S.steadyCycle(dm, dc, mlm, mlc, fb, tlEff);
    let mx = 1e-6;
    for (let i = 0; i < c.length; i++) mx = Math.max(mx, Math.abs(c[i]));
    const out = new Array(c.length);
    for (let i = 0; i < c.length; i++) out[i] = c[i] / mx;
    return out;
  }
  // 矩形波(duty=Highの割合)の128点
  function squareWave(duty) {
    const d = duty > 0 && duty < 1 ? duty : 0.5;
    const out = new Array(N);
    for (let i = 0; i < N; i++) out[i] = (i / N) < d ? 1 : -1;
    return out;
  }
  // ±1 の任意長1周期 → N163の32点4bit(vgm2mml/expansion/opn.js toN163Wave と同じ写像)
  function toN163(wave, len) {
    if (!wave || !wave.length) return null;
    const L = len || N163_LEN, out = new Array(L);
    for (let i = 0; i < L; i++) {
      const a = wave[Math.floor(i * wave.length / L)] || 0;
      out[i] = Math.max(0, Math.min(15, Math.round((a + 1) / 2 * 15)));
    }
    return out;
  }
  // 0-15 の波形メモリ(N163/SCC/PCMの1周期)を ±1 の128点へ
  function fromLevels(levels) {
    if (!levels || !levels.length) return null;
    let mn = Infinity, mx = -Infinity;
    for (const v of levels) { if (v < mn) mn = v; if (v > mx) mx = v; }
    const mid = (mn + mx) / 2, half = Math.max(1e-6, (mx - mn) / 2);
    const S = solver();
    const src = Array.from(levels, (v) => (v - mid) / half);
    return S ? Array.from(S.resample(src, N)) : src;
  }

  // ── VRC7自作音色の逆算(波形ごとに記憶) ───────────────────────────
  const solveCache = new Map(); // 波形キー → 8バイト
  // 探索は倍音の振幅だけで照合するので、正規化した波形をそのまま鍵にできる
  function waveKey(wave) { return Array.from(wave, (v) => Math.round(v * 100)).join(','); }
  /**
   * ±1 の1周期波形 → VRC7自作音色8バイト。エンベロープは持続型(EGT=1、AR最速、SL=0、RR=10)で、
   * 音量変化は借用元の v/@v が担う。探索は vrc7ToneSolver.searchSync(倍音振幅照合→上位から採用)。
   * ソルバー未読込なら null(呼び出し側がプリセットへ落とす)。
   */
  function vrc7BytesFromWave(wave) {
    const S = solver();
    if (!S || !wave || !wave.length) return null;
    const w = wave.length === N ? wave : Array.from(S.resample(wave, N));
    const key = waveKey(w);
    if (solveCache.has(key)) return solveCache.get(key);
    let bytes = null;
    try {
      const r = S.searchSync(S.analyze(w).mag, { coarseTop: 20, keep: 1 });
      const b = r && r[0];
      if (b) {
        bytes = [
          0x20 | (b.mlm & 15), 0x20 | (b.mlc & 15),
          b.tl & 63,
          ((b.dc & 1) << 4) | ((b.dm & 1) << 3) | (b.fb & 7),
          0xF0, 0xF0,
          0x0A, 0x0A
        ];
      }
    } catch (e) { bytes = null; }
    solveCache.set(key, bytes);
    return bytes;
  }

  // ── イベント→波形の引き当て ───────────────────────────────────
  // イベントが持つ音色情報から「元の音の1周期(±1)」を返す。無ければ null。
  //   ev.n163Wave(PCM/ADPCMの1周期、0-15)          → そのまま
  //   ev.opnPatch(OPN/OPM 4op)                      → 合成
  //   s.kind==='fm'(OPLL/OPL): ev.vrc7Tone(自作音色) → vrc7ToneReg.waves[idx] を合成
  //                            ev.instrument 1-15    → YM2413/VRC7内蔵ROMの音色を合成
  //   s.kind==='wave'(SCC等): ev.instrument           → n163WaveReg.waves[idx](0-15)
  //   s.kind==='square'(AY/SN/PSG)                    → 矩形波50%
  const steadyCache = new Map(); // 音色キー → 128点(合成は安いが、イベント数ぶん繰り返さない)
  function cached(key, make) {
    if (steadyCache.has(key)) return steadyCache.get(key);
    let w = null;
    try { w = make(); } catch (e) { w = null; }
    steadyCache.set(key, w);
    return w;
  }
  function sourceWaveRaw(ev, s, regs) {
    if (!ev || ev.note === null) return null;
    const r = regs || {};
    if (ev.n163Wave && ev.n163Wave.length) return fromLevels(ev.n163Wave);
    if (ev.opnPatch) return cached('opn:' + JSON.stringify(ev.opnPatch), () => opnSteadyWave(ev.opnPatch));
    if (s && s.kind === 'fm') {
      let bytes = null;
      if (ev.vrc7Tone !== undefined && r.vrc7ToneReg && r.vrc7ToneReg.waves) bytes = r.vrc7ToneReg.waves[ev.vrc7Tone] || null;
      else if (ev.instrument >= 1 && ev.instrument <= 15) {
        const O = opllNuked();
        // VGM/KSSのOPLLソースはYM2413のROM。VRC7(ds1001)ソースは nsf2mml 側(ここへは来ない)
        bytes = (O && O.presetBytes) ? O.presetBytes(s.chip === 'vrc7' ? 'ds1001' : 'ym2413', ev.instrument) : null;
      }
      return bytes ? cached('opll:' + bytes.join(','), () => opllSteadyWave(bytes)) : null;
    }
    if (s && s.kind === 'wave' && s.chip === 'k051649') {
      // SCC: 抽出器(kss2mml/expansion/scc.js)が波形メモリを n163WaveReg へ登録し ev.instrument で指す
      const w = (ev.instrument !== undefined && r.n163WaveReg && r.n163WaveReg.waves) ? r.n163WaveReg.waves[ev.instrument] : null;
      return w && w.length ? fromLevels(w) : null;
    }
    if (s && s.kind === 'square') {
      // GBパルスは ev.instrument がデューティ(0-3=12.5/25/50/75%)。AY/SNは50%固定
      // (AYの ev.instrument はミキサーモードなので見ない)
      const duty = (s.chip === 'gb' && ev.instrument >= 0 && ev.instrument <= 3) ? [0.125, 0.25, 0.5, 0.75][ev.instrument] : 0.5;
      return cached('sq' + duty, () => squareWave(duty));
    }
    return null;
  }

  // 元の音がどの経路で来ても(FM合成・波形メモリ・PCMの1周期)、平坦なら音にならないので
  // ここで一括して null にする。呼び出し側(vgm2mml/converter.js、convert/borrow.js)は
  // null を矩形波/プリセットへのフォールバックとして既に扱っている
  function sourceWave(ev, s, regs) {
    const w = sourceWaveRaw(ev, s, regs);
    return isFlatWave(w) ? null : w;
  }

  /** N163/FDS向け: イベントの元の音を32点4bitへ(無ければ null=矩形波にする) */
  TD.n163WaveForEvent = function (ev, s, regs, len) {
    if (ev && ev.n163Wave && ev.n163Wave.length === (len || N163_LEN) && !isFlatWave(ev.n163Wave)) return ev.n163Wave;
    const w = sourceWave(ev, s, regs);
    return w ? toN163(w, len) : null;
  };
  /** VRC7 @0向け: イベントの元の音から逆算した自作音色8バイト(無ければ null=プリセットへ) */
  TD.vrc7BytesForEvent = function (ev, s, regs) {
    const w = sourceWave(ev, s, regs);
    return w ? vrc7BytesFromWave(w) : null;
  };

  TD.isFlatWave = isFlatWave;
  TD.opnSteadyWave = opnSteadyWave;
  TD.opllSteadyWave = opllSteadyWave;
  TD.squareWave = squareWave;
  TD.toN163 = toN163;
  TD.vrc7BytesFromWave = vrc7BytesFromWave;
  TD.sourceWave = sourceWave;
})(window);
