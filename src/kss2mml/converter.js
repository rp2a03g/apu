/*
 * KSS → MML コンバータ (PSG + SCC + FMPAC)
 * MML.KSS2MML.fromKss(kssBytes, songIndex, durationSeconds)
 *   → Promise<{ mml: string, bpm: number, chips: string[], expansions: string[], n163Wave: number[] }>
 *
 * このアプリのMMLコンパイラ/プレイヤーはNES(6502+2A03+NES拡張音源)専用であり、
 * MSXのPSG/SCC/FMPACをネイティブに再生する経路を持たない。しかし偶然にも
 * NES拡張音源のうち FME-7 は AY-3-8910/YM2149 とレジスタ・DSP的に実質同一、
 * VRC7 は OPLL(YM2413) そのものであるため、PSGはFME-7として、FMPACはVRC7として
 * 実際に正しく再生できる。SCCに直接対応するNES拡張音源は無いため、構造が近い
 * N163(波形音源)へ波形/ノートを載せて近似する(音色は完全一致しない)。
 * これにより「MML変換して即このアプリで再生できる」体験を保つ。
 *
 * 出力チャンネル: fme7(3ch, 元PSG) / n163(8ch, 元SCC 5ch+空きch3) / vrc7(6ch, 元FMPAC、搭載時のみ)
 * レターは src/mml/compiler.js の assignExpansionLetters をそのまま使う。実機ppmck準拠で
 * 各チップの文字範囲は他の拡張音源の有無に関わらず完全固定(X-Z=fme7, P-W=n163, G-L=vrc7)
 * であり、E-Gから詰めて再割当てはしない(https://wikiwiki.jp/mck/チャンネル別MML一覧 参照)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.KSS2MML = {};

  MML.KSS2MML.fromKss = async function (kssBytes, songIndex, durationSeconds, options) {
    options = options || {};
    const header = MML.KSS.parseHeader(kssBytes);
    const capture = await MML.Emu.captureKssSongAsync(kssBytes, {
      songIndex: songIndex || 0,
      durationSeconds: Math.min(durationSeconds || 60, 60),
      sampleRate: 44100
    });
    const writeLog = capture.writeLog;
    const totalFrames = writeLog.length;
    const clock = MML.KSS.Z80_CLOCK;
    const frameRate = capture.frameRate;
    const hasOpll = header.device.mode === 'MSX' && header.device.fmpac;

    const expansions = ['fme7', 'n163'].concat(hasOpll ? ['vrc7'] : []);
    const expansionLetterMap = MML.Mml.assignExpansionLetters(expansions);

    const scoreChannels = [];

    // 音量変化をソフトウェアエンベロープとして曲全体で共有登録するレジストリ
    // (nsf2mml/converter.jsと同じ考え方)。
    const envReg = new MML.Convert.EnvelopeRegistry();

    // PSG(3ch) → fme7 (AY-3-8910互換なのでそのまま正しく再生できる)
    const ayResult = MML.Kss2MmlExpansion.ay(writeLog, totalFrames, clock, envReg);
    const fme7Letters = expansionLetterMap.fme7;
    ayResult.channels.forEach((ch, i) => scoreChannels.push(Object.assign({}, ch, { letter: fme7Letters[i] })));

    // SCC(5ch) → n163(8ch固定、余り3chは無音) 波形近似
    const sccResult = MML.Kss2MmlExpansion.scc(writeLog, totalFrames, clock);
    const n163Letters = expansionLetterMap.n163;
    for (let i = 0; i < n163Letters.length; i++) {
      const ch = sccResult.channels[i] || { events: [], hasVolume: true };
      scoreChannels.push(Object.assign({}, ch, { letter: n163Letters[i] }));
    }

    // FMPAC(6ch) → vrc7 (OPLL=YM2413そのものなのでそのまま正しく再生できる)
    if (hasOpll) {
      const opllResult = MML.Kss2MmlExpansion.opll(writeLog, totalFrames);
      const vrc7Letters = expansionLetterMap.vrc7;
      opllResult.channels.forEach((ch, i) => scoreChannels.push(Object.assign({}, ch, { letter: vrc7Letters[i] })));
    }

    // 音長に加え、チャンネル毎の発音開始間隔(IOI)も検出材料にする
    // (ゲートタイムで音符が短く切られてもIOIはグリッドに乗るため頑健)。
    const noteDurations = [];
    for (const ch of scoreChannels) {
      const sounding = ch.events.filter(ev => ev.note !== null);
      for (const ev of sounding) noteDurations.push(ev.end - ev.start);
      noteDurations.push(...MML.Convert.onsetIntervals(sounding.map(ev => ev.start)));
    }
    const bpm = options.bpm
      ? MML.Convert.refineBpm(options.bpm, noteDurations, frameRate)
      : MML.Convert.detectBpm(noteDurations, frameRate);
    const fpb = frameRate * 60 / bpm;

    const headerComment = [
      `; =========================================================`,
      `; KSS → MML 変換 (MSX: PSG + SCC${hasOpll ? ' + FMPAC' : ''})`,
      `; 曲番号   : ${songIndex}`,
      `; Tempo    : ${Math.round(bpm)} BPM (${options.bpm ? '指定' : '推定'})`,
      `; 分解能   : 480 TPQN (MIDI準拠)`,
      `; 変換     : FamiMML Studio`,
      `; チャンネル: A-D=未使用(2A03) X-Z=PSG(FME-7として再生) P-W=SCC(N163として近似再生)`,
      hasOpll ? `;             G-L=FMPAC(VRC7として再生)` : `;`,
      `; ※ このアプリのMMLプレイヤーはNES音源専用のため、MSX音源はレジスタ互換/構造が`,
      `;    近いNES拡張音源(PSG→FME-7, FMPAC→VRC7, SCC→N163)を借りて再生します。`,
      `;    SCCの波形はN163形式(4bit,16点)に変換した近似のため音色は完全一致しません。`,
      `; =========================================================`,
      ``
    ].join('\n');

    const scoreText = MML.Convert.emitScore(scoreChannels, fpb, {
      totalFrames, tempoBpm: bpm, headerLines: envReg.defLines()
    });
    const mml = [headerComment, scoreText].join('\n');

    return {
      mml, bpm: Math.round(bpm),
      chips: ['PSG', 'SCC'].concat(hasOpll ? ['FMPAC'] : []),
      expansions,
      n163Wave: sccResult.n163Wave
    };
  };
})(window);
