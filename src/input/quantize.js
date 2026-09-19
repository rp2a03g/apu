/*
 * 演奏入力の量子化 (MML.Input.quantize) — コア層
 *
 * TimedPitchEvent列(DESIGN.md §3、src/input/noteSource.js が出す)を音価の格子へ丸め、
 * src/convert/mmlEmit.js がそのまま食える { start, end, note } の配列にする。
 *
 * ★格子はフレーム(60Hz)ではなく **480TPQNのtick**。
 *   作業計画の当初案は「フレーム格子に量子化」だったが、src/convert/duration.js は既に
 *   tickドメインで丸めており(4分=480tick、3連16分=80tick が全て整数)、
 *   60Hzフレームを一度挟むと、そこで排除したはずの「テンポ次第で意味が変わる丸め誤差」を
 *   入口で作り直すことになる。秒→tick は  sec * bpm/60 * 480  で一発。
 *   emitChannel/framesToLengths には fpb=TPQN を渡せば、frames引数がそのままtickになる。
 *
 * ★オンセットと終端の**両方**を同じ格子へ丸める。
 *   終端を丸めないと、音価が 16&64&192 のような読めない連結になって
 *   「編曲の出発点」にならない。strength=1 なら全ての音価が格子の整数倍になる。
 *
 * ★和音(段階5-a/5-b)は「量子化してから同じstartでまとめる」。
 *   人の和音は10〜30msずれるが、格子へ吸着すれば勝手に揃うので、
 *   「同時押しの判定閾値」を発明する必要がない。順序を逆にすると閾値調整の泥沼になる。
 *   扱いは chordMode で選ぶ:
 *     'top'   … いちばん上の音だけ残す(単音のMMLになる)
 *     'arp'   … 1chの高速アルペジオ(EN)にする。ev.noteEnvOffsets を付けて返すので、
 *               呼び出し側が NoteEnvelopeRegistry へ登録して @EN<n> にする
 *               (検出はここ・登録は呼び出し元、という既存の役割分担に合わせてある)
 *     'split' … 複数チャンネルへ分ける(声部割当)。lanes[] に声部ごとの音符列を返す
 *
 * DOM非依存・デバイス非依存の純関数。合成イベントでテストできる。
 */
