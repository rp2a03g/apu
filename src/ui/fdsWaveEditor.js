/*
 * FDS波形グラフィカルエディタ
 * MML.UI.FdsWaveEditor
 *
 * MML本文中の @FM<n>(波形メモリ64サンプル) / @MW<n>(変調テーブル32サンプル、増減量表記) /
 * @MH<n>(変調パラメータ delay,freq,depth,waveform[,envDir,envSpeed]) をキャンバス/数値入力で
 * グラフィカルに編集する。MMLテキストが正典(DESIGN.md INV-2)。
 *
 * MMLへの書き込みタイミング: ドラッグ中のキャンバス編集・MH数値欄の入力・
 * ファイル読み込み・プリセット読み込み・貼り付けは、すべてローカル(この
 * ウィンドウ内)の状態だけを更新し、MML本文へは書き込まない(誤って
 * 意図しない内容を上書きしないため、また毎フレーム書き込むとシンタックス
 * ハイライト再構築が走り重かったため)。「反映」ボタンを押した時にだけ
 * 現在のローカル状態をMMLへ書き込む。「新規」だけは例外で、インデックス
 * 番号を確保する必要があるため即座にMMLへ書き込む。
 * MMLからの読み込みは、インデックスの選択を変えた時・ウィンドウを開いた時・
 * ダブルクリックで開いた時にだけ行う(こちらもテキスト全体の継続監視はしない)。
 *
 * @MW<n>について: MML上の値は「変調カウンタへの増分」そのもの
 * (0=維持, 1, 2, 4, -1, -2, -4, R=0へリセット)であり、飛び飛びの8段階しか
 * 取れないので、そのまま量としてドラッグ編集できるものではない。
 * (実機テーブルはこれを3bitコード0-7へ詰めたもの=src/emulator/expansion/fds.js
 *  MOD_TABLE_DELTA。MML表記↔生コードの変換はsrc/mml/lexer.jsが持ち、
 *  このエディタも読み書きの境界だけでそれを使う。内部状態は生コード側。)
 * このエディタでは実際に鳴る変調カウンタの累積カーブ(-64〜63)をキャンバスに
 * 描かせる。ドラッグ中は
 * nearestAchievableValue()で直前のバーから実際に到達可能な値だけに毎回
 * スナップし(自由な値は描けない)、反映時にcodesFromCurve()で生コード列へ
 * 変換してMMLへ書き込む。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};

  // 表示文言の翻訳(src/i18n/i18n.js)。キーは日本語の原文そのもの
  const T = (key, params) => MML.I18n.t(key, params);

  // --- MML定義ブロックのパース/書き戻し用ヘルパー(lexer.jsの内部関数には依存しない) ---

  // 定義ブロックの走査/読み書きは共通モジュール(src/mml/defBlocks.js)へ集約した
  const Defs = MML.Defs;
  const parseMmlNumber = (s) => Defs.parseNumber(s);
  const listIndices = (source, tag) => Defs.indices(source, tag);
  const extractDefinitionLines = (source) => Defs.definitionLines(source);

  function readValues(source, tag, index) {
    const tokens = Defs.tokens(source, tag, index);
    if (!tokens) return null;
    // @MWだけはMML表記(0/1/2/4/-1/-2/-4/R)なので、エディタ内部で扱う生コード(0-7)へ変換する。
    // 使えない値が書かれていた場合(コンパイル側ではエラーになる)は0(維持)として読む
    if (tag === 'MW') {
      return tokens.map(t => {
        const code = MML.Mml.fdsModTokenToCode(t);
        return code === undefined ? 0 : code;
      });
    }
    return tokens.map(parseMmlNumber);
  }

  function findEnclosingDef(source, pos) {
    const hit = Defs.enclosing(source, pos, ['FM', 'MW', 'MH']);
    return hit ? { tag: hit.tag, index: hit.index } : null;
  }

  // valuesは@MWの場合も生コード(0-7)で受け取り、ここでMML表記へ変換して書き出す
  function formatDefText(tag, index, values) {
    if (tag === 'FM') return Defs.format('FM', index, values, { perLine: 32, sep: ' ' });
    if (tag === 'MW') {
      return Defs.format('MW', index, values.map(c => MML.Mml.fdsModCodeToToken(c)), { perLine: 16, sep: ', ' });
    }
    // envDir(第5引数)が0なら本家ppmck互換の4引数で書く(envSpeedは意味を持たないので落とす)
    return Defs.format('MH', index, values[4] ? values.slice(0, 6) : values.slice(0, 4));
  }

  function sineDefault(length, maxValue) {
    const arr = [];
    for (let i = 0; i < length; i++) {
      arr.push(Math.round((maxValue / 2) + (maxValue / 2) * Math.sin((2 * Math.PI * i) / length)));
    }
    return arr;
  }

  // --- @MW<n> 生コード(0-7) <-> 変調カウンタ累積カーブ(-64..63) の相互変換 ---
  const MOD_TABLE_DELTA = [0, 1, 2, 4, 0, -4, -2, -1];
  const MOD_CANDIDATE_CODES = [0, 1, 2, 3, 5, 6, 7]; // 4(リセット)は候補に別途含める

  // 実機の変調カウンタの動き(src/emulator/expansion/fds.js _stepMod)に合わせる: 各項目は
  // 2ステップ分(2回)適用され、カウンタは7bitで折り返す(63+1=-64)。クランプではない
  function computeModCurve(codes) {
    let acc = 0;
    const curve = [];
    for (const raw of codes) {
      if (raw === 4) {
        acc = 0;
      } else {
        acc += 2 * (MOD_TABLE_DELTA[raw & 7] || 0);
        while (acc > 63) acc -= 128;
        while (acc < -64) acc += 128;
      }
      curve.push(acc);
    }
    return curve;
  }

  function codesFromCurve(curve) {
    let acc = 0;
    const codes = [];
    for (const target of curve) {
      let bestCode = 0, bestAcc = acc, bestDiff = Infinity;
      for (const code of MOD_CANDIDATE_CODES) {
        const next = Math.max(-64, Math.min(63, acc + MOD_TABLE_DELTA[code]));
        const diff = Math.abs(next - target);
        if (diff < bestDiff) { bestDiff = diff; bestCode = code; bestAcc = next; }
      }
      const resetDiff = Math.abs(0 - target);
      if (resetDiff < bestDiff) { bestCode = 4; bestAcc = 0; }
      codes.push(bestCode);
      acc = bestAcc;
    }
    return codes;
  }

  // 変調カーブをドラッグする際、直前のバーの値から実際に到達可能な値(0/+1/+2/+4/
  // リセット/-4/-2/-1のいずれか)だけに毎回スナップする(自由な値を描けてしまうと
  // 反映時に別の形へ変換されて見た目が変わってしまうため、描いている時点で拘束する)
  function nearestAchievableValue(prevAcc, target) {
    let best = 0, bestDiff = Infinity;
    for (const code of MOD_CANDIDATE_CODES) {
      const next = Math.max(-64, Math.min(63, prevAcc + MOD_TABLE_DELTA[code]));
      const diff = Math.abs(next - target);
      if (diff < bestDiff) { bestDiff = diff; best = next; }
    }
    const resetDiff = Math.abs(0 - target);
    if (resetDiff < bestDiff) best = 0;
    return best;
  }

  // --- ファイルへの保存/読み込み(localStorageはキャッシュクリアで消えるため使わない) ---
  function downloadValuesAsFile(tag, name, values) {
    const text = values.join(', ');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (name || ('fdswave-' + tag)).replace(/\.[^.]*$/, '') + '.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ファイル選択ダイアログを開き、選ばれたファイルをテキストとして読み込んで
  // コールバックへ数値配列を渡す(要素数変換等の解釈は呼び出し側で行う)
  function pickFileAsValues(callback) {
    const input = document.createElement('input');
    input.type = 'file';
    MML.Device.setFileAccept(input, '.txt,.json,text/plain');
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result);
        const values = text.trim().split(/[\s,]+/).filter(s => s.length > 0)
          .map(parseMmlNumber).filter(n => !isNaN(n));
        if (values.length > 0) callback(values);
      };
      reader.readAsText(file);
    });
    input.click();
  }

  // --- ドラッグでバーを描く波形キャンバス(FM/MW共用。負の値も表現できる汎用版) ---
  class WaveBarCanvas {
    constructor(canvas, length, minValue, maxValue, onPaint, constrainFn) {
      this.canvas = canvas;
      this.length = length;
      this.minValue = minValue;
      this.maxValue = maxValue;
      this.onPaint = onPaint; // 値表示欄の更新等、軽量な副作用専用(MMLへは書き込まない)
      this.constrainFn = constrainFn; // (data, idx, rawValue) => 実際に描画・保持する値。省略時はrawValueそのまま
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
      const range = this.maxValue - this.minValue;
      let value = Math.round(this.minValue + range * (1 - y / this.canvas.height));
      value = Math.max(this.minValue, Math.min(this.maxValue, value));
      if (this.constrainFn) value = this.constrainFn(this.data, idx, value);
      this.data[idx] = value;
      this.draw();
      if (this.onPaint) this.onPaint(this.data);
    }

    setData(arr) {
      this.data = arr.slice(0, this.length);
      while (this.data.length < this.length) this.data.push(0);
      // MML由来のカーブは常に到達可能な値のみだが、貼り付け/ファイル読み込みは
      // 任意の値を含みうるので、その場合も先頭から順に到達可能な値へ矯正する
      if (this.constrainFn) {
        for (let i = 0; i < this.data.length; i++) {
          this.data[i] = this.constrainFn(this.data, i, this.data[i]);
        }
      }
      this.draw();
      if (this.onPaint) this.onPaint(this.data);
    }

    draw() {
      const ctx = this.canvas.getContext('2d');
      const w = this.canvas.width, h = this.canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#14141a';
      ctx.fillRect(0, 0, w, h);

      const range = this.maxValue - this.minValue;
      const valueToY = (v) => h * (1 - (v - this.minValue) / range);
      const zeroY = valueToY(0);

      // グリッド線(縦8分割・横4分割)
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
        const y = valueToY(this.data[i]);
        const top = Math.min(y, zeroY);
        const barH = Math.abs(y - zeroY);
        ctx.fillRect(i * stepW, top, Math.max(1, stepW - 1), Math.max(1, barH));
      }

      ctx.strokeStyle = '#5a5a68';
      ctx.beginPath();
      ctx.moveTo(0, zeroY);
      ctx.lineTo(w, zeroY);
      ctx.stroke();
    }
  }

  UI.FdsWaveEditor = {
    init(mmlSourceEl) {
      const win = document.getElementById('win-fdswave');
      if (!win) return;
      const toggleBtn = document.querySelector('.toggle-btn[data-target="win-fdswave"]');

      const fmValuesEl = document.getElementById('fdsWaveFmValues');
      const mwValuesEl = document.getElementById('fdsWaveMwValues');

      const mhInputs = {
        delay: document.getElementById('fdsWaveMhDelay'),
        freq: document.getElementById('fdsWaveMhFreq'),
        depth: document.getElementById('fdsWaveMhDepth'),
        waveform: document.getElementById('fdsWaveMhWaveform'),
        envDir: document.getElementById('fdsWaveMhEnvDir'),
        envSpeed: document.getElementById('fdsWaveMhEnvSpeed')
      };

      const fmSection = {
        tag: 'FM', selectEl: document.getElementById('fdsWaveFmIndex'),
        currentIndex: 0, canvas: null
      };
      const mwSection = {
        tag: 'MW', selectEl: document.getElementById('fdsWaveMwIndex'),
        currentIndex: 0, canvas: null
      };
      const mhSection = {
        tag: 'MH', selectEl: document.getElementById('fdsWaveMhIndex'),
        currentIndex: 0
      };

      function sectionFor(tag) {
        return tag === 'FM' ? fmSection : tag === 'MW' ? mwSection : mhSection;
      }

      // HTML要素idはcamelCase("fdsWaveMhSave"等)なので、'FM'/'MW'/'MH'(MML側の正式表記)から
      // id構築用の表記へ変換する
      const ID_TAG = { FM: 'Fm', MW: 'Mw', MH: 'Mh' };

      // --- テキストへの書き戻し(反映・新規・プリセット読込・貼り付け時にのみ呼ぶ) ---
      function writeDef(tag, index, values) {
        // Defs.writeがスクロール位置の保持とinputイベント(シンタックスハイライト更新)まで面倒を見る
        Defs.write(mmlSourceEl, tag, index, formatDefText(tag, index, values));
      }

      // 未反映の印(セクションごと): ローカル(キャンバス/数値欄/読み込み/貼り付け)を触ったら
      // その「反映」ボタンを色付きにし、反映するかMMLから読み直すと戻す
      const dirty = { FM: false, MW: false, MH: false };
      function setDirty(tag, v) {
        dirty[tag] = v;
        const btn = document.getElementById(`fdsWave${ID_TAG[tag]}Apply`);
        if (btn) btn.classList.toggle('apply-btn--dirty', v);
      }
      Object.values(mhInputs).forEach((el) => el.addEventListener('input', () => setDirty('MH', true)));

      // --- ローカル(このウィンドウ内)の現在値の取得/設定 ---
      function getLocalData(tag) {
        if (tag === 'FM') return fmSection.canvas.data.slice();
        if (tag === 'MW') return mwSection.canvas.data.slice();
        return [mhInputs.delay, mhInputs.freq, mhInputs.depth, mhInputs.waveform, mhInputs.envDir, mhInputs.envSpeed]
          .map(el => parseInt(el.value, 10) || 0);
      }
      function setLocalData(tag, values) {
        if (tag === 'FM') { fmSection.canvas.setData(values); return; }
        if (tag === 'MW') { mwSection.canvas.setData(values); return; }
        const [delay = 0, freq = 0, depth = 0, waveform = 0, envDir = 0, envSpeed = 0] = values;
        mhInputs.delay.value = String(delay);
        mhInputs.freq.value = String(freq);
        mhInputs.depth.value = String(depth);
        mhInputs.waveform.value = String(waveform);
        mhInputs.envDir.value = String(envDir > 0 ? 1 : envDir < 0 ? -1 : 0);
        mhInputs.envSpeed.value = String(envSpeed);
        setDirty('MH', true); // 読み込み/貼り付け由来。MMLからの読み直しは loadFromMml が直後に戻す
      }

      // --- MMLからの読み込み(インデックス選択時・ウィンドウを開いた時にのみ呼ぶ) ---
      function loadFromMml(tag) {
        const section = sectionFor(tag);
        const values = readValues(mmlSourceEl.value, tag, section.currentIndex);
        if (values) {
          // @MWはMML上は生コード(0-7)。エディタ表示は実際に鳴る累積カーブなので変換する
          setLocalData(tag, tag === 'MW' ? computeModCurve(values) : values);
        } else {
          const defaults = tag === 'FM' ? sineDefault(64, 63) : tag === 'MW' ? new Array(32).fill(0) : [0, 0, 0, 0];
          setLocalData(tag, defaults);
        }
        setDirty(tag, false);
      }
      function loadAllFromMml() {
        loadFromMml('FM'); loadFromMml('MW'); loadFromMml('MH');
      }

      function refreshIndexSelect(selectEl, indices, currentIndex) {
        const list = indices.length ? indices : [0];
        selectEl.innerHTML = '';
        for (const idx of list) {
          const opt = document.createElement('option');
          opt.value = String(idx);
          opt.textContent = String(idx);
          selectEl.appendChild(opt);
        }
        const want = String(currentIndex);
        selectEl.value = list.map(String).includes(want) ? want : String(list[0]);
      }
      function refreshIndexSelectFor(tag) {
        const section = sectionFor(tag);
        refreshIndexSelect(section.selectEl, listIndices(mmlSourceEl.value, tag), section.currentIndex);
        section.currentIndex = parseInt(section.selectEl.value, 10) || 0;
      }
      function refreshAllIndexSelects() {
        refreshIndexSelectFor('FM'); refreshIndexSelectFor('MW'); refreshIndexSelectFor('MH');
      }

      // --- サンプル再生フレーズの自動生成(ユーザーが手を入れたら以後上書きしない) ---
      // FDSのチャンネル文字は実機ppmck準拠で常に'F'固定(src/mml/compiler.js assignExpansionLetters)。
      // 2A03のAチャンネルではFDS命令が効かず無音になるため注意
      const sampleMmlEl = document.getElementById('fdsWaveSampleMml');
      let sampleDirty = false;
      sampleMmlEl.addEventListener('input', () => { sampleDirty = true; });
      function regenerateSamplePhraseIfClean() {
        if (sampleDirty) return;
        sampleMmlEl.value = `F @v99 @${fmSection.currentIndex} MH${mhSection.currentIndex} o4 l4 cdefgab>c`;
      }

      // --- FM/MWキャンバス(値表示欄をドラッグ中もリアルタイム更新するが、MMLへは書かない) ---
      fmSection.canvas = new WaveBarCanvas(document.getElementById('fdsWaveFmCanvas'), 64, 0, 63, (data) => {
        fmValuesEl.textContent = data.join(' ');
        setDirty('FM', true);
      });
      mwSection.canvas = new WaveBarCanvas(document.getElementById('fdsWaveMwCanvas'), 32, -64, 63, (data) => {
        mwValuesEl.textContent = data.join(' ');
        setDirty('MW', true);
      }, (data, idx, rawValue) => nearestAchievableValue(idx === 0 ? 0 : data[idx - 1], rawValue));

      // --- 説明(❓)トグル ---
      ['FM', 'MW', 'MH'].forEach((tag) => {
        const btn = document.getElementById(`fdsWave${ID_TAG[tag]}Help`);
        const box = document.getElementById(`fdsWave${ID_TAG[tag]}HelpText`);
        if (btn && box) {
          btn.addEventListener('click', () => {
            box.style.display = box.style.display === 'none' ? 'block' : 'none';
          });
        }
      });

      // --- インデックス選択(MMLから読み込む唯一のトリガーの一つ) ---
      function wireIndexSelect(tag) {
        const section = sectionFor(tag);
        // ドロップダウンを開く直前に選択肢一覧をMMLから作り直す(手打ちで@FM5等を
        // 追加した場合でも、選ぶ時点では常に最新のインデックス一覧になるようにする)
        section.selectEl.addEventListener('mousedown', () => refreshIndexSelectFor(tag));
        section.selectEl.addEventListener('change', () => {
          section.currentIndex = parseInt(section.selectEl.value, 10) || 0;
          loadFromMml(tag);
          if (tag === 'FM' || tag === 'MH') regenerateSamplePhraseIfClean();
        });
      }
      wireIndexSelect('FM'); wireIndexSelect('MW'); wireIndexSelect('MH');

      // --- 新規: 空き番号を確保して即座にMMLへ書き込む ---
      function onAddClick(tag) {
        const section = sectionFor(tag);
        const indices = listIndices(mmlSourceEl.value, tag);
        const nextIndex = indices.length ? Math.max(...indices) + 1 : 0;
        const defaults = tag === 'FM' ? sineDefault(64, 63) : tag === 'MW' ? new Array(32).fill(0) : [0, 0, 0, 0];
        section.currentIndex = nextIndex;
        writeDef(tag, nextIndex, defaults);
        refreshIndexSelectFor(tag);
        loadFromMml(tag);
        regenerateSamplePhraseIfClean();
      }
      document.getElementById('fdsWaveFmAdd').addEventListener('click', () => onAddClick('FM'));
      document.getElementById('fdsWaveMwAdd').addEventListener('click', () => onAddClick('MW'));
      document.getElementById('fdsWaveMhAdd').addEventListener('click', () => onAddClick('MH'));

      // --- 反映: ローカルの現在値をMMLへ書き込む(ドラッグ/数値入力の確定操作) ---
      function onApplyClick(tag) {
        const section = sectionFor(tag);
        const local = getLocalData(tag);
        const toWrite = tag === 'MW' ? codesFromCurve(local) : local;
        writeDef(tag, section.currentIndex, toWrite);
        setDirty(tag, false);
        regenerateSamplePhraseIfClean();
      }
      document.getElementById('fdsWaveFmApply').addEventListener('click', () => onApplyClick('FM'));
      document.getElementById('fdsWaveMwApply').addEventListener('click', () => onApplyClick('MW'));
      document.getElementById('fdsWaveMhApply').addEventListener('click', () => onApplyClick('MH'));

      // --- 保存/読み込み(実ファイル。localStorageはキャッシュクリアで消えるため使わない)。
      // 読み込みはローカル(このウィンドウ内)を更新するのみで、MMLへは「反映」を押すまで書き込まない ---
      function wireFileIO(tag) {
        const section = sectionFor(tag);
        document.getElementById(`fdsWave${ID_TAG[tag]}Save`).addEventListener('click', () => {
          const name = prompt(T('保存するファイル名を入力してください(拡張子不要)'), `fdswave-${tag}${section.currentIndex}`);
          if (!name) return;
          downloadValuesAsFile(tag, name, getLocalData(tag));
        });
        document.getElementById(`fdsWave${ID_TAG[tag]}Load`).addEventListener('click', () => {
          pickFileAsValues((values) => {
            if (tag === 'MH') { setLocalData(tag, values.slice(0, 6)); return; }
            const range = tag === 'FM' ? [64, 0, 63] : [32, -64, 63];
            const resampled = UI.WaveClipboard ? UI.WaveClipboard.resample(values, range[0], range[1], range[2]) : values;
            setLocalData(tag, resampled);
          });
        });
      }
      wireFileIO('FM'); wireFileIO('MW'); wireFileIO('MH');

      // --- 波形クリップボード(コピー/貼り付け)。貼り付けもローカル更新のみで、
      // MMLへは「反映」を押すまで書き込まない ---
      function flashButton(btn, text) {
        const orig = btn.textContent;
        btn.textContent = text;
        setTimeout(() => { btn.textContent = orig; }, 900);
      }
      function wireClipboard(tag) {
        const copyBtn = document.getElementById(`fdsWave${ID_TAG[tag]}Copy`);
        const pasteBtn = document.getElementById(`fdsWave${ID_TAG[tag]}Paste`);
        if (!copyBtn || !pasteBtn || !UI.WaveClipboard) return;
        copyBtn.addEventListener('click', async () => {
          const ok = await UI.WaveClipboard.copyValues(getLocalData(tag));
          flashButton(copyBtn, ok ? '✓' : '✗');
        });
        pasteBtn.addEventListener('click', async () => {
          const range = tag === 'FM' ? [64, 0, 63] : [32, -64, 63];
          const values = await UI.WaveClipboard.pasteValues(range[0], range[1], range[2]);
          if (!values) { flashButton(pasteBtn, '✗'); return; }
          setLocalData(tag, values);
          flashButton(pasteBtn, '✓');
        });
      }
      wireClipboard('FM'); wireClipboard('MW');

      // --- ウィンドウを開いた時(トグルボタン)にMMLから再読み込み ---
      if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
          if (win.style.display === 'none') return; // 閉じる操作
          refreshAllIndexSelects();
          loadAllFromMml();
          regenerateSamplePhraseIfClean();
        });
      }

      // --- ダブルクリックで該当定義を開く ---
      function openFdsWindow() {
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
        openFdsWindow();
        sectionFor(hit.tag).currentIndex = hit.index;
        refreshIndexSelectFor(hit.tag);
        loadFromMml(hit.tag);
        const sectionEl = document.querySelector(`[data-fds-section="${hit.tag}"]`);
        if (sectionEl) sectionEl.scrollIntoView({ block: 'nearest' });
      });

      // --- サンプル再生(既存の@v<N>ソフトウェアエンベロープ機構を流用) ---
      const envelopeEl = document.getElementById('fdsWaveEnvelope');
      const playBtn = document.getElementById('fdsWavePlay');
      const stopBtn = document.getElementById('fdsWaveStop');
      const statusEl = document.getElementById('fdsWaveStatus');
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
        if (!/^\s*#EX-DISKFM\b/im.test(defText)) defText = '#EX-DISKFM\n' + defText;
        // サンプル再生は「反映」を押していなくても今キャンバス/数値欄に描いている内容が
        // そのまま鳴るようにする(defTextのMML本文由来の定義を、選択中インデックスの
        // ローカル編集内容で上書きする形で追加。後に書いた定義が有効になる仕様を利用)
        const liveDefs = [
          formatDefText('FM', fmSection.currentIndex, fmSection.canvas.data),
          formatDefText('MW', mwSection.currentIndex, codesFromCurve(mwSection.canvas.data)),
          formatDefText('MH', mhSection.currentIndex, getLocalData('MH'))
        ].join('\n');
        // 空欄の場合に@v99={0}(=常時無音)になるのを避け、無難な固定音量にフォールバックする
        const envText = envelopeEl.value.trim() || '12';
        const phrase = sampleMmlEl.value.trim() ||
          `F @v99 @${fmSection.currentIndex} MH${mhSection.currentIndex} o4 l4 cdefgab>c`;
        const tempSource = defText + '\n' + liveDefs + '\n@v99 = { ' + envText + ' }\n' + phrase + '\n';

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
      refreshAllIndexSelects();
      loadAllFromMml();
      regenerateSamplePhraseIfClean();
    }
  };
})(window);
