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
  function n163FreqRegRaw(waveLen, numCh) {
    return freq => freq * 15 * 65536 * waveLen * numCh / CPU_CLOCK_NTSC;
  }
  function vrc7FnumRaw(freq) {
    for (let block = 0; block <= 7; block++) {
      const fnum = (freq * 524288) / (49716 * Math.pow(2, block));
      if (fnum <= 511) return fnum;
    }
    return 511;
  }
  const pulsePeriodRaw = freq => CPU_CLOCK_NTSC / (16 * freq) - 1;   // 2A03/MMC5パルス
  const triPeriodRaw = freq => CPU_CLOCK_NTSC / (32 * freq) - 1;     // 2A03三角波
  const vrc6PulsePeriodRaw = freq => CPU_CLOCK_NTSC / (16 * freq) - 1;
  const fdsPeriodRaw = freq => (freq * 65536 * 64) / CPU_CLOCK_NTSC; // FDS(gbs2mml/expansion/wave.jsと同じ式)

  // ── 音量の写像 ──────────────────────────────────────────────
  // 対数DAC(dbPerStep/段)の4bit音量値を線形4bit(N163/2A03/VRC6)へ換算する表
  function logToLinearTable(dbPerStep) {
    const t = new Array(16);
    for (let v = 0; v < 16; v++) t[v] = v === 0 ? 0 : Math.max(1, Math.round(15 * Math.pow(10, -dbPerStep * (15 - v) / 20)));
    return t;
  }
  // 4bit対数音量 → VRC7の減衰値(v0=最大、3dB/段)
  function logToVrc7Table(dbPerStep) {
    const t = new Array(16);
    for (let v = 0; v < 16; v++) t[v] = Math.max(0, Math.min(15, Math.round((15 - v) * dbPerStep / 3)));
    return t;
  }
  const LIN_TABLE = { ay8910: logToLinearTable(1.5), sn76489: logToLinearTable(2) };
  const VRC7_TABLE = { ay8910: logToVrc7Table(1.5), sn76489: logToVrc7Table(2) };

  // 音量の減衰量(dB)→借用先の音量値。VRC7は「v0が最大・v15が最小」(このコンパイラ/ppmckのVRC7は
  // レジスタの減衰値をそのまま v に取る)、FME-7は v15 最大の3dB/段、線形音源は振幅比。
  const VOL_FROM_DB = {
    vrc7: att => Math.max(0, Math.min(15, Math.round(att / 3))),
    fme7: att => Math.max(0, Math.min(15, 15 - Math.round(att / 3))),
    linear: att => (att >= 60 ? 0 : Math.max(1, Math.min(15, Math.round(15 * Math.pow(10, -att / 20)))))
  };

  // envReg.assign(volSeq) を写像テーブル経由にするプロキシ(抽出器はassignしか使わない)
  function mappedEnvReg(envReg, table) {
    const top = table.length - 1;
    return { assign: seq => envReg.assign(seq.map(v => table[Math.max(0, Math.min(top, v))])) };
  }
  // 抽出器が定数音量として残した ev.volume も同じ表で写像する
  function mapConstVolumes(events, table) {
    const top = table.length - 1;
    for (const ev of events) if (ev.volume !== undefined) ev.volume = table[Math.max(0, Math.min(top, ev.volume))];
  }

  // 借用先ファミリの音量レンジ(FDSとVRC6のこぎり波だけ本家ppmck同様0-63、他は0-15)
  const FAMILY_VOL_MAX = { pulse: 15, triangle: 15, noise: 15, n163: 15, fme7: 15, vrc7: 15, vrc6pulse: 15, vrc6saw: 63, fds: 63 };

  // 変換元の音量値 v(0..srcMax)の減衰量[dB]。
  //   s.linear      … 抽出値が線形振幅(GB/HuC6280/2A03系)
  //   nativeFamily=vrc7 / chip=ym2413 … 値そのものが減衰値(v0が最大、3dB/段)
  //   それ以外      … 対数DAC(既定1.5dB/段。SN76489は2dB、FME-7は3dB)
  function attOf(s, v, srcMax) {
    if (s.linear) return v <= 0 ? 96 : -20 * Math.log10(v / srcMax);
    if (s.nativeFamily === 'vrc7' || s.chip === 'ym2413') return v * 3;
    const step = s.logStepDb || (s.chip === 'sn76489' ? 2 : 1.5);
    return (srcMax - v) * step;
  }
  // 変換元の音量値 → 借用先の音量値の対応表(0..srcMax)。変換不要なら null。
  // これ1本で「対数→線形」「線形→対数」「レンジ違い(0-15↔0-63)」を全部まかなう
  // (VGMのLIN_TABLE/VRC7_TABLEと同じ値になることは logToLinearTable/logToVrc7Table と一致確認済み)。
  function volTableFor(s, fam) {
    const srcMax = s.volMax || 15;
    const dstMax = FAMILY_VOL_MAX[fam] !== undefined ? FAMILY_VOL_MAX[fam] : 15;
    if (fam === s.nativeFamily && srcMax === dstMax) return null;
    if (fam === 'noise' || fam === 'triangle') return null; // ノイズは音量そのまま、三角波は音量が無い
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

  /**
   * ソースチャンネルのイベントを借用先ファミリの語彙へ整形する(破壊的。呼び出し側でコピー済み)。
   * s.nativeFamily と同じファミリへ載せる場合は「元のまま正しく鳴る」ので何もしない
   * (AY→FME-7、OPLL→VRC7、SCC/HuC6280→N163、GBパルス→2A03パルス、GB波形→FDS 等)。
   * tone: 借用先ごとの音色指定(channelPlan.js の toneOptionsFor)。
   *   VRC7 … 'auto'(元の音色そのまま)/'0'(自作音色へ変換)/'1'-'15'(プリセット)
   *   duty … '0'-'3'(2A03/MMC5)、'0'-'7'(VRC6)
   *   wave … 'copy'(元の波形をそのまま)/'pulse50' 等(N163/FDS)
   */
  function adaptEvents(ch, s, fam, ctx) {
    const events = ch.events;
    const tone = (ctx && ctx.tone) || undefined;
    const n163WaveReg = ctx && ctx.n163WaveReg;
    const vrc7ToneReg = ctx && ctx.vrc7ToneReg;
    const isAy = s.chip === 'ay8910';
    const nativeVrc7 = s.nativeFamily === 'vrc7' && fam === 'vrc7' && (tone === 'auto' || tone == null);
    if (fam === 'noise') return; // ノイズはノイズにしか載せないので整形不要
    if (nativeVrc7 || (fam === s.nativeFamily && fam !== 'vrc7' && (!tone || tone === 'copy'))) return;

    // AYのミキサー: ノイズ単独(mode 2)は矩形波系の借用先では鳴らせないので休符に、
    // トーン+ノイズ(mode 3)はトーンだけ残す。FME-7以外ではN<n>も出さない
    if (isAy && fam !== 'fme7') {
      for (const ev of events) { if (ev.instrument === 2) ev.note = null; delete ev.fme7Noise; }
      ch.hasFme7Noise = false;
    }

    // 音量: 借用先の尺度へ(@vテーブルは envRegFor() 側で同じ表に写像済み)。
    // attDb(減衰dBを直接持つVGMのOPN/ADPCM等)はテーブルを介さず直接換算する。
    const hasAttDb = events.some(ev => ev.attDb !== undefined);
    if (hasAttDb) {
      if (fam !== 'triangle') {
        const conv = fam === 'vrc7' ? VOL_FROM_DB.vrc7 : fam === 'fme7' ? VOL_FROM_DB.fme7 : VOL_FROM_DB.linear;
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
    if (fam === 'vrc7' && tone === '0' && s.kind === 'fm4' && vrc7ToneReg) {
      // OPN 4op → VRC7 2op 自作音色(opnToOpllBytes)。音色ごとに @OP<n> を登録し OP<n>+@0 で切り替える
      for (const ev of events) {
        delete ev.n163Wave; delete ev.rawLength;
        if (ev.note === null) { delete ev.vrc7Tone; delete ev.opnPatch; continue; }
        const bytes = opnToOpllBytes(ev.opnPatch);
        ev.instrument = 0;
        ev.vrc7Tone = bytes ? vrc7ToneReg.assign(bytes) : undefined;
        delete ev.opnPatch;
      }
      ch.hasVrc7Tone = true; ch.hasInstrument = true;
    } else if (fam === 'vrc7') {
      // VRC7プリセット音色。元の音色/カスタム音色は捨てる
      const inst = Math.max(1, Math.min(15, parseInt(tone, 10) || 1));
      for (const ev of events) { if (ev.note !== null) ev.instrument = inst; clearWave(ev); delete ev.rawLength; }
      ch.hasVrc7Tone = false; ch.hasInstrument = true;
    } else if (fam === 'n163') {
      // 元が波形を持つ(SCC/HuC6280/ADPCM)ならそれを、無ければ矩形波を @N に登録して音色にする
      const forced = toneWave(tone);
      for (const ev of events) {
        if (ev.note === null) { clearWave(ev); continue; }
        const wave = forced || ((ev.n163Wave && ev.n163Wave.length) ? ev.n163Wave : N163_SQUARE_WAVE);
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
   * @returns {{scoreChannels, expansions, letterMap, n163NumCh, notes, placed}}
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

    // ── 抽出(ソースチップごと。同じチップ内でも借用先ファミリが違えば音量写像が違うので、
    //    ファミリごとに抽出し直して該当chだけ採る。vgm2mmlのextractGroupと同じ考え方) ──
    const extracted = {}; // sourceId → channel
    const groups = {};    // chip → Set(family)
    // ★E(DPCM)へ載せたchはここでは扱わない: 合成音chの打楽器化は分離レンダリングした打点
    //   (options.drumHits、main.js synthDrum)が各 *2mml のE経路へ直接入る。旋律として
    //   借用先へ載せると二重になるので、抽出も配置も外す
    const isDpcm = t => familyOf(t) === 'dpcm';
    for (const s of src) {
      const t = plan[s.id] || 'skip';
      if (t === 'skip' || isDpcm(t)) continue;
      (groups[s.chip] = groups[s.chip] || new Set()).add(familyOf(t));
    }
    for (const chip of Object.keys(groups)) {
      for (const fam of groups[chip]) {
        const items = src.filter(s => s.chip === chip && familyOf(plan[s.id] || 'skip') === fam);
        if (!items.length) continue;
        const res = o.extract(chip, fam, envRegFor(regs.envReg, items[0], fam));
        if (!res) continue;
        for (const s of items) if (res[s.ch]) extracted[s.id] = res[s.ch];
      }
    }

    // ── 借用先ごとにイベントを整形して台帳へ ──
    const placed = {}; // targetType → { source, channel }
    for (const s of src) {
      const t = plan[s.id] || 'skip';
      if (t === 'skip' || isDpcm(t) || !extracted[s.id]) continue;
      if (placed[t]) {
        notes.push(`${s.label} は ${Plan.targetLabel(t)} が既に ${placed[t].source.label} に使われているため変換対象外です。`);
        continue;
      }
      const fam = familyOf(t);
      // 種別と借用先の相性(UI外から不正な組合せが来た時の防御)
      if ((s.kind === 'noise') !== (fam === 'noise')) {
        notes.push(`${s.label} → ${Plan.targetLabel(t)} は種別が合わないため変換対象外です。`);
        continue;
      }
      const ch = Object.assign({}, extracted[s.id], { events: extracted[s.id].events.map(ev => Object.assign({}, ev)) });
      adaptEvents(ch, s, fam, { tone: toneOf(s.id), n163WaveReg: regs.n163WaveReg, vrc7ToneReg: regs.vrc7ToneReg });
      placed[t] = { source: s, channel: ch };
    }

    // ── 借用先ファミリごとの後処理(音程補正・EN・EP)と文字割当 ──
    const byFamily = {};
    for (const t of Object.keys(placed)) {
      const f = familyOf(t);
      (byFamily[f] = byFamily[f] || []).push(Object.assign({ type: t }, placed[t]));
    }
    const expansions = [];
    for (const t of Object.keys(placed)) {
      const chip = Plan.targetInfo(t).chip;
      if (chip !== '2a03' && expansions.indexOf(chip) < 0) expansions.push(chip);
    }
    const prio = MML.Mml.EXPANSION_PRIORITY || ['dpcm', 'fds', 'vrc7', 'vrc6', 'n163', 'fme7', 'mmc5'];
    expansions.sort((a, b) => prio.indexOf(a) - prio.indexOf(b));
    const letterMap = expansions.length ? MML.Mml.assignExpansionLetters(expansions) : {};

    // N163のnumChはcompiler.js側の自動検出(音符を持つ最上位レター位置+1)と一致させる
    let n163NumCh = 1;
    for (const p of (byFamily.n163 || [])) {
      if (p.channel.events.some(ev => ev.note !== null)) n163NumCh = Math.max(n163NumCh, Plan.targetInfo(p.type).index + 1);
    }
    const waveLen = o.n163WaveLen || N163_WAVE_LEN;
    const periodFnFor = {
      fme7: fme7PeriodRaw, n163: n163FreqRegRaw(waveLen, n163NumCh), pulse: pulsePeriodRaw,
      triangle: triPeriodRaw, vrc6pulse: vrc6PulsePeriodRaw, vrc6saw: vrc6PulsePeriodRaw,
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
    // N163: 途中の空きレターも空チャンネルとして出す(numCh検出をcompiler.jsと揃えるため)
    if (letterMap.n163) {
      const have = {};
      for (const ch of scoreChannels) have[ch.letter] = true;
      for (let i = 0; i < n163NumCh; i++) {
        if (!have[letterMap.n163[i]]) scoreChannels.push({ letter: letterMap.n163[i], events: [], hasVolume: true, hasInstrument: true });
      }
    }
    scoreChannels.sort((a, b) => a.letter.localeCompare(b.letter));

    return { scoreChannels, expansions, letterMap, n163NumCh, notes, placed };
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
    fdsPeriodRaw,
    logToLinearTable,
    logToVrc7Table,
    LIN_TABLE,
    VRC7_TABLE,
    VOL_FROM_DB,
    volTableFor,
    mappedEnvReg,
    mapConstVolumes,
    envRegFor,
    adaptEvents,
    toneWave,
    compose,
  };
})(typeof window !== 'undefined' ? window : globalThis);
