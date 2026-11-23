/*
 * MML.Emu.EnsoniqConsole — タイトーの Ensoniq 音源基板(F3 システムほか: 68000+ES5505+ES5510)を、ゲーム画面(src/ui/nesScreen.js)と
 * 音スレッド(src/audio/nes-worklet-impl.js)が期待する「本体」の形にした物。考え方は ZOOM 音源基板(src/emulator/zsg2/zoomConsole.js)と同じ:
 * メイン基板は動かさず、サウンド基板(ensoniqBoard.js)だけを動かして、自前の「サウンドテスト画面」から指令を送る。
 *
 * ★メイン基板つき(opts.main がある時。F3 システムのゲーム): メイン CPU(68EC020、f3Main.js)も動かし、ゲームの本物のテストモード画面を出す(f3Video.js。絵の ROM があれば背景とスプライトも)。
 *   起動の指令が済むまで早送りし、テストスイッチを押してメニューを出した所から始める。指令はゲーム自身が送る(自前の表は、録音の番号を引くのにだけ使う)。
 *   操作: 十字 = レバー、A = ボタン 1、B = ボタン 2、Start = スタート、Select = テストスイッチ
 *
 * 操作(setController の bits): 左右 = 番号を 1 ずつ、上下 = 16 ずつ、A = 鳴らす、B = 止める、Start = 基板のリセット
 * 番号と指令の対応は、ゲームごとの表(ensoniqRomSet.js の cmds。ゲームのサウンドテストが送る物を実測で控えた)。
 *
 * 音: ES5505 の 4 組の出力を足した物。1 組目はそのまま、残り 3 組は ES5510(エフェクト。es5510.js)を通す。
 *
 * 録音(rec): フレームごとに { n0, n1, w: [キー, 値, n, …] }(n = 音源の通算サンプル番号。キーは src/vgm/ensoniqRecord.js の冒頭)。
 *   0xFFFF は「ここで指令を送った」の印(値 = 番号)。最初のフレームには、それまでの ES5510 への書き込み全部と、ES5505 の今のレジスタを置く
 *   (鳴っている途中の声は位置が分からないので、止めた状態から始める)。VGM にするのは主スレッドの MML.VGM.encodeEnsoniqRecording。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const W = 320, H = 224, FPS = 60, GAIN = 0.8, RING = 0x400, KEY_MARK = 0xFFFF;
  const rgb = (r, g, b) => (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
  const COL = { bg: rgb(0, 0, 0), title: rgb(255, 255, 0), text: rgb(255, 255, 255), dim: rgb(140, 140, 150), hot: rgb(255, 80, 80), ok: rgb(90, 220, 120), bar: rgb(80, 160, 255), barOff: rgb(36, 40, 56) };

  class EnsoniqConsole {
    /** @param rom 使わない @param opts { program(0xC00000 から見える並び), wave(Int16Array、語の番地), info(ensoniqRomSet.js の INFO の 1 件) } */
    constructor(rom, opts) {
      this.opts = opts;
      this.info = opts.info || {};
      // 番号の表(ゲームのサウンドテストが送る指令の実測)があるゲームは、その番号どおりに鳴らす(効果音も)。
      // 無いゲームは「内部の曲番号」で曲だけ鳴らす: [03 81 nn][04 86 nn 70](どのゲームも同じ形。音量 70 は仮の値)。番号は 01〜7F を全部出す(無い番号は何も鳴らない)
      this.cmds = this.info.cmds && this.info.cmds.length ? this.info.cmds : null;
      this.first = 1; this.last = this.cmds ? this.cmds.length : 0x7f;
      this.sampleRate = 48000;
      this.frame = new Uint32Array(W * H);
      this.frameWidth = W; this.frameHeight = H;
      this.frameRate = FPS;
      this.onFrame = null;
      this.rec = null;
      this.underruns = 0;
      this.pad = [0, 0]; this.prevPad = 0; this.repeat = 0;
      this.code = this.first;
      this.mainOpt = opts.main && Emu.createF3Main && Emu.createF3Video ? opts.main : null;
      this.eeprom = null;                                  // メイン基板の EEPROM(リセットをまたいで持つ)
      this._boot();
    }
    _boot() {
      const o = this.opts, Bd = Emu.ENSONIQ_BOARD, hexBytes = Emu.EnsoniqRomSet.bytes;
      this.hist = [];
      const chip0 = new Emu.Es5505Audio(Bd.CPU_HZ, o.wave); chip0.attachEsp();   // ES5510(エフェクト)つき
      this.board = Emu.createEnsoniqBoard({ program: o.program, wave: o.wave, chip: chip0, startHeld: !!this.mainOpt, onWrite: (kind, a, b, c) => this._write(kind, a, b, c) });
      const chip = this.chip = this.board.chip;
      this.chipRate = Bd.CPU_HZ / Bd.CYCLES_PER_SAMPLE;
      this.framePeriod = this.chipRate / FPS;
      this.acc = 0; this.frameAcc = 0; this.prevL = 0; this.prevR = 0;
      this.frameCount = 0; this.playing = 0; this.playFrames = 0;
      this.ring = 0;
      if (this.mainOpt) return this._bootMain();
      const vol = this.info.volume === undefined ? 0x30 : this.info.volume;
      for (let i = 0; i < 4; i++) this.board.dpram[0x7f8 + i] = vol;          // メイン CPU が置く音量(サウンドテストの既定)
      // 起動: 基板が立ち上がるのを待ってから、メイン CPU が起動時に送る指令を順に送る(音は出さずに先へ進める)
      const run = (sec) => this.board.run(Math.round(sec * this.chipRate));
      run(0.6);
      for (const h of this.info.boot || []) { this._sendBytes(hexBytes(h)); run(0.3); }
      void chip;
      this._draw();
    }
    // ── メイン基板つき ──
    _bootMain() {
      const m = this.mainOpt;
      if (!this.eeprom) { this.eeprom = new Uint16Array(64).fill(0xffff); if (m.eeprom) for (let i = 0; i < 64 && i * 2 + 1 < m.eeprom.length; i++) this.eeprom[i] = m.eeprom[i * 2] << 8 | m.eeprom[i * 2 + 1]; }
      this.pkt = []; this.seenEffect = false; this.lastCmdFrame = 0;
      const f3 = this.f3 = Emu.createF3Main({ program: m.program, sound: this.board, eeprom: this.eeprom, onDpram: (a, v) => this._mainWrite(a, v) });
      this.video = Emu.createF3Video(f3, { top: m.top, height: m.height, pal12: m.pal12, extend: m.extend, lag: m.lag, gfx: m.gfx || null });
      this.rot = m.rot || 0;
      const vw = this.video.width, vh = this.video.height;
      this.vbuf = new Uint32Array(vw * vh);
      this.frameWidth = this.rot ? vh : vw; this.frameHeight = this.rot ? vw : vh;
      this.frame = this.rot ? new Uint32Array(vw * vh) : this.vbuf;
      this.frameRate = Emu.F3_MAIN.MAIN_HZ / Emu.F3_MAIN.FRAME_CYCLES;
      this.mainFrame = 0;
      // 起動の指令(エフェクトの番号まで)が済むまで早送り → テストスイッチを押す。それより前に押しても効かない(実測)
      const runFrames = (n) => { const end = f3.frame + n; while (f3.frame < end) f3.runSample(); };
      let guard = 2400;
      while (guard-- > 0 && !(this.seenEffect && f3.frame > this.lastCmdFrame + 240)) runFrames(1);   // 指令が 4 秒途絶えたら起動は済んだとみなす(エフェクトの設定が 3 秒後に続くゲームがある)
      f3.inp.system &= ~0x02; runFrames(6); f3.inp.system |= 0x02; runFrames(12);
      this.mainFrame = f3.frame; this.playing = 0;
      this._draw();
    }
    // メイン CPU が共有 RAM に書いた: 書き込み位置(0x481)が動いたら、そこまでのバイトを指令として読む(録音の印と、起動の進み具合)
    _mainWrite(a, v) {
      if (a < RING) { this.pkt.push(v); return; }
      if (a !== 0x481) return;
      const b = this.pkt; this.pkt = [];
      let play = -1, at = -1;
      for (let i = 0; i < b.length && b[i] > 0; i += b[i]) {
        const c = b[i + 1];
        if (c === 0x20 || c === 0x21) this.seenEffect = true;
        if (c === 0x81 && play < 0) { play = b[i + 2]; at = i; } else if (c === 0x8D && play < 0) { play = b[i + 2]; at = i; }
      }
      if (this.f3) this.lastCmdFrame = this.f3.frame;
      if (play < 0) return;
      // 番号: 表のあるゲームは、サウンドテストの番号を引く(送ったバイト列が同じ物)。無ければ指令の中の番号
      let no = play;
      if (this.cmds) { const hex = b.slice(at).map((x) => x.toString(16).padStart(2, '0')).join(''), k = this.cmds.indexOf(hex); if (k >= 0) no = k + 1; }
      this.playing = no; this.playFrames = 0;
      if (this.rec) this.rec.cur.w.push(KEY_MARK, no, this.chip.nat);
    }
    _inputMain() {
      const b = this.pad[0] | this.pad[1], inp = this.f3.inp;
      inp.in0 = 0xffff & ~((b & 0x01 ? 0x01 : 0) | (b & 0x02 ? 0x02 : 0) | (b & 0x08 ? 0x1000 : 0));
      inp.in1 = 0xffff & ~((b & 0x10 ? 0x01 : 0) | (b & 0x20 ? 0x02 : 0) | (b & 0x40 ? 0x04 : 0) | (b & 0x80 ? 0x08 : 0));
      inp.system = 0xfe & ~(b & 0x04 ? 0x02 : 0);
    }
    _drawMain() {
      const v = this.video, w = v.width, h = v.height, src = this.vbuf, dst = this.frame;
      // 背景やスプライトを描く場面は重い(音スレッドの負荷が 2 割ほど増える)ので、1 フレームおきに描く。文字だけの場面(テストモード)は毎フレーム
      this.drawSkip = !this.drawSkip;
      if (v.busy && this.drawSkip) return;
      v.render(src);
      if (this.rot === 90) { for (let y = 0; y < w; y++) for (let x = 0; x < h; x++) dst[y * h + x] = src[(h - 1 - x) * w + y]; }
      else if (this.rot === 270) { for (let y = 0; y < w; y++) for (let x = 0; x < h; x++) dst[y * h + x] = src[x * w + (w - 1 - y)]; }
      else if (this.rot === 180) { for (let i = 0, n = w * h; i < n; i++) dst[i] = src[n - 1 - i]; }
    }

    // 基板からの書き込み → 録音の「キー」
    _write(kind, a, b, c) {
      let key = -1, value = b;
      if (kind === 'E') key = c === 0xff00 ? 0x100 + a : c === 0x00ff ? 0x200 + a : a;
      else if (kind === 'B') { key = 0x400 + a; value = b & 0xff; }
      else if (kind === 'D') { key = 0x1000 + a; this.hist.push(key, value, this.chip ? this.chip.nat : 0); }
      else if (kind === 'O') { key = 0x2000; value = a; this.hist.push(key, value, this.chip ? this.chip.nat : 0); }
      if (key >= 0 && this.rec) this.rec.cur.w.push(key, value, this.chip.nat);
    }
    static describe(c) { return (c.mainOpt ? 'Taito F3 (test mode, ES5505)' : 'Taito Ensoniq sound board (ES5505)') + (c.info.game ? ' — ' + c.info.game : ''); }

    get hasBattery() { return false; }
    setSampleRate(sr) { this.sampleRate = sr > 0 ? sr : 48000; }
    get stereo() { return true; }
    extBits() { return 0; }
    get diskCount() { return 0; }
    chips() { return ['es5505']; }
    reset() { const rec = !!this.rec; this.rec = null; this._boot(); if (rec) this.startRecording(); }
    applyMix(mute, volume) {
      const put = (target, source, conv) => { if (source) for (let i = 0; i < target.length; i++) if (source[i] !== undefined) target[i] = conv(source[i]); };
      if (mute) put(this.chip.mute, (mute.expansion || mute).es5505, (v) => !!v);
      if (volume) put(this.chip.vol, (volume.expansion || volume).es5505, (v) => Math.max(0, Math.min(2, +v || 0)));
    }

    // ── メイン CPU の代わり: 共有 RAM のリングバッファへ指令を書き、書き込み位置(× 2)を 0x480 / 0x481 に置く ──
    _sendBytes(bytes) {
      const d = this.board.dpram;
      for (const b of bytes) { d[this.ring] = b; this.ring = (this.ring + 1) % RING; }
      d[0x480] = (this.ring * 2) >> 8; d[0x481] = (this.ring * 2) & 0xff;
    }
    // 前に送った音を止める指令。ゲームのサウンドテストは、次の音を鳴らす前に必ずこれを送る(MAME で確かめた):
    //   曲 [03 81 nn] → [04 86 nn 00][03 82 nn]、効果音 [06 8E a b d e] → [05 8F a b d]。送らないと曲が重なり、鳴り続ける効果音が止まらない
    _stopOf(bytes) {
      const out = [];
      for (let i = 0; i < bytes.length && bytes[i] > 0; i += bytes[i]) {
        if (bytes[i + 1] === 0x81) out.push(4, 0x86, bytes[i + 2], 0, 3, 0x82, bytes[i + 2]);
        else if (bytes[i + 1] === 0x8E) out.push(5, 0x8F, bytes[i + 2], bytes[i + 3], bytes[i + 4]);
      }
      return out;
    }
    _send(no) {
      let bytes;
      if (this.cmds) { const hex = this.cmds[no - 1]; if (!hex) return; bytes = Emu.EnsoniqRomSet.bytes(hex); }
      else bytes = [3, 0x81, no, 4, 0x86, no, 0x70];
      if (this.lastStop && this.lastStop.length) this._sendBytes(this.lastStop);
      this._sendBytes(bytes); this.lastStop = this._stopOf(bytes);
      this.playing = no; this.playFrames = 0;
      if (this.rec) this.rec.cur.w.push(KEY_MARK, no, this.chip.nat);
    }
    _stop() {
      if (this.lastStop && this.lastStop.length) this._sendBytes(this.lastStop);
      if (this.cmds) for (const no of this.info.stop || []) { const hex = this.cmds[no - 1]; if (hex) this._sendBytes(Emu.EnsoniqRomSet.bytes(hex)); }
      this.lastStop = null; this.playing = 0;
    }
    setController(port, bits) { this.pad[port & 1] = bits | 0; }
    setTurboRate() {}
    _input() {
      if (this.f3) return this._inputMain();
      const b = this.pad[0] | this.pad[1], hit = b & ~this.prevPad, lo = this.first, hi = this.last;
      const dir = b & 0xF0;
      let move = hit & 0xF0;
      if (dir && dir === (this.prevPad & 0xF0)) { if (++this.repeat >= 20 && (this.repeat - 20) % 4 === 0) move = dir; } else this.repeat = 0;
      let c = this.code;
      if (move & 0x80) c++; if (move & 0x40) c--; if (move & 0x10) c += 16; if (move & 0x20) c -= 16;
      this.code = c > hi ? hi : c < lo ? lo : c;
      if (hit & 0x01) this._send(this.code);
      if (hit & 0x02) this._stop();
      if (hit & 0x08) { this.prevPad = b; this.reset(); return; }
      this.prevPad = b;
    }

    // ── 画面(自前のサウンドテスト。字は zoomConsole.js の 5×7 を借りる)──
    _text(x, y, s, color, scale) {
      const f = this.frame, FONT = Emu.ZoomConsole.FONT;
      for (let i = 0; i < s.length; i++) {
        const g = FONT[s[i]];
        if (g) for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r] >> (4 - c) & 1) {
          const px = x + (i * 6 + c) * scale, py = y + r * scale;
          for (let dy = 0; dy < scale; dy++) { const o = (py + dy) * W + px; if (py + dy < H) for (let dx = 0; dx < scale; dx++) if (px + dx < W) f[o + dx] = color; }
        }
      }
    }
    _num(n) { return this.info.hex ? n.toString(16).toUpperCase().padStart(2, '0') : String(n).padStart(2, '0'); }
    _draw() {
      if (this.f3) return this._drawMain();
      const f = this.frame, vs = this.chip.v;
      f.fill(COL.bg);
      const two = (n) => String(n).padStart(2, '0');
      this._text(100, 12, 'SOUND TEST', COL.title, 2);
      if (this.info.game) this._text(Math.max(4, (W - this.info.game.length * 6) >> 1), 34, this.info.game.toUpperCase(), COL.dim, 1);
      this._text(40, 64, this.cmds ? 'SOUND NO' : 'BGM NO', COL.hot, 2);
      this._text(190, 58, this._num(this.code), COL.text, 3);
      this._text(240, 68, '/ ' + this._num(this.first) + '-' + this._num(this.last), COL.dim, 1);
      const sec = Math.floor(this.playFrames / FPS);
      if (this.playing) this._text(40, 98, 'PLAYING ' + this._num(this.playing) + '   ' + two(Math.floor(sec / 60)) + ':' + two(sec % 60), COL.ok, 2);
      else this._text(40, 98, 'STOPPED', COL.dim, 2);
      for (let v = 0; v < 32; v++) {
        const e = vs[v], on = !(e.control & 3), h = on ? Math.min(40, Math.round(Math.sqrt(Math.max(e.lvol, e.rvol) / 255) * 40)) : 0, x = 16 + v * 9;
        for (let y = 0; y < 40; y++) { const o = (176 - y) * W + x, c = y < h ? COL.bar : (y === 0 ? COL.barOff : 0); if (c) for (let dx = 0; dx < 6; dx++) f[o + dx] = c; }
      }
      this._text(16, 190, 'LEFT/RIGHT: NUMBER   UP/DOWN: +-16', COL.dim, 1);
      this._text(16, 202, 'A: PLAY   B: STOP   START: RESET BOARD', COL.dim, 1);
    }

    // ── 音と進行 ──
    _frameEnd() {
      this.frameCount++;
      if (this.playing) this.playFrames++;
      this._input();
      this._draw();
      const rec = this.rec, chip = this.chip;
      if (rec) { rec.cur.n1 = chip.nat; rec.frames.push(rec.cur); rec.cur = { n0: chip.nat, n1: chip.nat, w: [] }; }
      if (this.onFrame) this.onFrame();
    }
    _stepChip() {
      const chip = this.chip;
      this.prevL = chip.outL; this.prevR = chip.outR;
      if (this.f3) { this.f3.runSample(); if (this.f3.frame !== this.mainFrame) { this.mainFrame = this.f3.frame; this._frameEnd(); } return; }   // メイン基板つき: 垂直帰線ごとに 1 フレーム
      this.board.run(1);
      if (++this.frameAcc >= this.framePeriod) { this.frameAcc -= this.framePeriod; this._frameEnd(); }
    }
    runSamplesStereo(outL, outR) {
      const step = this.chipRate / this.sampleRate;
      for (let i = 0; i < outL.length; i++) {
        this.acc += step;
        while (this.acc >= 1) { this.acc -= 1; this._stepChip(); }
        const chip = this.chip, a = this.acc;
        let l = (this.prevL + (chip.outL - this.prevL) * a) * GAIN, r = (this.prevR + (chip.outR - this.prevR) * a) * GAIN;
        l = l > 1 ? 1 : l < -1 ? -1 : l; r = r > 1 ? 1 : r < -1 ? -1 : r;
        if (outR) { outL[i] = l; outR[i] = r; } else outL[i] = (l + r) * 0.5;
      }
    }
    runSamples(out) { this.runSamplesStereo(out, null); }
    runFrame() { const f = this.frameCount; let guard = 4096; while (this.frameCount === f && guard-- > 0) this._stepChip(); return null; }

    // ── 録音 ──
    startRecording() {
      const chip = this.chip, n = chip.nat, w = this.hist.slice();
      for (let v = 0; v < 32; v++) {
        const e = chip.v[v];
        w.push(0x0f, v, n, 0x400 + v, (e.bank / 0x100000) & 0xff, n);
        w.push(0x00, (e.control & 0x0fff) | 1, n);                                  // 止めた状態から
        w.push(0x01, (e.freq >>> 1) & 0xffff, n, 0x02, (e.start >>> 18) & 0xffff, n, 0x03, (e.start >>> 2) & 0xffff, n, 0x04, (e.end >>> 18) & 0xffff, n, 0x05, (e.end >>> 2) & 0xffff, n);
        w.push(0x06, e.k2, n, 0x07, e.k1, n, 0x08, e.lvol << 8, n, 0x09, e.rvol << 8, n);
      }
      w.push(0x0f, chip.page, n);
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
  EnsoniqConsole.KEY_MARK = KEY_MARK; EnsoniqConsole.GAIN = GAIN;
  Emu.EnsoniqConsole = EnsoniqConsole;
})(typeof window !== 'undefined' ? window : globalThis);
