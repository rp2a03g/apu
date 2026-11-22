/*
 * MML.Emu.createZoomBoard({ program, wave })
 *
 * タイトーの ZOOM 音源基板(FX-1B)のうち「サウンド CPU が音源へ何を書くか」を作る部分。
 * MN10200(mn10200.js)にサウンドプログラムを走らせ、ZSG-2 と TMS57002 への書き込みを時刻つきで並べる。
 * 音は作らない(鳴らすのは Zsg2Audio。ここで出た書き込み列を VGM にして渡す)。
 * 配置は MAME の src/mame/taito/taito_zm.cpp(Olivier Galibert / hap / superctr / cam900、BSD-3-Clause)のとおり:
 *   0x080000-0x0FFFFF プログラム ROM / 0x400000-0x41FFFF RAM / 0x800000-0x8007FF ZSG-2(16bit)/ 0xC00000 TMS57002 / 0xE00000-0xE000FF メイン CPU との共有 RAM
 *   ポート 1 = TMS57002 の制御線、割り込み 0 = メイン CPU から、割り込み 1 = TMS57002 の EMPTY(反転)
 *
 * 時間: サウンド CPU は 12.5MHz の 2 分周 = 毎秒 625 万サイクル、ZSG-2 は 25MHz/768 = 1 サンプル 192 サイクル(割り切れる)。
 * DSP は 1 サンプルに 1 回、サンプルの境目でまとめて走らせる。CPU から見える DSP の働きは「係数の更新を食べ終えたか」だけなので、
 * 更新が待っていないサンプルでは DSP を回さない(回しても書き込み列は変わらない。opt.dspAlways で毎サンプル回して確かめられる)。
 *
 * 出力: events = [{ t(秒), o(通し番号), reg, value }]。reg は ZSG-2 のレジスタ番号(番地/2)、0x8000 = DSP のデータ、0x8001 = DSP の制御線。
 */
