/*
 * N163波形グラフィカルエディタ
 * MML.UI.N163WaveEditor
 *
 * MML本文中の @N<n> = { バッファ番号, v1, v2, ... } (N163波形)をキャンバスで
 * グラフィカルに編集する。FDS波形エディタ(src/ui/fdsWaveEditor.js)と同じ
 * アーキテクチャ・書き込みタイミング規約を踏襲するが、変調系コマンド(@MW/@MH相当)が
 * 無いためセクションは波形1つだけ。
 *
 * 波形長は作曲者が自由に決める(4の倍数に自動的に丸められる。src/mml/n163Alloc.js
 * MML.N163Alloc.roundedLen参照)。かつてのようにチャンネル数から波形長を計算する
 * 仕様ではない。同時に使用する波形の合計がN163内蔵RAMの空き容量(64byte)を
 * 超えると、compiler.js側の共有バッファアロケータがコンパイルエラーとして検出する。
 * このエディタは「反映」を押すたびに再コンパイルしてそのエラーを表示する。
 *
 * MMLへの書き込みタイミングはFDS版と同じ規約: ドラッグ・数値入力・ファイル読込・
 * 貼り付けはローカル(このウィンドウ内)のみ更新し、「反映」ボタンでMMLへ書き込む。
 * 「新規」だけは即座にMMLへ書き込む(インデックス確保のため)。MMLからの読み込みは
 * インデックス選択時・ウィンドウを開いた時・ダブルクリック時のみ。
 *
 * 先頭のバッファ番号はこのツールでは使用しない(常に0で書き込む。lexer.jsも既に
 * 読み捨てる設計)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};

  // 表示文言の翻訳(src/i18n/i18n.js)。キーは日本語の原文そのもの
  const T = (key, params) => MML.I18n.t(key, params);

  function parseMmlNumber(s) {
    if (s[0] === '$') return parseInt(s.slice(1), 16);
    return parseInt(s, 10);
  }

  // "@N<n> = { ... }" を全文から検索する。入れ子の{}が無い前提で
  // 開き"{"の直後から最初の"}"までを内容とみなす(複数行にまたがっても素朴に扱える)
  function scanDefs(source) {
    const re = /@N(\d+)\s*=\s*\{/gi;
    const results = [];
    let m;
    while ((m = re.exec(source)) !== null) {
      const braceStart = m.index + m[0].length - 1;
      const closeIdx = source.indexOf('}', braceStart);
      if (closeIdx === -1) continue;
      results.push({
        index: parseInt(m[1], 10),
        start: m.index,
        end: closeIdx + 1,
        contentStart: braceStart + 1,
        contentEnd: closeIdx
      });
    }
    return results;
  }

  function findDefRange(source, index) {
    const defs = scanDefs(source);
    for (const d of defs) if (d.index === index) return d;
    return null;
  }

  function listIndices(source) {
    return scanDefs(source).map(d => d.index).sort((a, b) => a - b);
  }

  // 先頭のバッファ番号を除いた波形値配列を返す(lexer.js parseN163WaveDefと同じ扱い)
  function readValues(source, index) {
    const range = findDefRange(source, index);
    if (!range) return null;
    const content = source.slice(range.contentStart, range.contentEnd);
    const parts = content.trim().split(/[\s,]+/).filter(s => s.length > 0).map(parseMmlNumber);
    return parts.slice(1);
  }

  function findEnclosingDef(source, pos) {
    return scanDefs(source).find(d => pos >= d.start && pos <= d.end) || null;
  }

  function formatDefText(index, values) {
    const perLine = 32;
    const rows = [];
    for (let i = 0; i < values.length; i += perLine) rows.push(values.slice(i, i + perLine).join(' '));
    const body = rows.join('\n        ');
    return `@N${index} = { 0, ${body} }`;
  }

  function findInsertionOffset(source) {
    const rawLines = source.split(/\r\n|\r|\n/);
    let depth = 0;
    let offset = 0;
    for (const rawLine of rawLines) {
      const commentIdx = rawLine.indexOf(';');
      const codePart = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;
      const trimmed = codePart.trim();
      const isDefLine = depth > 0 || trimmed === '' || trimmed[0] === '@' || trimmed[0] === '#' || trimmed[0] === '$';
      if (!isDefLine) return offset;
      for (const ch of codePart) {
        if (ch === '{') depth++;
        else if (ch === '}') depth = Math.max(0, depth - 1);
      }
      offset += rawLine.length + 1;
    }
    return source.length;
  }

  function extractDefinitionLines(source) {
    const rawLines = source.split(/\r\n|\r|\n/);
    const kept = [];
    let depth = 0;
    for (const rawLine of rawLines) {
      const commentIdx = rawLine.indexOf(';');
      const codePart = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;
      const trimmed = codePart.trim();
      const isDefLine = depth > 0 || trimmed === '' || trimmed[0] === '@' || trimmed[0] === '#' || trimmed[0] === '$';
      if (isDefLine) kept.push(rawLine);
      for (const ch of codePart) {
        if (ch === '{') depth++;
        else if (ch === '}') depth = Math.max(0, depth - 1);
      }
    }
    return kept.join('\n');
  }

  function defaultWave(length) {
    const base = (MML.Mml && MML.Mml.n163DefaultWave)
      ? MML.Mml.n163DefaultWave()
      : [0, 2, 4, 6, 8, 10, 12, 14, 15, 13, 11, 9, 7, 5, 3, 1];
    if (UI.WaveClipboard) return UI.WaveClipboard.resample(base, length, 0, 15);
    const out = base.slice(0, length);
    while (out.length < length) out.push(0);
    return out;
  }

  // --- ドラッグでバーを描く波形キャンバス(0-15固定、長さは可変) ---
  class WaveBarCanvas {
    constructor(canvas, length, onPaint) {
      this.canvas = canvas;
      this.length = length;
      this.minValue = 0;
      this.maxValue = 15;
      this.onPaint = onPaint;
      this.data = new Array(length).fill(0);
      this.dragging = false;

      canvas.addEventListener('mousedown', (e) => { this.dragging = true; this.paintAt(e); });
      canvas.addEventListener('mousemove', (e) => { if (this.dragging) this.paintAt(e); });
      window.addEventListener('mouseup', () => { this.dragging = false; });

      this.draw();
    }

    paintAt(e) {
      const rect = this.canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (this.canvas.width / rect.width);
      const y = (e.clientY - rect.top) * (this.canvas.height / rect.height);
      const stepW = this.canvas.width / this.length;
      const idx = Math.max(0, Math.min(this.length - 1, Math.floor(x / stepW)));
      let value = Math.round(this.maxValue * (1 - y / this.canvas.height));
      value = Math.max(this.minValue, Math.min(this.maxValue, value));
      this.data[idx] = value;
      this.draw();
      if (this.onPaint) this.onPaint(this.data);
    }

    setData(arr) {
      this.data = arr.slice(0, this.length);
      while (this.data.length < this.length) this.data.push(0);
      this.draw();
      if (this.onPaint) this.onPaint(this.data);
    }

    // 要素数自体を変更する。概形を保つようリサンプルしてから長さを変える
    setLength(newLength) {
      if (newLength === this.length) return;
      const resampled = UI.WaveClipboard
        ? UI.WaveClipboard.resample(this.data, newLength, this.minValue, this.maxValue)
        : this.data.slice(0, newLength);
      this.length = newLength;
      this.data = resampled;
      while (this.data.length < this.length) this.data.push(0);
      this.draw();
      if (this.onPaint) this.onPaint(this.data);
    }

    draw() {
      const ctx = this.canvas.getContext('2d');
      const w = this.canvas.width, h = this.canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#14141a';
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = '#26262f';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const vDivisions = Math.min(this.length, 8);
      for (let i = 1; i < vDivisions; i++) {
        const x = Math.round((i / vDivisions) * w) + 0.5;
        ctx.moveTo(x, 0); ctx.lineTo(x, h);
      }
      const hDivisions = 4;
      for (let i = 1; i < hDivisions; i++) {
        const y = Math.round((i / hDivisions) * h) + 0.5;
        ctx.moveTo(0, y); ctx.lineTo(w, y);
      }
      ctx.stroke();

      const stepW = w / this.length;
      ctx.fillStyle = '#6fb1ff';
      for (let i = 0; i < this.length; i++) {
        const barH = (this.data[i] / this.maxValue) * h;
        ctx.fillRect(i * stepW, h - barH, Math.max(1, stepW - 1), Math.max(1, barH));
      }

      ctx.strokeStyle = '#5a5a68';
      ctx.beginPath();
      ctx.moveTo(0, h); ctx.lineTo(w, h);
      ctx.stroke();
    }
  }

  UI.N163WaveEditor = {
    init(mmlSourceEl) {
      const win = document.getElementById('win-n163wave');
      if (!win) return;
      const toggleBtn = document.querySelector('.toggle-btn[data-target="win-n163wave"]');

      const selectEl = document.getElementById('n163WaveIndex');
      const lengthEl = document.getElementById('n163WaveLength');
      const valuesEl = document.getElementById('n163WaveValues');
      const helpBtn = document.getElementById('n163WaveHelp');
      const helpBox = document.getElementById('n163WaveHelpText');

      let currentIndex = 0;

      const canvas = new WaveBarCanvas(document.getElementById('n163WaveCanvas'), 16, (data) => {
        valuesEl.textContent = data.join(' ');
      });

      // --- テキストへの書き戻し(反映・新規・プリセット読込・貼り付け時にのみ呼ぶ) ---
      function writeDef(index, values) {
        const text = formatDefText(index, values);
        const source = mmlSourceEl.value;
        const range = findDefRange(source, index);
        let newSource;
        if (range) {
          newSource = source.slice(0, range.start) + text + source.slice(range.end);
        } else {
          const offset = findInsertionOffset(source);
          const sep = (offset > 0 && source[offset - 1] !== '\n') ? '\n' : '';
          newSource = source.slice(0, offset) + sep + text + '\n' + source.slice(offset);
        }
        const scrollTop = mmlSourceEl.scrollTop;
        mmlSourceEl.value = newSource;
        mmlSourceEl.scrollTop = scrollTop;
        mmlSourceEl.dispatchEvent(new Event('input'));
      }

      function refreshIndexSelect() {
        const indices = listIndices(mmlSourceEl.value);
        const list = indices.length ? indices : [0];
        selectEl.innerHTML = '';
        for (const idx of list) {
          const opt = document.createElement('option');
          opt.value = String(idx);
          opt.textContent = String(idx);
          selectEl.appendChild(opt);
        }
        // 呼び出し元がダブルクリック/新規追加などで事前に設定したcurrentIndexを優先する
        // (selectEl.valueは古い表示のままなので、それを見てしまうと直前の選択が
        // 上書きされずに残ってしまうバグになる)
        const want = String(currentIndex);
        selectEl.value = list.map(String).includes(want) ? want : String(list[0]);
        currentIndex = parseInt(selectEl.value, 10) || 0;
      }
      // ドロップダウンを開く直前に選択肢一覧をMMLから作り直す(手打ちで@N5等を追加した
      // 場合でも、選ぶ時点では常に最新のインデックス一覧になるようにする)
      selectEl.addEventListener('mousedown', refreshIndexSelect);

      function loadFromMml() {
        const values = readValues(mmlSourceEl.value, currentIndex);
        const data = values && values.length ? values : defaultWave(canvas.length);
        if (data.length !== canvas.length) {
          lengthEl.value = String(data.length);
          canvas.setLength(data.length);
        }
        canvas.setData(data);
      }

      selectEl.addEventListener('change', () => {
        currentIndex = parseInt(selectEl.value, 10) || 0;
        loadFromMml();
        regenerateSamplePhraseIfClean();
      });

      // --- 要素数変更(4の倍数へ自動的に丸める) ---
      lengthEl.addEventListener('change', () => {
        const requested = parseInt(lengthEl.value, 10) || 16;
        const rounded = MML.N163Alloc ? MML.N163Alloc.roundedLen(requested) : requested;
        lengthEl.value = String(rounded);
        canvas.setLength(rounded);
      });
      lengthEl.value = String(canvas.length);

      // --- 説明トグル ---
      if (helpBtn && helpBox) {
        helpBtn.addEventListener('click', () => {
          helpBox.style.display = helpBox.style.display === 'none' ? 'block' : 'none';
        });
      }

      // --- サンプル再生フレーズの自動生成 ---
      // N163のチャンネル文字は実機ppmck準拠でassignExpansionLettersにより常に'P'固定
      // (dpcm1+fds1+vrc7 6+vrc6 3=11番目からP-Wの8文字)
      const sampleMmlEl = document.getElementById('n163WaveSampleMml');
      let sampleDirty = false;
      sampleMmlEl.addEventListener('input', () => { sampleDirty = true; });
      function regenerateSamplePhraseIfClean() {
        if (sampleDirty) return;
        sampleMmlEl.value = `P @v99 @${currentIndex} o4 l4 cdefgab>c`;
      }

      // --- 新規: 空き番号を確保して即座にMMLへ書き込む ---
      document.getElementById('n163WaveAdd').addEventListener('click', () => {
        const indices = listIndices(mmlSourceEl.value);
        const nextIndex = indices.length ? Math.max(...indices) + 1 : 0;
        currentIndex = nextIndex;
        const data = defaultWave(canvas.length);
        writeDef(nextIndex, data);
        refreshIndexSelect();
        loadFromMml();
        regenerateSamplePhraseIfClean();
      });

      // --- 反映: ローカルの現在値をMMLへ書き込み、再コンパイルしてN163配置エラーを表示 ---
      const statusEl = document.getElementById('n163WaveStatus');
      function checkCompileErrors() {
        const compiled = MML.Mml.compile(mmlSourceEl.value, {});
        if (compiled.errors.length > 0) {
          statusEl.className = 'output fds-status-output error';
          statusEl.textContent = T('エラー:') + '\n' +
            compiled.errors.map(e => e.lineNo ? `[Line ${e.lineNo}] ${e.message}` : e.message).join('\n');
        } else {
          statusEl.className = 'output fds-status-output';
          statusEl.textContent = '';
        }
      }
      document.getElementById('n163WaveApply').addEventListener('click', () => {
        writeDef(currentIndex, canvas.data);
        regenerateSamplePhraseIfClean();
        checkCompileErrors();
      });

      // --- 保存/読み込み(実ファイル。localStorageはキャッシュクリアで消えるため使わない)。
      // 読み込みはローカルのみ更新、MMLへは「反映」を押すまで書き込まない ---
      document.getElementById('n163WaveSave').addEventListener('click', () => {
        const name = prompt(T('保存するファイル名を入力してください(拡張子不要)'), `n163wave-${currentIndex}`);
        if (!name) return;
        const text = canvas.data.join(', ');
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name.replace(/\.[^.]*$/, '') + '.txt';
        a.click();
        URL.revokeObjectURL(url);
      });
      document.getElementById('n163WaveLoad').addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.txt,.json,text/plain';
        input.addEventListener('change', () => {
          const file = input.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            const text = String(reader.result);
            const values = text.trim().split(/[\s,]+/).filter(s => s.length > 0)
              .map(parseMmlNumber).filter(n => !isNaN(n));
            if (values.length === 0) return;
            const rounded = MML.N163Alloc ? MML.N163Alloc.roundedLen(values.length) : values.length;
            const resampled = UI.WaveClipboard ? UI.WaveClipboard.resample(values, rounded, 0, 15) : values;
            lengthEl.value = String(rounded);
            canvas.setLength(rounded);
            canvas.setData(resampled);
          };
          reader.readAsText(file);
        });
        input.click();
      });

      // --- 波形クリップボード(コピー/貼り付け。貼り付けもローカルのみ更新) ---
      function flashButton(btn, text) {
        const orig = btn.textContent;
        btn.textContent = text;
        setTimeout(() => { btn.textContent = orig; }, 900);
      }
      const copyBtn = document.getElementById('n163WaveCopy');
      const pasteBtn = document.getElementById('n163WavePaste');
      if (copyBtn && UI.WaveClipboard) {
        copyBtn.addEventListener('click', async () => {
          const ok = await UI.WaveClipboard.copyValues(canvas.data);
          flashButton(copyBtn, ok ? '✓' : '✗');
        });
      }
      if (pasteBtn && UI.WaveClipboard) {
        pasteBtn.addEventListener('click', async () => {
          const values = await UI.WaveClipboard.pasteValues(canvas.length, 0, 15);
          if (!values) { flashButton(pasteBtn, '✗'); return; }
          canvas.setData(values);
          flashButton(pasteBtn, '✓');
        });
      }

      // --- ウィンドウを開いた時(トグルボタン)にMMLから再読み込み ---
      if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
          if (win.style.display === 'none') return; // 閉じる操作
          refreshIndexSelect();
          loadFromMml();
          regenerateSamplePhraseIfClean();
        });
      }

      // --- ダブルクリックで該当定義を開く ---
      function openN163Window() {
        if (win.style.display === 'none') {
          if (toggleBtn) toggleBtn.click();
        } else if (win._famimmlWindow) {
          win._famimmlWindow.bringToFront();
        }
      }
      mmlSourceEl.addEventListener('dblclick', () => {
        const pos = mmlSourceEl.selectionStart;
        const hit = findEnclosingDef(mmlSourceEl.value, pos);
        if (!hit) return;
        openN163Window();
        currentIndex = hit.index;
        refreshIndexSelect();
        loadFromMml();
        const sectionEl = document.querySelector('[data-fds-section="N"]');
        if (sectionEl) sectionEl.scrollIntoView({ block: 'nearest' });
      });

      // --- サンプル再生(既存の@v<N>ソフトウェアエンベロープ機構を流用) ---
      const envelopeEl = document.getElementById('n163WaveEnvelope');
      const playBtn = document.getElementById('n163WavePlay');
      const stopBtn = document.getElementById('n163WaveStop');
      let audioCtx = null;
      let activeSamplePlayer = null;

      function stopSamplePlayback() {
        if (activeSamplePlayer) {
          activeSamplePlayer.destroy();
          activeSamplePlayer = null;
        }
      }

      function playSample() {
        stopSamplePlayback();
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        audioCtx.resume();

        let defText = extractDefinitionLines(mmlSourceEl.value);
        if (!/^\s*#EX-NAMCO106\b/im.test(defText)) defText = '#EX-NAMCO106\n' + defText;
        // 「反映」を押していなくても今キャンバスに描いている内容がそのまま鳴るよう、
        // 選択中インデックスの定義をローカルの現在値で上書きする形で追加する
        const liveDef = formatDefText(currentIndex, canvas.data);
        const envText = envelopeEl.value.trim() || '12';
        const phrase = sampleMmlEl.value.trim() || `P @v99 @${currentIndex} o4 l4 cdefgab>c`;
        const tempSource = defText + '\n' + liveDef + '\n@v99 = { ' + envText + ' }\n' + phrase + '\n';

        const compiled = MML.Mml.compile(tempSource, {});
        statusEl.className = 'output fds-status-output';
        if (compiled.errors.length > 0) {
          statusEl.classList.add('error');
          statusEl.textContent = T('エラー:') + '\n' +
            compiled.errors.map(e => e.lineNo ? `[Line ${e.lineNo}] ${e.message}` : e.message).join('\n');
          return;
        }

        const player = new MML.Audio.MmlStreamPlayer(audioCtx);
        player.load(compiled, null);
        player.onEnded = () => {
          activeSamplePlayer = null;
          statusEl.textContent = T('再生終了');
        };
        player.play();
        activeSamplePlayer = player;
        statusEl.classList.add('ok');
        statusEl.textContent = T('再生中...');
      }

      playBtn.addEventListener('click', playSample);
      stopBtn.addEventListener('click', () => {
        stopSamplePlayback();
        statusEl.className = 'output fds-status-output';
        statusEl.textContent = T('停止');
      });

      // --- 初期化 ---
      refreshIndexSelect();
      loadFromMml();
      regenerateSamplePhraseIfClean();
    }
  };
})(window);
