/*
 * HES PSG 波形ch(0-5) → MML共通イベント形式 抽出(N163への借用を前提)
 * MML.Hes2MmlExpansion.wave(snapshots, waveReg, envReg) → { channels: [ch0..ch5], n163Wave }
 *
 * PC EngineのPSGは6ch全てが同種の32サンプル5bit波形音源で、N163(最大8ch、可変長波形)への
 * 借用が最も自然(DESIGN.md §5)。kss2mml/expansion/scc.js(32サンプル波形チップ→N163)と
 * 同じ設計を踏襲する。5bit(0-31)→N163の4bit(0-31を0-15へ、単純に1bit右シフト)で
 * ビット深度のみ落とす(情報量を最小限の劣化で移す)。
 *
 * PSGには専用アタックレジスタが無い(on/off・音量書換えだけの素朴な発振器)ため、
 * 打ち直し(ロール奏法)の検出はsrc/convert/retrigger.jsの共通ヒューリスティックに委ねる
 * (nsf2mml/expansion/n163.jsと同じ2パス構成: パス1でピッチ/波形が同じ区間をまとめ、
 * パス2でsplitRetriggersにより音量の跳ね上がりを打ち直しとして分割する)。
 *
 * ch4/5はノイズモード(noiseOn)の間、この波形chとしては「休符」として扱う
 * (ノイズ側の抽出はhes2mml/expansion/noise.js が別途担当し、2A03ノイズchへ借用する)。
 * DDAモード(直接D/A、音声ストリーミング用)は@DPCM(hes2mml/expansion/dpcm.js)が担当する。
 *
 * ★巡回シフト(rotation)の正規化について: PSGの波形バッファは「読み出し位相」と
 * 「$0806書込み位相」が同一のカウンタを共有する実機仕様を持つ(ユーザーとの調査で判明。
 * DDAが1→0に落ちた瞬間だけ位相が0にリセットされ、単なる$0806書込みや音符のon/off
 * 切替では0に戻らない)。そのため、多くの曲は演奏中のchに対しDDAを経由せず波形を
 * 再アップロードしており、毎回「前回どこまで読み出しが進んでいたか」という位相から
 * 書込みが始まる。結果、ドライバが送っているのは実質同じ波形データでも、バッファの
 * 中身は送るたびに開始オフセットが違う「巡回シフトしたコピー」になる
 * (聴感上は「音色が切り替わっている」のではなく「同じ波形がスライドして見える」)。
 * これを生の配列比較(完全一致)のまま音符分割・WaveRegistry登録に使うと、1サンプルでも
 * 巡回位置がずれるたびに別音符・別@N<n>として扱われ、音色定義と音符数が異常に
 * 膨れ上がる(ユーザー報告で発覚)。canonicalRotation()で「32通りの巡回シフトのうち
 * 辞書順最小のもの」に正規化してから音符分割・登録の両方に使うことで、巡回シフトだけの
 * 違いを同一波形とみなす。定常音では巡回シフトしても倍音構成(聴感上の音色)は変わらない
 * ため、音楽的忠実度への影響は無視できる(1周期未満、最大でも数ミリ秒の位相ズレのみ)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Hes2MmlExpansion = MML.Hes2MmlExpansion || {};

  MML.Hes2MmlExpansion.CH_COUNT = 6;
  const WAVE_LEN = 32;

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    const n = Math.round(57 + 12 * Math.log2(freq / 440));
    return (n >= 0 && n <= 119) ? n : null;
  }

  // f = PSG_CLOCK / (32 * period) (hesHeader.js HES.PSG_CLOCK、apuHuC6280.jsのclock()と同じ式)
  function waveFreq(periodReg) { return periodReg > 0 ? MML.HES.PSG_CLOCK / (32 * periodReg) : 0; }
  MML.Hes2MmlExpansion._waveFreq = waveFreq; // converter.jsのapplyPitchDetuneから使う

  // PSGの5bit(0-31)波形をN163の4bit(0-15)へビット深度変換する(単純な1bit右シフト、
  // 0-31を0-15へ均等対応。情報量の損失は最小限)。
  function resampleTo4bit(wave) {
    const out = new Array(WAVE_LEN);
    for (let i = 0; i < WAVE_LEN; i++) out[i] = Math.max(0, Math.min(15, wave[i] >> 1));
    return out;
  }

  // wave(長さWAVE_LENの配列)の32通りの巡回シフトのうち、要素を","結合した文字列が
  // 辞書順最小になるものを返す(冒頭コメント参照)。WAVE_LEN=32程度なのでO(n^2)の
  // 素朴な全探索で十分高速。
  function canonicalRotation(wave) {
    const n = wave.length;
    let best = wave;
    let bestKey = wave.join(',');
    for (let r = 1; r < n; r++) {
      const rotated = wave.slice(r).concat(wave.slice(0, r));
      const key = rotated.join(',');
      if (key < bestKey) { bestKey = key; best = rotated; }
    }
    return best;
  }

  // useCanonicalRotation: false(既定)だとcanonicalRotation()(32要素のO(n^2)巡回シフト探索)を
  // 省略し、素の4bitリサンプルだけを使う。実際のMML変換(@N<n>の重複排除)ではtrueにして
  // 必ず正規化するが、main.js buildHesRollTimeline()(ネイティブ再生中に先読み進捗のたび
  // 全snapshotsを最初から処理し直すピアノロール表示用)は音符境界の見た目が多少荒くても
  // 実害が無く、フレーム数×6ch分この演算が積み重なると再生中の音声コールバックと
  // メインスレッドを奪い合って「がくがく」の一因になっていた(ユーザー実測。この関数は
  // hes2mml変換とロール表示の両方から共有されているため、変換専用のはずのコストが
  // 意図せずロール表示側にも波及していた)。
  function extractChannelEvents(snapshots, chIndex, useCanonicalRotation) {
    const runs = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) runs.push(cur); cur = null; } }
    for (let f = 0; f < snapshots.length; f++) {
      const c = snapshots[f][chIndex];
      const activeWave = c.on && !c.dda && !c.noiseOn;
      const vol4 = Math.max(0, Math.min(15, c.vol >> 1));
      const freqHz = activeWave ? waveFreq(c.freq) : 0;
      const note = (activeWave && vol4 > 0 && freqHz > 0) ? freqToNoteNumber(freqHz) : null;
      // 巡回シフトの正規化(冒頭コメント参照): 音符分割にも@N<n>登録にも常にこの
      // 正規化後の配列を使うことで、位相がズレただけの再アップロードを同一波形とみなす
      // (useCanonicalRotation=falseの場合は上記コメントの理由で省略する)。
      const resampled = resampleTo4bit(c.wave);
      const wave4 = useCanonicalRotation ? canonicalRotation(resampled) : resampled;
      const waveKey = wave4.join(',');
      if (!cur) { cur = { note, wave: wave4, waveKey, rawFreq: note !== null ? freqHz : null, start: f, end: f, volSeq: [vol4], pitchSeq: [c.freq], tieCandidate: false }; continue; }
      if (note !== cur.note || (note !== null && waveKey !== cur.waveKey)) {
        // PSGには専用アタックレジスタが無くこの時点では打ち直し(パス2のsplitRetriggers)を
        // まだ判定していないため、ここでの「純粋な音程変化」は波形切替を伴わないことのみで
        // 判定する(打ち直しかどうかはパス2の結果を見てから確定させる、下記参照)
        const pureNoteChange = note !== cur.note && waveKey === cur.waveKey;
        flush(f);
        cur = { note, wave: wave4, waveKey, rawFreq: note !== null ? freqHz : null, start: f, end: f, volSeq: [vol4], pitchSeq: [c.freq], tieCandidate: pureNoteChange };
      } else {
        cur.volSeq.push(vol4);
        cur.pitchSeq.push(c.freq);
      }
    }
    flush(snapshots.length);

    // パス2: 打ち直し(ロール)検出(retrigger.js参照)。休符ランは対象外。
    // tieCandidateはrun先頭のパス1判定をそのまま引き継ぐが、runの途中で打ち直しにより
    // 新設された区間(r.start>0、実際に音量ジャンプで区切られた=本物の再アタック)は
    // 常にfalseにする(パス1では見えていなかった打ち直しがここで確定するため)
    const events = [];
    for (const run of runs) {
      if (run.note == null) { events.push(run); continue; }
      const ranges = MML.Convert.splitRetriggers(run.volSeq);
      for (const r of ranges) {
        events.push({
          note: run.note, wave: run.wave, waveKey: run.waveKey, rawFreq: run.rawFreq,
          start: run.start + r.start, end: run.start + r.end,
          volSeq: run.volSeq.slice(r.start, r.end),
          pitchSeq: run.pitchSeq.slice(r.start, r.end),
          tieCandidate: r.start === 0 ? run.tieCandidate : false
        });
      }
    }
    return events;
  }

  // waveReg/envRegは省略可(ピアノロール用タイムライン構築時は渡されない、
  // kss2mml/expansion/scc.jsと同じ理由)。waveRegが無い(=ロール表示専用)呼び出しでは
  // canonicalRotationを省略し、再生中のメインスレッド負荷を抑える(extractChannelEvents
  // 冒頭コメント参照)。
  MML.Hes2MmlExpansion.wave = function (snapshots, waveReg, envReg) {
    function toVolumeFields(volSeq) {
      const idx = envReg ? envReg.assign(volSeq) : null;
      return idx == null ? { volume: volSeq[0] } : { envelopeV: idx };
    }
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, tieCandidate: ev.tieCandidate },
      (ev.note !== null && waveReg) ? { instrument: waveReg.assign(ev.wave) } : {},
      ev.note !== null && ev.rawFreq != null ? { rawFreq: ev.rawFreq, freqSeq: ev.pitchSeq.map(waveFreq) } : {},
      ev.noteEnvOffsets ? { noteEnvOffsets: ev.noteEnvOffsets } : {},
      toVolumeFields(ev.volSeq)
    );

    const channels = [];
    for (let i = 0; i < MML.Hes2MmlExpansion.CH_COUNT; i++) {
      channels.push({
        // 分節のヒステリシス化(DESIGN-PITCH.md Phase 2)+高速アルペジオ→EN統合(2026-08-14)+
        // P-5「不明瞭→EPテーブル」側(2026-08-12)
        events: MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractChannelEvents(snapshots, i, !!waveReg))).map(toCommon),
        hasVolume: true, hasEnvelope: true, hasInstrument: true
      });
    }

    const finalSnap = snapshots.length > 0 ? snapshots[snapshots.length - 1][0] : null;
    return {
      channels,
      n163Wave: finalSnap ? resampleTo4bit(finalSnap.wave) : new Array(WAVE_LEN).fill(0)
    };
  };
})(window);
