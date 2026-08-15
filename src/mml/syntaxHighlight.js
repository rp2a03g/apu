/*
 * MMLシンタックスハイライト
 * MML.Mml.highlight(source) -> HTML文字列
 * MML.Mml.attachHighlighter(textarea, overlay, onUpdate) -> textareaの入力/スクロールに同期してoverlayへハイライトHTMLを反映。
 *   onUpdate(省略可): overlay.innerHTMLを更新するたびに呼ばれるコールバック(再生ハイライト機能が
 *   Mml.buildOffsetIndexでインデックスを再構築するために使う)
 *
 * 色分け12分類(色自体は src/css/style.css の --tok-* カスタムプロパティ、
 * src/ui/editorSettings.js のプリセット/個別カスタマイズで上書きされる):
 *   tok-header      #で始まるヘッダー/ディレクティブ行全体
 *   tok-track       行頭のトラックチャンネル文字(A-Z, ab)
 *   tok-note        音階(cdefgab)+音長+付点
 *   tok-rest        休符(r)+音長+付点
 *   tok-cmd-length  音長系: t,@t,l,q,@q,-,~,&,^,{},w
 *   tok-cmd-volume  音量系: v,v+,v-,@v,@vr,EH,k,S,M
 *   tok-cmd-pitch   音程系: o,<,>,n,@n,D,MP,MPOF,EP,EPOF,EN,ENOF,SM,SMOF,PS,s,K,SA(,PT/PTOFも同系統として含む)
 *   tok-cmd-perf    演奏制御系: L,[ | ],|: \ :|,SD,SDOF,SDQR
 *   tok-cmd-special 特殊: !,!!,!!!,y,x,NB
 *   tok-def-envelope  エンベロープデータ定義行(@v<n>/@vr<n>/@EP<n>/@EN<n>/@MP<n> = {...}の先頭キーワード)
 *   tok-def-tone      音色データ定義行(@OP/@OT/@FM/@MW/@MH/@N/@DPCM/@<n> = {...}の先頭キーワード)、
 *                     および音色選択コマンド@@<n>/@@r<n>、
 *                      および本体中のOP/OPOF,MH/MHOF,N(FME7ノイズ)コマンド使用側も同じ色に統一
 *   tok-comment     ;以降のコメント
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Mml = MML.Mml = MML.Mml || {};

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // トラック本体テキストを分類するトークン列。曖昧な前方一致(例: "S"単体 vs "SD"/"SM",
  // "M"単体 vs "MP"/"MH", "O"単体 vs "OP", "N"単体 vs "NB")を正しく解決するため、
  // 長い/具体的なキーワードを必ず先に置く(alternationは書かれた順に試すため)。
  // 大文字小文字の扱いはsrc/mml/lexer.jsのswitch(c)に合わせる: コマンドの先頭文字は
  // lexer側がcase 'X':と単一caseで分岐している箇所のみ大文字/小文字を区別し、
  // 接尾語(2文字目以降)はlexerがstr[i]==='x'||str[i]==='X'の形で両対応している箇所のみ
  // 大文字小文字を許容する。
  const ORDERED_TOKENS = [
    // --- 演奏制御系 ---
    ['tok-cmd-perf', 'S[Dd][Qq][Rr]'],       // SDQR
    ['tok-cmd-perf', 'S[Dd][Oo][Ff]'],       // SDOF
    ['tok-cmd-perf', 'S[Dd]\\d*'],           // SD<n>
    ['tok-cmd-perf', 'L'],                   // ループ地点マーカー(大文字のみ、小文字lは音長系)
    ['tok-cmd-perf', '\\|:'],                // |: ~ \ ~ :| (独自拡張表記、参考として着色のみ)
    ['tok-cmd-perf', ':\\|'],
    ['tok-cmd-perf', '\\\\'],
    ['tok-cmd-perf', '\\['],                 // ループ開始
    ['tok-cmd-perf', '\\|'],                 // ループ区切り
    ['tok-cmd-perf', '\\]\\d*'],             // ループ終了+回数

    // --- 音程系(SM/MP/EP/EN等の"OF"解除形は素の形より先に判定する) ---
    ['tok-cmd-pitch', 'S[Mm][Oo][Ff]'],      // SMOF
    ['tok-cmd-pitch', 'S[Mm]'],              // SM
    ['tok-cmd-pitch', 'M[Pp][Oo][Ff]'],      // MPOF
    ['tok-cmd-pitch', 'M[Pp]\\d*'],          // MP<n>
    // --- 音色データ定義(本体中の使用側もOP/OPOF,MH/MHOF,Nは常にこの色) ---
    ['tok-def-tone', 'M[Hh][Oo][Ff]'],       // MHOF
    ['tok-def-tone', 'M[Hh]\\d*'],           // MH<n>
    ['tok-cmd-pitch', 'E[Pp][Oo][Ff]'],      // EPOF
    ['tok-cmd-pitch', 'E[Pp]\\d*(?:,\\d+)?'],// EP<n>[,<delay>]
    ['tok-cmd-pitch', 'E[Nn][Oo][Ff]'],      // ENOF
    ['tok-cmd-pitch', 'E[Nn]\\d*'],          // EN<n>
    ['tok-cmd-volume', 'E[Hh]'],             // EH(EP/ENに一致しなかった場合のフォールバック)
    ['tok-def-tone', 'O[Pp][Oo][Ff]'],       // OPOF
    ['tok-def-tone', 'O[Pp]\\d*'],           // OP<n>
    ['tok-cmd-pitch', '[oO]\\d*'],           // o<n>(オクターブ、OP/OPOFに一致しなかった場合)
    ['tok-cmd-special', 'NB'],               // NB(音色データ定義のN<n>に一致しなかった場合)
    ['tok-def-tone', 'N\\d*'],               // N<n>(FME7ノイズ周波数、大文字のみ)

    // --- 音色系(@@は@より先に判定する) ---
    ['tok-def-tone', '@@[Rr]\\d*'],          // @@r<n>(リリース音色)
    ['tok-def-tone', '@@\\d*'],              // @@<n>(デューティ=音色エンベロープ選択)
    // --- 音量系 ---
    ['tok-cmd-volume', '@[Vv][Rr]\\d*'],     // @vr<n>(リリースエンベロープ)
    ['tok-cmd-volume', '@[Vv]\\d*'],         // @v<n>(音量エンベロープ選択)
    // --- 音長系(@q/@tは@vより先でなくても@v/@qの接尾語が食い違うので順不同で安全) ---
    ['tok-cmd-length', '@[Qq]\\d*'],         // @q<n>
    ['tok-cmd-length', '@[Tt]\\d*\\.*(?:,\\d+)?'], // @t<len>,<num>
    ['tok-cmd-pitch', '@\\d+'],              // @<n>(素の楽器/インストゥルメント選択)

    ['tok-cmd-volume', '[vV][+-]\\d*'],      // v+<n>/v-<n>
    ['tok-cmd-volume', '[vV]\\d*'],          // v<n>
    ['tok-cmd-length', '[tT]\\d*'],          // t<n>(テンポ)
    ['tok-cmd-length', 'l\\d*\\.*'],         // l<n>(デフォルト音長、小文字のみ)
    ['tok-cmd-length', '[qQ]\\d*'],          // q<n>(ゲート)
    ['tok-cmd-length', '[wW]\\d*\\.*'],      // w<len>(ウェイト)
    ['tok-cmd-length', '&'],                 // タイ
    ['tok-cmd-length', '\\^'],               // 音長タイ(短縮形)
    ['tok-cmd-length', '-'],                 // 音長タイ(短縮形、音符の付随修飾以外の単独出現時)
    ['tok-cmd-length', '~'],                 // 音長タイ(短縮形)
    ['tok-cmd-length', '\\{'],               // 連符開始
    ['tok-cmd-length', '\\}\\d*\\.*'],       // 連符終了+音長+付点

    ['tok-cmd-pitch', '<'],                  // オクターブダウン
    ['tok-cmd-pitch', '>'],                  // オクターブアップ
    ['tok-cmd-pitch', 'D[+-]?\\d*'],         // D<n>(デチューン、大文字のみ)
    ['tok-cmd-pitch', 'K[+-]?\\d*'],         // K<n>(移調、大文字のみ)
    ['tok-cmd-pitch', 'P[Tt][Oo][Ff]'],      // PTOF(ポルタメント解除)
    ['tok-cmd-pitch', 'P[Tt][+-]?\\d*(?:,\\d+)?(?:,\\d+)?'], // PT<target>,<duration>,<delay>
    ['tok-cmd-pitch', 'P[Ss]'],              // PS(ポルタメント、ppmck本家系)
    ['tok-cmd-pitch', 'n\\d*(?:,\\d+\\.*)?'],// n<num>,<length>(直接音程指定、小文字のみ)
    ['tok-cmd-pitch', 's\\d*(?:,\\d*)?'],    // s<speed>,<depth>(スイープ、小文字のみ)
    ['tok-cmd-pitch', 'S[Aa]'],              // SA(SD/SMに一致しなかった場合のフォールバック)
    ['tok-cmd-volume', 'S\\d*'],             // S<n>(FME7エンベロープ形状、大文字のみ)
    ['tok-cmd-volume', 'M\\d*'],             // M<n>(FME7エンベロープ周期、大文字のみ)
    ['tok-cmd-volume', 'k'],                 // k(小文字、Kとは別コマンド)

    ['tok-cmd-special', '!!!'],              // 再生終了位置
    ['tok-cmd-special', '!!'],               // 再生開始位置
    ['tok-cmd-special', '!'],                // データスキップ
    ['tok-cmd-special', 'y(?:\\$[0-9a-fA-F]*|\\d*)(?:,(?:\\$[0-9a-fA-F]*|\\d*))?'], // yレジスタ書込み
    ['tok-cmd-special', 'x(?:\\$[0-9a-fA-F]*|\\d*)(?:,(?:\\$[0-9a-fA-F]*|\\d*))?'], // xバイト埋込み

    // --- 音階・音長/休符(コマンド判定に一致しなかった残りの文字だけがここに来る) ---
    ['tok-note', '(?:[a-g]|[A-CE-G])[+#-]*\\d*\\.*'],
    ['tok-rest', '[rR][+#-]*\\d*\\.*']
  ];

  const BODY_TOKEN_RE = new RegExp(
    ORDERED_TOKENS.map(([, src]) => '(' + src + ')').join('|') + '|(\\d+)|(\\s+)|(.)',
    'g'
  );
  // 末尾3つの固定グループ(数値/空白/その他)のうち、空白だけ data-s/data-e を持つ
  // 無色spanにする(範囲ハイライトの帯を途切れさせないため)。数値/その他は無着色のまま。
  const SPACE_GROUP = ORDERED_TOKENS.length + 2;

  // @v<n>/@vr<n>/@EP<n>/@EN<n>/@MP<n> = {...} (エンベロープデータ定義)
  const ENVELOPE_DEF_PREFIX_RE = /^(\s*)(@(?:v[rR]?|EP|EN|MP)\d+)(\s*=\s*\{)/i;
  // @OP<n>/@OT<n>/@FM<n>/@MW<n>/@MH<n>/@N<n>/@DPCM<n> = {...} (音色データ定義)。
  // @<n> = {...}(デューティ=音色エンベロープ定義、@@<n>で選択する)も同じ扱いにする
  const TONE_DEF_PREFIX_RE = /^(\s*)(@(?:OP|OT|FM|MW|MH|N|DPCM)?\d+)(\s*=\s*\{)/i;

  // 行内(コメントを除いた部分)をトークンに分割
  function highlightBody(body, bodyStart) {
    let out = '';
    let m;
    BODY_TOKEN_RE.lastIndex = 0;
    while ((m = BODY_TOKEN_RE.exec(body)) !== null) {
      const text = m[0];
      const esc = escapeHtml(text);
      let cls = null;
      for (let g = 0; g < ORDERED_TOKENS.length; g++) {
        if (m[g + 1] !== undefined) { cls = ORDERED_TOKENS[g][0]; break; }
      }
      // 空白もspan化する(それ自体に色は付けないが、data-s/data-eを持たせることで
      // 再生範囲の背景ハイライト(main.jsのmml-range-selected)がスペース部分も
      // 途切れず塗れるようにするため)
      if (!cls && m[SPACE_GROUP] !== undefined) cls = 'tok-space';

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
    // #で始まる行(ヘッダー/ディレクティブ)は行全体を1色で扱う(コメント分離やコマンド分割はしない)
    if (/^\s*#/.test(line)) {
      return `<span class="tok-header">${escapeHtml(line)}</span>`;
    }

    const commentIdx = line.indexOf(';');
    const body = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
    const comment = commentIdx >= 0 ? line.slice(commentIdx) : '';

    // エンベロープ/音色データ定義行: 先頭の"@キーワード<n>"部分だけ定義色で着色し、
    // "= { ... }"の中身は無着色のプレーンテキストとして出す
    const envDef = body.match(ENVELOPE_DEF_PREFIX_RE);
    const toneDef = !envDef && body.match(TONE_DEF_PREFIX_RE);
    const def = envDef || toneDef;
    if (def) {
      const cls = envDef ? 'tok-def-envelope' : 'tok-def-tone';
      let out = escapeHtml(def[1]);
      out += `<span class="${cls}">${escapeHtml(def[2])}</span>`;
      out += escapeHtml(body.slice(def[1].length + def[2].length));
      if (comment) out += `<span class="tok-comment">${escapeHtml(comment)}</span>`;
      return out;
    }

    const chanMatch = body.match(/^(\s*)([A-Za-z]+)(\s+|$)/);
    let out = '';
    let rest = body;
    let restStart = lineStart;
    if (chanMatch) {
      out += escapeHtml(chanMatch[1]);
      out += `<span class="tok-track">${escapeHtml(chanMatch[2])}</span>`;
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
