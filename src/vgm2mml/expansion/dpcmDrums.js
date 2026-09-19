/*
 * VGMのサンプルPCM(打楽器) → 打点リスト → @DPCM<n>
 *   MML.Vgm2MmlExpansion.collectDrumHits(sources, frameRate, totalFrames) → hits
 *   MML.Vgm2MmlExpansion.dpcmDrums(sources, frameRate, opt) → { defs, files, events, stats }
 *
 * 考え方(2026-08-29):
 *   ドラムを2A03ノイズchの疑似音程で出すのではなく、実サンプルをDMC(DPCM)へ変換して
 *   本物の音で鳴らす。DPCMチャンネルは実機どおり1本しか無いので、
 *     「複数のPCMチャンネルが同時に鳴っている区間は、その瞬間に鳴っている音を
 *       ミックスした1つの新しいサンプルとして焼き込む」
 *   という方針で単音制約を回避する(ユーザー案)。
 *
 * 2026-09-03: ミックス・重複排除・レート選択・命名は src/convert/drumHits.js
 * (MML.Convert.DrumHits.dpcm)へ移し、HES/SPC/NSF と共有する。ここに残るのは
 * 「VGMのスナップショット列から打点リストを作る」部分だけ。
 *
 * 入力 sources: [{ chip, snapshots, chans:[ch番号...], shape:'pcm'|'adpcmA', samples:{key→Float32Array} }]
 *   snapshots/samples は captureVgmSongAsync の戻り(src/emulator/vgmPlayer.js collectUsedSamples)。
 *   chans は「DPCMへ載せるチャンネル」= ユーザーが割当UIで選んだもの。
 *
 * 出力は HES の @DPCM 抽出(src/hes2mml/expansion/dpcm.js)と同じ {defs, files, events} 形。
 *   events: { start, end, note: 24+clipIndex }(src/convert/drumHits.js dpcmNote)
 *   ★ppmck準拠(2026-09-19): E の音符は @DPCM 番号そのもの(n<番号>)。レートは定義の freq で固定。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Vgm2MmlExpansion = MML.Vgm2MmlExpansion || {};

  /**
   * 選ばれたチャンネルの「打点」を集める。
   * 1打点 = キーオン(seq変化)から、そのチャンネルが鳴り止む/次のキーオンが来るまで。
   * 音量は打点の頭の値で固定する(打点の途中の減衰はサンプル自身が持っているため。
   * opn.js drumChannelOf と同じ理由)。
   * ★このチャンネルはユーザーが明示的にDPCMへ載せた先なので、音程が取れたサンプルも
   *   変換対象にする(DPCMで音律を奏でることもある。方針)。
   * ★サンプル単位の設定(変換する/しない・レート・音量・差し替え)は打点に hash を載せておき、
   *   DrumHits.dpcm 側で反映する(src/convert/drumSamples.js)。
   */
  MML.Vgm2MmlExpansion.collectDrumHits = function (sources, frameRate, totalFrames) {
    const hits = [];
    for (const src of sources) {
      const getCh = (f, ch) => {
        const s = src.snapshots[f];
        if (!s) return null;
        // adpcmB は1本(ch番号は使わない)。sample は {kind:'b', start, end}
        return src.shape === 'adpcmB' ? s.adpcmB : src.shape === 'adpcmA' ? (s.adpcmA && s.adpcmA[ch]) : s[ch];
      };
      for (const ch of src.chans) {
        let prevSeq = null, cur = null;
        for (let f = 0; f < totalFrames; f++) {
          const c = getCh(f, ch);
          const isKeyOn = c && c.seq !== prevSeq && c.seq > 0;
          if (c) prevSeq = c.seq;
          const sounding = !!(c && c.active && c.sample);
          if (cur && (isKeyOn || !sounding)) { cur.endFrame = f; cur = null; }
          if (isKeyOn && sounding) {
            const sampleKey = c.sample.kind + ':' + c.sample.start + ':' + c.sample.end;
            const pcm = src.samples[sampleKey];
            if (pcm && pcm.length && c.rate > 0) {
              cur = { key: c.sample.kind + ':' + c.sample.start, sampleKey, hash: c.sampleHash || null,
                      pcm, rate: c.rate, vol: c.vol || 0, startFrame: f, endFrame: totalFrames,
                      chip: src.chip, ch,
                      // 割当で D(ノイズ)を選んだchのサンプルはパッドになるが DPCM には焼かない(ノイズパッド、2026-09-18)
                      assignTarget: (src.assignTarget === 'noise' || (src.noiseChans && src.noiseChans.indexOf(ch) >= 0)) ? 'noise' : 'dpcm' };
              hits.push(cur);
            }
          }
        }
      }
    }
    hits.sort((a, b) => a.startFrame - b.startFrame);
    return hits;
  };

  /**
   * @param {Array} sources 上記の形
   * @param {number} frameRate
   * @param {object} opt { totalFrames, dmcRate, rateMix, poly, rateIndex, extraHits }(src/convert/drumHits.js dpcm と同じ)
   */
  MML.Vgm2MmlExpansion.dpcmDrums = function (sources, frameRate, opt) {
    opt = opt || {};
    const totalFrames = opt.totalFrames || 0;
    const empty = { defs: [], files: [], events: [], stats: { clips: 0, bytes: 0, segments: 0, dropped: 0 } };
    const extra = opt.extraHits || []; // 合成音ch(FM/PSG等)を打楽器化した打点(main.js synthDrum)
    if ((!sources || !sources.length) && !extra.length) return empty;
    if (!totalFrames || !MML.Convert.DrumHits) return empty;
    const hits = (sources && sources.length ? MML.Vgm2MmlExpansion.collectDrumHits(sources, frameRate, totalFrames) : [])
      .concat(extra);
    return MML.Convert.DrumHits.dpcm(hits, frameRate, Object.assign({ prefix: 'vgm_dpcm' }, opt));
  };
})(window);
