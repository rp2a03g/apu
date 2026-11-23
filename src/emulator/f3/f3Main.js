/*
 * MML.Emu.createF3Main(opt) — タイトー F3 システムのメイン基板(68EC020+入出力+EEPROM+画面用の RAM)。音源基板(ensoniqBoard.js)をつないで一緒に進める。
 *
 * ゲームの本物のテストモード画面(サウンドテスト)を出すための物。配置と割り込みは MAME taito/taito_f3.cpp(Copyright Bryan McPhail。BSD-3-Clause)から。
 *   0x000000 プログラム ROM(2MB)/ 0x400000 RAM(128KB。0x420000 に鏡像)/ 0x440000 パレット(32KB)
 *   0x4A0000 入出力(入力 6 本、EEPROM、コインカウンタ)/ 0x4C0000 タイマの設定(何もしない)
 *   0x600000 スプライト / 0x610000 背景 4 面 / 0x61C000 文字の面 / 0x61E000 文字の絵(RAM)/ 0x620000 ライン RAM / 0x630000 ピクセルの面
 *   0x660000 画面の制御レジスタ / 0xC00000 音源基板との共有 RAM(バイト番地そのまま)/ 0xC80000 サウンド CPU のリセットを放す / 0xC80100 押さえる
 * 割り込み: 垂直帰線の頭でレベル 2、その 10000 クロック後にレベル 3(どちらも受け付けで下がる)。
 * ウォッチドッグ: 0x4A0000 への書き込みが 3 秒途絶えるとメイン基板ごとリセット(MAME の既定値)。ゲームは EEPROM を作り直した後、わざと止まってこれを待つ。
 * 画面: 6.6715MHz ÷ 432 ÷ 262 = 58.94Hz。垂直帰線は 256 本目から。
 *
 * opt: { program(Uint8Array 2MB、並べ替え済み), sound(Emu.createEnsoniqBoard の戻り値。startHeld: true で作る), eeprom(Uint16Array 64。省略時は 0xFFFF) , onDpram(番地, 値, 秒) }
 * 口: runSample()(音源の 1 サンプルぶん: メイン CPU と音源基板を進め、音源を 1 回刻む)/ frame(今のフレーム番号)/ setInputs({ in0, in1, system })
 *     ram / pal / vram(0x600000〜0x63FFFF)/ ctrl(0x660000〜)/ eeprom / cpu
 */
