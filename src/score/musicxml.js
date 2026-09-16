/*
 * MusicXML 書き出し(ROADMAP「フェーズ外: 楽譜出力」段階2、2026-09-16。段階5で和音とピアノ2段を追加)
 *
 * notation.js の表記モデル → MusicXML 4.0 (score-partwise) の文字列。
 * 1チャンネル=1パート=1段。ピアノ2段(buildPianoNotation の group='piano' な RH/LH)は1パート2段
 * (<staves>2</staves>、右手=staff 1/voice 1、左手=staff 2/voice 2、小節ごとに <backup> で戻る)。
 * 和音(item.chord)は2音目以降に <chord/> を付け、タイ/臨時記号は音ごと、連桁/連符/スラーは先頭の音だけに付ける。
 * 要素の並び順は MusicXML のスキーマ順に固定している
 * (note: chord → pitch/unpitched/rest → duration → tie → voice → type → dot → accidental →
 *  time-modification → staff → beam → notations)。順序を崩すと MuseScore が警告/無視する。
 * 圧縮形式(.mxl=zip)は出さない。拡張子は .musicxml。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Score = MML.Score = MML.Score || {};

  const TYPE_NAMES = { 1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth', 16: '16th', 32: '32nd', 64: '64th', 128: '128th', 256: '256th' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtTempo(bpm) { return String(Math.round(bpm * 100) / 100); }

  // 連続する同じ group のパートを1つの <part> にまとめる。戻り値 [{ id, name, abbrev, staves:[part...] }]
  function groupParts(parts) {
    const out = [];
    for (const part of parts) {
      const last = out[out.length - 1];
      if (part.group && last && last.group === part.group) { last.staves.push(part); continue; }
      out.push({ id: part.group ? 'P_' + part.group.toUpperCase() : part.id, name: part.group ? part.name : part.name,
        abbrev: part.group ? part.group.slice(0, 3) : part.letter, group: part.group || null, staves: [part] });
    }
    return out;
  }

  // notation → MusicXML 文字列。opts: { software, date(YYYY-MM-DD) }
  Score.toMusicXML = function (notation, opts) {
    opts = opts || {};
    const L = [];
    const push = (s) => L.push(s);
    const measureUnits = notation.time.beats * notation.units / notation.time.beatType;
    push('<?xml version="1.0" encoding="UTF-8"?>');
    push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
    push('<score-partwise version="4.0">');
    if (notation.title) push(`  <work><work-title>${esc(notation.title)}</work-title></work>`);
    push('  <identification>');
    if (notation.composer) push(`    <creator type="composer">${esc(notation.composer)}</creator>`);
    push('    <encoding>');
    push(`      <software>${esc(opts.software || 'Sound Emulation Foundry')}</software>`);
    push(`      <encoding-date>${esc(opts.date || new Date().toISOString().slice(0, 10))}</encoding-date>`);
    push('    </encoding>');
    push('  </identification>');
    const groups = groupParts(notation.parts);
    push('  <part-list>');
    for (const gp of groups) {
      push(`    <score-part id="${esc(gp.id)}">`);
      push(`      <part-name>${esc(gp.name)}</part-name>`);
      push(`      <part-abbreviation>${esc(gp.abbrev)}</part-abbreviation>`);
      push('    </score-part>');
    }
    push('  </part-list>');

    // 1つの音符/休符/和音を書く。staffNo/voice は多段パートのとき
    const writeItem = (it, staffNo, voice, nStaves) => {
      const notes = it.chord && it.chord.length ? it.chord : [null];
      notes.forEach((cn, ci) => {
        push('      <note>');
        if (ci > 0) push('        <chord/>');
        if (it.rest) {
          push(it.measureRest ? '        <rest measure="yes"/>' : '        <rest/>');
        } else if (it.unpitched) {
          push(`        <unpitched><display-step>${it.unpitched.step}</display-step><display-octave>${it.unpitched.octave}</display-octave></unpitched>`);
        } else {
          const p = cn ? cn.pitch : it.pitch;
          push('        <pitch>');
          push(`          <step>${p.step}</step>`);
          if (p.alter) push(`          <alter>${p.alter}</alter>`);
          push(`          <octave>${p.octave}</octave>`);
          push('        </pitch>');
        }
        push(`        <duration>${it.dur}</duration>`);
        const tieStop = cn ? cn.tieStop : it.tieStop, tieStart = cn ? cn.tieStart : it.tieStart;
        if (tieStop) push('        <tie type="stop"/>');
        if (tieStart) push('        <tie type="start"/>');
        push(`        <voice>${voice}</voice>`);
        if (!it.measureRest) {
          push(`        <type>${TYPE_NAMES[it.noteType]}</type>`);
          for (let d = 0; d < it.dots; d++) push('        <dot/>');
        }
        const acc = cn ? cn.accidental : it.accidental;
        if (acc) push(`        <accidental>${acc}</accidental>`);
        if (it.tuplet) push(`        <time-modification><actual-notes>${it.tuplet.actual}</actual-notes><normal-notes>${it.tuplet.normal}</normal-notes></time-modification>`);
        if (nStaves > 1) push(`        <staff>${staffNo}</staff>`);
        if (ci === 0) it.beams.forEach((b, i) => push(`        <beam number="${i + 1}">${b}</beam>`));
        const notations = [];
        if (tieStop) notations.push('<tied type="stop"/>');
        if (tieStart) notations.push('<tied type="start"/>');
        if (ci === 0) {
          if (it.slurStop) notations.push('<slur type="stop" number="1"/>');
          if (it.slurStart) notations.push('<slur type="start" number="1"/>');
          if (it.tuplet && it.tuplet.stop) notations.push('<tuplet type="stop"/>');
          if (it.tuplet && it.tuplet.start) notations.push('<tuplet type="start"/>');
        }
        if (notations.length) push(`        <notations>${notations.join('')}</notations>`);
        push('      </note>');
      });
    };
    const writeDirection = (it, staffNo, nStaves) => {
      push('      <direction placement="above">');
      push('        <direction-type>');
      push(`          <metronome><beat-unit>quarter</beat-unit><per-minute>${fmtTempo(it.tempo)}</per-minute></metronome>`);
      push('        </direction-type>');
      if (nStaves > 1) push(`        <staff>${staffNo}</staff>`);
      push(`        <sound tempo="${fmtTempo(it.tempo)}"/>`);
      push('      </direction>');
    };

    for (const gp of groups) {
      const nStaves = gp.staves.length;
      const nMeasures = Math.max(...gp.staves.map(p => p.measures.length));
      push(`  <part id="${esc(gp.id)}">`);
      for (let mi = 0; mi < nMeasures; mi++) {
        push(`    <measure number="${mi + 1}">`);
        if (mi === 0) {
          push('      <attributes>');
          push(`        <divisions>${notation.divisions}</divisions>`);
          push(`        <key><fifths>${notation.key.fifths}</fifths><mode>${esc(notation.key.mode || 'major')}</mode></key>`);
          push(`        <time><beats>${notation.time.beats}</beats><beat-type>${notation.time.beatType}</beat-type></time>`);
          if (nStaves > 1) push(`        <staves>${nStaves}</staves>`);
          gp.staves.forEach((part, si) => {
            if (!part.clef) return;
            const num = nStaves > 1 ? ` number="${si + 1}"` : '';
            push(`        <clef${num}><sign>${esc(part.clef.sign)}</sign><line>${part.clef.line}</line></clef>`);
          });
          push('      </attributes>');
        }
        gp.staves.forEach((part, si) => {
          const measure = part.measures[mi];
          if (!measure) return;
          if (si > 0) push(`      <backup><duration>${measureUnits}</duration></backup>`);
          for (const it of measure.items) {
            if (it.tempo != null && si === 0) writeDirection(it, si + 1, nStaves);
            writeItem(it, si + 1, si + 1, nStaves);
          }
        });
        push('    </measure>');
      }
      push('  </part>');
    }
    push('</score-partwise>');
    return L.join('\n') + '\n';
  };

  // compile() の戻り値から一気に MusicXML 文字列へ。opts は buildNotation/toMusicXML 共通。
  // opts.piano=true でピアノ2段(buildPianoNotation)
  Score.compiledToMusicXML = function (compiled, opts) {
    opts = opts || {};
    const notation = opts.piano ? Score.buildPianoNotation(compiled, opts) : Score.buildNotation(compiled, opts);
    return { notation, xml: Score.toMusicXML(notation, opts) };
  };
})(window);
