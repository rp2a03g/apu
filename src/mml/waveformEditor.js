/*
 * 波形エディタ (FDS / N163 拡張音源用カスタム波形)
 * MML.WaveformEditor
 *
 * - FDS: 64サンプル, 各6bit (0-63)
 * - N163: 4〜128サンプル(4の倍数), 各4bit (0-15)
 * キャンバス上をドラッグして波形を編集し、MMLコンパイル/キャプチャ時に
 * compiler.js の fdsInitWrites()/n163InitWrites() へ渡される。
 */
(function (global) {
  const MML = global.MML = global.MML || {};

  const PRESETS = {
    sine: (i, n, max) => Math.round((max / 2) + (max / 2) * Math.sin((2 * Math.PI * i) / n)),
    triangle: (i, n, max) => {
      const t = i / n; // 0-1
      const v = t < 0.5 ? t * 2 : (1 - t) * 2; // 0-1-0
      return Math.round(v * max);
    },
    saw: (i, n, max) => Math.round((i / n) * max),
    square: (i, n, max) => (i < n / 2 ? max : 0),
    random: (i, n, max) => Math.floor(Math.random() * (max + 1))
  };

  class WaveCanvas {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {number} length - サンプル数
     * @param {number} maxValue - サンプル値の最大値 (0-maxValue)
     * @param {number[]} initial - 初期波形データ
     */
    constructor(canvas, length, maxValue, initial) {
      this.canvas = canvas;
      this.length = length;
      this.maxValue = maxValue;
      this.data = initial.slice(0, length);
      while (this.data.length < length) this.data.push(0);

      this.dragging = false;
      this.canvas.addEventListener('mousedown', (e) => { this.dragging = true; this.paintAt(e); });
      this.canvas.addEventListener('mousemove', (e) => { if (this.dragging) this.paintAt(e); });
      window.addEventListener('mouseup', () => { this.dragging = false; });
      this.canvas.addEventListener('mouseleave', () => { /* keep dragging across edge */ });

      this.draw();
    }

    paintAt(e) {
      const rect = this.canvas.getBoundingClientRect();
      // CSSで拡大縮小されている場合に備えてキャンバス実ピクセル座標へ変換
      const x = (e.clientX - rect.left) * (this.canvas.width / rect.width);
      const y = (e.clientY - rect.top) * (this.canvas.height / rect.height);
      const stepW = this.canvas.width / this.length;
      const idx = Math.max(0, Math.min(this.length - 1, Math.floor(x / stepW)));
      let value = Math.round(this.maxValue * (1 - y / this.canvas.height));
      value = Math.max(0, Math.min(this.maxValue, value));
      this.data[idx] = value;
      this.draw();
    }

    applyPreset(name) {
      const fn = PRESETS[name];
      if (!fn) return;
      for (let i = 0; i < this.length; i++) {
        this.data[i] = fn(i, this.length, this.maxValue);
      }
      this.draw();
    }

    setData(arr) {
      this.data = arr.slice(0, this.length);
      while (this.data.length < this.length) this.data.push(0);
      this.draw();
    }

    getData() {
      return this.data.slice();
    }

    draw() {
      const ctx = this.canvas.getContext('2d');
      const w = this.canvas.width;
      const h = this.canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#14141a';
      ctx.fillRect(0, 0, w, h);

      const stepW = w / this.length;
      ctx.fillStyle = '#6fb1ff';
      for (let i = 0; i < this.length; i++) {
        const value = this.data[i];
        const barH = (value / this.maxValue) * h;
        ctx.fillRect(i * stepW, h - barH, Math.max(1, stepW - 1), barH);
      }

      // 中央線
      ctx.strokeStyle = '#3d3d4a';
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
    }
  }

  MML.WaveformEditor = {
    WaveCanvas,
    PRESETS,
    fdsWave: null,
    n163Wave: null,

    init() {
      const fdsCanvas = document.getElementById('fdsWaveCanvas');
      const n163Canvas = document.getElementById('n163WaveCanvas');

      this.fdsWave = new WaveCanvas(fdsCanvas, 64, 63, MML.Mml.fdsDefaultWave());
      this.n163Wave = new WaveCanvas(n163Canvas, MML.Mml.N163_WAVE_LEN, 15, MML.Mml.n163DefaultWave());

      document.querySelectorAll('[data-fds-preset]').forEach(btn => {
        btn.addEventListener('click', () => this.fdsWave.applyPreset(btn.dataset.fdsPreset));
      });
      document.querySelectorAll('[data-n163-preset]').forEach(btn => {
        btn.addEventListener('click', () => this.n163Wave.applyPreset(btn.dataset.n163Preset));
      });
    },

    getFdsWave() {
      return this.fdsWave ? this.fdsWave.getData() : MML.Mml.fdsDefaultWave();
    },

    getN163Wave() {
      return this.n163Wave ? this.n163Wave.getData() : MML.Mml.n163DefaultWave();
    }
  };
})(window);
