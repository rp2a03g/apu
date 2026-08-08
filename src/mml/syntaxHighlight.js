/*
 * MMLシンタックスハイライト
 * MML.Mml.highlight(source) -> HTML文字列
 * MML.Mml.attachHighlighter(textarea, overlay, onUpdate) -> textareaの入力/スクロールに同期してoverlayへハイライトHTMLを反映。
 *   onUpdate(省略可): overlay.innerHTMLを更新するたびに呼ばれるコールバック(再生ハイライト機能が
 *   Mml.buildOffsetIndexでインデックスを再構築するために使う)
 * MML.Mml.buildOffsetIndex(overlay) -> Map<srcStart, Element> (data-s属性を持つ要素の索引)
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Mml = MML.Mml = MML.Mml || {};

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 行内（コメントを除いた部分）をトークンに分割
  // 大文字"D"はD<n>(デチューン)コマンド専用(lexer.js参照)なので音符グループから除外する
  // (小文字dは通常通り音符)
  const TOKEN_RE = /([a-grABCEFGR][+#-]*\d*\.*)|([oOlLvVqQtT@][+-]?\d*\.*)|([&]\d*)|(\[)|(\](\d*))|([><])|(\d+)|(\s+)|(.)/g;

  // bodyStart!=null のとき、各トークンspanに data-s(絶対開始位置)/data-e(絶対終了位置) を
  // 埋め込む。再生ハイライト機能(main.js)がMml.buildOffsetIndexで拾い、再生中は
  // このspan自体にclassList.add/removeするだけで済ませる(毎フレームのDOM総入れ替えを避けるため)
  function highlightBody(body, bodyStart) {
    let out = '';
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(body)) !== null) {
      const text = m[0];
      const esc = escapeHtml(text);
      let cls = null;
      if (m[1] !== undefined) cls = 'tok-note';
      else if (m[2] !== undefined) cls = 'tok-command';
      else if (m[3] !== undefined) cls = 'tok-tie';
      else if (m[4] !== undefined || m[5] !== undefined) cls = 'tok-loop';
      else if (m[7] !== undefined) cls = 'tok-octave';
      else if (m[8] !== undefined) cls = 'tok-number';
      // 空白もspan化する(それ自体に色は付けないが、data-s/data-eを持たせることで
      // 再生範囲の背景ハイライト(main.jsのmml-range-selected)がスペース部分も
      // 途切れず塗れるようにするため)
      else if (m[9] !== undefined) cls = 'tok-space';

      if (cls) {
        if (bodyStart != null) {
          const s = bodyStart + m.index;
          const e = s + text.length;
          out += `<span class="${cls}" data-s="${s}" data-e="${e}">${esc}</span>`;
        } else {
          out += `<span class="${cls}">${esc}</span>`;
        }
      } else {
        out += esc;
      }
    }
    return out;
  }

  function highlightLine(line, lineStart) {
    const commentIdx = line.indexOf(';');
    const body = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
    const comment = commentIdx >= 0 ? line.slice(commentIdx) : '';

    const chanMatch = body.match(/^(\s*)([A-Za-z]+)(\s+|$)/);
    let out = '';
    let rest = body;
    let restStart = lineStart;
    if (chanMatch) {
      out += escapeHtml(chanMatch[1]);
      out += `<span class="tok-channel">${escapeHtml(chanMatch[2])}</span>`;
      out += escapeHtml(chanMatch[3]);
      rest = body.slice(chanMatch[0].length);
      if (restStart != null) restStart += chanMatch[0].length;
    }
    out += highlightBody(rest, restStart);
    if (comment) out += `<span class="tok-comment">${escapeHtml(comment)}</span>`;
    return out;
  }

  // 各行を display:block の <span class="mml-line"> で包む。
  // ★性能上の要点(2026-07-25): これをやらず全行を1つの<pre>(単一のインライン整形
  //   コンテキスト)に流すと、再生ハイライトが中のspan1個のclassを変えるだけでも
  //   ブラウザは<pre>全体を再レイアウト(reflow)する。そのコストはハイライトする要素数
  //   ではなく「オーバーレイ全体のトークン数」に正比例し、文字数の多いMMLでは1フレーム
  //   数十msに達してScriptProcessorNode(メインスレッド音声)ともたつきを起こしていた。
  //   行ごとに独立したブロック(=別々のインライン整形コンテキスト)にすると、再レイアウトは
  //   変更のあった行だけに閉じ、他の全行を巻き込まなくなる(実測で約4倍改善)。
  //   空行は高さ確保のためゼロ幅スペース(​。表示上は不可視)を入れる。
  function wrapLine(inner) {
    return '<span class="mml-line">' + (inner === '' ? '​' : inner) + '</span>';
  }

  Mml.highlight = function (source) {
    const re = /\r\n|\r|\n/g;
    let last = 0;
    let m;
    const parts = [];
    while ((m = re.exec(source)) !== null) {
      parts.push(wrapLine(highlightLine(source.slice(last, m.index), last)));
      last = m.index + m[0].length;
    }
    parts.push(wrapLine(highlightLine(source.slice(last), last)));
    return parts.join('');
  };

  // data-s属性を持つ全spanから Map<絶対開始位置, Element> を構築する。
  // 再生ハイライト機能が毎フレームDOMを再構築せず対象要素をO(1)で引けるようにするため
  Mml.buildOffsetIndex = function (overlay) {
    const map = new Map();
    const nodes = overlay.querySelectorAll('[data-s]');
    for (const el of nodes) map.set(Number(el.dataset.s), el);
    return map;
  };

  Mml.attachHighlighter = function (textarea, overlay, onUpdate) {
    function update() {
      // 各行が独立した display:block の <span class="mml-line"> になったため、
      // 旧実装のような末尾'\n'による高さ補正は不要(空行もwrapLineがゼロ幅スペースで高さ確保する)
      overlay.innerHTML = Mml.highlight(textarea.value);
      if (onUpdate) onUpdate();
    }
    function syncScroll() {
      overlay.scrollTop = textarea.scrollTop;
      overlay.scrollLeft = textarea.scrollLeft;
    }
    textarea.addEventListener('input', update);
    textarea.addEventListener('scroll', syncScroll);
    update();
    syncScroll();
  };
})(window);
