/*
 * MML.Emu.ZoomConsole — タイトーの ZOOM 音源基板(ZSG-2+TMS57002)を、ゲーム画面(src/ui/nesScreen.js)と
 * 音スレッド(src/audio/nes-worklet-impl.js)が期待する「本体」の形にした物。
 *
 * 中身はサウンド基板(zoomBoard.js: MN10200 がサウンドプログラムを走らせる)+音源(Zsg2Audio)。メイン基板は動かさず、
 * 代わりに自前の「サウンドテスト画面」を出して、そこからサウンドコードを送る。選んだ瞬間に鳴り、鳴らしながら録れる。
 * 他の機種の本体(Cps3Console など)と同じ口を持つ:
 *   setSampleRate / runSamples / runSamplesStereo / runFrame / frame / frameWidth / frameHeight / frameRate / frameCount / onFrame
 *   setController / setTurboRate / reset / startRecording / stopRecording / chips / extBits / diskCount / hasBattery / applyMix
 *
 * 操作(setController の bits。他の機種と同じ並び): 左右 = コードを 1 ずつ、上下 = 16 ずつ、A = 鳴らす、B = 止める、Start = 基板のリセット
 *
 * メイン基板つき(opts.main = { bios, rom, cat1, cat2 }。ソニー ZN-1+FX-1B の ROM がそろっている時):
 *   本物の BIOS とゲームを走らせ(zn/znMain.js、zn/psxGpu.js)、ゲーム本体のテストモード画面を出す。指令はゲームが音源基板へ送る物そのまま。
 *   DIP の Test Mode を入れて起動し、最初の指令が出る所まで早送りする。
 *   操作: 十字 = レバー、A / B = ボタン 1 / 2、Start = スタート、Select = DIP の Test Mode の入切、連射 A のキー = コイン
 *   PlayStation の SPU(効果音)も混ぜて鳴らすが、録音(VGM)には入らない(ZSG-2 と DSP だけ)
 *
 * 指令(G-DARIUS のサウンドテストの実測): 共有 RAM に (01, コード, 01, 55) を書いて割り込み。止めるのは (01, 00, 00, 55)(起動時にメイン CPU が送る物と同じ)。
 *
 * 録音(rec): フレームごとに { n0, n1, w: [レジスタ番号, 値, n, …] }。n は音源の通算サンプル番号(「何サンプル目の前に効くか」)。
 *   レジスタ番号は VGM の ZSGX ブロックと同じ(0〜0x3FF = ZSG-2、0x8000 = DSP のデータ、0x8001 = DSP の制御線、0x8002 / 0x8003 = 全体音量)。
 *   0xFFFF は「ここでサウンドコードを送った」の印(値 = コード。VGM にする時、最初の印を曲の頭にする)。
 *   録音の最初のフレームには、それまでの DSP への書き込み全部(プログラムと係数。元の n のまま)と、ZSG-2 の今のレジスタを置く。
 *   VGM にするのは主スレッドの MML.VGM.encodeZoomRecording(波形は主スレッドが持っている)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const W = 320, H = 224, FPS = 60;
  const GLOBAL_GAIN = 0x30;          // メイン CPU が書く全体音量(G-DARIUS のサウンドテストの実測。0〜63)
  const REG_MARK = 0xFFFF;
  const SPU_GAIN = 0.3 / 32768;      // PlayStation の SPU を混ぜる大きさ(MAME の配線の 0.3。ZSG-2 側は 1.0)
  // 5×7 の字(上から 7 行、各行 5bit)
  const FONT = {
    '0': [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E], '1': [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E], '2': [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F], '3': [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
    '4': [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02], '5': [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E], '6': [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E], '7': [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
    '8': [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E], '9': [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
    A: [0x0E, 0x11, 0x11, 0x11, 0x1F, 0x11, 0x11], B: [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E], C: [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E], D: [0x1C, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1C],
    E: [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F], F: [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10], G: [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F], H: [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
    I: [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E], J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C], K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
    M: [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11], N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11], O: [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E], P: [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
    Q: [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D], R: [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11], S: [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E], T: [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
    U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E], V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04], W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0A], X: [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
    Y: [0x11, 0x11, 0x11, 0x0A, 0x04, 0x04, 0x04], Z: [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F],
    ':': [0x00, 0x0C, 0x0C, 0x00, 0x0C, 0x0C, 0x00], '-': [0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00], '/': [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x00], '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x0C],
    '>': [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08], '<': [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02], '+': [0x00, 0x04, 0x04, 0x1F, 0x04, 0x04, 0x00], '=': [0x00, 0x00, 0x1F, 0x00, 0x1F, 0x00, 0x00]
  };
  const rgb = (r, g, b) => (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
  const COL = { bg: rgb(0, 0, 0), title: rgb(255, 255, 0), text: rgb(255, 255, 255), dim: rgb(140, 140, 150), hot: rgb(255, 80, 80), ok: rgb(90, 220, 120), bar: rgb(80, 160, 255), barOff: rgb(36, 40, 56) };

  class ZoomConsole {
    /** @param rom 使わない(他の機種と引数の位置を合わせるだけ) @param opts { program, wave, info: { game, first, last } } */
    constructor(rom, opts) {
      this.opts = opts;
      this.info = Object.assign({ game: '', first: 1, last: 32 }, opts.info || {});
      this.sampleRate = 48000;
      this.frame = new Uint32Array(W * H);
      this.frameWidth = W; this.frameHeight = H;
      this.frameRate = FPS;
      this.onFrame = null;
      this.rec = null;
      this.underruns = 0;
      this.pad = [0, 0]; this.prevPad = 0; this.repeat = 0;
      this.coinKeys = [0, 0];                                // 連射 A / B のキー。メイン基板つきの時はコインに使う
      this.code = this.info.first;
      this.mainOpt = opts.main && Emu.createZnMain && Emu.createPsxGpu ? opts.main : null;
      this.nv = null;                                        // メイン基板の不揮発メモリ(リセットをまたいで持つ)
      this.dsw = 0x7;                                        // DIP: bit3 = Test Mode(0 で入)
      this._boot();
    }
    _boot() {
      const o = this.opts, Bd = Emu.ZOOM_BOARD;
      const chip = this.chip = new Emu.Zsg2Audio(25000000, 1);
      chip.loadRom(0, o.wave);
      this.hist = [];                        // DSP と全体音量への書き込み全部(録音を途中から始めても DSP の中身を作り直せるように)
      this.board = Emu.createZoomBoard({ program: o.program, wave: o.wave, onWrite: (reg, value) => this._write(reg, value) });
      this.chipRate = Bd.CPU_HZ / Bd.CYCLES_PER_SAMPLE;
      this.framePeriod = this.chipRate / FPS;
      this.acc = 0; this.frameAcc = 0; this.prevL = 0; this.prevR = 0;
      this.frameCount = 0;
      this.playing = 0; this.playFrames = 0; this.sent = 0;
      this.zn = null; this.spuL = 0; this.spuR = 0; this.prevSpuL = 0; this.prevSpuR = 0;
      if (this.mainOpt) return this._bootMain();
      this._write(0x8002, GLOBAL_GAIN); this._write(0x8003, GLOBAL_GAIN);
      // 起動: 基板が立ち上がるのを 1 秒待って初期化の指令、さらに 0.5 秒。音は出さずに先へ進める(1.5 秒ぶんを一気に)
      const n1 = Math.round(this.chipRate), n2 = Math.round(this.chipRate * 0.5);
      for (let i = 0; i < n1; i++) { this.board.run(1); chip.clock(); }
      this.board.command(0x01, 0x00, 0x00, 0x55);
      for (let i = 0; i < n2; i++) { this.board.run(1); chip.clock(); }
      this._draw();
    }
    // ── メイン基板つき ──
    _bootMain() {
      const m = this.mainOpt, chip = this.chip;
      this.gain = [-1, -1]; this.slot = 0; this.booted = false;
      this.gpu = Emu.createPsxGpu({ vramHeight: 1024 });
      const zn = this.zn = Emu.createZnMain({ bios: m.bios, rom: m.rom, cat1: m.cat1, cat2: m.cat2, sound: this.board, gpu: this.gpu, dsw: this.dsw,
        at28: this.nv ? this.nv.at28 : null, fram: this.nv ? this.nv.fram : null, onSound: (k, a, v) => this._mainSound(k, a, v) });
      this.nv = { at28: zn.at28, fram: zn.fram };
      this.frameRate = Emu.ZN_MAIN.FRAME_HZ;
      this.mainRatio = Emu.ZN_MAIN.CPU_HZ / this.chipRate;   // 音源の 1 サンプルぶんのメイン CPU のサイクル数
      this.nsamp = 0; this.mainFrame = 0;
      // 最初の指令(音源基板の初期化)が出て 0.3 秒たつまで早送り。出なければ 20 秒で打ち切る(BIOS の画面やエラー表示のまま見せる)
      let after = -1;
      const limit = Math.round(this.chipRate * 20), tail = Math.round(this.chipRate * 0.3);
      while (this.nsamp < limit) {
        this._stepMain(); chip.clock();
        if (this.booted) { if (after < 0) after = this.nsamp; if (this.nsamp - after >= tail) break; }
      }
      this.mainFrame = zn.frame; this.playing = 0;
      this._drawMain();
    }
    // 音源の 1 サンプルぶん、メイン基板と音源基板を進める
    _stepMain() {
      const zn = this.zn, board = this.board;
      this.nsamp++;
      zn.runTo(this.nsamp * this.mainRatio);
      while (board.samples < this.nsamp) board.run(1);       // 端数で 1 サンプル届いていない時
      this.prevSpuL = this.spuL; this.prevSpuR = this.spuR;
      this.spuL = zn.spu.outL * SPU_GAIN; this.spuR = zn.spu.outR * SPU_GAIN;
    }
    // ゲームが音源基板へ書いた: G = 全体音量(番号 4 / 5)、M = 共有 RAM、I = 割り込み(共有 RAM の 4 バイトを指令として読む)
    _mainSound(kind, a, v) {
      if (kind === 'G') {
        if (a === 4 || a === 5) { const g = v & 0x3f; if (this.gain[a - 4] !== g) { this.gain[a - 4] = g; this._write(0x8002 + (a - 4), g); } }   // サウンドテストの画面は毎フレーム同じ値を書くので、変わった時だけ
        return;
      }
      if (kind === 'M') { if (v) this.slot = a & ~3; return; }
      const s = this.board.shared, o = this.slot;
      this.booted = true;
      if (s[o] !== 0x01 || s[o + 3] !== 0x55) return;
      const code = s[o + 2] ? s[o + 1] : 0;
      this.playing = code; this.playFrames = 0; this.sent++;
      if (this.rec && code) this.rec.cur.w.push(REG_MARK, code, this.chip.nat);
    }
    _inputMain() {
      const b = this.pad[0] | this.pad[1], hit = b & ~this.prevPad, c = this.coinKeys[0] | this.coinKeys[1], inp = this.zn.inp;
      inp.p1 = 0xff & ~((b & 0x10 ? 0x01 : 0) | (b & 0x20 ? 0x02 : 0) | (b & 0x40 ? 0x04 : 0) | (b & 0x80 ? 0x08 : 0) | (b & 0x01 ? 0x10 : 0) | (b & 0x02 ? 0x20 : 0));
      inp.system = 0xff & ~((b & 0x08 ? 0x01 : 0) | (c & 1 ? 0x10 : 0) | (c & 2 ? 0x20 : 0));
      if (hit & 0x04) { this.dsw ^= 0x8; inp.dsw = this.dsw; }   // Select: DIP の Test Mode の入切(切ってからメニューの EXIT でゲームへ)
      this.prevPad = b;
    }
    _drawMain() {
      const g = this.gpu, w = g.width, h = g.height;
      if (w !== this.frameWidth || h !== this.frameHeight || this.frame.length !== w * h) { this.frame = new Uint32Array(w * h); this.frameWidth = w; this.frameHeight = h; }
      g.render(this.frame);
    }

    _write(reg, value) {
      const chip = this.chip;
      chip.write(reg, value);
      if (reg >= 0x8000) this.hist.push(reg, value, chip.nat);
      if (this.rec) this.rec.cur.w.push(reg, value, chip.nat);
    }
    static describe(c) { return 'Taito ZOOM sound board (ZSG-2)' + (c.info.game ? ' — ' + c.info.game : ''); }

    get hasBattery() { return false; }
    setSampleRate(sr) { this.sampleRate = sr > 0 ? sr : 48000; }
    get stereo() { return true; }
    extBits() { return 0; }
    get diskCount() { return 0; }
    chips() { return ['zsg2']; }
    reset() { const rec = !!this.rec; this.rec = null; this.frame = new Uint32Array(W * H); this.frameWidth = W; this.frameHeight = H; this._boot(); if (rec) this.startRecording(); }
    applyMix(mute, volume) {
      const put = (target, source, conv) => { if (source) for (let i = 0; i < target.length; i++) if (source[i] !== undefined) target[i] = conv(source[i]); };
      if (mute) put(this.chip.mute, (mute.expansion || mute).zsg2, (v) => !!v);
      if (volume) put(this.chip.vol, (volume.expansion || volume).zsg2, (v) => Math.max(0, Math.min(2, +v || 0)));
    }

    // ── 入力(フレームの終わりに読む)──
    setController(port, bits, turbo) { this.pad[port & 1] = bits | 0; this.coinKeys[port & 1] = turbo | 0; }
    setTurboRate() {}
    _send(code) {
      if (code) this.board.command(0x01, code & 0xff, 0x01, 0x55); else this.board.command(0x01, 0x00, 0x00, 0x55);
      this.playing = code; this.playFrames = 0; this.sent++;
      if (this.rec && code) this.rec.cur.w.push(REG_MARK, code, this.chip.nat);
    }
    _input() {
      const b = this.pad[0] | this.pad[1], hit = b & ~this.prevPad, lo = this.info.first, hi = this.info.last;
      // 左右上下は押しっぱなしで繰り返す(20 フレーム待って 4 フレームごと)
      const dir = b & 0xF0;
      let move = hit & 0xF0;
      if (dir && dir === (this.prevPad & 0xF0)) { if (++this.repeat >= 20 && (this.repeat - 20) % 4 === 0) move = dir; } else this.repeat = 0;
      let c = this.code;
      if (move & 0x80) c++; if (move & 0x40) c--; if (move & 0x10) c += 16; if (move & 0x20) c -= 16;
      this.code = c > hi ? hi : c < lo ? lo : c;
      if (hit & 0x01) this._send(this.code);
      if (hit & 0x02) this._send(0);
      if (hit & 0x08) { this.prevPad = b; this.reset(); return; }
      this.prevPad = b;
    }

    // ── 画面(自前のサウンドテスト)──
    _text(x, y, s, color, scale) {
      const f = this.frame;
      for (let i = 0; i < s.length; i++) {
        const g = FONT[s[i]];
        if (g) for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r] >> (4 - c) & 1) {
          const px = x + (i * 6 + c) * scale, py = y + r * scale;
          for (let dy = 0; dy < scale; dy++) { const o = (py + dy) * W + px; if (py + dy < H) for (let dx = 0; dx < scale; dx++) if (px + dx < W) f[o + dx] = color; }
        }
      }
    }
    _draw() {
      const f = this.frame, ch = this.chip.ch;
      f.fill(COL.bg);
      const two = (n) => String(n).padStart(2, '0');
      this._text(100, 12, 'SOUND TEST', COL.title, 2);
      if (this.info.game) this._text(Math.max(4, (W - this.info.game.length * 6) >> 1), 34, this.info.game.toUpperCase(), COL.dim, 1);
      this._text(40, 64, 'SOUND CODE', COL.hot, 2);
      this._text(190, 58, two(this.code), COL.text, 3);
      this._text(240, 68, '/ ' + two(this.info.first) + '-' + two(this.info.last), COL.dim, 1);
      const sec = Math.floor(this.playFrames / FPS);
      if (this.playing) this._text(40, 98, 'PLAYING ' + two(this.playing) + '   ' + two(Math.floor(sec / 60)) + ':' + two(sec % 60), COL.ok, 2);
      else this._text(40, 98, 'STOPPED', COL.dim, 2);
      // 声ごとの今の音量(48 本)
      for (let v = 0; v < 48; v++) {
        const e = ch[v], h = e.active ? Math.min(40, Math.round(Math.sqrt(e.vol / 65535) * 40)) : 0, x = 16 + v * 6;
        for (let y = 0; y < 40; y++) { const o = (176 - y) * W + x, c = y < h ? COL.bar : (y === 0 ? COL.barOff : 0); if (c) for (let dx = 0; dx < 4; dx++) f[o + dx] = c; }
      }
      this._text(16, 190, 'LEFT/RIGHT: CODE   UP/DOWN: +-16', COL.dim, 1);
      this._text(16, 202, 'A: PLAY   B: STOP   START: RESET BOARD', COL.dim, 1);
      if (this.info.need && this.info.need.length) this._text(16, 214, ('TEST MODE: ALSO DROP ' + this.info.need.join(' + ')).toUpperCase().slice(0, 48), COL.dim, 1);
    }

    // ── 音と進行 ──
    _frameEnd() {
      this.frameCount++;
      if (this.playing) this.playFrames++;
      if (this.zn) { this._inputMain(); this._drawMain(); } else { this._input(); this._draw(); }
      const rec = this.rec, chip = this.chip;
      if (rec) { rec.cur.n1 = chip.nat; rec.frames.push(rec.cur); rec.cur = { n0: chip.nat, n1: chip.nat, w: [] }; }
      if (this.onFrame) this.onFrame();
    }
    _stepChip() {
      const chip = this.chip;
      this.prevL = chip.outL; this.prevR = chip.outR;
      if (this.zn) { this._stepMain(); chip.clock(); if (this.zn.frame !== this.mainFrame) { this.mainFrame = this.zn.frame; this._frameEnd(); } return; }   // メイン基板つき: 垂直帰線ごとに 1 フレーム
      this.board.run(1);
      chip.clock();
      if (++this.frameAcc >= this.framePeriod) { this.frameAcc -= this.framePeriod; this._frameEnd(); }
    }
    runSamplesStereo(outL, outR) {
      const step = this.chipRate / this.sampleRate;
      for (let i = 0; i < outL.length; i++) {
        this.acc += step;
        while (this.acc >= 1) { this.acc -= 1; this._stepChip(); }
        const chip = this.chip, a = this.acc;            // 音源の 2 サンプルの間を直線でつなぐ
        let l = this.prevL + (chip.outL - this.prevL) * a, r = this.prevR + (chip.outR - this.prevR) * a;
        if (this.zn) { l += this.prevSpuL + (this.spuL - this.prevSpuL) * a; r += this.prevSpuR + (this.spuR - this.prevSpuR) * a; }
        l = l > 1 ? 1 : l < -1 ? -1 : l; r = r > 1 ? 1 : r < -1 ? -1 : r;
        if (outR) { outL[i] = l; outR[i] = r; } else outL[i] = (l + r) * 0.5;
      }
    }
    runSamples(out) { this.runSamplesStereo(out, null); }
    /** 1 フレーム進める(音スレッドが使えない時の主スレッド実行と、検査用。音は返さない) */
    runFrame() { const f = this.frameCount; let guard = 4096; while (this.frameCount === f && guard-- > 0) this._stepChip(); return null; }

    // ── 録音 ──
    startRecording() {
      const chip = this.chip, n = chip.nat, w = this.hist.slice();
      for (let c = 0; c < 48; c++) for (let r = 0; r < 16; r++) w.push(c * 16 + r, chip.ch[c].v[r], n);
      this.rec = { frames: [], cur: { n0: n, n1: n, w } };
    }
    stopRecording() {
      const rec = this.rec;
      if (!rec) return [];
      rec.cur.n1 = this.chip.nat; rec.frames.push(rec.cur);
      this.rec = null;
      return rec.frames;
    }
  }
  ZoomConsole.REG_MARK = REG_MARK;
  ZoomConsole.FONT = FONT;   // 他の基板のサウンドテスト画面(f3/ensoniqConsole.js)も同じ字を使う
  Emu.ZoomConsole = ZoomConsole;
})(typeof window !== 'undefined' ? window : globalThis);
