/*
 * MMLヘルプパネル (MML.UI.HelpPanel)
 *
 * MML本文中の ";@help" タグ(src/mml/helpIndex.js)を索引化して一覧表示し、項目ごとに
 * 実演スニペットをその場で鳴らす。ヘルプの中身は別ファイルではなくMMLそのものなので、
 * ユーザーが自分のMMLに ";@help" を書けば、そのまま自分用の項目としてここに増える
 * (「ヘルプをカスタマイズする」の実体)。
 *
 * 表示ソースは3通り:
 *   組み込みサンプル … Mml.SAMPLE_SOURCE(このツールの公式リファレンス)
 *   エディタ本文     … 今MMLエディタに入っている本文(自分で書いたタグ)
 *   両方             … 上記を続けて表示(同じコマンドが両方にある場合は両方出す)
 *
 * 再生は既存のFDS/N163波形エディタと同じ流儀(MML.Mml.compile + MML.Audio.MmlStreamPlayer)。
 * メインの再生とは独立した専用AudioContextを持ち、ウィンドウを閉じると必ず止める。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};

  const T = (key, params) => (MML.I18n ? MML.I18n.t(key, params) : key);

  UI.HelpPanel = {
    init() {
      const win = document.getElementById('win-help');
      if (!win) return;
      const mmlSourceEl = document.getElementById('mmlSource');
      const listEl = document.getElementById('helpList');
      const indexBoxEl = document.getElementById('helpIndexBox');
      const categoryEl = document.getElementById('helpCategory');
      const sourceEl = document.getElementById('helpSource');
      const statusEl = document.getElementById('helpStatus');
      const lintEl = document.getElementById('helpLint');
      const lintToggleEl = document.getElementById('helpLintToggle');
      const stopBtn = document.getElementById('helpStopAll');

      let entries = [];       // { entry, origin: 'sample'|'editor', source }
      let audioCtx = null;
      let player = null;
      let playingId = null;

      // ---- 再生 ----
      // 既定はメインのMML再生経路(MML.UI.MmlPlayback)へ委譲する。こうすると鍵盤表示・
      // ピアノロール・レジスタモニタ・シークバー・ch別ミュート/音量が、ヘルプの実演にも
      // そのまま効く。main.jsが無い(単体テスト等)場合だけ、このパネル専用の
      // 簡易プレイヤーへフォールバックする
      const useMainTransport = () => !!(MML.UI && MML.UI.MmlPlayback);

      function stopPlayback() {
        if (useMainTransport() && playingId) MML.UI.MmlPlayback.stop();
        if (player) { player.destroy(); player = null; }
        playingId = null;
        listEl.querySelectorAll('.help-play.playing').forEach(b => {
          b.classList.remove('playing');
          b.textContent = '▶';
        });
        statusEl.textContent = '';
      }

      function play(item, btn) {
        const wasPlaying = playingId;
        stopPlayback();
        if (wasPlaying === item.entry.id) return;   // 同じ項目の再クリックは停止扱い

        const source = MML.HelpIndex.playableSource(item.source, item.entry);

        if (useMainTransport()) {
          // 停止(曲末/メインの■ボタン/他の再生開始)はメイン側から通知される
          const started = MML.UI.MmlPlayback.playSource(
            source, T('ヘルプ: {title}', { title: item.entry.title }), () => {
              playingId = null;
              listEl.querySelectorAll('.help-play.playing').forEach(b => { b.classList.remove('playing'); b.textContent = '▶'; });
              statusEl.textContent = '';
            });
          if (!started) {
            statusEl.className = 'output help-status error';
            statusEl.textContent = T('この項目は再生できませんでした(MMLエディタ側のエラー表示を確認してください)。');
            return;
          }
          playingId = item.entry.id;
          btn.classList.add('playing');
          btn.textContent = '■';
          statusEl.className = 'output help-status ok';
          statusEl.textContent = T('再生中: {title}', { title: item.entry.title });
          return;
        }

        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        audioCtx.resume();
        const compiled = MML.Mml.compile(source, {});
        if (compiled.errors.length > 0) {
          statusEl.className = 'output help-status error';
          statusEl.textContent = T('エラー:') + ' ' + compiled.errors.map(e => e.message).join(' / ');
          return;
        }
        player = new MML.Audio.MmlStreamPlayer(audioCtx);
        player.load(compiled, null);
        player.onEnded = () => stopPlayback();
        player.play();
        playingId = item.entry.id;
        btn.classList.add('playing');
        btn.textContent = '■';
        statusEl.className = 'output help-status ok';
        statusEl.textContent = T('再生中: {title}', { title: item.entry.title });
      }

      // ---- エディタの該当行へジャンプ ----
      function jumpToEditor(item) {
        if (item.origin !== 'editor' || !mmlSourceEl) return;
        const lines = mmlSourceEl.value.split('\n');
        let offset = 0;
        for (let i = 0; i < item.entry.lineNo - 1 && i < lines.length; i++) offset += lines[i].length + 1;
        const end = offset + (lines[item.entry.lineNo - 1] || '').length;
        mmlSourceEl.focus();
        mmlSourceEl.setSelectionRange(offset, end);
        // 選択位置がビューの中央あたりに来るようスクロールさせる
        const lineHeight = parseFloat(getComputedStyle(mmlSourceEl).lineHeight) || 16;
        mmlSourceEl.scrollTop = Math.max(0, (item.entry.lineNo - 1) * lineHeight - mmlSourceEl.clientHeight / 2);
      }

      // ---- 索引の再構築 ----
      function collectSources() {
        const mode = sourceEl.value;
        const out = [];
        if (mode === 'sample' || mode === 'both') {
          out.push({ origin: 'sample', label: T('組み込みサンプル'), text: MML.Mml.sampleSource() });
        }
        if ((mode === 'editor' || mode === 'both') && mmlSourceEl) {
          out.push({ origin: 'editor', label: T('エディタ本文'), text: mmlSourceEl.value });
        }
        return out;
      }

      function rebuild() {
        stopPlayback();
        entries = [];
        const lintLines = [];
        for (const src of collectSources()) {
          const parsed = MML.HelpIndex.parse(src.text);
          for (const entry of parsed.entries) {
            entries.push({ entry, origin: src.origin, originLabel: src.label, source: src.text });
          }
          for (const e of parsed.errors) {
            lintLines.push(T('[{src} {line}行] {msg}', { src: src.label, line: e.lineNo, msg: e.message }));
          }
        }
        // カテゴリ選択肢
        const categories = [];
        for (const it of entries) if (it.entry.category && !categories.includes(it.entry.category)) categories.push(it.entry.category);
        const keep = categoryEl.value;
        categoryEl.innerHTML = '';
        const allOpt = document.createElement('option');
        allOpt.value = '';
        allOpt.textContent = T('すべて');
        categoryEl.appendChild(allOpt);
        for (const c of categories) {
          const o = document.createElement('option');
          o.value = c; o.textContent = T(c); // カテゴリ名は ;@help タグの原文(日本語)。辞書にあれば訳す
          categoryEl.appendChild(o);
        }
        categoryEl.value = categories.includes(keep) ? keep : '';

        lintEl.textContent = lintLines.length
          ? lintLines.join('\n')
          : T('問題は見つかりませんでした(書式・重複コマンド)。');
        render();
      }

      /* ---- コマンド索引 ----
       * 「このコマンドは何だっけ」を引くための索引なので、項目単位ではなくコマンド単位で並べる
       * (1項目が SD<n>/SDOF/SDQR のように複数コマンドを持つため)。素のASCII順だと
       * 記号・"@"付き・"#"付きが入り混じって引きにくいので、4群に分けてから群ごとに
       * アルファベット順(接頭辞の @ / # は無視)に並べる。
       */
      const INDEX_GROUPS = [
        { key: 'alpha',  label: () => T('A-Z(音符・コマンド)'), test: c => /^[A-Za-z]/.test(c) },
        { key: 'at',     label: () => T('@ で始まるもの'),      test: c => c.startsWith('@') },
        { key: 'hash',   label: () => T('# ヘッダ指示子'),      test: c => c.startsWith('#') },
        { key: 'symbol', label: () => T('記号'),                test: () => true }
      ];

      // 先頭の @ / # は1個だけ落として並べる(こうすると "@@<n>" と "@@r<n>" が隣り合い、
      // それ以外は "@v<n>" → v、"#TITLE" → title のように中身のアルファベット順になる)
      function sortKeyOf(cmd) {
        return cmd.replace(/^[@#]/, '').toLowerCase();
      }

      function renderIndex() {
        indexBoxEl.innerHTML = '';
        if (indexBoxEl.style.display === 'none') return;
        // コマンド→項目。重複(同じコマンドが両方のソースにある等)は最初のものを採る
        const seen = new Map();
        for (const item of entries) {
          for (const cmd of item.entry.commands) {
            if (!seen.has(cmd)) seen.set(cmd, item);
          }
        }
        const buckets = new Map(INDEX_GROUPS.map(g => [g.key, []]));
        for (const [cmd, item] of seen) {
          const group = INDEX_GROUPS.find(g => g.test(cmd));
          buckets.get(group.key).push({ cmd, item });
        }
        for (const group of INDEX_GROUPS) {
          const list = buckets.get(group.key);
          if (!list.length) continue;
          // 記号群だけは辞書順(localeCompare)だと句読点の重みで直感に反する並びになるので符号位置順
          const cmp = group.key === 'symbol'
            ? (x, y) => (x.cmd < y.cmd ? -1 : x.cmd > y.cmd ? 1 : 0)
            : (x, y) => sortKeyOf(x.cmd).localeCompare(sortKeyOf(y.cmd)) || (x.cmd < y.cmd ? -1 : 1);
          list.sort(cmp);
          const label = document.createElement('div');
          label.className = 'help-index-label';
          label.textContent = group.label();
          indexBoxEl.appendChild(label);
          for (const { cmd, item } of list) {
            const row = document.createElement('div');
            row.className = 'help-index-item';
            row.tabIndex = 0;
            const code = document.createElement('code');
            code.className = 'help-index-cmd';
            code.textContent = cmd;
            const title = document.createElement('span');
            title.className = 'help-index-title';
            title.textContent = item.entry.title;
            row.appendChild(code);
            row.appendChild(title);
            row.addEventListener('click', () => jumpToEntry(item));
            row.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); jumpToEntry(item); } });
            indexBoxEl.appendChild(row);
          }
        }
      }

      // 索引のコマンドをクリックしたとき、その項目までスクロールして一瞬光らせる
      function jumpToEntry(item) {
        // カテゴリで絞り込み中に索引から飛ぶと対象が描画されていないので、絞り込みを解除する
        const target = () => document.getElementById('card-' + item.origin + '-' + item.entry.id);
        if (!target() && categoryEl.value) { categoryEl.value = ''; render(); }
        const el = target();
        if (!el) return;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.remove('help-card--flash');
        void el.offsetWidth;                    // アニメーションを再スタートさせる
        el.classList.add('help-card--flash');
      }

      // ---- 一覧描画 ----
      function render() {
        const cat = categoryEl.value;
        listEl.innerHTML = '';
        let shown = 0;
        let lastChapter = null;

        for (const item of entries) {
          const e = item.entry;
          if (cat && e.category !== cat) continue;
          const chapterKey = item.originLabel + ' / ' + (e.chapter || '');
          if (chapterKey !== lastChapter) {
            lastChapter = chapterKey;
            const h = document.createElement('div');
            h.className = 'help-chapter';
            h.textContent = chapterKey;
            listEl.appendChild(h);
          }

          const card = document.createElement('div');
          card.className = 'help-card';
          card.id = 'card-' + item.origin + '-' + e.id;   // コマンド索引からのジャンプ先

          const head = document.createElement('div');
          head.className = 'help-card-head';
          const cmd = document.createElement('code');
          cmd.className = 'help-cmd';
          cmd.textContent = e.commands.join('  ');
          const title = document.createElement('span');
          title.className = 'help-title';
          title.textContent = e.title;
          head.appendChild(cmd);
          head.appendChild(title);

          const actions = document.createElement('span');
          actions.className = 'help-actions';
          if (e.playable) {
            const playBtn = document.createElement('button');
            playBtn.className = 'secondary help-play';
            playBtn.textContent = '▶';
            playBtn.title = T('この項目を聴く');
            playBtn.addEventListener('click', () => play(item, playBtn));
            actions.appendChild(playBtn);
          }
          if (item.origin === 'editor') {
            const jumpBtn = document.createElement('button');
            jumpBtn.className = 'secondary';
            jumpBtn.textContent = '↧';
            jumpBtn.title = T('エディタの該当行へ移動');
            jumpBtn.addEventListener('click', () => jumpToEditor(item));
            actions.appendChild(jumpBtn);
          }
          if (e.snippet) {
            const copyBtn = document.createElement('button');
            copyBtn.className = 'secondary';
            copyBtn.textContent = '📋';
            copyBtn.title = T('実演MMLをコピー');
            copyBtn.addEventListener('click', () => {
              navigator.clipboard.writeText(e.snippet).then(
                () => { statusEl.className = 'output help-status ok'; statusEl.textContent = T('コピーしました'); },
                () => { statusEl.className = 'output help-status error'; statusEl.textContent = T('コピーできませんでした'); }
              );
            });
            actions.appendChild(copyBtn);
          }
          head.appendChild(actions);
          card.appendChild(head);

          const useEn = MML.I18n && MML.I18n.getLang && MML.I18n.getLang() !== 'ja';
          const bodyText = (useEn && e.bodyEn) ? e.bodyEn : e.body;
          if (bodyText) {
            const body = document.createElement('div');
            body.className = 'help-body';
            body.textContent = bodyText;
            card.appendChild(body);
          }
          if (e.snippet) {
            const pre = document.createElement('pre');
            pre.className = 'help-snippet';
            pre.textContent = e.snippet;
            card.appendChild(pre);
          }
          listEl.appendChild(card);
          shown++;
        }

        if (shown === 0) {
          const empty = document.createElement('div');
          empty.className = 'help-empty';
          empty.textContent = T('該当する項目がありません。');
          listEl.appendChild(empty);
        }
        renderIndex();
      }

      // ---- イベント ----
      categoryEl.addEventListener('change', render);
      sourceEl.addEventListener('change', rebuild);
      document.getElementById('helpReload').addEventListener('click', rebuild);
      stopBtn.addEventListener('click', stopPlayback);
      document.getElementById('helpIndexToggle').addEventListener('click', () => {
        indexBoxEl.style.display = indexBoxEl.style.display === 'none' ? '' : 'none';
        renderIndex();
      });
      lintToggleEl.addEventListener('click', () => {
        const box = document.getElementById('helpLintBox');
        box.style.display = box.style.display === 'none' ? 'block' : 'none';
      });
      const closeBtn = win.querySelector('.float-window-close');
      if (closeBtn) closeBtn.addEventListener('click', stopPlayback);
      // 表示ソースが「エディタ本文」の時は、開くたびに最新の本文を読み直す
      document.querySelectorAll('.toggle-btn[data-target="win-help"]').forEach(btn => {
        btn.addEventListener('click', () => { if (win.style.display !== 'none') rebuild(); });
      });
      if (MML.I18n && MML.I18n.onChange) MML.I18n.onChange(() => rebuild());

      rebuild();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => UI.HelpPanel.init());
  } else {
    UI.HelpPanel.init();
  }
})(window);
