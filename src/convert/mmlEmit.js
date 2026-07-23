/*
 * フォーマット非依存 MML テキスト生成
 * MML.Convert.emitChannel(letter, events, fpb, opts) → string (1チャンネル分、80桁折り返し)
 * MML.Convert.emitScore(channelsData, fpb, opts) → string (全チャンネルを小節単位で
 *   縦に揃えたスコア形式。数小節ごとに改行してパート譜のように読める形にする)
 *
 * events: [{ start, end, note: number|null, volume?, instrument?, envelopeV?, envelopeVr?,
 *            fme7EnvShape?, fme7EnvPeriod? }]
 *   note=null は休符。start/endはフレーム単位で、隙間があっても良い(内部で休符補完する)。
 * 共通opts:
 *   hasVolume    … true の場合のみ v トークンを出す
 *   hasInstrument… true の場合のみ @ トークンを出す
 *   hasEnvelope  … true の場合、envelopeV が設定されているイベントは
 *                   v の代わりに @v<N>/@vr<N> トークンを出す。hasVolumeと併用可能で、
 *                   その場合 envelopeV が無い(フラットな)イベントだけ通常の v<N> を出す
 *   hasFme7Env   … true の場合、fme7EnvShape が設定されているイベントは
 *                   S<N>(+周期が変わればM<N>)を出す。hasVolumeと併用可能
 *   (v<N>/@v<N>/S<N>の切替時は値が前回と同じ番号でも必ずトークンを出し直す。
 *    コンパイラ側は明示的なv<n>でstate.envelopeV/fme7EnvShapeをnullにクリアするため)
 *   totalFrames  … 末尾休符を補うための曲全体のフレーム数
 *
 * 音価の継続(タイ)は必ず & (note/rest名を繰り返す) で行う。
 * 字句解析器 (src/mml/lexer.js) は & のみを tie として認識し、^ は無視される
 * ため、^ は使わない。
 */
