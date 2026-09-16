/*
 * MusicXML → MML 取り込み(ROADMAP「フェーズ外: 楽譜出力」入力側、2026-09-16)
 *
 * MuseScore 等で書いた楽譜(score-partwise、.musicxml/.xml、または .mxl=zip)を ppmck 系 MML にする。
 * 楽譜出力(notation.js/musicxml.js)の逆向きで、音符の位置と長さは楽譜のまま(量子化しない。
 * 音価は MusicXML の duration/divisions から厳密に決め、MML の音長 c4/c8./c12 と & のタイで書く)。
 *
 * 流れ:
 *   1. XmlLite で木にする → パート/小節/音符(和音・声部・段・タイ・休符・テンポ)を拾う
 *      (backup/forward で時刻を戻す/進める。時刻はパートごとに divisions の最小公倍数 D の tick)
 *   2. (パート, 段, 声部)ごとに「和音の流れ」を単旋律の行(line)へ割る: 和音の上の音から順に、
 *      その時刻に空いている行へ。タイで続く音は同じ行へ繋いで1音にする
 *   3. 行を MML チャンネルへ: 音程あり → A B C(2A03)、足りなければ MMC5(2)・VRC6(3)・N163(8) を
 *      #EX-* で宣言して使う(全16行まで。超えた行は警告して落とす)。打楽器(percussion 音部記号/unpitched)
 *      → D(ノイズ、1行だけ)。テンポは全チャンネルへ t<n> で書く(変化点で音符を & で割る)
 *   4. 1小節=1行のテキスト。#TITLE/#COMPOSER、;@time/;@key(楽譜出力と対)
 *
 *   MML.Score.importMusicXML(text, opts)  → { mml, warnings:[], info:{ title, parts:[...], lines, channels:[...], expansions:[...] } }
 *   MML.Score.importMusicXMLBytes(bytes, name) → Promise(同上。.mxl(zip)は container.xml の rootfile を読む)
 *
 * 対応しないもの(警告して読み飛ばす): 装飾音(grace)、リピート/ダ・カーポ(展開しない)、強弱/アーティキュレーション、
 * 歌詞、移調楽器の transpose、拍子の途中変更(最初の拍子だけ ;@time に書く。小節割りは backup/forward と
 * 小節ごとの実長で追うので音は正しい)、score-timewise(エラー)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Score = MML.Score = MML.Score || {};
  const X = MML.XmlLite;

  const STEP_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const NOTE_NAMES = ['c', 'c+', 'd', 'd+', 'e', 'f', 'f+', 'g', 'g+', 'a', 'a+', 'b'];
  const NOTE_NAMES_FLAT = ['c', 'd-', 'd', 'e-', 'e', 'f', 'g-', 'g', 'a-', 'a', 'b-', 'b'];
  const MAX_LINES = 16;

  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = a % b; a = b; b = t; } return a || 1; }
  function lcm(a, b) { return (a / gcd(a, b)) * b; }

  // ── 1. 楽譜の読み取り ─────────────────────────────────────────────
  // 戻り値 { title, composer, time, key, parts:[{ id, name, D, percStaves:Set, voices: Map(key → {events:[...], perc}), measureStarts:[], tempos:[{tick,bpm}] }] }
  function readScore(root, warnings) {
    if (root.name === 'score-timewise') throw new Error('score-timewise 形式は未対応です(MuseScore 等で score-partwise で保存してください)');
    if (root.name !== 'score-partwise') throw new Error('MusicXML(score-partwise)ではありません: <' + root.name + '>');
    const title = X.childText(X.child(root, 'work'), 'work-title') || X.childText(root, 'movement-title');
    let composer = '';
    for (const c of X.children(X.child(root, 'identification'), 'creator')) if (c.attrs.type === 'composer' || !composer) composer = X.text(c);
    const partNames = new Map();
    for (const sp of X.children(X.child(root, 'part-list'), 'score-part')) partNames.set(sp.attrs.id, X.childText(sp, 'part-name') || sp.attrs.id);

    let time = null, key = null;
    const parts = [];
    let graceSkipped = 0;
    for (const partEl of X.children(root, 'part')) {
      const measures = X.children(partEl, 'measure');
      // divisions は小節の途中で変わりうるので、パート内の全 divisions の最小公倍数 D を tick の単位にする
      let D = 1;
      for (const m of measures) for (const a of X.children(m, 'attributes')) { const d = X.childInt(a, 'divisions', null); if (d) D = lcm(D, d); }
      const part = { id: partEl.attrs.id, name: partNames.get(partEl.attrs.id) || partEl.attrs.id, D, percStaves: new Set(), voices: new Map(), measureStarts: [], tempos: [] };
      let divisions = 1;
      let cursor = 0;            // tick(D 単位)
      let measureStart = 0;
      const voiceOf = (staff, voice) => {
        const k = staff + ':' + voice;
        if (!part.voices.has(k)) part.voices.set(k, { staff, voice, events: [], perc: part.percStaves.has(staff) });
        return part.voices.get(k);
      };
      for (const m of measures) {
        measureStart = cursor;
        part.measureStarts.push(measureStart);
        let maxCursor = cursor;
        let lastNoteEvent = null;   // 直前の(和音でない)音符イベント。<chord/> の音はここへ足す
        for (const el of m.children) {
          if (el.name === 'attributes') {
            const d = X.childInt(el, 'divisions', null); if (d) divisions = d;
            const k = X.child(el, 'key'); if (k && key == null) key = { fifths: X.childInt(k, 'fifths', 0) };
            const t = X.child(el, 'time'); if (t && time == null) time = { beats: X.childInt(t, 'beats', 4), beatType: X.childInt(t, 'beat-type', 4) };
            for (const c of X.children(el, 'clef')) { const num = parseInt(c.attrs.number || '1', 10); if (X.childText(c, 'sign') === 'percussion') part.percStaves.add(num); }
            if (X.child(el, 'transpose')) warnings.push(`パート ${part.name}: 移調楽器の transpose は無視しました(実音でなく記譜の高さで取り込みます)`);
            continue;
          }
          if (el.name === 'backup') { cursor -= Math.round(X.childInt(el, 'duration', 0) * D / divisions); continue; }
          if (el.name === 'forward') { cursor += Math.round(X.childInt(el, 'duration', 0) * D / divisions); maxCursor = Math.max(maxCursor, cursor); continue; }
          if (el.name === 'direction' || el.name === 'sound') {
            const snd = el.name === 'sound' ? el : X.child(el, 'sound');
            let bpm = snd && snd.attrs.tempo != null ? parseFloat(snd.attrs.tempo) : NaN;
            if (!Number.isFinite(bpm)) {
              const met = X.child(X.child(el, 'direction-type'), 'metronome');
              if (met) {
                const unit = X.childText(met, 'beat-unit', 'quarter');
                const pm = X.childFloat(met, 'per-minute', NaN);
                const unitQ = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25 }[unit] || 1;
                const dotted = X.child(met, 'beat-unit-dot') ? 1.5 : 1;
                if (Number.isFinite(pm)) bpm = pm * unitQ * dotted;
              }
            }
            if (Number.isFinite(bpm) && bpm > 0) part.tempos.push({ tick: cursor, bpm });
            continue;
          }
          if (el.name !== 'note') continue;
          if (X.child(el, 'grace')) { graceSkipped++; continue; }
          const dur = Math.round(X.childInt(el, 'duration', 0) * D / divisions);
          const isChord = !!X.child(el, 'chord');
          const isRest = !!X.child(el, 'rest');
          const staff = X.childInt(el, 'staff', 1);
          const voice = X.childText(el, 'voice', '1');
          const v = voiceOf(staff, voice);
          const start = isChord && lastNoteEvent ? lastNoteEvent.start : cursor;
          if (!isChord) { cursor += dur; maxCursor = Math.max(maxCursor, cursor); }
          if (isRest) { lastNoteEvent = null; continue; }
          let midi = null, unpitched = null;
          const p = X.child(el, 'pitch');
          if (p) {
            const step = X.childText(p, 'step', 'C'), alter = X.childFloat(p, 'alter', 0), oct = X.childInt(p, 'octave', 4);
            midi = (oct + 1) * 12 + (STEP_PC[step] || 0) + Math.round(alter);
          } else {
            const u = X.child(el, 'unpitched');
            if (u) unpitched = { step: X.childText(u, 'display-step', 'E'), octave: X.childInt(u, 'display-octave', 4) };
            else continue;
          }
          let tieStart = false, tieStop = false;
          for (const t of X.children(el, 'tie')) { if (t.attrs.type === 'start') tieStart = true; if (t.attrs.type === 'stop') tieStop = true; }
          for (const nt of X.children(el, 'notations')) for (const t of X.children(nt, 'tied')) { if (t.attrs.type === 'start') tieStart = true; if (t.attrs.type === 'stop') tieStop = true; }
          const note = { midi, unpitched, tieStart, tieStop };
          if (isChord && lastNoteEvent && lastNoteEvent.voice === v) { lastNoteEvent.notes.push(note); continue; }
          const ev = { start, dur: isChord && lastNoteEvent ? lastNoteEvent.dur : dur, notes: [note], voice: v };
          v.events.push(ev);
          lastNoteEvent = ev;
        }
        cursor = maxCursor;
      }
      part.totalTicks = cursor;
      for (const v of part.voices.values()) { v.perc = part.percStaves.has(v.staff); v.events.sort((a, b) => a.start - b.start); }
      parts.push(part);
    }
    if (graceSkipped) warnings.push(`装飾音(grace)${graceSkipped}個を読み飛ばしました`);
    return { title, composer, time: time || { beats: 4, beatType: 4 }, key, parts };
  }

  // ── 2. 声部を単旋律の行へ ───────────────────────────────────────────
  // 戻り値 [{ perc, notes:[{start, end, midi|null, unpitched}] }](tick は D 単位)
  function splitVoiceToLines(voice) {
    const lines = [];
    const freeLine = (start) => {
      for (const ln of lines) { const last = ln.notes[ln.notes.length - 1]; if (!last || last.end <= start) return ln; }
      const ln = { perc: voice.perc, notes: [], openTie: null };
      lines.push(ln);
      return ln;
    };
    for (const ev of voice.events) {
      const notes = ev.notes.slice().sort((a, b) => (b.midi == null ? -1 : b.midi) - (a.midi == null ? -1 : a.midi)); // 上の音から
      for (const n of notes) {
        const end = ev.start + ev.dur;
        if (n.tieStop && n.midi != null) {
          // 同じ音でタイが開いている行があれば、そこへ繋いで延ばす
          const ln = lines.find(l => l.openTie && l.openTie.midi === n.midi && l.openTie.end === ev.start);
          if (ln) { ln.openTie.end = end; if (!n.tieStart) ln.openTie = null; continue; }
        }
        const ln = freeLine(ev.start);
        const rec = { start: ev.start, end, midi: n.midi, unpitched: n.unpitched };
        ln.notes.push(rec);
        ln.openTie = (n.tieStart && n.midi != null) ? rec : null;
      }
    }
    return lines;
  }

  // ── 3. tick → MML の音長 ─────────────────────────────────────────
  // ticks(D 単位) を「c4. c12 …」の音長列(数値 n と付点)に分解。全音符 = 4D tick。
  // Score.decompose(units, U) の型/付点/連符比を MML の分母 n = T*a/b にする(整数でなければ半分に割ってタイ)
  function ticksToLengths(ticks, D, isRest) {
    const U = 4 * D;
    const out = [];
    const chunks = Score.decompose(ticks, U, isRest ? 1 : 2);
    for (const c of chunks) {
      const a = c.tuplet ? c.tuplet.actual : 1, b = c.tuplet ? c.tuplet.normal : 1;
      let n = c.noteType * a / b;
      if (Number.isInteger(n)) { out.push({ n, dots: c.dots, units: c.units }); continue; }
      // 例: 全音符の3連(T=1,a=3,b=2 → n=1.5)。半分の音価2つに割って & で繋ぐ
      const half = c.units / 2;
      for (let k = 0; k < 2; k++) out.push(...ticksToLengths(half, D, isRest));
    }
    return out;
  }
  function lenToken(l) { return String(l.n) + '.'.repeat(l.dots); }

  // ── 4. MML 書き出し ──────────────────────────────────────────────
  Score.importMusicXML = function (text, opts) {
    opts = opts || {};
    const warnings = [];
    const root = X.parse(text);
    const sc = readScore(root, warnings);
    // 行に割る(パート順 → 段 → 声部)。打楽器行は別に集める
    const pitchedLines = [], percLines = [];
    const partInfo = [];
    for (const part of sc.parts) {
      const vs = Array.from(part.voices.values()).sort((a, b) => a.staff - b.staff || String(a.voice).localeCompare(String(b.voice)));
      let count = 0;
      for (const v of vs) {
        for (const ln of splitVoiceToLines(v)) {
          if (!ln.notes.length) continue;
          const rec = { part, staff: v.staff, voice: v.voice, notes: ln.notes, perc: v.perc };
          (v.perc ? percLines : pitchedLines).push(rec);
          count++;
        }
      }
      partInfo.push({ name: part.name, lines: count, D: part.D });
    }
    // チャンネル割当: 2A03 A/B/C → MMC5 → VRC6 → N163(必要な分だけ #EX 宣言)
    const need = pitchedLines.length;
    const expansions = [];
    if (need > 3) expansions.push('mmc5');
    if (need > 5) expansions.push('vrc6');
    if (need > 8) expansions.push('n163');
    if (need > MAX_LINES) warnings.push(`音程のある行が ${need} 本あり、${MAX_LINES} 本(2A03 3 + MMC5 2 + VRC6 3 + N163 8)を超えた分は落としました`);
    if (percLines.length > 1) warnings.push(`打楽器の行が ${percLines.length} 本ありますが、ノイズ(D)に載せるのは最初の1本だけです`);
    const headerLines = [];
    if (sc.title) headerLines.push('#TITLE ' + sc.title);
    if (sc.composer) headerLines.push('#COMPOSER ' + sc.composer);
    if (expansions.includes('mmc5')) headerLines.push('#EX-MMC5');
    if (expansions.includes('vrc6')) headerLines.push('#EX-VRC6');
    if (expansions.includes('n163')) headerLines.push('#EX-N163 ' + Math.min(8, need - 8));
    headerLines.push(`;@time ${sc.time.beats}/${sc.time.beatType}`);
    if (sc.key) headerLines.push(`;@key ${sc.key.fifths}`);
    // 拡張音源のチャンネル文字はコンパイラの割当に従う(ヘッダだけのMMLを一度通して引く)
    let letters = ['A', 'B', 'C'];
    if (expansions.length) {
      const probe = MML.Mml.compile(headerLines.filter(l => l.startsWith('#EX')).join('\n') + '\nA r1', {});
      const lm = probe.expansionLetterMap || {};
      letters = letters.concat(lm.mmc5 || [], lm.vrc6 || [], lm.n163 || []);
    }
    const flat = sc.key && sc.key.fifths < 0;
    const names = flat ? NOTE_NAMES_FLAT : NOTE_NAMES;
    const channels = [];
    const body = [];
    const writeLine = (letter, line, perc) => {
      const part = line.part;
      const D = part.D;
      const tempos = part.tempos.length ? part.tempos : (sc.parts[0].tempos.length ? sc.parts[0].tempos : [{ tick: 0, bpm: 120 }]);
      const tempoAt = new Map(); for (const t of tempos) if (!tempoAt.has(t.tick)) tempoAt.set(t.tick, t.bpm);
      if (!tempoAt.has(0)) tempoAt.set(0, tempos[0].bpm);
      const bars = part.measureStarts.slice(1);
      const total = Math.max(part.totalTicks, line.notes.length ? line.notes[line.notes.length - 1].end : 0);
      // 区切り点: 小節線とテンポ変化。ここで音符/休符を割って & で繋ぐ
      const cuts = new Set(bars); for (const t of tempoAt.keys()) if (t > 0) cuts.add(t);
      const cutList = Array.from(cuts).sort((a, b) => a - b);
      // 音符と休符の列(隙間は休符)
      const segs = [];
      let cur = 0;
      for (const n of line.notes) {
        if (n.start > cur) segs.push({ start: cur, end: n.start, rest: true });
        if (n.start < cur) { warnings.push(`${letter}: 重なった音符を詰めました(tick ${n.start})`); }
        segs.push({ start: Math.max(cur, n.start), end: n.end, rest: false, midi: n.midi, unpitched: n.unpitched });
        cur = Math.max(cur, n.end);
      }
      if (total > cur) segs.push({ start: cur, end: total, rest: true });
      // 既定音長: いちばん多い音長を l<n> に
      const tally = new Map();
      const pieces = []; // { tokens:[{n,dots}], rest, midi, unpitched, tieNext, start }
      for (const sg of segs) {
        let s = sg.start;
        const ends = cutList.filter(c => c > sg.start && c < sg.end).concat([sg.end]);
        ends.forEach((e, k) => {
          const lens = ticksToLengths(e - s, D, sg.rest);
          for (const l of lens) tally.set(lenToken(l), (tally.get(lenToken(l)) || 0) + 1);
          pieces.push({ lens, rest: sg.rest, midi: sg.midi, unpitched: sg.unpitched, start: s, tieNext: !sg.rest && k < ends.length - 1 });
          s = e;
        });
      }
      let defaultLen = '4';
      let best = -1; for (const [k, v] of tally) if (v > best) { best = v; defaultLen = k; }
      // 本文: 1小節=1行
      const lines = [];
      let curLine = `${letter} t${Math.round(tempoAt.get(0))} l${defaultLen}`;
      let oct = null, barIdx = 0; // オクターブは最初の音の直前で o<n> を書く
      const flush = () => { lines.push(curLine); curLine = letter + ' '; };
      for (let i = 0; i < pieces.length; i++) {
        const pc = pieces[i];
        while (barIdx < bars.length && pc.start >= bars[barIdx]) { flush(); barIdx++; }
        if (pc.start > 0 && tempoAt.has(pc.start)) curLine += ` t${Math.round(tempoAt.get(pc.start))}`;
        let tok = '';
        if (pc.rest) {
          tok = pc.lens.map(l => 'r' + (lenToken(l) === defaultLen ? '' : lenToken(l))).join('');
        } else if (perc) {
          // 打楽器: 表示位置(E4 を 0)を n<num> に
          const u = pc.unpitched || { step: 'E', octave: 4 };
          const idx = ((u.octave * 7 + { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 }[u.step] - 30) % 16 + 16) % 16;
          tok = pc.lens.map((l, k) => (k ? '&' : '') + 'n' + idx + (lenToken(l) === defaultLen ? '' : ',' + lenToken(l))).join('');
        } else {
          const mmlNote = pc.midi - 12;                 // MML のノート番号(o4c=48 ⇔ MIDI 60)
          const o = Math.floor(mmlNote / 12), name = names[((mmlNote % 12) + 12) % 12];
          if (o !== oct) { tok += `o${o} `; oct = o; }
          tok += pc.lens.map((l, k) => (k ? '&' : '') + name + (lenToken(l) === defaultLen ? '' : lenToken(l))).join('');
        }
        if (pc.tieNext && !pc.rest) tok += '&';
        curLine += (curLine.endsWith(' ') ? '' : ' ') + tok;
      }
      lines.push(curLine);
      return lines.filter(l => l.trim() !== letter);
    };
    pitchedLines.slice(0, MAX_LINES).forEach((ln, i) => {
      const letter = letters[i];
      if (!letter) return;
      channels.push({ letter, part: ln.part.name, staff: ln.staff, voice: ln.voice, notes: ln.notes.length });
      body.push(`; ${letter}: ${ln.part.name} (staff ${ln.staff}, voice ${ln.voice})`);
      body.push(...writeLine(letter, ln, false));
      body.push('');
    });
    if (percLines.length) {
      const ln = percLines[0];
      channels.push({ letter: 'D', part: ln.part.name, staff: ln.staff, voice: ln.voice, notes: ln.notes.length, perc: true });
      body.push(`; D: ${ln.part.name} (percussion)`);
      body.push(...writeLine('D', ln, true));
      body.push('');
    }
    if (!channels.length) warnings.push('音符が1つも見つかりませんでした');
    const mml = [`; MusicXML から取り込み: ${sc.title || '(無題)'}`, ...headerLines, '', ...body].join('\n');
    return { mml, warnings, info: { title: sc.title, composer: sc.composer, time: sc.time, key: sc.key, parts: partInfo, lines: pitchedLines.length + percLines.length, channels, expansions } };
  };

  // バイト列から。.mxl(zip)は META-INF/container.xml の rootfile を読む。テキストは UTF-8(BOM 可)
  Score.importMusicXMLBytes = async function (bytes, name, opts) {
    let data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const Archive = MML.Archive;
    if (Archive && Archive.isZip && Archive.isZip(data)) {
      const { entries } = Archive.parseZip(data);
      let target = null;
      const container = entries.find(e => e.name === 'META-INF/container.xml');
      if (container) {
        const cx = X.parse(new TextDecoder('utf-8').decode(await Archive.readEntry(data, container)));
        const rf = X.child(X.child(cx, 'rootfiles'), 'rootfile');
        const full = rf && rf.attrs['full-path'];
        if (full) target = entries.find(e => e.name === full) || null;
      }
      if (!target) target = entries.find(e => !e.isDir && !e.name.startsWith('META-INF/') && /\.(musicxml|xml)$/i.test(e.name)) || null;
      if (!target) throw new Error('.mxl の中に MusicXML が見つかりません');
      data = await Archive.readEntry(data, target);
    }
    const text = new TextDecoder('utf-8').decode(data).replace(/^﻿/, '');
    return Score.importMusicXML(text, opts);
  };
})(window);