(function (root) {
  'use strict';
  const MML = root.MML = root.MML || {}, Emu = MML.Emu = MML.Emu || {};
  const CPU_HZ = 6250000, CYCLES_PER_SAMPLE = 192;
  const REG_DSP_DATA = 0x8000, REG_DSP_CTRL = 0x8001;

  Emu.createZoomBoard = function (opt) {
    const program = opt.program, wave = opt.wave;
    const ram = new Uint8Array(0x20000), shared = new Uint8Array(0x100), ctlReg = new Uint16Array(0x20);
    const waveWords = wave.length >>> 2;
    const dsp = Emu.createTms57002();
    let events = [], order = 0, readAddr = 0, tmsCtrl = 0, samples = 0, dspRuns = 0, cmdSlot = 0x80;
    const stats = { unmappedR: 0, unmappedW: 0, zsgByte: 0, zsgRead: 0 };
    let cpu = null;
    const now = () => cpu.cycles / CPU_HZ;
    // opt.onWrite(reg, value): 書き込みをその場で受け取る(実時間で鳴らす時。渡すと events には溜めない)
    const onWrite = typeof opt.onWrite === 'function' ? opt.onWrite : null;
    const push = (reg, value) => { if (onWrite) onWrite(reg, value); else events.push({ t: now(), o: order++, reg, value }); };
    const syncEmpty = () => { cpu.setInput(1, dsp.empty ? 0 : 1); };

    function zsgRead(reg) {
      stats.zsgRead++;
      if (reg < 0x300) return 0;                       // 声のレジスタの読み戻しは、このドライバは使わない
      const r = reg - 0x300;
      if (r === 0x14) return 0;                        // 波形メモリのバスの空き待ち
      if (r === 0x1e || r === 0x1f) {
        if (readAddr >= waveWords) return 0;
        const p = readAddr * 4;
        return r === 0x1e ? wave[p] | wave[p + 1] << 8 : wave[p + 2] | wave[p + 3] << 8;
      }
      return r < 0x20 ? ctlReg[r] : 0;
    }
    function zsgWrite(reg, v) {
      if (reg >= 0x300) {
        const r = reg - 0x300;
        if (r === 0x1c) readAddr = ((readAddr & 0x3fffc000) | (v >> 2 & 0x3fff)) >>> 0;
        else if (r === 0x1d) readAddr = ((readAddr & 0x3fff) | (v << 14 & 0x3fffc000)) >>> 0;
        else if (r < 0x20 && !(r <= 2 || (r >= 4 && r <= 6))) ctlReg[r] = v;
      }
      push(reg, v);
    }
    const bus = {
      rom: program,
      read8(a) {
        if (a >= 0x400000 && a < 0x420000) return ram[a - 0x400000];
        if (a >= 0xe00000 && a < 0xe00100) return shared[a - 0xe00000];
        if (a === 0xc00000) return 0xff;               // DSP からの読み出し(このドライバは結果を使わない)
        if (a >= 0x800000 && a < 0x800800) { stats.zsgByte++; return 0; }
        stats.unmappedR++; return 0;
      },
      read16(a) {
        if (a >= 0x400000 && a < 0x420000) return ram[a - 0x400000] | ram[a - 0x3fffff] << 8;
        if (a >= 0x800000 && a < 0x800800) return zsgRead((a - 0x800000) >> 1);
        if (a >= 0xe00000 && a < 0xe00100) return shared[a - 0xe00000] | shared[a - 0xdfffff] << 8;
        if (a === 0xc00000) return 0xff;
        stats.unmappedR++; return 0;
      },
      write8(a, v) {
        if (a >= 0x400000 && a < 0x420000) { ram[a - 0x400000] = v; return; }
        if (a >= 0xe00000 && a < 0xe00100) { shared[a - 0xe00000] = v; return; }
        if (a === 0xc00000) { push(REG_DSP_DATA, v); dsp.dataW(v); syncEmpty(); return; }
        if (a >= 0x800000 && a < 0x800800) { stats.zsgByte++; return; }   // ZSG-2 は 16bit の書き込みだけ受ける
        stats.unmappedW++;
      },
      write16(a, v) {
        if (a >= 0x400000 && a < 0x420000) { ram[a - 0x400000] = v & 0xff; ram[a - 0x3fffff] = v >> 8; return; }
        if (a >= 0x800000 && a < 0x800800) { zsgWrite((a - 0x800000) >> 1, v); return; }
        if (a >= 0xe00000 && a < 0xe00100) { shared[a - 0xe00000] = v & 0xff; shared[a - 0xdfffff] = v >> 8; return; }
        if (a === 0xc00000) { push(REG_DSP_DATA, v & 0xff); dsp.dataW(v & 0xff); syncEmpty(); return; }
        stats.unmappedW++;
      },
      portWrite(n, v) { if (n === 1) { tmsCtrl = v; if (cpu) push(REG_DSP_CTRL, v); dsp.ctrl(v); } },
      portRead(n) { return n === 1 ? tmsCtrl : 0xff; }
    };
    cpu = Emu.createMn10200(bus);
    cpu.reset();
    syncEmpty();

    // n サンプルぶん進める。DSP は MAME と同じく「サンプルの境目で同期し、次の境目までの間に 1 命令 = CPU の半サイクルで走る」と見なす:
    // 境目でまとめて走らせ、更新を食べ終えた命令の番号から、割り込み線が変わる時刻(その境目からのサイクル数)を出して CPU に渡す
    function run(n) {
      const always = !!opt.dspAlways;
      for (let i = 0; i < n; i++) {
        const base = samples * CYCLES_PER_SAMPLE;
        if (always || !dsp.empty) {
          dsp.sample(0, 0, 0, 0); dspRuns++;
          if (dsp.empty) { cpu.run(base + (dsp.emptyAt >> 1)); syncEmpty(); }
        }
        samples++;
        cpu.run(samples * CYCLES_PER_SAMPLE);
      }
    }
    // メイン CPU の代わり: 共有 RAM の次の枠に 4 バイトを書いて割り込みを入れる。
    // 枠は 0x80 から 4 バイトずつ進む(G-DARIUS の実測。メイン側の番地では 0x100 から 8 ずつ)。0x100 で 0x80 に戻すのは推定
    function command(b0, b1, b2, b3) {
      shared[cmdSlot] = b0; shared[cmdSlot + 1] = b1; shared[cmdSlot + 2] = b2; shared[cmdSlot + 3] = b3;
      cmdSlot += 4; if (cmdSlot >= 0x100) cmdSlot = 0x80;
      cpu.setInput(0, 1); cpu.setInput(0, 0);
    }
    // サンプルの途中の時刻(通しのサイクル数)まで CPU だけ進める。指令を入れる時刻を MAME のログに合わせて照合する時に使う
    function runToCycle(c) { const n = Math.floor(c / CYCLES_PER_SAMPLE) - samples; if (n > 0) run(n); cpu.run(c); }
    function takeEvents() { const e = events; events = []; return e; }
    return { run, runToCycle, command, takeEvents, cpu, dsp, ram, shared, stats,
      get time() { return samples * CYCLES_PER_SAMPLE / CPU_HZ; }, get samples() { return samples; }, get dspRuns() { return dspRuns; } };
  };
  Emu.ZOOM_BOARD = { CPU_HZ, CYCLES_PER_SAMPLE, REG_DSP_DATA, REG_DSP_CTRL };
})(typeof globalThis !== 'undefined' ? globalThis : this);
