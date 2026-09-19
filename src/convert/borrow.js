/*
 * 借用先(NES音源)への載せ替え共通層 — MML.Convert.Borrow (2026-08-26)
 *
 * 「変換元チャンネルを任意のNES側チャンネルへ載せる」処理を1箇所にまとめたもの。
 * 元は src/vgm2mml/converter.js の composePsgLike 後半にだけ在った(VGMのPSG系合成専用)。
 * 鍵盤表示のチャンネル割当(案E、src/convert/channelPlan.js)を KSS/GBS/HES にも効かせるため、
 * 変換元に依らない部分をここへ移した。vgm2mml は引き続きこのモジュールを使う
 * (抽出器も借用ロジックも複製しない、というROADMAPの方針)。
 *
 * 使い方(各 *2mml の「ユーザーが割当を変えたとき」の経路):
 *   const r = MML.Convert.Borrow.compose({
 *     sources,      // 変換元ch [{ id, label, chip, kind, ch, linear?, nativeFamily? }]
 *     plan,         // { sourceId: targetType }  targetTypeは channelPlan.js の語彙
 *     extract,      // (chip, family, envRegProxy) => { [ch]: channel }  ※(chip,family)ごとに1回呼ばれる
 *     cmd, regs, toneOf, n163WaveLen
 *   });
 *   // r = { scoreChannels, expansions, letterMap, n163NumCh, notes, placed }
 *
 * ★既定の割当のときは各 *2mml の従来コードをそのまま使うこと。このモジュールは
 *   「ユーザーが既定から変えたとき」だけ通る道で、従来出力のバイト一致は保証しない
 *   (=既定の変換結果は従来コードが担保し続ける)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  const CPU_CLOCK_NTSC = 1789773; // 借用先(2A03/VRC6/MMC5/FME7/FDS/N163/VRC7)側のクロック
  const N163_WAVE_LEN = 32;       // N163へ載せる矩形波の長さ(SCC近似と同じ32点で統一)
  const N163_SQUARE_WAVE = Array.from({ length: N163_WAVE_LEN }, (_, i) => (i < N163_WAVE_LEN / 2 ? 15 : 0));

  // ── 借用先ファミリごとの生周期換算(detune/EP用。丸めない: src/convert/detune.js冒頭) ──
  function fme7PeriodRaw(freq) { return CPU_CLOCK_NTSC / (32 * freq); }
  // ★波形長は音符ごと(ev.rawLength、N163Fit が縮めた波形の音符に付く)。コンパイラはその長さで
  //   freqReg を作るので、既定長のまま D/EP を出すと縮めた音符だけ2倍以上効く(2026-09-19)
  function n163FreqRegRaw(waveLen, numCh) {
    return (freq, ev) => freq * 15 * 65536 * ((ev && ev.rawLength) || waveLen) * numCh / CPU_CLOCK_NTSC;
  }
  // VRC7: freq = fnum * 2^block * 49716 / 2^19(compiler.js vrc7FreqToFnumBlock() の逆関数、丸めない
  // 生の連続値)。再生側は「理論値(音符)の block を固定し、fnum だけに D<n> を足す」ので、
  // D の材料となる実測周波数も同じ block で fnum に換算しないと辻褄が合わない。
  // ev(音符イベント、ev.note)があれば block を ev.note の理論周波数から compiler.js と同じ規則
  // (round(fnum) <= 511)で決め、freq をその block 内の fnum として返す(511 を超えてもそのまま)。
  // ★2026-09-07: 以前は freq 自身で block を自己選択していたため、理論値より数十セント低いだけで
  // block 境界の反対側に落ちる音符(fnum 258 に対し実測 510)で D が上限(fnum 幅の半分)に
  // 張り付き、VGM の YM2151→VRC7 で 122 音が約7度上ずって鳴っていた。
  // ev 無し(単独の周波数換算)は従来通り自己選択+511 クランプ。
  function vrc7BlockOf(freq) {
    for (let block = 0; block <= 7; block++) {
      if (Math.round((freq * 524288) / (49716 * Math.pow(2, block))) <= 511) return block;
    }
    return 7;
  }
  function vrc7FnumRaw(freq, ev) {
    if (ev && ev.note != null) {
      const block = vrc7BlockOf(MML.Convert.noteToFreq(ev.note));
      return (freq * 524288) / (49716 * Math.pow(2, block));
    }
    for (let block = 0; block <= 7; block++) {
      const fnum = (freq * 524288) / (49716 * Math.pow(2, block));
      if (fnum <= 511) return fnum;
    }
    return 511;
  }
  const pulsePeriodRaw = freq => CPU_CLOCK_NTSC / (16 * freq) - 1;   // 2A03/MMC5パルス
  const triPeriodRaw = freq => CPU_CLOCK_NTSC / (32 * freq) - 1;     // 2A03三角波
  const vrc6PulsePeriodRaw = freq => CPU_CLOCK_NTSC / (16 * freq) - 1;
  // VRC6のこぎり波は7段アキュムレータ×2=14クロックで1周期(compiler.js sawPeriod と同じ式)。
  // パルスの16で代用するとデチューン/EPの生値が14%ずれる
  const vrc6SawPeriodRaw = freq => CPU_CLOCK_NTSC / (14 * freq) - 1;
  const fdsPeriodRaw = freq => (freq * 65536 * 64) / CPU_CLOCK_NTSC; // FDS(gbs2mml/expansion/wave.jsと同じ式)

  // ── 音量の写像 ──────────────────────────────────────────────
  // 対数DAC(dbPerStep/段)の4bit音量値を、借用先の音量レンジ(既定0-15)へ換算する表。
  // max は FAMILY_VOL_MAX の値(FDS=32/VRC6のこぎり=42)を渡す
  function logToLinearTable(dbPerStep, max) {
    const m = max == null ? 15 : max;
    const t = new Array(16);
    for (let v = 0; v < 16; v++) t[v] = v === 0 ? 0 : Math.max(1, Math.min(m, Math.round(m * Math.pow(10, -dbPerStep * (15 - v) / 20))));
    return t;
  }
  // 4bit対数音量 → VRC7の減衰値(v0=最大、3dB/段)
  function logToVrc7Table(dbPerStep) {
    const t = new Array(16);
    for (let v = 0; v < 16; v++) t[v] = Math.max(0, Math.min(15, Math.round((15 - v) * dbPerStep / 3)));
    return t;
  }
  const LIN_TABLE = { ay8910: logToLinearTable(3), sn76489: logToLinearTable(2) };
  const VRC7_TABLE = { ay8910: logToVrc7Table(3), sn76489: logToVrc7Table(2) };

  // 音量の減衰量(dB)→借用先の音量値。VRC7は「v0が最大・v15が最小」(このコンパイラ/ppmckのVRC7は
  // レジスタの減衰値をそのまま v に取る)、FME-7は v15 最大の3dB/段、線形音源は振幅比。
  // ★linear の max は借用先ごと(FAMILY_VOL_MAX)。以前は 15 を直書きしており、0-63 を持つ
  //   FDS/VRC6のこぎり波でもレンジの上半分が一切使われず、実測で約6.6dB/約9dB小さく鳴っていた
  //   (2026-09-11、ユーザー報告「YM2151→VRC6のこぎりの音量がおかしい」)。
  const VOL_FROM_DB = {
    vrc7: att => Math.max(0, Math.min(15, Math.round(att / 3))),
    fme7: att => Math.max(0, Math.min(15, 15 - Math.round(att / 3))),
    linear: (att, max) => { const m = max == null ? 15 : max; return att >= 60 ? 0 : Math.max(1, Math.min(m, Math.round(m * Math.pow(10, -att / 20)))); }
  };

  // envReg.assign(volSeq) を写像テーブル経由にするプロキシ
  // ★volumeFieldsWithRelease が返す定数音量(volume)は **写像後の列** から作られる=写像済み。
  //   印 _volMapped を付けて返し、adaptGroup の mapConstVolumes が同じ表を重ねて掛けないようにする
  //   (2026-09-19。以前は二重に写像され、HuC6280→2A03パルスで元の音量14が v11 でなく v4 になっていた。
  //   @v テーブルは1回だけなので、同じ音符列の中で v と @v の尺度が食い違っていた)。
  //   印の無い定数音量(OPLL/OPL の抽出器や AY のハードウェアエンベロープ音符のように、レジストリを
  //   通さず直接 volume を付けるもの)は生の値なので、従来どおり mapConstVolumes が1回写像する
  function mappedEnvReg(envReg, table) {
    const top = table.length - 1;
    const map = seq => seq.map(v => table[Math.max(0, Math.min(top, v))]);
    return {
      assign: seq => envReg.assign(map(seq)),
      // 楽器化(リリース切り出し、envelope.js volumeFieldsWithRelease)も写像経由で通す
      volumeFieldsWithRelease: seq => Object.assign(envReg.volumeFieldsWithRelease ? envReg.volumeFieldsWithRelease(map(seq))
        : (() => { const idx = envReg.assign(map(seq)); return idx == null ? { volume: MML.Convert.plainVolume(map(seq)) } : { envelopeV: idx }; })(),
      { _volMapped: true })
    };
  }
  // 抽出器が定数音量として残した ev.volume も同じ表で写像する(写像済みの印 _volMapped が付いたものは除く)
  function mapConstVolumes(events, table) {
    const top = table.length - 1;
    for (const ev of events) if (ev.volume !== undefined && !ev._volMapped) ev.volume = table[Math.max(0, Math.min(top, ev.volume))];
  }

  // 借用先ファミリの音量レンジ。★FDS=32/VRC6のこぎり=42 は「コンパイラが受け付ける上限」(v0-63、
  //   compiler.js volMax)ではなく **実機で意味のある上限**(2026-09-11に63から訂正):
  //     ・VRC6のこぎり波は14ステップ中6回だけ蓄積レートを足し、8bitで溢れる。6×42=252で出力段が
  //       最大の31に届き、43以上は最後の加算が折り返してのこぎりの形が壊れる(src/emulator/expansion/vrc6.js)
  //     ・FDSは出力段が Math.min(32, gain)/32 なので33-63は32と同じ音(src/emulator/expansion/fds.js)
  //   spc2mml は元からこの値(TARGET_VOL_MAX)を使っており、ここを正典にして3経路の食い違いを解消する
  const FAMILY_VOL_MAX = { pulse: 15, triangle: 15, noise: 15, n163: 15, fme7: 15, vrc7: 15, vrc6pulse: 15, vrc6saw: 42, fds: 32 };

  // ── チップごとの音量則(正典) ────────────────────────────────────────
  // ★2026-09-11、各エミュレータの実装と一次資料を突き合わせて訂正。音量則は「どの形式から
  //   来たか」ではなく **チップの性質** なので、形式ごとの宣言ではなくここ1箇所で持つ。
  //   vgm2mml の sourceAttDb と src/audio/assign-preview.js volSpecOf も同じ表を見る。
  //   linear … 音量値が振幅そのもの / stepDb … 1段あたりの減衰dB / attDb … 値自体が減衰値
  const CHIP_VOL_LAW = {
    // SCC: mixSample が (sample * vol) >> 4 の掛け算。対数DACではない(sccAudio.js)
    k051649: { linear: true },
    // GB: パルスは4bit線形エンベロープ、波形chは音量シフト(apuGb.js)
    gb: { linear: true },
    // AY-3-8910/YM2149: 1.5dB/段の32段表を、4bitレジスタが channelLevel=v*2+1 で1段飛ばしに引く
    //   → レジスタ1段は3dB(ay8910Msx.js)。NESdev Sunsoft 5B audio も「5bitで1.5dB/段、
    //   4bit扱いなら3dB/段」と記す。★以前は1.5dBにしており、エンベロープ側の段数を流用していた
    ay8910: { stepDb: 3 },
    // HuC6280: 5bitで1.5dB/段の対数(MAME c6280 は「48dBを32段に配分」)。抽出器が effVol>>1 で
    //   16段へ落とすので実効3dB/段(apuHuC6280.js gainFromIndex)。★以前は線形扱いだった
    huc6280: { stepDb: 3 },
    // SN76489: 2dB/段(sn76489.js VOL_TABLE)
    sn76489: { stepDb: 2 },
    // OPLL: 値そのものが減衰値(v0が最大、3dB/段)
    ym2413: { attDb: 3 },
    // OPL(YM3812/YM3526/Y8950/MSX-AUDIO): 抽出器(kss2mml/expansion/opl.js)が
    // キャリアTL(6bit×0.75dB)を TL>>2 に落として渡すので、OPLLと同じ 3dB/段の減衰値。
    // ★VGM側のコピー(vgm2mml/converter.js sourceAttDb)は nativeFamily を持たないため、
    //   ここに載せないと既定の「(15-v)×1.5dB」(=線形音源向きで**向きが逆**)に落ちる。
    //   Haunted Castle の YM3812 を N163 へ載せると一番大きい音が v1/v2 になっていた(2026-09-17)。
    opl: { attDb: 3 },
  };

  // 変換元の音量値 v(0..srcMax)の減衰量[dB]。チップ表(CHIP_VOL_LAW)が最優先。
  // 表に無いチップは s.linear / s.logStepDb / nativeFamily から推定する(既定は対数1.5dB/段)。
  function attOf(s, v, srcMax) {
    const law = CHIP_VOL_LAW[s.chip];
    if (law) {
      if (law.linear) return v <= 0 ? 96 : -20 * Math.log10(v / srcMax);
      if (law.attDb) return v * law.attDb;
      return (srcMax - v) * law.stepDb;
    }
    if (s.linear) return v <= 0 ? 96 : -20 * Math.log10(v / srcMax);
    if (s.nativeFamily === 'vrc7') return v * 3; // OPL(chip:'opl')など、減衰値をそのまま持つ元
    const step = s.logStepDb || 1.5;
    return (srcMax - v) * step;
  }
  // 変換元の音量値 → 借用先の音量値の対応表(0..srcMax)。変換不要なら null。
  // これ1本で「対数→線形」「線形→対数」「レンジ違い(0-15↔0-63)」を全部まかなう
  // (VGMのLIN_TABLE/VRC7_TABLEと同じ値になることは logToLinearTable/logToVrc7Table と一致確認済み)。
  function volTableFor(s, fam) {
    const srcMax = s.volMax || 15;
    const dstMax = FAMILY_VOL_MAX[fam] !== undefined ? FAMILY_VOL_MAX[fam] : 15;
    if (fam === s.nativeFamily && srcMax === dstMax) return null;
    if (fam === 'triangle' || (fam === 'noise' && s.kind === 'noise')) return null; // ノイズ→ノイズは音量そのまま、三角波は音量が無い(旋律→ノイズは線形4bitへ)
    const t = new Array(srcMax + 1);
    for (let v = 0; v <= srcMax; v++) {
      const att = attOf(s, v, srcMax);
      t[v] = fam === 'vrc7' ? VOL_FROM_DB.vrc7(att)
        : fam === 'fme7' ? VOL_FROM_DB.fme7(att)
          : (v === 0 ? 0 : Math.max(1, Math.min(dstMax, Math.round(dstMax * Math.pow(10, -att / 20)))));
    }
    return t;
  }

  // 抽出時に使う音量エンベロープレジストリ。元と借用先の音量尺度が違うときだけ写像プロキシを返す
  // (@vテーブルと定数音量 ev.volume の両方を同じ表で揃えるため、抽出のたびに family 別で呼ぶ)。
  function envRegFor(envReg, s, fam) {
    const table = fam ? volTableFor(s, fam) : null;
    return table ? mappedEnvReg(envReg, table) : envReg;
  }

  // ── OPN 4op音色 → OPLL/VRC7 2op音色 ────────────────────────────
  // (実体は vgm2mml が持つ変換。VGM以外のソースには4op音色が無いので参照だけする)
  function opnToOpllBytes(p) {
    return (MML.VGM2MML && MML.VGM2MML.opnToOpllBytes) ? MML.VGM2MML.opnToOpllBytes(p) : null;
  }

  // ── 旋律ch → 2A03ノイズ(D) ───────────────────────────────────
  // FMやPSGで「ノイズっぽく」鳴らしているパートを2A03ノイズへ載せる(2026-09-05、ユーザー要望)。
  // 音程はノイズの周期index(0=最も明るい)へ写し、ノート番号は nsf2mml/gbs2mml のノイズと同じ
  // 31-idx 空間にする(compiler.js noisePeriodIndex = 15-(note%16))。周期は tone が '0'-'15' なら
  // 固定、'auto'/未指定なら基音(OPNはキャリアの倍率ML込み)から最寄りのシフトレートへ
  // (MML.Convert.ChannelPlan.noiseIndexFor。割当プレビューも同じ式)。音量は呼び出し側で線形4bit済み。
  // ピッチ系の付帯情報(EN/EP/D/波形/音色)はノイズでは意味を持たないので落とす。
  const OPN_CARRIERS = [[3], [3], [3], [3], [1, 3], [1, 2, 3], [1, 2, 3], [0, 1, 2, 3]];
  function opnCarrierMul(p) {
    if (!p || !p.ops) return 1;
    let m = 0;
    for (const i of OPN_CARRIERS[p.AL & 7]) if (p.ops[i]) m = Math.max(m, p.ops[i].ML || 0);
    return m || 0.5; // ML=0 は実機で×0.5
  }
  function pitchedToNoise(ch, tone, events) {
    const Plan = MML.Convert.ChannelPlan;
    for (const ev of (events || ch.events)) {
      if (ev.note !== null && ev.note !== undefined) {
        const freq = ev.freqHz || ev.rawFreq || MML.Convert.noteToFreq(ev.note);
        ev.note = 31 - Plan.noiseIndexFor(tone, freq, opnCarrierMul(ev.opnPatch));
      }
      for (const k of ['instrument', 'n163Wave', 'vrc7Tone', 'opnPatch', 'rawLength', 'fme7Noise', 'rawFreq', 'freqHz', 'freqSeq', 'pitchSeq', 'noteEnvOffsets', 'detune']) delete ev[k];
    }
    ch.hasInstrument = false; ch.hasVrc7Tone = false; ch.hasFme7Noise = false;
    ch.hasNoteEnv = false; ch.hasPitchMod = false; ch.hasDetune = false;
  }

  /**
   * ソースチャンネルのイベントを借用先ファミリの語彙へ整形する(破壊的。呼び出し側でコピー済み)。
   * s.nativeFamily と同じファミリへ載せる場合は「元のまま正しく鳴る」ので何もしない
   * (AY→FME-7、OPLL→VRC7、SCC/HuC6280→N163、GBパルス→2A03パルス、GB波形→FDS 等)。
   * tone: 借用先ごとの音色指定(channelPlan.js の toneOptionsFor)。
   *   VRC7 … 'auto'(元の音色そのまま)/'0'(自作音色へ変換)/'1'-'15'(プリセット)
   *   duty … '0'-'3'(2A03/MMC5)、'0'-'7'(VRC6)
   *   wave … 'copy'(元の波形をそのまま)/'pulse50' 等(N163/FDS)
   *
   * 音色ごとの指定(2026-09-09、src/convert/toneSettings.js): ctx.toneOfEvent(ev) が音色(楽器)単位の
   * 指定を返すときは、イベントを「効く音色指定」でグループに分け、グループごとに従来の整形を通す。
   * 指定の無い音色は ctx.tone(チャンネルの指定)に従う。全イベントが同じ指定なら従来と同じ1回の処理
   * (=既定出力は不変)。
   *   ctx.toneKeyOf(ev)   … 音色キー(toneKey.js)。VRC7自作音色の登録番号→音色キー対応
   *                          (ctx.toneIdxKey[idx]=key)を控えるのに使う(あぶれてプリセットへ落ちた音色を
   *                          一覧で「→@n」と報告するため)
   */
  function adaptEvents(ch, s, fam, ctx) {
    ctx = ctx || {};
    const chTone = ctx.tone || undefined;
    if (typeof ctx.toneOfEvent !== 'function') { adaptGroup(ch, ch.events, s, fam, chTone, ctx); return; }
    const groups = new Map(); // tone文字列(既定は ' '+chTone) → events
    for (const ev of ch.events) {
      let t = ev.note === null ? undefined : ctx.toneOfEvent(ev);
      if (t === undefined || t === null || t === '') t = chTone;
      const gk = t === undefined ? '' : String(t);
      let g = groups.get(gk);
      if (!g) { g = { tone: t, events: [] }; groups.set(gk, g); }
      g.events.push(ev);
    }
    if (groups.size <= 1) {
      const only = groups.values().next().value;
      adaptGroup(ch, ch.events, s, fam, only ? only.tone : chTone, ctx);
      return;
    }
    // 休符(note===null)は全グループに現れうるが整形は音符にしか効かないので、そのまま各グループで処理する
    for (const g of groups.values()) adaptGroup(ch, g.events, s, fam, g.tone, ctx);
    // フラグはグループごとに上書きされるので、混在時は実際のイベントから決め直す
    ch.hasInstrument = ch.events.some(ev => ev.instrument !== undefined);
    ch.hasVrc7Tone = ch.events.some(ev => ev.vrc7Tone !== undefined);
  }

  function adaptGroup(ch, events, s, fam, tone, ctx) {
    const n163WaveReg = ctx && ctx.n163WaveReg;
    const vrc7ToneReg = ctx && ctx.vrc7ToneReg;
    const isAy = s.chip === 'ay8910';
    const nativeVrc7 = s.nativeFamily === 'vrc7' && fam === 'vrc7' && (tone === 'auto' || tone == null);
    // ★ドラムパート(合成ch、ch:-1)は kind:'noise' を名乗るが実体は「音程の取れないサンプルを
    //   1本にまとめたレーン」で音量を attDb で持つ。早期returnすると音量換算に届かず強弱が反転する。
    //   ただし音程は DrumMap のレーン番号なので、下の pitchedToNoise は通さないこと。
    //   ※現状 ch:-1 のドラムパートを持つのはVGMだけ(vgm2mml/converter.js の独自コピーが本番)。
    //     ここは2つのコピーを揃えるための保険。
    if (fam === 'noise' && s.kind === 'noise') {
      // ノイズ→ノイズは整形不要(旋律→ノイズは下で周期へ写す)。抽出器が付けた短/長周期(instrument 0/1、
      // GBの7bit幅・SN76489の周期性ノイズ→2A03の短周期 @1)だけは @<n> として出せるようフラグを立てる
      ch.hasInstrument = events.some(ev => ev.instrument !== undefined);
      return;
    }
    if (nativeVrc7 || (fam === s.nativeFamily && fam !== 'vrc7' && (!tone || tone === 'copy'))) return;
    // VRC7自作音色の登録番号 → 音色キー(あぶれ報告用)
    const noteToneIdx = (ev, idx) => {
      if (!ctx || !ctx.toneIdxKey || typeof ctx.toneKeyOf !== 'function' || idx === undefined) return;
      const k = ctx.toneKeyOf(ev);
      if (k && ctx.toneIdxKey[idx] === undefined) ctx.toneIdxKey[idx] = k;
    };

    // AYのミキサー: ノイズ単独(mode 2)は矩形波系の借用先では鳴らせないので休符に、
    // トーン+ノイズ(mode 3)はトーンだけ残す。FME-7以外ではN<n>も出さない。
    // ハードウェアエンベロープ(S<n>/M<n>、kss2mml/expansion/ay.js 2026-09-19)も FME-7 専用なので落とし、
    // 抽出器が付けた volume(減衰の最大値)で鳴らす
    if (isAy && fam !== 'fme7') {
      for (const ev of events) { if (ev.instrument === 2) ev.note = null; delete ev.fme7Noise; delete ev.fme7EnvShape; delete ev.fme7EnvPeriod; }
      ch.hasFme7Noise = false; ch.hasFme7Env = false;
    }

    // 音量: 借用先の尺度へ(@vテーブルは envRegFor() 側で同じ表に写像済み)。
    // attDb(減衰dBを直接持つVGMのOPN/ADPCM等)はテーブルを介さず直接換算する。
    const hasAttDb = events.some(ev => ev.attDb !== undefined);
    if (hasAttDb) {
      if (fam !== 'triangle') {
        const conv = fam === 'vrc7' ? VOL_FROM_DB.vrc7 : fam === 'fme7' ? VOL_FROM_DB.fme7
          : (att) => VOL_FROM_DB.linear(att, FAMILY_VOL_MAX[fam]);
        for (const ev of events) if (ev.note !== null && ev.attDb !== undefined) ev.volume = conv(ev.attDb);
      }
    } else {
      const table = volTableFor(s, fam);
      if (table) mapConstVolumes(events, table);
    }
    for (const ev of events) delete ev.attDb;

    // 音色/波形: 借用先ごとに作り直す。N163以外へ載せるときは rawLength(N163波形長)も落とす
    // (applyPitchDetune/assignPitchEnvelope の periodForFreq が ev 経由で参照するため)
    const clearWave = (ev) => { delete ev.n163Wave; delete ev.vrc7Tone; delete ev.opnPatch; };
    const TD = MML.Convert.ToneDerive;
    const deriveRegs = { n163WaveReg, vrc7ToneReg };
    if (fam === 'noise') {
      pitchedToNoise(ch, tone, events);
    } else if (fam === 'vrc7' && tone === '0' && vrc7ToneReg && TD && s.kind !== 'fm' && s.kind !== 'fm4') {
      // 矩形波(PSG)/波形(SCC/HuC6280)/PCM → VRC7 2op 自作音色。元の音の波形から逆算する
      // (src/convert/toneDerive.js)。★以前は '0' を選んでも下のプリセット分岐で @1 に落ちていた
      let any = false;
      for (const ev of events) {
        if (ev.note === null) { clearWave(ev); delete ev.rawLength; continue; }
        const bytes = TD.vrc7BytesForEvent(ev, s, deriveRegs);
        if (bytes) { ev.instrument = 0; ev.vrc7Tone = vrc7ToneReg.assign(bytes); noteToneIdx(ev, ev.vrc7Tone); any = true; }
        else { ev.instrument = 1; delete ev.vrc7Tone; }
        delete ev.n163Wave; delete ev.opnPatch; delete ev.rawLength;
      }
      ch.hasVrc7Tone = any; ch.hasInstrument = true;
    } else if (fam === 'vrc7' && tone === '0' && s.kind === 'fm4' && vrc7ToneReg) {
      // OPN 4op → VRC7 2op 自作音色(opnToOpllBytes)。音色ごとに @OP<n> を登録し OP<n>+@0 で切り替える
      for (const ev of events) {
        delete ev.n163Wave; delete ev.rawLength;
        if (ev.note === null) { delete ev.vrc7Tone; delete ev.opnPatch; continue; }
        const bytes = opnToOpllBytes(ev.opnPatch);
        ev.instrument = 0;
        ev.vrc7Tone = bytes ? vrc7ToneReg.assign(bytes) : undefined;
        noteToneIdx(ev, ev.vrc7Tone);
        delete ev.opnPatch;
      }
      ch.hasVrc7Tone = true; ch.hasInstrument = true;
    } else if (fam === 'vrc7') {
      // VRC7プリセット音色。元の音色/カスタム音色は捨てる
      const inst = Math.max(1, Math.min(15, parseInt(tone, 10) || 1));
      for (const ev of events) { if (ev.note !== null) ev.instrument = inst; clearWave(ev); delete ev.rawLength; }
      ch.hasVrc7Tone = false; ch.hasInstrument = true;
    } else if (fam === 'n163') {
      // 元が波形を持つ(SCC/HuC6280/ADPCM)ならそれを、FM(OPLL/OPL/OPN)なら音色の定常波形
      // (src/convert/toneDerive.js)を、どちらも無ければ矩形波を @N に登録して音色にする
      const forced = toneWave(tone);
      for (const ev of events) {
        if (ev.note === null) { clearWave(ev); continue; }
        const derived = forced ? null : (TD ? TD.n163WaveForEvent(ev, s, deriveRegs, N163_WAVE_LEN) : null);
        const wave = forced || derived || ((ev.n163Wave && ev.n163Wave.length) ? ev.n163Wave : N163_SQUARE_WAVE);
        ev.instrument = n163WaveReg.assign(wave); ev.rawLength = wave.length;
        clearWave(ev);
      }
      ch.hasInstrument = true; ch.hasVrc7Tone = false;
    } else if (fam === 'pulse' || fam === 'vrc6pulse') {
      // 2A03/MMC5パルスは@2(50%)、VRC6パルスは@7(8/16=50%)が既定
      const def = fam === 'pulse' ? 2 : 7;
      const inst = tone !== undefined && tone !== null && tone !== '' && !isNaN(parseInt(tone, 10))
        ? parseInt(tone, 10) : def;
      for (const ev of events) { if (ev.note !== null) ev.instrument = inst; clearWave(ev); delete ev.rawLength; }
      ch.hasInstrument = true; ch.hasVrc7Tone = false;
    } else if (fam === 'fme7') {
      // FME-7: @1=トーンのみ
      for (const ev of events) { if (ev.note !== null) ev.instrument = 1; clearWave(ev); delete ev.rawLength; }
      ch.hasInstrument = true; ch.hasVrc7Tone = false;
    } else if (fam === 'vrc6saw') {
      // VRC6のこぎり波: 音色指定は無い(音量は0-63だが借用元の0-15をそのまま使う)
      for (const ev of events) { if (ev.note !== null) delete ev.instrument; clearWave(ev); delete ev.rawLength; }
      ch.hasInstrument = false; ch.hasVrc7Tone = false;
    } else if (fam === 'triangle') {
      // 三角波: 音量・音色は無い。音程だけ
      for (const ev of events) { delete ev.volume; delete ev.envelopeV; delete ev.envelopeVr; delete ev.instrument; delete ev.rawLength; clearWave(ev); }
      ch.hasVolume = false; ch.hasEnvelope = false; ch.hasInstrument = false; ch.hasVrc7Tone = false;
    } else if (fam === 'fds') {
      // FDS: 元が波形を持たない場合だけ矩形波を作る(GB波形chのようにネイティブな元は上で早期returnしている)
      for (const ev of events) { clearWave(ev); delete ev.rawLength; }
      ch.hasVrc7Tone = false;
    }
  }

  // 波形音色の固定波形(channelPlan.js toneOptionsFor の 'pulse50'/'sin'/'triangle'/'saw')。
  // 'copy'(既定)と未指定は元の波形をそのまま使うので null を返す。
  function toneWave(tone) {
    if (!tone || tone === 'copy') return null;
    const n = N163_WAVE_LEN;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = i / n;
      let v;
      if (tone === 'pulse50') v = p < 0.5 ? 15 : 0;
      else if (tone === 'sin') v = Math.round(7.5 + 7.5 * Math.sin(2 * Math.PI * p));
      else if (tone === 'triangle') v = Math.round(p < 0.5 ? 30 * p : 30 * (1 - p));
      else if (tone === 'saw') v = Math.round(15 * p);
      else return null;
      out[i] = Math.max(0, Math.min(15, v));
    }
    return out;
  }

  /**
   * 借用先へ配置してスコア用チャンネル配列を作る。
   * @param {object} o
   *   o.sources  : [{ id, label, chip, kind, ch, linear?, nativeFamily? }]
   *   o.plan     : { sourceId: targetType }
   *   o.extract  : (chip, family, envRegProxy) => channelsByCh(配列 or {ch: channel})
   *   o.cmd      : normalizeCmd 済み変換設定
   *   o.regs     : { envReg, pitchReg, noteEnvReg, n163WaveReg, vrc7ToneReg }
   *   o.toneOf   : (sourceId) => tone文字列|undefined
   *   o.n163WaveLen : N163の波形長(既定32)
   * @returns {{scoreChannels, expansions, letterMap, n163NumCh, notes, placed, demotions}}
   */
  function compose(o) {
    const Plan = MML.Convert.ChannelPlan;
    const src = o.sources || [];
    const plan = o.plan || {};
    const regs = o.regs || {};
    const cmd = o.cmd;
    const toneOf = o.toneOf || (() => undefined);
    const notes = [];
    const familyOf = t => (Plan.targetInfo(t).family || null);

    // ── 音色ごとの設定(src/convert/toneSettings.js、2026-09-09) ──────────────────
    // o.toneSettings … main.js が ToneSettings.snapshot() で作った素のオブジェクト(無ければ従来どおり)
    // o.toneKeyOf(ev, s) … 音色キー(既定は toneKey.js ofEvent。SPC等はソース固有の文脈で差し替える)
    const TS = (MML.Convert.ToneSettings && o.toneSettings) ? MML.Convert.ToneSettings.lookup(o.toneSettings) : null;
    const TK = MML.Convert.ToneKey;
    const keyOf = o.toneKeyOf || ((ev, s) => (TK ? TK.ofEvent(ev, s) : null));
    const useTone = !!(TS && !TS.isEmpty() && TK);
    const demotions = []; // VRC7自作音色があぶれてプリセットへ落ちた音色 [{key, preset, label}]

    // ── 抽出(ソースチップごと。同じチップ内でも借用先ファミリが違えば音量写像が違うので、
    //    ファミリごとに抽出し直して該当chだけ採る。vgm2mmlのextractGroupと同じ考え方) ──
    const extracted = {}; // sourceId → channel
    const groups = {};    // chip → Set(family)
    // ★E(DPCM)へ載せたchはここでは扱わない: 合成音chの打楽器化は分離レンダリングした打点
    //   (options.drumHits、main.js synthDrum)が各 *2mml のE経路へ直接入る。旋律として
    //   借用先へ載せると二重になるので、抽出も配置も外す
    const isDpcm = t => familyOf(t) === 'dpcm';
    const extractedByFam = {}; // chip → fam → channelsByCh(音色ごとの載せ先分割で別ファミリの抽出が要るとき用)
    const extractFor = (chip, fam) => {
      const byFam = extractedByFam[chip] = extractedByFam[chip] || {};
      if (byFam[fam] !== undefined) return byFam[fam];
      const sample = src.find(s => s.chip === chip);
      const res = sample ? o.extract(chip, fam, envRegFor(regs.envReg, sample, fam)) : null;
      byFam[fam] = res || null;
      return byFam[fam];
    };
    for (const s of src) {
      const t = plan[s.id] || 'skip';
      if (t === 'skip' || isDpcm(t)) continue;
      (groups[s.chip] = groups[s.chip] || new Set()).add(familyOf(t));
    }
    for (const chip of Object.keys(groups)) {
      for (const fam of groups[chip]) {
        const items = src.filter(s => s.chip === chip && familyOf(plan[s.id] || 'skip') === fam);
        if (!items.length) continue;
        const res = extractFor(chip, fam);
        if (!res) continue;
        for (const s of items) if (res[s.ch]) extracted[s.id] = res[s.ch];
      }
    }

    // ── 音色ごとの載せ先(toneSettings[key].target)で1本の元chを分割する ─────────────
    // 「V2のベース音色だけ三角波へ」のように、チャンネルの中の特定の音色だけ別の借用先へ載せる。
    // 元chは単音なので分割後の各パートに重なりは無い。分割先は仮想ソース(id 'V2@triangle')として
    // 通常の配置ループへ入れる(借用先の取り合いは他のソースと同じ規則で処理される)。
    // ★分割先のファミリが元chの借用先と違えば音量写像も違うので、そのファミリで抽出し直した
    //   結果から該当イベントだけを採る(キーは各抽出結果のイベントから引き直すので index 対応に頼らない)。
    const restOf = (ev) => ({ start: ev.start, end: ev.end, note: null });
    const splitSources = [];
    if (useTone) {
      for (const s of src) {
        const t = plan[s.id] || 'skip';
        const base = extracted[s.id];
        if (!base || t === 'skip' || isDpcm(t)) continue;
        // この元chに現れる音色キー → 上書き載せ先
        const overrides = new Map();
        for (const ev of base.events) {
          if (ev.note === null) continue;
          const k = keyOf(ev, s);
          const tt = k ? TS.targetFor(k) : undefined;
          if (tt && tt !== t) overrides.set(k, tt);
        }
        if (!overrides.size) continue;
        // 元ch側: 上書きされた音色のイベントを休符に
        const baseCopy = Object.assign({}, base, { events: base.events.map(ev => (ev.note !== null && overrides.has(keyOf(ev, s))) ? restOf(ev) : ev) });
        extracted[s.id] = baseCopy;
        // 載せ先ごとに仮想ソースを作る
        const byTarget = new Map();
        for (const [k, tt] of overrides) { if (!byTarget.has(tt)) byTarget.set(tt, []); byTarget.get(tt).push(k); }
        for (const [tt, keys] of byTarget) {
          const names = keys.map(k => TS.nameOf(k) || k.replace(/^[a-z]+:/, '').slice(0, 6));
          if (tt === 'skip') { notes.push(`${s.label} の音色 ${names.join(', ')} はスキップ指定のため変換対象外です。`); continue; }
          if (isDpcm(tt)) { notes.push(`${s.label} の音色 ${names.join(', ')} → E(DPCM) は音色単位の打楽器化に未対応のため変換対象外です(チャンネル単位でEを選ぶか、サンプルの「扱い」で打楽器にしてください)。`); continue; }
          const fam = familyOf(tt);
          const res = extractFor(s.chip, fam);
          const chFam = res && res[s.ch];
          if (!chFam) continue;
          const keySet = new Set(keys);
          const vs = Object.assign({}, s, { id: `${s.id}@${tt}`, label: `${s.label}[${names.join(',')}]`, splitFrom: s.id, splitKeys: keySet });
          extracted[vs.id] = Object.assign({}, chFam, { events: chFam.events.map(ev => (ev.note !== null && keySet.has(keyOf(ev, s))) ? ev : restOf(ev)) });
          plan[vs.id] = tt;
          splitSources.push(vs);
        }
      }
    }
    const allSrc = src.concat(splitSources);

    // ── 借用先ごとにイベントを整形して台帳へ ──
    const placed = {}; // targetType → { source, channel }
    for (const s of allSrc) {
      const t = plan[s.id] || 'skip';
      if (t === 'skip' || isDpcm(t) || !extracted[s.id]) continue;
      if (placed[t]) {
        notes.push(`${s.label} は ${Plan.targetLabel(t)} が既に ${placed[t].source.label} に使われているため変換対象外です。`);
        continue;
      }
      const fam = familyOf(t);
      // 種別と借用先の相性(UI外から不正な組合せが来た時の防御)
      if (s.kind === 'noise' && fam !== 'noise') {
        notes.push(`${s.label} → ${Plan.targetLabel(t)} は種別が合わないため変換対象外です。`);
        continue;
      }
      const ch = Object.assign({}, extracted[s.id], { events: extracted[s.id].events.map(ev => Object.assign({}, ev)) });
      // 音色ごとの音色指定(toneSettings[key].tone[種別])。チャンネルの指定 toneOf() を音色単位で上書きする
      const chTone = toneOf(s.splitFrom || s.id);
      const toneKind = Plan.toneKindOfTarget ? Plan.toneKindOfTarget(t, s.kind) : null;
      const toneIdxKey = {};
      const ctx = { tone: chTone, n163WaveReg: regs.n163WaveReg, vrc7ToneReg: regs.vrc7ToneReg,
        toneKeyOf: (ev) => keyOf(ev, s), toneIdxKey };
      if (useTone && toneKind) ctx.toneOfEvent = (ev) => TS.toneFor(keyOf(ev, s), toneKind);
      adaptEvents(ch, s, fam, ctx);
      for (const ev of ch.events) delete ev._volMapped; // 写像済みの印(mappedEnvReg)は整形が済んだら要らない
      ch.toneIdxKey = toneIdxKey;
      // ★動かさないのはYM2413(OPLL)だけ。OPLLの自作音色はVRC7と同じく$00-$07の1組を
      //   全chで共有する設計なので、抽出結果は最初から1系統に収まっている(実機がそう鳴らしていた)。
      //   OPL(YM3812/YM3526/Y8950)はチャンネルごとに独立した音色レジスタを持ち、それを
      //   OPLLカスタム音色8バイトへ変換しているので、OPN 4op と同じく衝突しうる(下の resolveConflicts)
      if (fam === 'vrc7') ch.vrc7ToneFixed = (s.chip === 'ym2413');
      placed[t] = { source: s, channel: ch };
    }

    // ── 借用先ファミリごとの後処理(音程補正・EN・EP)と文字割当 ──
    const byFamily = {};
    for (const t of Object.keys(placed)) {
      const f = familyOf(t);
      (byFamily[f] = byFamily[f] || []).push(Object.assign({ type: t }, placed[t]));
    }

    // ── VRC7自作音色(@0)の同時使用を1系統へ解く ──────────────────────────
    // 実機の自作音色スロットは$00-$07の1組だけで全ch共有。OPN 4op→2op変換や
    // SPCのサンプル推定音色はチャンネルごとに別音色を作るので、そのままだと2ch以上が
    // 重なった瞬間に src/mml/compiler.js の同時使用チェックへ引っかかり、MMLが
    // コンパイルできず全パート無音になる。あぶれたチャンネルはいちばん近い内蔵
    // プリセットへ落とす(src/convert/vrc7Tone.js)。
    if (regs.vrc7ToneReg && byFamily.vrc7) {
      MML.Convert.Vrc7Tone.resolveConflicts(
        byFamily.vrc7.map(p => p.channel), regs.vrc7ToneReg,
        {
          onDemote: (ch, presetByTone) => {
            ch.vrc7Demoted = presetByTone;
            const p = byFamily.vrc7.find(x => x.channel === ch);
            // 音色一覧パネルで「この音色は→@nへ落ちた」と示すため、登録番号→音色キーで控える
            for (const idx of Object.keys(presetByTone || {})) {
              const key = ch.toneIdxKey && ch.toneIdxKey[idx];
              if (key) demotions.push({ key, preset: presetByTone[idx], label: p ? p.source.label : '' });
            }
            notes.push(`${p ? p.source.label : ''} は VRC7の自作音色(@0)が実機の制約でチップ全体に1音色しか` +
              `持てないため、いちばん近い内蔵音色(${MML.Convert.Vrc7Tone.presetListOf(presetByTone)})へ置き換えました。`);
          }
        });
      // プリセットへ落としたぶんの @OP<n> 定義は誰も参照しなくなる。NSF書き出しで
      // 音色テーブル+分岐コードとしてROMを食う([[nsf-export-size-consciousness]])ので詰める
      MML.Convert.Vrc7Tone.compactRegistry(regs.vrc7ToneReg, byFamily.vrc7.map(p => p.channel));
    }

    // ── N163内蔵RAMへ波形が収まらない曲を収まる形へ ──────────────────────
    // 波形に使えるのは 128-8*有効ch数 バイトだけ。あふれるとコンパイルエラーで再生も
    // 書き出しもできないため、変換設定 N163_WAVE='fit'(既定)ならあふれたぶんの波形を
    // 半分ずつ縮める(src/convert/n163Fit.js)。★下の音程補正より前に呼ぶこと:
    // N163の周波数式は波形長を含むので、縮めた後の長さで生レジスタ値を出す必要がある
    // ★休符だけのN163チャンネルは出さない(ユーザー指示 2026-09-11)。実効ch数は
    //   #EX-N163 の数値で伝わるので、空チャンネルを並べて位置を示す必要がなくなった
    if (byFamily.n163) {
      const sounding = byFamily.n163.filter(p => p.channel.events.some(ev => ev.note !== null));
      for (const p of byFamily.n163) if (sounding.indexOf(p) < 0) delete placed[p.type];
      if (sounding.length) byFamily.n163 = sounding; else delete byFamily.n163;
    }
    // N163の実効チャンネル数(変換設定 N163_CH)。周波数式・波形RAM枠・#EX-N163の宣言の
    // 3か所すべてでこの値を使う(src/convert/options.js n163NumChFor 冒頭コメント)
    const n163NumCh = MML.Convert.n163NumChFor(cmd,
      (byFamily.n163 || []).map(p => Plan.targetInfo(p.type).index));
    let n163FitNotes = [];
    if (regs.n163WaveReg && byFamily.n163) {
      // スロット順(P-W)に並べ直してから渡す(有効ch数の判定が位置依存のため)
      const slots = [];
      for (const p of byFamily.n163) slots[Plan.targetInfo(p.type).index] = p.channel;
      // o.n163ExtraMargin / o.n163ForceHalve: コンパイルで RAM 不足が出たときのやり直し用(N163Fit.retryOnRamError)
      n163FitNotes = MML.Convert.N163Fit.apply(slots, regs.n163WaveReg, cmd, n163NumCh, o.n163ExtraMargin || 0, o.n163ForceHalve || null);
      notes.push(...n163FitNotes);
    }
    const expansions = [];
    for (const t of Object.keys(placed)) {
      const chip = Plan.targetInfo(t).chip;
      if (chip !== '2a03' && expansions.indexOf(chip) < 0) expansions.push(chip);
    }
    const prio = MML.Mml.EXPANSION_PRIORITY || ['dpcm', 'fds', 'vrc7', 'vrc6', 'n163', 'fme7', 'mmc5'];
    expansions.sort((a, b) => prio.indexOf(a) - prio.indexOf(b));
    const letterMap = expansions.length ? MML.Mml.assignExpansionLetters(expansions) : {};

    const waveLen = o.n163WaveLen || N163_WAVE_LEN;
    const periodFnFor = {
      fme7: fme7PeriodRaw, n163: n163FreqRegRaw(waveLen, n163NumCh), pulse: pulsePeriodRaw,
      triangle: triPeriodRaw, vrc6pulse: vrc6PulsePeriodRaw, vrc6saw: vrc6SawPeriodRaw,
      vrc7: vrc7FnumRaw, fds: fdsPeriodRaw, noise: null
    };

    const scoreChannels = [];
    for (const fam of Object.keys(byFamily)) {
      const list = byFamily[fam];
      const chans = list.map(p => p.channel);
      const fn = periodFnFor[fam];
      if (fn) {
        // 音程補正の方針は変換元ごとに決まる([[kss2mml-pitch-detune-correction]]):
        //   'chorus'(既定、KSS/VGM) … 同時発音のコーラスだけD<n>で明示し単独音は理論値へ丸める
        //   'apply' (GBS/HES)       … 二重量子化の補正として常に実測周波数ベースで補正
        if (o.detuneMode === 'apply') {
          for (const c of chans) MML.Convert.applyPitchDetune([{ events: c.events }], fn, { cmd });
        } else {
          MML.Convert.detectChorusDetune(chans, fn, { cmd });
        }
        MML.Convert.assignNoteEnvelope(chans, regs.noteEnvReg);
        // N163出力先だけSA<num>自動選択を有効化(pitch.js n163SaForBase参照)
        if (fam !== 'vrc7') MML.Convert.assignPitchEnvelope(chans, fn, regs.pitchReg, fam === 'n163' ? { saMode: cmd.PITCH_SA } : undefined);
      }
      for (const p of list) {
        const letter = Plan.letterOfTarget(p.type);
        if (!letter) continue;
        const flags = fam === 'vrc7' ? { hasDetune: true, hasNoteEnv: true }
          : fam === 'noise' ? {} : { hasDetune: true, hasPitchMod: true };
        scoreChannels.push(Object.assign({}, p.channel, { letter }, flags));
      }
    }
    MML.Convert.sortChannelsByLetter(scoreChannels);

    return { scoreChannels, expansions, letterMap, n163NumCh, notes, placed, demotions };
  }

  MML.Convert.Borrow = {
    CPU_CLOCK_NTSC,
    N163_WAVE_LEN,
    N163_SQUARE_WAVE,
    fme7PeriodRaw,
    n163FreqRegRaw,
    vrc7FnumRaw,
    pulsePeriodRaw,
    triPeriodRaw,
    vrc6PulsePeriodRaw,
    vrc6SawPeriodRaw,
    fdsPeriodRaw,
    logToLinearTable,
    logToVrc7Table,
    LIN_TABLE,
    VRC7_TABLE,
    VOL_FROM_DB,
    FAMILY_VOL_MAX, // 借用先ファミリの音量レンジ(vgm2mml/spc2mml/assign-preview も同じ表を見る)
    CHIP_VOL_LAW,   // チップごとの音量則(同上)
    volTableFor,
    mappedEnvReg,
    mapConstVolumes,
    envRegFor,
    adaptEvents,
    pitchedToNoise,
    toneWave,
    compose,
  };
})(typeof window !== 'undefined' ? window : globalThis);