(function (global) {
  'use strict';
  const MML   = global.MML = global.MML || {};
  const Input = MML.Input  = MML.Input  || {};

  /* 量子化の分母。4=4分音符 … 12=8分3連 24=16分3連 */
  const GRID_VALUES = [4, 8, 12, 16, 24, 32];

  /*
   * 和音を声部へ配る規則(段階5-a/5-bで共通。src/audio/live-monitor.js もこれを使う)。
   * ★高い音から順に、先頭の声部へ入れる。2A03で pulse1/pulse2/triangle を使う場合、
   *   メロディがpulse1・ベースが三角波になり実際のファミコン曲の書き方と一致する。
   * ★声部が足りないときは「最高音と最低音を残す」。メロディとベースが生きていれば
   *   和音の内声が欠けても音楽として成立する(内声から捨てる)。
   */
  Input.selectChordVoices = function (items, count, getPitch) {
    const pitchOf = getPitch || ((x) => x);
    if (count <= 0 || !items || !items.length) return [];
    const desc = items.slice().sort((a, b) => pitchOf(b) - pitchOf(a));
    if (desc.length <= count) return desc;
    if (count === 1) return [desc[0]];
    const picked = desc.slice(0, count - 1);
    picked.push(desc[desc.length - 1]); // 最低音
    return picked;
  };

  /*
   * events: [{ timeSec, midiNote, velocity }] (midiNote=null は無音区間の開始)
   * opts:
   *   bpm         … 必須。拍の長さ
   *   originSec   … tick 0 とみなす時刻(メトロノームのカウントイン明け等)
   *   endSec      … 録音終了時刻(最後の音の終端に使う)
   *   grid        … 量子化の分母(既定16)
   *   strength    … 0..1。1=完全に格子へ吸着、0=丸めない(既定1)
   *   gate        … 0<g<=1。音符の実音長を「格子に丸めた長さ×g」にする(既定1=そのまま)
   *   legato      … true で、音符と次の音符の隙間を詰める(gateより優先)。
   *                 鍵盤を9割の長さで弾いた旋律が c8.r16d8.r16… ではなく c4d4… になる
   *   minTicks    … これ未満になった音符は捨てる(既定=192分音符=10tick)
   *   beatsPerBar … 全体長をこの拍数の小節単位へ切り上げる(既定4)
   *   noteEvents  … 打鍵列 [{ type:'on'|'off', note, velocity, timeSec }]。
   *                 渡すと和音を扱えるモードになる(第1引数の単音ビューより優先)
   *   chordMode   … 'top'(既定) | 'arp' | 'split'
   *   voices      … chordMode='split' のときの声部数(既定3)
   *
   * 戻り値 { events, lanes, contentTicks, totalTicks, gridTicks, noteCount, droppedCount, chordCount }
   *   lanes:  声部ごとの音符列。単一声部のときは [events] と同じ
   *   events: [{ start, end, note }] tick単位・MMLノート番号(= MIDI - 12)。lanes[0] と同じ
   *   contentTicks: 最後の音符が終わる位置(小節へ切り上げる前)。
   *     既存MMLのカーソル位置へ差し込むときはこちらを尺に使う。小節へ切り上げた尺を
   *     使うと、弾いていない末尾の休符が入って後ろの既存音符が押し出されてしまう。
   *   休符は入れない。隙間は mmlEmit.js の fillGaps が休符にする。
   */
  Input.quantize = function (events, opts = {}) {
    const TPQN = MML.Convert.TPQN;
    const bpm         = opts.bpm;
    const originSec   = opts.originSec || 0;
    const grid        = GRID_VALUES.indexOf(opts.grid) >= 0 ? opts.grid : 16;
    const strength    = clamp(opts.strength != null ? opts.strength : 1, 0, 1);
    const gate        = clamp(opts.gate != null ? opts.gate : 1, 0.05, 1);
    const minTicks    = opts.minTicks != null ? opts.minTicks : TPQN / 48; // 192分音符
    const beatsPerBar = Math.max(1, Math.round(opts.beatsPerBar || 4));
    const chordMode   = (opts.chordMode === 'arp' || opts.chordMode === 'split') ? opts.chordMode : 'top';
    const voiceCount  = Math.max(1, Math.min(8, Math.round(opts.voices || 3)));
    const empty = { events: [], lanes: [[]], contentTicks: 0, totalTicks: 0, gridTicks: 0,
                    noteCount: 0, droppedCount: 0, chordCount: 0 };
    if (!Number.isFinite(bpm) || bpm <= 0) return empty;

    const gridTicks = TPQN * 4 / grid;
    const toTick = (sec) => (sec - originSec) * (bpm / 60) * TPQN;
    const snap = (t) => t + (Math.round(t / gridTicks) * gridTicks - t) * strength;

    // 1) 実測の音符区間を作る
    const sorted = (events || [])
      .filter(e => e && Number.isFinite(e.timeSec))
      .slice().sort((a, b) => a.timeSec - b.timeSec);
    const endSec = Number.isFinite(opts.endSec) ? opts.endSec
      : (sorted.length ? sorted[sorted.length - 1].timeSec : originSec);

    const raw = [];
    if (opts.noteEvents) {
      // ポリ: 打鍵のon/offを対にして音符区間にする(重なりはそのまま=和音)
      for (const iv of pairNoteEvents(opts.noteEvents, endSec)) {
        raw.push({ s: snap(toTick(iv.startSec)), e: snap(toTick(iv.stopSec)), midi: iv.note });
      }
      raw.sort((a, b) => (a.s - b.s) || (a.midi - b.midi));
    } else {
      // 単音ビュー: 次のイベントの時刻が今の音の終端
      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i].midiNote == null) continue;
        const stop = (i + 1 < sorted.length) ? sorted[i + 1].timeSec : endSec;
        if (stop <= sorted[i].timeSec) continue;
        raw.push({ s: snap(toTick(sorted[i].timeSec)), e: snap(toTick(stop)), midi: sorted[i].midiNote });
      }
    }

    // 2) 格子へ丸めた結果つぶれた音符は1格子ぶんに広げる
    //    (格子より短く弾いた音。捨てるより「その格子で鳴った」とみなす方が譜面に近い)
    for (const r of raw) if (r.e <= r.s) r.e = r.s + gridTicks;

    // 2b) 和音の扱い。★量子化した後なので「同じ start = 同時に押した」で判定できる。
    //     'top'/'arp' はまとめて単音列に戻し、'split' は声部ごとの列に分ける。
    //     どちらも以降の手順(重なり解消/レガート/ゲート)は1声ぶんずつ同じものを掛ける
    let chordCount = 0;
    let lanesRaw = [raw];
    if (opts.noteEvents) {
      const groups = [];
      for (let i = 0; i < raw.length; ) {
        let j = i;
        while (j < raw.length && raw[j].s === raw[i].s) j++;
        groups.push(raw.slice(i, j).sort((a, b) => a.midi - b.midi));
        i = j;
      }
      for (const g of groups) if (g.length > 1) chordCount++;

      if (chordMode === 'split') {
        // 声部割当。★まずは音高順の固定割当(高い音から順に先頭の声部へ)。
        //   声部交差の無い普通の和音進行ならこれで正しく、同じ高さの位置は同じ声部に
        //   留まるので声部が跳ね回らない。「前の和音から最も近い音へ」の最小移動
        //   マッチング(声部≤8なので総当たりでも一瞬)は、これで不満が出てから。
        lanesRaw = new Array(voiceCount).fill(null).map(() => []);
        for (const g of groups) {
          const picked = Input.selectChordVoices(g, voiceCount, (r) => r.midi);
          for (let v = 0; v < picked.length; v++) lanesRaw[v].push(picked[v]);
        }
      } else {
        const merged = [];
        for (const group of groups) {
          if (group.length === 1) { merged.push(group[0]); continue; }
          // 和音の長さは「最後に離した指」まで(いちばん自然に聞こえる)
          const end = Math.max.apply(null, group.map((g) => g.e));
          if (chordMode === 'top') {
            merged.push({ s: group[0].s, e: end, midi: group[group.length - 1].midi });
          } else {
            // 1フレームずつ巡る高速アルペジオ。書かれる音符は refNote(=巡回の最後の音)
            const cycle = group.map((g) => g.midi);
            const { refNote, deltas } = MML.Convert.buildNoteEnvelopeDeltas(cycle, cycle.map(() => 1));
            merged.push({ s: group[0].s, e: end, midi: refNote, noteEnvOffsets: deltas });
          }
        }
        lanesRaw = [merged];
      }
    }

    // 3〜5) 声部ごとに同じ仕上げを掛ける(finishLane)
    let dropped = 0;
    const lanes = lanesRaw.map((laneRaw) => {
      const r = finishLane(laneRaw, { minTicks, gate, legato: !!opts.legato });
      dropped += r.dropped;
      return r.out;
    });
    const out = lanes[0] || [];

    // 6) 全体長は小節単位へ切り上げる(半端な小節で終わると譜面として読みにくい)。
    //    ★基準は「最後の音符の終わり」で、停止ボタンを押した時刻ではない。
    //    弾き終えてからボタンを押すまでの間(数百ms)で小節が1つ増え、
    //    末尾に無意味な全休符が付いてしまうため
    const barTicks = TPQN * beatsPerBar;
    let lastEnd = 0;
    for (const lane of lanes) if (lane.length) lastEnd = Math.max(lastEnd, lane[lane.length - 1].end);
    if (!lastEnd) lastEnd = Math.round(snap(toTick(endSec)));
    const totalTicks = Math.max(barTicks, Math.ceil(lastEnd / barTicks) * barTicks);

    let noteCount = 0;
    for (const lane of lanes) noteCount += lane.length;

    return { events: out, lanes, contentTicks: lastEnd, totalTicks, gridTicks,
             noteCount, droppedCount: dropped, chordCount };
  };

  /*
   * 1声ぶんの仕上げ(重なり解消 → レガート/ゲート → 捨てる)。
   * 声部に分けても単音でも、ここから先の扱いはまったく同じ。
   */
  function finishLane(raw, o) {
    // 3) 重なりの解消。1声の中では実演奏で重ならず、重なるのは丸めの結果だけ。
    //    先の音符を次の音符の開始で切る(同じ格子に2音入ったら後着が残る)
    for (let i = 0; i < raw.length - 1; i++) {
      if (raw[i].e > raw[i + 1].s) raw[i].e = raw[i + 1].s;
    }

    // 4a) レガート: 指を離した隙間を次の音符まで詰める。人は鍵盤を音価いっぱいには
    //     押さないので、そのままだと旋律が c8.r16d8.r16… と休符だらけになって読めない。
    //     ★ただし全ての隙間を潰すと「意図した休符」まで消える。隙間がその音符自身の
    //     長さ以下のときだけ詰める(articulation と rest の切り分け)。
    if (o.legato) {
      for (let i = 0; i < raw.length - 1; i++) {
        const gap = raw[i + 1].s - raw[i].e;
        if (gap > 0 && gap <= (raw[i].e - raw[i].s)) raw[i].e = raw[i + 1].s;
      }
    }

    // 4b) ゲート(スタッカート)。休符ぶんは fillGaps が埋める
    if (!o.legato && o.gate < 1) {
      for (const r of raw) {
        const len = r.e - r.s;
        r.e = r.s + Math.max(o.minTicks, Math.round(len * o.gate));
      }
    }

    // 5) カウントイン中(負のtick)と、つぶれた音符を捨てる
    const out = [];
    let dropped = 0;
    for (const r of raw) {
      if (r.e <= 0 || r.e - r.s < o.minTicks) { dropped++; continue; }
      const start = Math.max(0, Math.round(r.s));
      const end   = Math.round(r.e);
      if (end - start < o.minTicks) { dropped++; continue; }
      // MMLノート番号はMIDIより1オクターブ低い番号付け
      const ev = { start, end, note: r.midi - 12 };
      if (r.noteEnvOffsets) ev.noteEnvOffsets = r.noteEnvOffsets;
      out.push(ev);
    }
    return { out, dropped };
  }

  /*
   * 打鍵列 → 音符区間。同じ音を押し直したら前の区間をそこで閉じ、
   * 離されないまま録音が終わった音は endSec で閉じる。
   */
  function pairNoteEvents(noteEvents, endSec) {
    const evs = (noteEvents || [])
      .filter((e) => e && Number.isFinite(e.timeSec) && Number.isFinite(e.note))
      .slice().sort((a, b) => a.timeSec - b.timeSec);
    const open = new Map();
    const out = [];
    const close = (note, at) => {
      const o = open.get(note);
      if (!o) return;
      open.delete(note);
      if (at > o.startSec) out.push({ note, startSec: o.startSec, stopSec: at });
    };
    for (const e of evs) {
      if (e.type === 'on') { close(e.note, e.timeSec); open.set(e.note, { startSec: e.timeSec }); }
      else close(e.note, e.timeSec);
    }
    for (const note of Array.from(open.keys())) close(note, endSec);
    return out.sort((a, b) => a.startSec - b.startSec);
  }

  Input.QUANTIZE_GRIDS = GRID_VALUES;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, Number(v))); }

})(window);
