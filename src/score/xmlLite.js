/*
 * 小さな XML パーサ(MusicXML 取り込み用、2026-09-16)
 *
 * ブラウザの DOMParser に頼らない(ヘッドレスの Node でも同じコードで動かすため)。
 * 扱うのは: XML宣言/DOCTYPE/コメント/処理命令(読み飛ばし)、要素と属性、テキスト、CDATA、
 * 文字実体(&amp; &lt; &gt; &quot; &apos; と数値参照)。名前空間は名前の一部としてそのまま持つ。
 * 整形式でない入力は Error を投げる(タグの対応が取れない、閉じていない)。
 *
 *   const root = MML.XmlLite.parse(text)   → { name, attrs:{}, children:[node...], text:'' }
 *   MML.XmlLite.child(node, name) / children(node, name) / text(node) / childText(node, name)
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const XmlLite = MML.XmlLite = MML.XmlLite || {};

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function decode(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
      if (e[0] === '#') { const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(cp) ? String.fromCodePoint(cp) : m; }
      return ENTITIES[e] != null ? ENTITIES[e] : m;
    });
  }

  XmlLite.parse = function (text) {
    const s = String(text == null ? '' : text);
    const n = s.length;
    let i = 0;
    const root = { name: '#document', attrs: {}, children: [], text: '' };
    const stack = [root];
    const top = () => stack[stack.length - 1];
    const addText = (t) => { if (!t) return; const cur = top(); cur.text += t; cur.children.push({ name: '#text', attrs: {}, children: [], text: t }); };
    while (i < n) {
      const lt = s.indexOf('<', i);
      if (lt < 0) { addText(decode(s.slice(i))); break; }
      if (lt > i) addText(decode(s.slice(i, lt)));
      i = lt;
      if (s.startsWith('<!--', i)) { const e = s.indexOf('-->', i + 4); if (e < 0) throw new Error('XML: コメントが閉じていません'); i = e + 3; continue; }
      if (s.startsWith('<![CDATA[', i)) { const e = s.indexOf(']]>', i + 9); if (e < 0) throw new Error('XML: CDATA が閉じていません'); addText(s.slice(i + 9, e)); i = e + 3; continue; }
      if (s.startsWith('<?', i)) { const e = s.indexOf('?>', i + 2); if (e < 0) throw new Error('XML: 処理命令が閉じていません'); i = e + 2; continue; }
      if (s.startsWith('<!', i)) {
        // DOCTYPE(内部サブセット [...] を含むこともある)
        let depth = 0, j = i + 2;
        for (; j < n; j++) { const c = s[j]; if (c === '[') depth++; else if (c === ']') depth--; else if (c === '>' && depth <= 0) break; }
        if (j >= n) throw new Error('XML: DOCTYPE が閉じていません');
        i = j + 1; continue;
      }
      if (s[i + 1] === '/') {
        const e = s.indexOf('>', i + 2);
        if (e < 0) throw new Error('XML: 閉じタグが壊れています');
        const name = s.slice(i + 2, e).trim();
        const cur = top();
        if (cur === root || cur.name !== name) throw new Error(`XML: 閉じタグ </${name}> が <${cur.name}> と対応しません`);
        stack.pop();
        i = e + 1; continue;
      }
      // 開始タグ
      let j = i + 1;
      while (j < n && !/[\s/>]/.test(s[j])) j++;
      const name = s.slice(i + 1, j);
      if (!name) throw new Error('XML: 要素名がありません');
      const node = { name, attrs: {}, children: [], text: '' };
      let selfClose = false;
      for (;;) {
        while (j < n && /\s/.test(s[j])) j++;
        if (j >= n) throw new Error('XML: タグが閉じていません <' + name);
        if (s[j] === '/') { selfClose = true; j++; continue; }
        if (s[j] === '>') { j++; break; }
        let k = j;
        while (k < n && !/[\s=/>]/.test(s[k])) k++;
        const aname = s.slice(j, k);
        j = k;
        while (j < n && /\s/.test(s[j])) j++;
        if (s[j] !== '=') { node.attrs[aname] = ''; continue; }
        j++;
        while (j < n && /\s/.test(s[j])) j++;
        const q = s[j];
        if (q !== '"' && q !== "'") throw new Error('XML: 属性値が引用符で囲まれていません ' + aname);
        const e = s.indexOf(q, j + 1);
        if (e < 0) throw new Error('XML: 属性値が閉じていません ' + aname);
        node.attrs[aname] = decode(s.slice(j + 1, e));
        j = e + 1;
      }
      top().children.push(node);
      if (!selfClose) stack.push(node);
      i = j;
    }
    if (stack.length !== 1) throw new Error(`XML: <${top().name}> が閉じていません`);
    const first = root.children.find(c => c.name !== '#text');
    if (!first) throw new Error('XML: ルート要素がありません');
    return first;
  };

  XmlLite.child = (node, name) => (node && node.children.find(c => c.name === name)) || null;
  XmlLite.children = (node, name) => (node ? node.children.filter(c => c.name === name) : []);
  XmlLite.text = (node) => (node ? node.text.trim() : '');
  XmlLite.childText = (node, name, dflt) => { const c = XmlLite.child(node, name); return c ? c.text.trim() : (dflt == null ? '' : dflt); };
  XmlLite.childInt = (node, name, dflt) => { const t = XmlLite.childText(node, name, null); if (t == null || t === '') return dflt; const v = parseInt(t, 10); return Number.isFinite(v) ? v : dflt; };
  XmlLite.childFloat = (node, name, dflt) => { const t = XmlLite.childText(node, name, null); if (t == null || t === '') return dflt; const v = parseFloat(t); return Number.isFinite(v) ? v : dflt; };
})(window);
