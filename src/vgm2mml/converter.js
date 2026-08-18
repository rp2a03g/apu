/*
 * VGM → MML コンバータ
 * MML.VGM2MML.fromVgm(vgmBytes, durationSeconds, options)
 *   → Promise<{ mml, bpm, chips, expansions, family, ... }>
 *
 * VGMはCPU無しのレジスタ書込みログで、使うチップはヘッダで決まる(src/vgm/vgmHeader.js)。
 * 変換は「チップファミリ」ごとに既存の *2mml へ委譲する(抽出器を複製しない、ROADMAP.md
 * VGM節「やってはいけないこと」):
 *   NES APU(+FDS)      → MML.NSF2MML.convert   (nsf2mml、ネイティブ変換)
 *   GB DMG             → MML.GBS2MML.convertCapture (gbs2mml、2A03/FDS借用)
 *   HuC6280            → MML.HES2MML.convertCapture (hes2mml、N163/2A03ノイズ/DMC借用)
 *   AY8910/SCC/YM2413  → MML.KSS2MML.convertCapture (kss2mml、FME-7/N163/VRC7借用)
 *   SN76489            → 本ファイル(新規: expansion/sn76489.js、FME-7+2A03ノイズ借用)
 * 入力データは captureVgmSongAsync(src/emulator/vgmPlayer.js)がチップファミリごとに
 * 各抽出器の入力形(NES=regSnapshots+writeLog、GB/HES=snapshots、KSS=writeLog、SN=snapshots)
 * で積んだもの。
 *
 * 1つのVGMに複数ファミリが同居する(例: SN76489+YM2612のメガドライブ、AY+SCCはKSSファミリ
 * 内なので同居ではない)場合、MMLに変換できるのは1ファミリだけなので、実装済みファミリの
 * うち最初の1つ(優先: KSS系→SN→NES→GB→HES)を変換し、残りはヘッダコメントに明記して無視する。
 * YM2612等の未実装チップは常に無視(ROADMAP 段階4)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.VGM2MML = {};

  const CPU_CLOCK_NTSC = 1789773; // 借用先(FME-7/2A03)のクロック。src/mml/compiler.jsと同じ値

  // FME-7: freq = CLOCK/(32*period)。kss2mml/converter.jsのfme7PeriodRawと同じ(丸めない)。
  function fme7PeriodRaw(freq) { return CPU_CLOCK_NTSC / (32 * freq); }

  function gd3Field(h, en, ja) {
    const g = h && h.gd3;
    if (!g) return '';
    return g[en] || g[ja] || '';
  }

  /**
   * SN76489(SMS/GG/SG-1000/MDのPSG)ファミリの変換。トーン3本→FME-7(X-Z)、ノイズ→2A03ノイズ(D)。
   */
  function convertSn(data, title, options, ignoredNote) {
    const snapshots = data.sn.snapshots;
    // デュアルチップ(2個目、スナップショット8要素)は変換対象外(FME-7は3chしか無い)。注記だけ残す
    if (snapshots.length && snapshots[0].length >= 8) {
      const n = '2個目のSN76489(デュアルチップ)は変換対象外のため無視しました。';
      ignoredNote = ignoredNote ? ignoredNote + n : n;
    }
    const totalFrames = snapshots.length;
    const frameRate = data.frameRate;
    const clock = data.sn.clock;

    const envReg = new MML.Convert.EnvelopeRegistry();
    const pitchReg = new MML.Convert.PitchEnvelopeRegistry();
    const noteEnvReg = new MML.Convert.NoteEnvelopeRegistry();

    const snResult = MML.Vgm2MmlExpansion.sn76489(snapshots, clock, envReg);
    const hasNoise = snResult.noise.events.some(ev => ev.note !== null);

    // 音程補正: kss2mml(PSG→FME-7)と同じ detectChorusDetune 方針(単独音は12平均律へ丸め、
    // 同時に同音程を鳴らすコーラスだけD<n>)。SMSドライバの音程テーブルも12平均律から
    // 系統的にズレることがあり、applyPitchDetuneで単独音まで追随させると音痴に聞こえる
    // (kss2mml-pitch-detune-correction の経緯と同じ判断)。
    MML.Convert.detectChorusDetune(snResult.tones, fme7PeriodRaw);
    // 高速アルペジオ→EN統合は必ずassignPitchEnvelope(内部でmarkSlurTies)より先(kss2mml参照)
    MML.Convert.assignNoteEnvelope(snResult.tones, noteEnvReg);
    MML.Convert.assignPitchEnvelope(snResult.tones, fme7PeriodRaw, pitchReg);

    const expansions = ['fme7'];
    const letterMap = MML.Mml.assignExpansionLetters(expansions);
    const scoreChannels = snResult.tones.map((ch, i) =>
      Object.assign({}, ch, { letter: letterMap.fme7[i], hasDetune: true, hasPitchMod: true }));
    if (hasNoise) scoreChannels.push(Object.assign({}, snResult.noise, { letter: 'D' }));

    const noteDurations = [];
    for (const ch of scoreChannels) {
      const sounding = ch.events.filter(ev => ev.note !== null);
      for (const ev of sounding) noteDurations.push(ev.end - ev.start);
      noteDurations.push(...MML.Convert.onsetIntervals(sounding.map(ev => ev.start)));
    }
    const bpm = options.bpm
      ? MML.Convert.refineBpm(options.bpm, noteDurations, frameRate)
      : MML.Convert.detectBpm(noteDurations, frameRate);
    // t<n>は整数に丸められるのでfpbも丸め後の値で計算する([[tempo-rounding-drift-future-issue]])
    const fpb = frameRate * 60 / Math.round(bpm);

    const headerComment = [
      `; =========================================================`,
      `; VGM → MML 変換 (SN76489: トーン3ch + ノイズ${hasNoise ? '' : '(未使用)'})`,
      `; 曲名     : ${title || '-'}`,
      `; Tempo    : ${Math.round(bpm)} BPM (${options.bpm ? '指定' : '推定'})`,
      `; 分解能   : 480 TPQN (MIDI準拠)`,
      `; 変換     : Sound Emulation Foundry`,
      `; チャンネル: X-Z=SN76489トーン(FME-7として再生)${hasNoise ? ' D=SN76489ノイズ(2A03ノイズとして近似再生)' : ''}`,
      `; ※ このアプリのMMLプレイヤーはNES音源専用のため、SN76489の矩形波3本は同じ外形の`,
      `;    FME-7(@1=トーン)へ、ノイズは2A03ノイズ(実測シフトレートに最も近い固定周期)へ載せています。`,
      `;    音程は12平均律へ丸め、複数chが同音程を同時に鳴らすコーラスだけD<n>で実測差を残しています。`,
      ...(ignoredNote ? [`; ※ ${ignoredNote}`] : []),
      `; =========================================================`,
      ``
    ].join('\n');

    const directiveLines = [MML.Mml.EX_CHIP_DIRECTIVE.fme7];
    const scoreText = MML.Convert.emitScore(scoreChannels, fpb, {
      totalFrames, tempoBpm: bpm,
      headerLines: [...directiveLines, ...envReg.defLines(), ...pitchReg.defLines(), ...noteEnvReg.defLines()]
    });
    return {
      mml: [headerComment, scoreText].join('\n'),
      bpm: Math.round(bpm),
      chips: ['SN76489'],
      expansions
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

    // 変換可能なファミリ(優先順)。複数同居していれば先頭だけ変換する。
    const families = [];
    if (data.kss) families.push('kss');
    if (data.sn) families.push('sn');
    if (data.nes) families.push('nes');
    if (data.gb) families.push('gb');
    if (data.hes) families.push('hes');
    if (families.length === 0) {
      const names = h.usedChips.map(c => c.name).join(', ') || '-';
      throw new Error(`MML変換に対応した音源がありません(${names})`);
    }
    const family = families[0];
    const ignoredChips = h.usedChips
      .filter(c => {
        if (!c.impl) return true; // 未実装チップは常に無視
        const fam = { ay8910: 'kss', k051649: 'kss', ym2413: 'kss', sn76489: 'sn', nes: 'nes', gb: 'gb', huc6280: 'hes' }[c.id];
        return fam !== family;
      })
      .map(c => c.name);
    const ignoredNote = ignoredChips.length
      ? `このVGMは複数の音源を含みます。${ignoredChips.join(', ')} はMML変換の対象外のため無視しました。`
      : null;

    let result;
    if (family === 'kss') {
      const c = h.chips;
      // kss2mmlのclockはZ80クロック基準(AY/SCCの実チップクロックの2倍)。OPLLは3579545そのもの。
      const clock = c.ay8910 ? c.ay8910.clock * 2 : c.k051649 ? c.k051649.clock * 2 : c.ym2413.clock;
      result = MML.KSS2MML.convertCapture({
        writeLog: data.kss.writeLog, frameRate: data.frameRate, clock,
        hasOpll: !!data.kss.opll, songLabel: label, sourceLabel: 'VGM'
      }, options);
      result.chips = ['PSG'].concat(data.kss.scc ? ['SCC'] : []).concat(data.kss.opll ? ['FMPAC(YM2413)'] : []);
    } else if (family === 'sn') {
      result = convertSn(data, label, options, ignoredNote);
    } else if (family === 'nes') {
      const header = {
        extraChips: data.nes.fds ? MML.NSF.CHIP_FLAGS.FDS : 0,
        songName: label, artist: author, copyright: '', totalSongs: 1
      };
      // $4015を一度も書かないVGMでもチャンネルが有効扱いになるよう既定値を補う
      // (NSFのINIT後initRegsに相当。実際に書かれていればwriteLog側の値が上書きする)
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
    if (ignoredNote && family !== 'sn') {
      // 委譲先のヘッダコメントの直後に「無視した音源」の注記を差し込む
      result.mml = result.mml.replace(/\n(; =+\n)\n/, `\n; ※ ${ignoredNote}\n$1\n`);
    }
    result.family = family;
    result.ignoredChips = ignoredChips;
    return result;
  };
})(window);
