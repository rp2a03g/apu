/*
 * MML定義ブロック(`@TAG<n> = { ... }`)の走査・読み書き共通処理
 * MML.Defs
 *
 * FDS波形エディタ(src/ui/fdsWaveEditor.js)・N163波形エディタ・VRC7音色エディタ・
 * DPCMコンバータが、それぞれ同じ内容のscanDefs/findDefRange/findInsertionOffset/
 * extractDefinitionLinesを持っていたのを1箇所へ集めたもの。エンベロープエディタ
 * (@v/@vr/@<n>/@@r/@EP/@EN)を足す前の地ならしとして切り出した。
 *
 * MMLテキストが正典(DESIGN.md INV-2)という前提は変わらない。このモジュールは
 * 「テキスト中の定義ブロックの位置を返す」「その位置を差し替えた新しいテキストを
 * 返す」だけを行い、値の意味(波形なのか音色なのかエンベロープなのか)は一切解釈
 * しない。値の解釈は各エディタ側に残す。
 *
 * ■ コンパイラ(src/mml/lexer.js)との一致について
 * lexer.jsは行コメント(";"以降)を落としてから"{"と"}"の対応を取る(joinBraceBlocks)。
 * このモジュールも同じ見方をする:
 *   ・コメント内の "@FM0 = {" は定義として拾わない(コメントアウトした定義を
 *     エディタが書き換えてしまわないように)
 *   ・コメント内の "}" は閉じ括弧として数えない
 * 切り出し前の4エディタはどちらもしていなかったので、この2点だけは挙動が変わる
 * (いずれもコンパイラの見方に寄せる方向の変更)。
 * 入れ子の"{}"を扱わない点は切り出し前と同じ(MMLの定義ブロックに入れ子は無い)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Defs = MML.Defs = MML.Defs || {};

  // "$"接頭辞で16進。lexer.js parseMmlNumber と同じ規約
  function parseNumber(s) {
    if (s[0] === '$') return parseInt(s.slice(1), 16);
    return parseInt(s, 10);
  }

  // 行コメント(";"以降)を各行から取り除く。定義ブロックの中身を読む前に必ず通す
  // (@OTのように「; AR DR SL RR …」と見出しコメントを添えて書くのが普通の定義があり、
  //  落とさないとコメントの語をパラメータとして数えてしまう)
  function stripComments(text) {
    return String(text).split(/\r\n|\r|\n/).map((line) => {
      const i = line.indexOf(';');
      return i >= 0 ? line.slice(0, i) : line;
    }).join('\n');
  }

  // posがその行のコメント(";"以降)の中にあるか
  function isInComment(source, pos) {
    for (let i = pos - 1; i >= 0; i--) {
      const ch = source[i];
      if (ch === '\n' || ch === '\r') return false;
      if (ch === ';') return true;
    }
    return false;
  }

  // fromの位置("{")から対応する"}"を探す。コメント中の"}"は無視する
  function findCloseBrace(source, from) {
    let inComment = false;
    for (let i = from; i < source.length; i++) {
      const ch = source[i];
      if (ch === '\n' || ch === '\r') { inComment = false; continue; }
      if (inComment) continue;
      if (ch === ';') { inComment = true; continue; }
      if (ch === '}') return i;
    }
    return -1;
  }

  // タグ指定を配列へ正規化する。長いものから試すよう並べ替える
  // ('v'と'vr'のように片方がもう片方の接頭辞になる組でも取り違えないため)
  function normalizeTags(tag) {
    const list = Array.isArray(tag) ? tag.slice() : [tag == null ? '' : tag];
    return list.map(String).sort((a, b) => b.length - a.length);
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * `@TAG<n> = {` を全文から探し、定義ブロックの範囲を返す。
   * @param {string} source   MML全文
   * @param {string|string[]} tag  'FM' / ['OP','OT'] のようなタグ名。''(空文字)は
   *                               "@"の直後が数字の形(デューティエンベロープ定義 `@1={...}`)
   * @returns {{tag:string,index:number,start:number,end:number,contentStart:number,contentEnd:number}[]}
   *          tagは引数で渡した綴り(ソース側の大文字小文字には従わない)。
   *          start/endは"@"から"}"の次までの絶対位置、contentStart/contentEndは"{"と"}"の内側
   */
  function scan(source, tag) {
    const tags = normalizeTags(tag);
    const alt = tags.map(escapeRegExp).join('|');
    const re = new RegExp('@(' + alt + ')(\\d+)\\s*=\\s*\\{', 'gi');
    const out = [];
    let m;
    while ((m = re.exec(source)) !== null) {
      if (isInComment(source, m.index)) continue;
      const braceStart = m.index + m[0].length - 1;
      const closeIdx = findCloseBrace(source, braceStart);
      if (closeIdx === -1) continue;
      // ソース側の綴りではなく、呼び出し側が渡したタグ名を返す(switchで分岐できるように)
      const matched = tags.find((t) => t.toUpperCase() === m[1].toUpperCase());
      out.push({
        tag: matched == null ? m[1] : matched,
        index: parseInt(m[2], 10),
        start: m.index,
        end: closeIdx + 1,
        contentStart: braceStart + 1,
        contentEnd: closeIdx
      });
    }
    return out;
  }

  /** 番号を指定して定義1件の範囲を返す(無ければnull)。タグを複数渡した場合は最初に見つかったもの */
  function find(source, tag, index) {
    return scan(source, tag).find((d) => d.index === index) || null;
  }

  /** 定義されている番号の一覧(昇順・重複なし) */
  function indices(source, tag) {
    return [...new Set(scan(source, tag).map((d) => d.index))].sort((a, b) => a - b);
  }

  /** 文字位置posを含む定義(エディタのダブルクリックで開く用)。無ければnull */
  function enclosing(source, pos, tag) {
    return scan(source, tag).find((d) => pos >= d.start && pos <= d.end) || null;
  }

  /** 定義の中身を空白/カンマ区切りのトークン列で返す(コメント除去済み)。定義が無ければnull */
  function tokens(source, tag, index) {
    const range = find(source, tag, index);
    if (!range) return null;
    return stripComments(source.slice(range.contentStart, range.contentEnd))
      .trim().split(/[\s,]+/).filter((s) => s.length > 0);
  }

  /** 定義の中身を数値の配列で返す。定義が無ければnull */
  function values(source, tag, index) {
    const list = tokens(source, tag, index);
    return list ? list.map(parseNumber) : null;
  }

  /**
   * 値の並びを `@TAG<n> = { ... }` の1定義テキストへ整形する。
   * @param {object} [opt] perLine:1行あたりの個数(既定Infinity) / sep:区切り(既定', ') /
   *                      indent:2行目以降の字下げ(既定8スペース) / prefix:本体の先頭に置く文字列
   */
  function format(tag, index, parts, opt) {
    const o = opt || {};
    const perLine = o.perLine || Infinity;
    const sep = o.sep == null ? ', ' : o.sep;
    const indent = o.indent == null ? '\n        ' : o.indent;
    const rows = [];
    for (let i = 0; i < parts.length; i += perLine) rows.push(parts.slice(i, i + perLine).join(sep));
    return `@${tag}${index} = { ${o.prefix || ''}${rows.join(indent)} }`;
  }

  // 先頭から続く「定義行ブロック」(@ / # / $ で始まる行、その{}内の継続行、空行、
  // コメント行)を走査する共通処理。keep=trueならその行を集めて返し、
  // keep=falseならブロックが終わる位置(=チャンネル本文の最初の行の先頭)を返す
  function scanLeadingDefs(source, keep) {
    const rawLines = String(source).split(/\r\n|\r|\n/);
    const kept = [];
    let depth = 0;
    let offset = 0;
    for (const rawLine of rawLines) {
      const commentIdx = rawLine.indexOf(';');
      const codePart = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;
      const trimmed = codePart.trim();
      const isDefLine = depth > 0 || trimmed === '' ||
        trimmed[0] === '@' || trimmed[0] === '#' || trimmed[0] === '$';
      if (!isDefLine && !keep) return offset;
      if (isDefLine && keep) kept.push(rawLine);
      for (const ch of codePart) {
        if (ch === '{') depth++;
        else if (ch === '}') depth = Math.max(0, depth - 1);
      }
      offset += rawLine.length + 1;
    }
    return keep ? kept.join('\n') : String(source).length;
  }

  /** 新規定義の挿入位置(先頭の定義行ブロックの直後=チャンネル本文の手前) */
  function insertionOffset(source) {
    return scanLeadingDefs(source, false);
  }

  /** 定義行だけを抜き出す(試聴用の一時MMLへ音色/波形定義を持ち込むために使う) */
  function definitionLines(source) {
    return scanLeadingDefs(source, true);
  }

  /**
   * 定義テキストを差し替えた(無ければ挿入した)新しいMML全文を返す。
   * @param {object} [opt] anchor:{tag,index} を渡すと、新規挿入先をその定義の直後にする
   *                       (DPCMの分割定義を親の隣へ並べるため)
   */
  function replaceOrInsert(source, tag, index, text, opt) {
    const range = find(source, tag, index);
    if (range) return source.slice(0, range.start) + text + source.slice(range.end);
    const anchorSpec = (opt && opt.anchor) || null;
    const anchor = anchorSpec ? find(source, anchorSpec.tag, anchorSpec.index) : null;
    if (anchor) {
      const nl = source.indexOf('\n', anchor.end);
      const at = nl < 0 ? source.length : nl + 1;
      const lead = (at === source.length && source[at - 1] !== '\n') ? '\n' : '';
      return source.slice(0, at) + lead + text + '\n' + source.slice(at);
    }
    const offset = insertionOffset(source);
    const sep = (offset > 0 && source[offset - 1] !== '\n') ? '\n' : '';
    return source.slice(0, offset) + sep + text + '\n' + source.slice(offset);
  }

  /** 定義1件を(その行末の改行ごと)取り除いた新しいMML全文を返す */
  function removeDef(source, tag, index) {
    const range = find(source, tag, index);
    if (!range) return source;
    let end = range.end;
    if (source[end] === '\r') end++;
    if (source[end] === '\n') end++;
    return source.slice(0, range.start) + source.slice(end);
  }

  /**
   * MML本文のtextareaへ書き戻す。スクロール位置を保ち、シンタックスハイライト更新の
   * ためにinputイベントを飛ばす(4エディタが同じことをしていた)
   */
  function setSource(textareaEl, newSource) {
    const scrollTop = textareaEl.scrollTop;
    textareaEl.value = newSource;
    textareaEl.scrollTop = scrollTop;
    textareaEl.dispatchEvent(new Event('input'));
  }

  /** textareaに対する replaceOrInsert。反映・新規・プリセット読込・貼り付け時にだけ呼ぶ */
  function write(textareaEl, tag, index, text, opt) {
    setSource(textareaEl, replaceOrInsert(textareaEl.value, tag, index, text, opt));
  }

  /** textareaに対する removeDef */
  function erase(textareaEl, tag, index) {
    setSource(textareaEl, removeDef(textareaEl.value, tag, index));
  }

  /** 既存の定義番号とusedを避けた次の空き番号 */
  function nextFreeIndex(source, tag, used) {
    let n = 0;
    for (const d of scan(source, tag)) n = Math.max(n, d.index + 1);
    for (const u of (used || [])) n = Math.max(n, u + 1);
    return n;
  }

  Defs.parseNumber = parseNumber;
  Defs.stripComments = stripComments;
  Defs.scan = scan;
  Defs.find = find;
  Defs.indices = indices;
  Defs.enclosing = enclosing;
  Defs.tokens = tokens;
  Defs.values = values;
  Defs.format = format;
  Defs.insertionOffset = insertionOffset;
  Defs.definitionLines = definitionLines;
  Defs.replaceOrInsert = replaceOrInsert;
  Defs.removeDef = removeDef;
  Defs.setSource = setSource;
  Defs.write = write;
  Defs.erase = erase;
  Defs.nextFreeIndex = nextFreeIndex;
})(typeof window !== 'undefined' ? window : globalThis);