(function (root) {
  'use strict';
  const MML = root.MML = root.MML || {}, Emu = MML.Emu = MML.Emu || {};
  const MAIN_HZ = 16000000, FRAME_CYCLES = MAIN_HZ / (6671500 / 432 / 262), VBLANK_AT = 256 / 262, INT3_DELAY = 10000, WATCHDOG = 3 * MAIN_HZ;

  // ── EEPROM 93C46(16bit × 64 語)。CS を上げ、開始ビット 1、命令 2bit、番地 6bit、(データ 16bit)──
  function createEeprom93c46(data) {
    const mem = data || new Uint16Array(64).fill(0xffff);
    let cs = 0, clk = 0, di = 0, out = 1, bits = 0, count = 0, started = false, mode = 0, addr = 0, shiftOut = 0, outLeft = 0, writable = false, dirty = false;
    function begin() { bits = 0; count = 0; started = false; mode = 0; outLeft = 0; out = 1; }
    function clock() {
      if (mode === 1) {          // 読み出し中: 上位から 1 ビットずつ
        if (outLeft > 0) { out = shiftOut >> 15 & 1; shiftOut = (shiftOut << 1) & 0xffff; outLeft--; if (outLeft === 0) { addr = (addr + 1) & 63; shiftOut = mem[addr]; outLeft = 16; } }
        return;
      }
      if (mode === 2 || mode === 3) {   // 書き込みのデータ待ち(2 = 1 語、3 = 全部)
        bits = (bits << 1 | di) & 0xffff; count++;
        if (count === 16) {
          if (writable) { if (mode === 2) mem[addr] = bits; else mem.fill(bits); dirty = true; }
          mode = 4; out = 1;
        }
        return;
      }
      if (mode === 4) return;
      if (!started) { if (di) { started = true; bits = 0; count = 0; } return; }
      bits = (bits << 1 | di) & 0xff; count++;
      if (count < 8) return;
      const op = bits >> 6 & 3; addr = bits & 63;
      if (op === 2) { mode = 1; shiftOut = mem[addr]; outLeft = 16; out = 0; }         // READ(最初に 0 を 1 つ出す)
      else if (op === 1) { mode = 2; bits = 0; count = 0; }                           // WRITE
      else if (op === 3) { if (writable) { mem[addr] = 0xffff; dirty = true; } mode = 4; out = 1; }   // ERASE
      else {
        const sub = addr >> 4;
        if (sub === 3) { writable = true; mode = 4; } else if (sub === 0) { writable = false; mode = 4; }
        else if (sub === 2) { if (writable) { mem.fill(0xffff); dirty = true; } mode = 4; }
        else { mode = 3; bits = 0; count = 0; }                                       // WRAL
      }
    }
    return {
      mem,
      write(csNew, clkNew, diNew) {
        di = diNew;
        if (csNew && !cs) begin();
        if (!csNew && cs) begin();
        if (csNew && clkNew && !clk) clock();
        cs = csNew; clk = clkNew;
      },
      get out() { return out; },
      get dirty() { return dirty; }, set dirty(v) { dirty = v; },
      getState() { return [cs, clk, di, out, bits, count, started ? 1 : 0, mode, addr, shiftOut, outLeft, writable ? 1 : 0]; },
      setState(s) { let st, w; [cs, clk, di, out, bits, count, st, mode, addr, shiftOut, outLeft, w] = s; started = !!st; writable = !!w; }
    };
  }
  Emu.createEeprom93c46 = createEeprom93c46;

  Emu.createF3Main = function (opt) {
    const rom = opt.program, sound = opt.sound, SB = Emu.ENSONIQ_BOARD;
    const ram = new Uint8Array(0x20000), pal = new Uint8Array(0x8000), vram = new Uint8Array(0x40000), ctrl = new Uint8Array(0x20);
    const eeprom = createEeprom93c46(opt.eeprom);
    const dpram = sound.dpram, onDpram = opt.onDpram || null, onReset = opt.onReset || null;
    // 入力(どれも押していない = 1)。in0 = ボタンとスタート、in1 = レバー、system = テスト / コイン(EEPROM の読み出しと同じバイト)
    const inp = { in0: 0xffff, in1: 0xffff, system: 0xfe, in4: 0xffffffff, in5: 0xffff, analog0: 0, analog1: 0 };
    const coinWord = [0, 0];
    const stats = { unmappedR: 0, unmappedW: 0, lastUnmapped: 0, vramDirty: 0 };
    let cpu = null, irqPending = 0, frame = 0, samples = 0, nextVblank = FRAME_CYCLES * VBLANK_AT, int3At = Infinity, eeOut = 0, watchdogAt = WATCHDOG, resets = 0;

    function port(n) {
      switch (n) {
        case 0: { const e = (inp.system & 0xfe) | eeprom.out; return ((e << 24) | (e << 16) | (inp.in0 & 0xffff)) >>> 0; }
        case 1: return ((coinWord[0] << 16) | (inp.in1 & 0xffff)) >>> 0;
        case 2: return (0xffff0000 | (inp.analog0 & 0xffff)) >>> 0;
        case 3: return (0xffff0000 | (inp.analog1 & 0xffff)) >>> 0;
        case 4: return inp.in4 >>> 0;
        case 5: return ((coinWord[1] << 16) | (inp.in5 & 0xffff)) >>> 0;
        default: return 0xffffffff;
      }
    }
    function ioWrite8(a, v) {
      const off = (a - 0x4a0000) >> 2, lane = a & 3;
      if (off === 0) { watchdogAt = cpu.cycles + WATCHDOG; return; }
      if (off === 1) { if (lane < 2) coinWord[0] = lane === 0 ? (coinWord[0] & 0x00ff) | v << 8 : (coinWord[0] & 0xff00) | v; }
      else if (off === 5) { if (lane < 2) coinWord[1] = lane === 0 ? (coinWord[1] & 0x00ff) | v << 8 : (coinWord[1] & 0xff00) | v; }
      else if (off === 4 && lane === 3) { eeOut = v; eeprom.write(v >> 4 & 1, v >> 3 & 1, v >> 2 & 1); }
    }
    function updateIrq() { cpu.setIrq(irqPending & 8 ? 3 : irqPending & 4 ? 2 : 0); }

    const bus = {
      read8(a) {
        if (a < 0x200000) return rom[a];
        if (a >= 0x400000 && a < 0x440000) return ram[a & 0x1ffff];
        if (a >= 0x600000 && a < 0x640000) return vram[a - 0x600000];
        if (a >= 0x440000 && a < 0x448000) return pal[a - 0x440000];
        if (a >= 0x4a0000 && a < 0x4a0020) return port((a - 0x4a0000) >> 2) >>> ((3 - (a & 3)) * 8) & 0xff;
        if (a >= 0xc00000 && a < 0xc00800) return dpram[a - 0xc00000];
        stats.unmappedR++; stats.lastUnmapped = a;
        return 0xff;
      },
      read16(a) {
        if (a < 0x200000) return rom[a] << 8 | rom[a + 1];
        if (a >= 0x400000 && a < 0x440000) { const i = a & 0x1ffff; return ram[i] << 8 | ram[i + 1]; }
        if (a >= 0x600000 && a < 0x640000) { const i = a - 0x600000; return vram[i] << 8 | vram[i + 1]; }
        return bus.read8(a) << 8 | bus.read8(a + 1);
      },
      write8(a, v) {
        if (a >= 0x400000 && a < 0x440000) { ram[a & 0x1ffff] = v; return; }
        if (a >= 0x600000 && a < 0x640000) { vram[a - 0x600000] = v; stats.vramDirty++; return; }
        if (a >= 0x440000 && a < 0x448000) { pal[a - 0x440000] = v; return; }
        if (a >= 0x660000 && a < 0x660020) { ctrl[a - 0x660000] = v; return; }
        if (a >= 0x4a0000 && a < 0x4a0020) { ioWrite8(a, v); return; }
        if (a >= 0xc00000 && a < 0xc00800) { dpram[a - 0xc00000] = v; if (onDpram) onDpram(a - 0xc00000, v, cpu.cycles / MAIN_HZ); return; }
        if (a >= 0xc80000 && a < 0xc80004) { if (sound.held) { sound.setReset(false); if (onReset) onReset(0, cpu.cycles / MAIN_HZ); } return; }
        if (a >= 0xc80100 && a < 0xc80104) { if (!sound.held) { sound.setReset(true); if (onReset) onReset(1, cpu.cycles / MAIN_HZ); } return; }
        if (a >= 0x4c0000 && a < 0x4c0004) return;
        if (a >= 0x300000 && a < 0x300080) return;      // 波形のバンク(一部のゲームだけ。未対応)
        stats.unmappedW++; stats.lastUnmapped = a;
      },
      write16(a, v) {
        if (a >= 0x400000 && a < 0x440000) { const i = a & 0x1ffff; ram[i] = v >> 8; ram[i + 1] = v; return; }
        if (a >= 0x600000 && a < 0x640000) { const i = a - 0x600000; vram[i] = v >> 8; vram[i + 1] = v; stats.vramDirty++; return; }
        bus.write8(a, v >> 8); bus.write8(a + 1, v & 0xff);
      },
      irqAck(level) { irqPending &= ~(1 << level); updateIrq(); return 24 + level; }
    };
    cpu = Emu.createM68020(bus);
    cpu.reset();
    cpu.cycles = 0;

    // メイン CPU を通しのクロック数 until まで進める。垂直帰線とレベル 3 の時刻で区切る
    function hardReset() {
      const c = cpu.cycles;
      if (!sound.held) { sound.setReset(true); if (onReset) onReset(1, c / MAIN_HZ); }
      cpu.reset(); cpu.cycles = c;
      irqPending = 0; int3At = Infinity; watchdogAt = c + WATCHDOG; resets++;
    }
    function runTo(until) {
      for (;;) {
        if (cpu.cycles >= watchdogAt) hardReset();
        const ev = Math.min(nextVblank, int3At);
        if (ev > until) { cpu.run(until); return; }
        if (cpu.cycles < ev) cpu.run(ev);
        if (ev === nextVblank) { irqPending |= 4; frame++; int3At = cpu.cycles + INT3_DELAY; nextVblank += FRAME_CYCLES; }
        else { irqPending |= 8; int3At = Infinity; }
        updateIrq();
      }
    }
    const MAIN_PER_SAMPLE = MAIN_HZ * SB.CYCLES_PER_SAMPLE / SB.CPU_HZ;
    /** 音源の 1 サンプルぶん進める */
    function runSample() {
      samples++;
      runTo(samples * MAIN_PER_SAMPLE);
      sound.run(1);
    }
    return { runSample, runTo, cpu, ram, pal, vram, ctrl, eeprom, inp, stats, bus,
      get frame() { return frame; }, get resets() { return resets; }, get samples() { return samples; }, get time() { return samples * SB.CYCLES_PER_SAMPLE / SB.CPU_HZ; } };
  };
  Emu.F3_MAIN = { MAIN_HZ, FRAME_CYCLES };
})(typeof globalThis !== 'undefined' ? globalThis : this);