(function (global) {
  'use strict';
  const MML     = global.MML     = global.MML     || {};
  MML.Convert   = MML.Convert   || {};

  const NOTE_NAMES = ['c','c+','d','d+','e','f','f+','g','g+','a','a+','b'];

  MML.Convert.noteNumberToMmlParts = function (n) {
    if (n === null || n === undefined) return null;
    return { oct: Math.floor(n / 12), name: NOTE_NAMES[((n % 12) + 12) % 12] };
  };

  // ── ギャップ・末尾を休符イベントで補完してギャップレス化 ──────────────
  function fillGaps(events, totalFrames) {
    const filled = [];
    let cursor = 0;
    const sorted = (events || []).slice().sort((a, b) => a.start - b.start);
    for (const ev of sorted) {
      if (ev.start > cursor) filled.push({ start: cursor, end: ev.start, note: null });
      filled.push(ev);
      cursor = Math.max(cursor, ev.end);
    }
    if (cursor < totalFrames) filled.push({ start: cursor, end: totalFrames, note: null });
    return filled;
  }

  // ── イベント配列 → トークン列 (共通コア) ────────────────────────────
  // state (curOct/curVol/curInst/curEnvV/curEnvVr) は呼び出しをまたいで
  // 共有できるようにする(小節ごとに分けて呼んでも変化検出が継続するため)。
  // ev.continued=true の音符は小節境界で分割された継続音として、音色/音量/
  // オクターブを再指定せずタイ(&)だけで繋げる(休符は繋げても繋げなくても
  // 音的に同じなので continued を見る必要がない)。
  function renderEvents(events, fpb, flags, state, appendToken) {
    for (const ev of events) {
      const dur = ev.end - ev.start;
      if (dur <= 0) continue;
      const { lengths, carryOut } = MML.Convert.framesToLengths(dur, fpb, state.durCarry);
      state.durCarry = carryOut;

      if (ev.note === null) {
        appendToken('r' + lengths[0] + lengths.slice(1).map(l => `&r${l}`).join(''));
        continue;
      }

      if (!ev.continued) {
        if (flags.hasVrc7Tone && ev.vrc7Tone !== undefined && ev.vrc7Tone !== state.curVrc7Tone) {
          appendToken(`OP${ev.vrc7Tone}`); state.curVrc7Tone = ev.vrc7Tone;
        }
        if (flags.hasFdsMod && ev.fdsMod !== undefined && ev.fdsMod !== state.curFdsMod) {
          appendToken(ev.fdsMod === 'off' ? 'MHOF' : `MH${ev.fdsMod}`); state.curFdsMod = ev.fdsMod;
        }
        if (flags.hasInstrument && ev.instrument !== undefined && ev.instrument !== state.curInst) {
          appendToken(`@${ev.instrument}`); state.curInst = ev.instrument;
        }
        if (flags.hasFme7Env && ev.fme7EnvShape !== undefined) {
          if (ev.fme7EnvPeriod !== undefined && ev.fme7EnvPeriod !== state.curFme7Period) {
            appendToken(`M${ev.fme7EnvPeriod}`); state.curFme7Period = ev.fme7EnvPeriod;
          }
          // S<n>には解除コマンドが無く一度出すと残り続けるため(compiler.js側もv<n>でしか
          // クリアできない)、v<n>経由でモードを抜けていた場合は番号が同じでも出し直す。
          if (ev.fme7EnvShape !== state.curFme7Shape || state.curVolMode !== 'fme7env') {
            appendToken(`S${ev.fme7EnvShape}`); state.curFme7Shape = ev.fme7EnvShape;
          }
          state.curVolMode = 'fme7env';
        } else if (flags.hasEnvelope && ev.envelopeV !== undefined) {
          if (ev.envelopeVr !== undefined && ev.envelopeVr !== state.curEnvVr) {
            appendToken(`@vr${ev.envelopeVr}`); state.curEnvVr = ev.envelopeVr;
          }
          // v<n>とhasEnvelopeを併用するチャンネル(NSF/KSSの帯域)では、直前がv<n>だった
          // 場合コンパイラ側のstate.envelopeVがnullにクリアされているため、値が前回の
          // @v<n>と同じ番号でも必ずトークンを出し直して再セットする(state.curVolMode参照)。
          if (ev.envelopeV !== state.curEnvV || state.curVolMode !== 'env') {
            appendToken(`@v${ev.envelopeV}`); state.curEnvV = ev.envelopeV;
          }
          state.curVolMode = 'env';
        } else if (flags.hasVolume && ev.volume !== undefined) {
          // 同様に、直前が@v<n>だった場合はコンパイラのstate.volumeが古いままなので、
          // 値が前回のv<n>と同じでも必ず出し直してエンベロープを解除する。
          if (ev.volume !== state.curVol || state.curVolMode !== 'plain') {
            appendToken(`v${ev.volume}`); state.curVol = ev.volume;
          }
          state.curVolMode = 'plain';
        }
      }

      const { oct, name } = MML.Convert.noteNumberToMmlParts(ev.note);
      if (!ev.continued && oct !== state.curOct) {
        if      (state.curOct >= 0 && oct === state.curOct + 1) appendToken('>');
        else if (state.curOct >= 0 && oct === state.curOct - 1) appendToken('<');
        else                                                    appendToken(`o${oct}`);
        state.curOct = oct;
      }

      const tie = ev.continued ? '&' : '';
      appendToken(tie + name + lengths[0] + lengths.slice(1).map(l => `&${name}${l}`).join(''));
    }
  }

  function newState() {
    return {
      curOct: -1, curVol: -1, curInst: -1, curEnvV: -1, curEnvVr: -1,
      curFme7Shape: -1, curFme7Period: -1, curVolMode: null, durCarry: 0, curVrc7Tone: -1,
      curFdsMod: 'off'
    };
  }

  // ── 1チャンネル分の連続テキスト (80桁折り返し) ──────────────────────
  MML.Convert.emitChannel = function (letter, events, fpb, opts) {
    opts = opts || {};
    const totalFrames = opts.totalFrames || 0;
    const wrapCol      = opts.wrapCol || 80;
    const flags = {
      hasVolume: !!opts.hasVolume, hasInstrument: !!opts.hasInstrument,
      hasEnvelope: !!opts.hasEnvelope, hasFme7Env: !!opts.hasFme7Env, hasVrc7Tone: !!opts.hasVrc7Tone,
      hasFdsMod: !!opts.hasFdsMod
    };
    const tempoPrefix = opts.tempoPrefix || '';

    const lines = [];
    if (opts.headerLines) lines.push(...opts.headerLines);

    const filled = fillGaps(events, totalFrames);

    if (filled.length === 0) {
      lines.push(`${letter} ${tempoPrefix}r1`.trimEnd());
      if (opts.footerLines) lines.push(...opts.footerLines);
      return lines.join('\n');
    }

    let line = `${letter} ${tempoPrefix}`;
    let col  = line.length;

    function appendToken(tok) {
      if (col + tok.length + 1 > wrapCol) {
        lines.push(line.trimEnd());
        line = `${letter} `;
        col = line.length;
      }
      line += tok + ' ';
      col += tok.length + 1;
    }

    renderEvents(filled, fpb, flags, newState(), appendToken);

    lines.push(line.trimEnd());
    if (opts.footerLines) lines.push(...opts.footerLines);
    return lines.join('\n');
  };

  // ── 小節境界での分割 ─────────────────────────────────────────────────
  // boundaries(昇順のフレーム位置配列)をまたぐイベントを2つに割り、
  // 後半に continued:true を付与する。
  function splitAtBoundaries(events, boundaries) {
    const result = [];
    let bi = 0;
    for (const ev of events) {
      while (bi < boundaries.length && boundaries[bi] <= ev.start) bi++;
      let segStart = ev.start;
      let continued = false;
      while (bi < boundaries.length && boundaries[bi] < ev.end) {
        result.push(Object.assign({}, ev, { start: segStart, end: boundaries[bi], continued }));
        segStart = boundaries[bi];
        continued = true;
        bi++;
      }
      result.push(Object.assign({}, ev, { start: segStart, end: ev.end, continued }));
    }
    return result;
  }

  function bucketByMeasure(events, framesPerMeasure, measureCount) {
    const buckets = Array.from({ length: measureCount }, () => []);
    for (const ev of events) {
      const m = Math.max(0, Math.min(measureCount - 1, Math.floor(ev.start / framesPerMeasure)));
      buckets[m].push(ev);
    }
    return buckets;
  }

  // ── 全チャンネルを小節単位で縦に揃えたスコア形式 ────────────────────
  // channelsData: [{ letter, events, hasVolume?, hasInstrument?, hasEnvelope? }]
  // opts:
  //   totalFrames, beatsPerMeasure(既定4), measuresPerLine(既定4),
  //   tempoBpm(指定すると先頭に "<使用チャンネル文字列> t<bpm>" 行を1本だけ出す),
  //   headerLines(スコア全体の先頭に足す生テキスト行)
  MML.Convert.emitScore = function (channelsData, fpb, opts) {
    opts = opts || {};
    const totalFrames     = opts.totalFrames || 0;
    const beatsPerMeasure = opts.beatsPerMeasure || 4;
    const measuresPerLine = opts.measuresPerLine || 4;
    const framesPerMeasure = fpb * beatsPerMeasure;
    const measureCount = Math.max(1, Math.ceil(totalFrames / framesPerMeasure));

    const boundaries = [];
    for (let m = 1; m < measureCount; m++) boundaries.push(Math.round(m * framesPerMeasure));

    const lines = [];
    if (opts.headerLines) lines.push(...opts.headerLines);
    if (opts.tempoBpm != null) {
      const letters = channelsData.map(c => c.letter).join('');
      lines.push(`${letters} t${Math.round(opts.tempoBpm)}`);
    }

    // チャンネルごとに: ギャップ補完 → 小節境界で分割 → 小節バケツへ → テキスト化
    const perChannelMeasureTexts = channelsData.map(chan => {
      const filled  = fillGaps(chan.events, totalFrames);
      const split   = splitAtBoundaries(filled, boundaries);
      const buckets = bucketByMeasure(split, framesPerMeasure, measureCount);
      const flags = {
        hasVolume: !!chan.hasVolume, hasInstrument: !!chan.hasInstrument,
        hasEnvelope: !!chan.hasEnvelope, hasFme7Env: !!chan.hasFme7Env, hasVrc7Tone: !!chan.hasVrc7Tone,
        hasFdsMod: !!chan.hasFdsMod
      };
      const state = newState();
      return buckets.map(bucketEvents => {
        let text = '';
        renderEvents(bucketEvents, fpb, flags, state, tok => { text += tok + ' '; });
        return text.trimEnd();
      });
    });

    // 小節ごとに全チャンネル中の最大幅で列を揃える
    const colWidth = [];
    for (let m = 0; m < measureCount; m++) {
      let w = 0;
      for (const texts of perChannelMeasureTexts) w = Math.max(w, texts[m].length);
      colWidth.push(w);
    }

    for (let blockStart = 0; blockStart < measureCount; blockStart += measuresPerLine) {
      const blockEnd = Math.min(measureCount, blockStart + measuresPerLine);
      for (let ci = 0; ci < channelsData.length; ci++) {
        let line = `${channelsData[ci].letter} `;
        for (let m = blockStart; m < blockEnd; m++) {
          line += perChannelMeasureTexts[ci][m].padEnd(colWidth[m]) + ' ';
        }
        lines.push(line.trimEnd());
      }
      if (blockEnd < measureCount) lines.push('');
    }

    return lines.join('\n');
  };

})(window);
