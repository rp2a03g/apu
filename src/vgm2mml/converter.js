/*
 * VGM → MML コンバータ
 * MML.VGM2MML.fromVgm(vgmBytes, durationSeconds, options)
 *   → Promise<{ mml, bpm, chips, expansions, family, assignments, ... }>
 *
 * VGMはCPU無しのレジスタ書込みログで、使うチップはヘッダで決まる(src/vgm/vgmHeader.js)。
 * 抽出器は既存の *2mml のものを流用する(抽出器を複製しない、ROADMAP.md VGM節):
 *   NES APU(+FDS)      → MML.NSF2MML.convert         (nsf2mml、ネイティブ変換。丸ごと委譲)
 *   GB DMG             → MML.GBS2MML.convertCapture   (gbs2mml、2A03/FDS借用。丸ごと委譲)
 *   HuC6280            → MML.HES2MML.convertCapture   (hes2mml、N163/2A03ノイズ借用。丸ごと委譲)
 *   AY8910/SCC/YM2413/SN76489(複数チップ・デュアルチップの同居あり)
 *                      → 本ファイルの composePsgLike: kss2mml/expansion/{ay,scc,opll}.js と
 *                        vgm2mml/expansion/sn76489.js の抽出器を直接呼び、**構成に応じて借用先を
 *                        自動割当**してから1つのスコアに合成する(下記)。
 *
 * ── 借用先の自動割当(構成駆動) ──────────────────────────────────────────
 * 「AY8910×1+SN76489×2(Exed Exes)なら AY→FME-7、SN×2→N163×6ch」のように、ファイルごとの
 * 個別対応ではなく、音源の種類と本数から機械的に決める:
 *   - ネイティブ相当のNES音源がある種類は固定: AY(1個目)→FME-7、YM2413→VRC7、SCC→N163。
 *   - それ以外の矩形波チップ(SN76489)は「矩形波を出せる借用先」を優先順に、チップ単位で
 *     まとまって収まる所へ入れる: FME-7(3ch、空きがあれば) → N163(8chからSCC使用分を引いた
 *     残り。矩形波は@N波形として登録) → 収まらなければ変換対象外(注記)。
 *   - ノイズは 2A03ノイズ(D)が1本だけ。最初に見つかったノイズchをDへ、残りは対象外(注記)。
 *   音量は借用先に合わせて写像する: FME-7(対数DAC)には元の4bit値をそのまま、N163(線形)には
 *   元チップの減衰カーブ(SN=2dB/step)を線形の0-15へ換算した値を入れる。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.VGM2MML = {};

  const CPU_CLOCK_NTSC = 1789773; // 借用先(FME-7/N163/2A03)のクロック。src/mml/compiler.jsと同じ値
  const N163_WAVE_LEN = 32;       // N163へ載せる矩形波の長さ(SCC近似と同じ32点で統一)
  // N163用の矩形波(50%デューティ、4bit)。@N<n>として登録し、矩形波チップの音色に使う
  const N163_SQUARE_WAVE = Array.from({ length: N163_WAVE_LEN }, (_, i) => (i < N163_WAVE_LEN / 2 ? 15 : 0));

  // FME-7: freq = CLOCK/(32*period)。kss2mml/converter.jsのfme7PeriodRawと同じ(丸めない)。
  function fme7PeriodRaw(freq) { return CPU_CLOCK_NTSC / (32 * freq); }
  // N163: freqReg = freq*15*65536*waveLen*numCh/CLOCK(kss2mml/converter.jsのn163FreqRegRawと同じ)。
  function n163FreqRegRaw(waveLen, numCh) { return freq => freq * 15 * 65536 * waveLen * numCh / CPU_CLOCK_NTSC; }
  // VRC7: kss2mml/converter.jsのvrc7FnumRawと同じ
  function vrc7FnumRaw(freq) {
    for (let block = 0; block <= 7; block++) {
      const fnum = (freq * 524288) / (49716 * Math.pow(2, block));
      if (fnum <= 511) return fnum;
    }
    return 511;
  }

  // 対数DAC(dbPerStep/段)の4bit音量値を線形4bit(N163)へ換算する表
  function logToLinearTable(dbPerStep) {
    const t = new Array(16);
    for (let v = 0; v < 16; v++) t[v] = v === 0 ? 0 : Math.max(1, Math.round(15 * Math.pow(10, -dbPerStep * (15 - v) / 20)));
    return t;
  }
  // envReg.assign(volSeq) を写像テーブル経由にするプロキシ(抽出器はassignしか使わない)
  function mappedEnvReg(envReg, table) {
    return { assign: seq => envReg.assign(seq.map(v => table[Math.max(0, Math.min(15, v))])) };
  }
  // 抽出器が定数音量として残した ev.volume も同じ表で写像する
  function mapConstVolumes(events, table) {
    for (const ev of events) if (ev.volume !== undefined) ev.volume = table[Math.max(0, Math.min(15, ev.volume))];
  }

  function gd3Field(h, en, ja) {
    const g = h && h.gd3;
    if (!g) return '';
    return g[en] || g[ja] || '';
  }

  // ---------------------------------------------------------------------------
  // PSG系(AY/SCC/OPLL/SN76489)の合成変換
  // ---------------------------------------------------------------------------
  function composePsgLike(data, h, label, options, ignoredNote) {
    const frameRate = data.frameRate;
    const totalFrames = data.totalFrames;
    const c = h.chips;

    const envReg = new MML.Convert.EnvelopeRegistry();
    const pitchReg = new MML.Convert.PitchEnvelopeRegistry();
    const noteEnvReg = new MML.Convert.NoteEnvelopeRegistry();
    const n163WaveReg = new MML.Convert.WaveRegistry('@N', v => [0, ...v]);
    const vrc7ToneReg = new MML.Convert.WaveRegistry('@OP');

    // ── 借用先のスロット台帳 ──
    const slots = {
      fme7: { cap: 3, used: [] },   // used: {label, channel}
      n163: { cap: 8, used: [] },
      vrc7: { cap: 6, used: [] },
      noise: { cap: 1, used: [] }   // 2A03ノイズ(D)
    };
    const notes = ignoredNote ? [ignoredNote] : [];
    const assignments = []; // 表示/コメント用: "AY8910 → FME-7" 等
    function free(target) { return slots[target].cap - slots[target].used.length; }
    function place(target, label, channels) {
      if (channels.length > free(target)) return false;
      for (const ch of channels) slots[target].used.push({ label, channel: ch });
      return true;
    }

    // ── 抽出(借用先が固定のもの) ──
    const kssClock = c.ay8910 ? c.ay8910.clock * 2 : c.k051649 ? c.k051649.clock * 2 : (c.ym2413 ? c.ym2413.clock : 3579545);
    let sccResult = null, hasScc = false;
    if (data.kss && data.kss.scc) {
      sccResult = MML.Kss2MmlExpansion.scc(data.kss.writeLog, totalFrames, kssClock, n163WaveReg, envReg);
      hasScc = sccResult.channels.some(ch => ch.events.some(ev => ev.note !== null));
    }
    // 1) 固定割当: SCC→N163(実際に使っている時だけ、5ch)、YM2413→VRC7、AY(1個目)→FME-7
    if (hasScc) { place('n163', 'SCC', sccResult.channels); assignments.push('SCC → N163'); }
    let opllResult = null;
    if (data.kss && data.kss.opll) {
      opllResult = MML.Kss2MmlExpansion.opll(data.kss.writeLog, totalFrames, vrc7ToneReg);
      place('vrc7', 'YM2413', opllResult.channels); assignments.push('YM2413 → VRC7');
    }
    if (data.kss && data.kss.ay) {
      const ayResult = MML.Kss2MmlExpansion.ay(data.kss.writeLog, totalFrames, kssClock, envReg);
      if (place('fme7', 'AY8910', ayResult.channels)) assignments.push('AY8910 → FME-7');
      else notes.push('AY8910 は FME-7 の空きが無いため変換対象外です。');
      // AY2個目のwriteLogは分離していない(vgmPlayer.js capture参照)ため変換対象外
      if (c.ay8910 && c.ay8910.dual) notes.push('2個目のAY8910(デュアルチップ)は変換対象外のため無視しました。');
    }

    // 2) 矩形波チップ(SN76489、デュアルなら2個): FME-7の空き → N163 の順でチップ単位に収める。
    //    借用先ごとに音量写像が違うので、先に借用先を決めてから抽出する。
    if (data.sn) {
      const nChips = data.sn.snapshots.length && data.sn.snapshots[0].length >= 8 ? 2 : 1;
      const SQUARE_TARGETS = ['fme7', 'n163'];
      for (let i = 0; i < nChips; i++) {
        const chipLabel = nChips > 1 ? `SN76489#${i + 1}` : 'SN76489';
        let target = null;
        for (const t of SQUARE_TARGETS) { if (free(t) >= 3) { target = t; break; } }
        if (!target) { notes.push(`${chipLabel} は借用先(FME-7/N163)の空きが無いため変換対象外です。`); continue; }
        const table = logToLinearTable(2); // SN76489の減衰は2dB/step
        const reg = target === 'n163' ? mappedEnvReg(envReg, table) : envReg;
        const r = MML.Vgm2MmlExpansion.sn76489(data.sn.snapshots, data.sn.clock, reg, i);
        if (target === 'n163') {
          for (const ch of r.tones) {
            mapConstVolumes(ch.events, table);
            for (const ev of ch.events) if (ev.note !== null) { ev.instrument = n163WaveReg.assign(N163_SQUARE_WAVE); ev.rawLength = N163_WAVE_LEN; }
            ch.hasFme7Noise = false;
          }
        }
        place(target, chipLabel, r.tones);
        assignments.push(`${chipLabel} → ${target === 'fme7' ? 'FME-7' : 'N163(矩形波)'}`);
        // ノイズ: 最初の1本だけ2A03ノイズ(D)へ
        if (r.noise.events.some(ev => ev.note !== null)) {
          if (place('noise', chipLabel + ' noise', [r.noise])) assignments.push(`${chipLabel} noise → 2A03 noise(D)`);
          else notes.push(`${chipLabel} のノイズは2A03ノイズ(D)が使用済みのため変換対象外です。`);
        }
      }
    }

    // ── 借用先ごとの後処理(音程補正・EN・EP)とレター割当 ──
    const expansions = [];
    if (slots.fme7.used.length) expansions.push('fme7');
    if (slots.n163.used.length) expansions.push('n163');
    if (slots.vrc7.used.length) expansions.push('vrc7');
    // ppmck固定優先順(src/mml/compiler.js EXPANSION_PRIORITY)に並べ替える
    const prio = MML.Mml.EXPANSION_PRIORITY || ['fds', 'vrc7', 'vrc6', 'n163', 'fme7', 'mmc5'];
    expansions.sort((a, b) => prio.indexOf(a) - prio.indexOf(b));
    const letterMap = expansions.length ? MML.Mml.assignExpansionLetters(expansions) : {};
    const scoreChannels = [];

    if (slots.fme7.used.length) {
      const chans = slots.fme7.used.map(u => u.channel);
      // 音程補正: kss2mml(PSG→FME-7)と同じ detectChorusDetune 方針(単独音は12平均律へ丸め、
      // 同時に同音程を鳴らすコーラスだけD<n>)。EN→EPの順序はkss2mml/converter.js参照。
      MML.Convert.detectChorusDetune(chans, fme7PeriodRaw);
      MML.Convert.assignNoteEnvelope(chans, noteEnvReg);
      MML.Convert.assignPitchEnvelope(chans, fme7PeriodRaw, pitchReg);
      chans.forEach((ch, i) => scoreChannels.push(Object.assign({}, ch, { letter: letterMap.fme7[i], hasDetune: true, hasPitchMod: true })));
    }
    if (slots.n163.used.length) {
      const chans = slots.n163.used.map(u => u.channel);
      // numChはcompiler.js側の自動検出(音符を持つ最上位レター位置+1)と一致させる(kss2mml参照)
      let numCh = 0;
      chans.forEach((ch, i) => { if (ch.events.some(ev => ev.note !== null)) numCh = i + 1; });
      numCh = Math.max(1, numCh);
      const fn = n163FreqRegRaw(N163_WAVE_LEN, numCh);
      MML.Convert.detectChorusDetune(chans, fn);
      MML.Convert.assignNoteEnvelope(chans, noteEnvReg);
      MML.Convert.assignPitchEnvelope(chans, fn, pitchReg);
      const letters = letterMap.n163 || [];
      for (let i = 0; i < letters.length; i++) {
        const ch = chans[i] || { events: [], hasVolume: true, hasInstrument: true };
        scoreChannels.push(Object.assign({}, ch, { letter: letters[i], hasDetune: true, hasPitchMod: true }));
      }
    }
    if (slots.vrc7.used.length) {
      const chans = slots.vrc7.used.map(u => u.channel);
      MML.Convert.detectChorusDetune(chans, vrc7FnumRaw);
      MML.Convert.assignNoteEnvelope(chans, noteEnvReg);
      chans.forEach((ch, i) => scoreChannels.push(Object.assign({}, ch, { letter: letterMap.vrc7[i], hasDetune: true, hasNoteEnv: true })));
    }
    if (slots.noise.used.length) {
      scoreChannels.push(Object.assign({}, slots.noise.used[0].channel, { letter: 'D' }));
    }

    // ── テンポ・出力 ──
    const noteDurations = [];
    for (const ch of scoreChannels) {
      const sounding = ch.events.filter(ev => ev.note !== null);
      for (const ev of sounding) noteDurations.push(ev.end - ev.start);
      noteDurations.push(...MML.Convert.onsetIntervals(sounding.map(ev => ev.start)));
    }
    const bpm = options.bpm
      ? MML.Convert.refineBpm(options.bpm, noteDurations, frameRate)
      : MML.Convert.detectBpm(noteDurations, frameRate);
    const fpb = frameRate * 60 / Math.round(bpm); // t<n>整数丸めと揃える([[tempo-rounding-drift-future-issue]])

    const uniq = arr => arr.filter((v, i, a) => a.indexOf(v) === i);
    const chipList = h.usedChips.map(ch => ch.name + (ch.dual ? ' x2' : '')).join(', ');
    const letterDesc = [];
    if (slots.fme7.used.length) letterDesc.push(`${(letterMap.fme7 || []).slice(0, slots.fme7.used.length).join('')}=${uniq(slots.fme7.used.map(u => u.label)).join('/')}(FME-7として再生)`);
    if (slots.n163.used.length) letterDesc.push(`${(letterMap.n163 || []).slice(0, slots.n163.used.length).join('')}=${uniq(slots.n163.used.map(u => u.label)).join('/')}(N163として${hasScc ? '近似' : '矩形波で'}再生)`);
    if (slots.vrc7.used.length) letterDesc.push(`${(letterMap.vrc7 || []).join('')}=YM2413(VRC7として再生)`);
    if (slots.noise.used.length) letterDesc.push(`D=${slots.noise.used[0].label}(2A03ノイズとして近似再生)`);

    const headerComment = [
      `; =========================================================`,
      `; VGM → MML 変換 (${chipList})`,
      `; 曲名     : ${label || '-'}`,
      `; Tempo    : ${Math.round(bpm)} BPM (${options.bpm ? '指定' : '推定'})`,
      `; 分解能   : 480 TPQN (MIDI準拠)`,
      `; 変換     : Sound Emulation Foundry`,
      `; チャンネル: ${letterDesc.join(' ')}`,
      `; 借用先の割当(構成から自動): ${assignments.join(', ') || '-'}`,
      `; ※ このアプリのMMLプレイヤーはNES音源専用のため、AY8910→FME-7(互換)、YM2413→VRC7(同一)、`,
      `;    SCC→N163(波形近似)、その他の矩形波チップ(SN76489等)はFME-7の空き→N163(矩形波@N)の順に、`,
      `;    ノイズは2A03ノイズ(D)へ載せています。N163へ載せた音量は対数DAC→線形へ換算した値です。`,
      ...notes.map(n => `; ※ ${n}`),
      `; =========================================================`,
      ``
    ].join('\n');

    const directiveLines = expansions.map(chip => chip === 'n163'
      ? `${MML.Mml.EX_CHIP_DIRECTIVE[chip]} ${(letterMap.n163 || []).length}`
      : MML.Mml.EX_CHIP_DIRECTIVE[chip]);
    const scoreText = MML.Convert.emitScore(scoreChannels, fpb, {
      totalFrames, tempoBpm: bpm,
      headerLines: [
        ...directiveLines, ...envReg.defLines(), ...pitchReg.defLines(), ...noteEnvReg.defLines(),
        ...(slots.n163.used.length ? n163WaveReg.defLines() : []),
        ...(slots.vrc7.used.length ? vrc7ToneReg.defLines() : [])
      ]
    });
    return {
      mml: [headerComment, scoreText].join('\n'),
      bpm: Math.round(bpm),
      chips: h.usedChips.filter(ch => ['ay8910', 'k051649', 'ym2413', 'sn76489'].includes(ch.id)).map(ch => ch.name + (ch.dual ? ' x2' : '')),
      expansions,
      assignments,
      n163Wave: hasScc && sccResult ? sccResult.n163Wave : (slots.n163.used.length ? N163_SQUARE_WAVE : null)
    };
  }

  /**
   * @param {Uint8Array} vgmBytes - 解凍済みVGM
   * @param {number} durationSeconds
   * @param {object} [options] - { bpm }
   */
  MML.VGM2MML.fromVgm = async function (vgmBytes, durationSeconds, options) {
    options = options || {};
    const data = await MML.Emu.captureVgmSongAsync(vgmBytes, { durationSeconds: durationSeconds || 60 });
    const h = data.header;
    const title = gd3Field(h, 'trackEn', 'trackJa');
    const game = gd3Field(h, 'gameEn', 'gameJa');
    const author = gd3Field(h, 'authorEn', 'authorJa');
    const label = [game, title].filter(Boolean).join(' - ') || 'VGM';

    // 変換ファミリ: PSG系(AY/SCC/OPLL/SN、同居可) / NES / GB / HES。複数同居していれば先頭だけ。
    const families = [];
    if (data.kss || data.sn) families.push('psg');
    if (data.nes) families.push('nes');
    if (data.gb) families.push('gb');
    if (data.hes) families.push('hes');
    if (families.length === 0) {
      const names = h.usedChips.map(ch => ch.name).join(', ') || '-';
      throw new Error(`MML変換に対応した音源がありません(${names})`);
    }
    const family = families[0];
    const famOf = { ay8910: 'psg', k051649: 'psg', ym2413: 'psg', sn76489: 'psg', nes: 'nes', gb: 'gb', huc6280: 'hes' };
    const ignoredChips = h.usedChips.filter(ch => !ch.impl || famOf[ch.id] !== family).map(ch => ch.name);
    const ignoredNote = ignoredChips.length
      ? `このVGMは複数の音源を含みます。${ignoredChips.join(', ')} はMML変換の対象外のため無視しました。`
      : null;

    let result;
    if (family === 'psg') {
      result = composePsgLike(data, h, label, options, ignoredNote);
    } else if (family === 'nes') {
      const header = {
        extraChips: data.nes.fds ? MML.NSF.CHIP_FLAGS.FDS : 0,
        songName: label, artist: author, copyright: '', totalSongs: 1
      };
      // $4015を一度も書かないVGMでもチャンネルが有効扱いになるよう既定値を補う
      const initRegs = { 0x4015: 0x0F };
      result = MML.NSF2MML.convert(data.nes.writeLog, null, header, 0, initRegs, null, options);
      result.chips = ['2A03'].concat(data.nes.fds ? ['FDS'] : []);
    } else if (family === 'gb') {
      result = MML.GBS2MML.convertCapture({
        snapshots: data.gb.snapshots, frameRate: data.frameRate, songLabel: label, sourceLabel: 'VGM'
      }, options);
    } else if (family === 'hes') {
      result = MML.HES2MML.convertCapture({
        snapshots: data.hes.snapshots, dpcmTrace: [], controlTrace: [],
        frameRate: data.frameRate, trackLabel: label, sourceLabel: 'VGM'
      }, options);
    }
    if (ignoredNote && family !== 'psg') {
      // 委譲先のヘッダコメントの直後に「無視した音源」の注記を差し込む
      result.mml = result.mml.replace(/\n(; =+\n)\n/, `\n; ※ ${ignoredNote}\n$1\n`);
    }
    result.family = family;
    result.ignoredChips = ignoredChips;
    return result;
  };
})(window);
