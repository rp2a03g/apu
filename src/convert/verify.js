/*
 * 変換結果の音程検証(2026-08-24)
 *
 * MML.Convert.verifyPitch(mmlText, scoreChannels, opts) → {
 *   diffs: [{ letter, sec, endSec, expected, got, expectedMidi, gotMidi }],
 *   checked, skipped, missing, error? }
 *
 * 目的: *2MML変換の出力(コマンド込みの最終MMLテキスト)を実際にコンパイルし、
 * ブラウザ再生とまったく同じ経路(コンパイル→フレーム毎レジスタ書き込み→ピアノロール抽出
 * MML.UI.buildRollTracksFromRegSnapshots)で「実際に鳴る音の高さ」を復元して、変換元イベント
 * (scoreChannels、抽出時の意図したノート)と突き合わせる。抽出の丸め誤り(例: サンプル原音
 * 検出の偏りでA#4がB4に化ける)や、エンベロープ/EP/タイのエンコード・コンパイル段の不具合を
 * 変換直後に自動検出してユーザーへ知らせるためのもの。
 *
 * 比較の方針:
 *  - 各音符イベントの内部3点(30/50/70%)でコンパイル済みロールのノート(midi)をサンプルする。
 *    テンポの丸め(t<bpm>は整数)由来の±0.3%程度の時間ドリフトがあるため、境界でなく内部を
 *    見る+全体尺の比率で時間軸を補正する(下のtimeScale)。
 *  - 素の音符(変調なし): 3点すべてが揃って期待値と異なる場合のみ不一致(境界揺れの誤検出防止)。
 *  - ビブラート(MP)/ピッチエンベロープ(EP)付き: 中央値が期待値から±1半音を超えたら不一致。
 *  - EN(アルペジオ)/PT(ポルタメント)付き: 音程が意図的に動くためスキップ(skippedに計上)。
 *  - ノイズ(D)/DPCM(E)/FME7のノイズ単独(@2)は音程比較の意味が薄いためスキップ。
 *  - コンパイルエラー時・実行例外時は error を返すだけで変換自体は妨げない。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  // MMLチャンネル文字 → ロールのトラックid(src/ui/keyboard.js extractChannels)。
  // 拡張音源の文字は assignExpansionLetters の完全固定範囲(dpcm=E, fds=F, vrc7=G-L,
  // vrc6=M-O, n163=P-W, fme7=X-Z, mmc5=a-b)。
  const LETTER_TO_TRACK_ID = {
    A: 'P1', B: 'P2', C: 'TR', D: 'NO', E: 'DM',
    F: 'FDS',
    G: 'VR1', H: 'VR2', I: 'VR3', J: 'VR4', K: 'VR5', L: 'VR6',
    M: 'V6P1', N: 'V6P2', O: 'V6SW',
    P: 'N1', Q: 'N2', R: 'N3', S: 'N4', T: 'N5', U: 'N6', V: 'N7', W: 'N8',
    X: 'FE1', Y: 'FE2', Z: 'FE3',
    a: 'M5P1', b: 'M5P2',
  };
  // 音程比較の対象外(ノイズ=周期index軸/DPCM=@DPCM番号の選択軸。どちらも音高ではない、本家ppmck準拠)
  const SKIP_LETTERS = new Set(['D', 'E']);

  const NOTE_NAMES = ['c', 'c+', 'd', 'd+', 'e', 'f', 'f+', 'g', 'g+', 'a', 'a+', 'b'];
  function noteName(n) {
    if (n == null) return '-';
    return NOTE_NAMES[((n % 12) + 12) % 12] + Math.floor(n / 12);
  }

  // コンパイル結果(tracks[letter][frame]=writes[])からフレーム毎レジスタスナップショットと
  // writeLogを作る(main.js buildRegSnapshotsFromTracks/buildWriteLogFromTracksと同じ処理。
  // UI依存を持たないようここに複製する)
  function buildSnapshots(compiled) {
    const { tracks, channelLetters, totalFrames, statusAddr } = compiled;
    const snapshots = new Array(totalFrames);
    const writeLog = new Array(totalFrames);
    const regs = { [statusAddr]: 0x0F };
    for (let f = 0; f < totalFrames; f++) {
      const writes = [];
      for (const ch of channelLetters) {
        for (const w of tracks[ch][f]) { regs[w.addr] = w.value; writes.push(w); }
      }
      snapshots[f] = Object.assign({}, regs);
      writeLog[f] = writes;
    }
    return { snapshots, writeLog };
  }

  // track.notes(startSec昇順)から時刻secのmidiを引く
  function midiAt(notes, sec) {
    let lo = 0, hi = notes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const n = notes[mid];
      if (sec < n.startSec) hi = mid - 1;
      else if (sec >= n.endSec) lo = mid + 1;
      else return n.midi;
    }
    return null;
  }

  MML.Convert.verifyPitch = function (mmlText, scoreChannels, opts) {
    try {
      const frameRate = (opts && opts.frameRate) || 60;
      const compileOpts = (opts && opts.compileOpts) || {};
      if (!MML.Mml || !MML.UI || !MML.UI.buildRollTracksFromRegSnapshots) {
        return { diffs: [], checked: 0, skipped: 0, missing: 0, error: 'verify unavailable' };
      }
      const compiled = MML.Mml.compile(mmlText, compileOpts);
      if (compiled.errors && compiled.errors.length) {
        return { diffs: [], checked: 0, skipped: 0, missing: 0,
          error: 'compile: ' + compiled.errors[0].message };
      }
      // 音域外など「鳴らない箇所」の警告(compiler.js warnings)。変換自体は成立するので
      // 検証は続行し、結果に添えて呼び出し元(変換ステータス)へ見せる
      // @DPCM の .dmc 未読込(kind:'dpcm-missing')はここでは出さない: 検証は音程だけが対象で、
      // 変換直後は台帳(main.js dpcmSampleCache)に入っているのに「無い」と言ってしまうため
      const warnings = (compiled.warnings || []).filter((w) => w.kind !== 'dpcm-missing').map((w) => w.message);
      const { snapshots, writeLog } = buildSnapshots(compiled);
      const sampleRate = 44100;
      const chips = ['nes', ...(compiled.expansions || []).filter((e) => e !== 'dpcm')];
      const rollTracks = MML.UI.buildRollTracksFromRegSnapshots(
        snapshots, writeLog, compiled.totalFrames, sampleRate / compiled.frameRate,
        sampleRate, chips, null,
        // #TUNING(基準ピッチ)込みで音名へ丸める(keyboard.js freqToMidi)。これが無いと全体ずれのある
        // 曲で「変換元は c、鳴った音は c+」という偽の不一致が出る
        { tuningCents: (compiled.settings && compiled.settings.tuningCents) || 0,
          tuningNotes: (compiled.settings && compiled.settings.tuningNotes) || null }) || []; // #TUNING-NOTE(音名別)
      const trackById = new Map(rollTracks.map((t) => [t.id, t]));
      // N163のロール行idは N1=内部ch7(最上位) の逆順(keyboard.js snapshotN163参照)。
      // コンパイラはレターk(0始まり)を内部ch (8-numCh)+k に置くため、対応する行は
      // N{numCh-k}。numChは「音符を持つ最上位レター位置+1」(compiler.jsと同じ規則)
      const n163Letters = (compiled.expansionLetterMap && compiled.expansionLetterMap.n163) || [];
      // ★#EX-N163 <n> の宣言があればそれが正典(compiler.js n163NumChOf と同じ規則)。音符から数えると、
      //   宣言8・使用4ch(P-S)のMMLで行の対応が丸ごとずれ、全音符が「聞こえない」と誤判定される
      //   (PSF の SaGa Frontier / R4 / 魔界島で発覚。変換側は N163_CH=fixed8 が既定なので他形式でも起きうる)
      let n163NumCh = 0;
      const declaredN163 = compiled.settings && compiled.settings.n163NumCh;
      if (declaredN163) n163NumCh = Math.max(1, Math.min(8, declaredN163));
      else n163Letters.forEach((L, k) => {
        if ((compiled.segmentsByChannel[L] || []).some((sg) => sg.freq != null)) n163NumCh = k + 1;
      });
      const trackFor = (letter) => {
        const k = n163Letters.indexOf(letter);
        if (k >= 0 && n163NumCh > 0) return trackById.get('N' + (n163NumCh - k));
        const id = LETTER_TO_TRACK_ID[letter];
        return id ? trackById.get(id) : null;
      };

      // テンポ丸め由来の一定比率ドリフトを全体尺の比で補正(tempo-rounding-drift対策)。
      // 大きく違う場合(曲がループ短縮された等)は補正しない。
      const srcTotalSec = (opts && opts.totalFrames ? opts.totalFrames : 0) / frameRate;
      const dstTotalSec = compiled.totalFrames / compiled.frameRate;
      let timeScale = 1;
      if (srcTotalSec > 0 && dstTotalSec > 0) {
        const r = dstTotalSec / srcTotalSec;
        if (r > 0.97 && r < 1.03) timeScale = r;
      }

      const diffs = [];
      let checked = 0, skipped = 0, missing = 0;
      for (const ch of scoreChannels || []) {
        if (SKIP_LETTERS.has(ch.letter)) continue;
        const track = trackFor(ch.letter);
        for (const ev of ch.events || []) {
          if (ev.note == null) continue;
          // 音量0(volPct=0で意図的に消したチャンネル等)は音が鳴らず実音高が取れないため対象外
          // (VRC7=G-L の ev.volume はレジスタの減衰値で 0 が最大音量なので除外しない。mmlEmit.js vrc7MmlVolume 参照)
          if (ev.verifySkip || (ev.volume === 0 && !/^[G-L]$/.test(ch.letter))) { skipped++; continue; }
          // 音程が意図的に動くコマンドは対象外(EN=アルペジオ、PT=ポルタメント)
          if (ev.noteEnv != null || ev.portamento) { skipped++; continue; }
          // FME7のノイズ単独ミキサー(@2)はノート番号=ノイズ周期なので対象外
          if (ev.fme7Noise !== undefined && ev.instrument === 2) { skipped++; continue; }
          const startSec = ev.start / frameRate;
          // NOTE_END='next'(src/convert/envelope.js absorbSilenceIntoEnvelopes)で次の音符の頭まで
          // 伸ばした音符は、伸ばした区間が無音(表の末尾0保持)なので可聴区間だけをサンプルする
          const endSec = (ev.audibleEnd != null ? ev.audibleEnd : ev.end) / frameRate;
          const len = endSec - startSec;
          if (len < 0.1) { skipped++; continue; } // 短すぎる音符は境界ドリフトの誤検出源
          if (!track) { missing++; continue; }
          const expectedMidi = ev.note + 12; // converterのnote空間(57=a4) → 標準MIDI(69=a4)
          const pts = [0.3, 0.5, 0.7].map((k) => (startSec + len * k) * timeScale);
          const got = pts.map((t) => midiAt(track.notes, t));
          const nonNull = got.filter((g) => g != null);
          checked++;
          if (nonNull.length === 0) { missing++; continue; }
          const wobbly = ev.vibrato != null || ev.pitchEp != null;
          if (wobbly) {
            // 中央値が±1半音以内なら変調の揺れとみなしOK
            const sorted = nonNull.slice().sort((x, y) => x - y);
            const med = sorted[sorted.length >> 1];
            if (Math.abs(med - expectedMidi) > 1) {
              diffs.push({ letter: ch.letter, sec: startSec, endSec,
                expected: ev.note, got: med - 12, expectedMidi, gotMidi: med });
            }
          } else {
            // 素の音符: 3点すべてが同じ値で、かつ期待値と異なる場合のみ不一致
            if (nonNull.length === got.length &&
                nonNull.every((g) => g === nonNull[0]) && nonNull[0] !== expectedMidi) {
              diffs.push({ letter: ch.letter, sec: startSec, endSec,
                expected: ev.note, got: nonNull[0] - 12, expectedMidi, gotMidi: nonNull[0] });
            }
          }
        }
      }
      diffs.sort((x, y) => x.sec - y.sec);
      return { diffs, checked, skipped, missing, warnings };
    } catch (e) {
      return { diffs: [], checked: 0, skipped: 0, missing: 0, error: e.message };
    }
  };

  MML.Convert.verifyNoteName = noteName;
})(window);
