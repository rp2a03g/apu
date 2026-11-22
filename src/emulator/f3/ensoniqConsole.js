/*
 * MML.Emu.EnsoniqConsole — タイトーの Ensoniq 音源基板(F3 システムほか: 68000+ES5505+ES5510)を、ゲーム画面(src/ui/nesScreen.js)と
 * 音スレッド(src/audio/nes-worklet-impl.js)が期待する「本体」の形にした物。考え方は ZOOM 音源基板(src/emulator/zsg2/zoomConsole.js)と同じ:
 * メイン基板は動かさず、サウンド基板(ensoniqBoard.js)だけを動かして、自前の「サウンドテスト画面」から指令を送る。
 *
 * 操作(setController の bits): 左右 = 番号を 1 ずつ、上下 = 16 ずつ、A = 鳴らす、B = 止める、Start = 基板のリセット
 * 番号と指令の対応は、ゲームごとの表(ensoniqRomSet.js の cmds。ゲームのサウンドテストが送る物を実測で控えた)。
 *
 * 音: ES5505 の 4 組の出力を足した物。ES5510(エフェクト)はまだ通していない。
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
      this._boot();
    }
    _boot() {
      const o = this.opts, Bd = Emu.ENSONIQ_BOARD, hexBytes = Emu.EnsoniqRomSet.bytes;
      this.hist = [];
      this.board = Emu.createEnsoniqBoard({ program: o.program, wave: o.wave, onWrite: (kind, a, b, c) => this._write(kind, a, b, c) });
      const chip = this.chip = this.board.chip;
      this.chipRate = Bd.CPU_HZ / Bd.CYCLES_PER_SAMPLE;
      this.framePeriod = this.chipRate / FPS;
      this.acc = 0; this.frameAcc = 0; this.prevL = 0; this.prevR = 0;
      this.frameCount = 0; this.playing = 0; this.playFrames = 0;
      this.ring = 0;
      const vol = this.info.volume === undefined ? 0x30 : this.info.volume;
      for (let i = 0; i < 4; i++) this.board.dpram[0x7f8 + i] = vol;          // メイン CPU が置く音量(サウンドテストの既定)
      // 起動: 基板が立ち上がるのを待ってから、メイン CPU が起動時に送る指令を順に送る(音は出さずに先へ進める)
      const run = (sec) => this.board.run(Math.round(sec * this.chipRate));
      run(0.6);
      for (const h of this.info.boot || []) { this._sendBytes(hexBytes(h)); run(0.3); }
      void chip;
      this._draw();
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
    static describe(c) { return 'Taito Ensoniq sound board (ES5505)' + (c.info.game ? ' — ' + c.info.game : ''); }

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
    _send(no) {
      if (this.cmds) { const hex = this.cmds[no - 1]; if (!hex) return; this._sendBytes(Emu.EnsoniqRomSet.bytes(hex)); }
      else { if (this.playing) this._sendBytes([4, 0x86, this.playing, 0, 3, 0x82, this.playing]); this._sendBytes([3, 0x81, no, 4, 0x86, no, 0x70]); }
      this.playing = no; this.playFrames = 0;
      if (this.rec) this.rec.cur.w.push(KEY_MARK, no, this.chip.nat);
    }
    _stop() {
      if (this.cmds) for (const no of this.info.stop || []) { const hex = this.cmds[no - 1]; if (hex) this._sendBytes(Emu.EnsoniqRomSet.bytes(hex)); }
      else if (this.playing) this._sendBytes([4, 0x86, this.playing, 0, 3, 0x82, this.playing]);       // ゲームが曲を止める時に送る形(音量 0 → 停止)
      this.playing = 0;
    }
    setController(port, bits) { this.pad[port & 1] = bits | 0; }
    setTurboRate() {}
    _input() {
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
