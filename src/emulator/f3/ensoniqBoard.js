/*
 * MML.Emu.createEnsoniqBoard({ program, wave, … })
 *
 * タイトーの Ensoniq 音源基板(F3 システム、Super Chase、JC システムほか): 68000+ES5505+ES5510+MC68681+共有 RAM。
 * サウンド CPU にサウンドプログラムを走らせ、音源への書き込みを作る。配置は MAME の src/mame/taito/taito_en.cpp
 * (Bryan McPhail / Aaron Giles / R. Belmont / Philip Bennett、BSD-3-Clause)のとおり:
 *   0x000000-0x00FFFF RAM(0xFF0000 にも見える)/ 0x140000 共有 RAM(偶数番地の上位バイト、0x800 バイト)/ 0x200000 ES5505 /
 *   0x260000 ES5510(奇数番地)/ 0x280000 MC68681(奇数番地)/ 0x300000 波形のバンク(声ごと)/ 0x340000 音量 IC / 0xC00000 プログラム ROM
 *   割り込みは MC68681 だけ(レベル 6、ベクタは IVR)。起動時に ROM の先頭 8 バイトを RAM の 0 番地へ写す(スタックと開始番地)
 *
 * 時間: CPU と ES5505 は同じ 15.238090MHz。ES5505 は 32 声で 512 クロックに 1 サンプル。MC68681 は 4MHz(タイマは X1/CLK)。
 *
 * MC68681 は MAME の src/devices/machine/mc68681.cpp の要る所だけ: カウンタ/タイマ、割り込み、出力ポート、シリアルは「送信にかかる時間」だけ。
 *   ドライバは B チャンネルへ 1 バイト送るたびに送信完了を待つ(31250bps = MIDI の速さ)。待ちの長さは MAME の実測に合わせた:
 *   書いてから 64 µs で TxRDY、352 µs で TxEMT
 * ES5510 は、ここではホスト側の窓口(レジスタとプログラムの読み書き)だけ。音の処理は別(es5510.js)。
 *
 * opt: { program(サウンド CPU のプログラム。0xC00000 から見える並び = 16bit ビッグエンディアン), wave(Int16Array、語の番地), onWrite(kind, a, b) }
 *   onWrite の kind: 'E' ES5505(レジスタ, 値, マスク)/ 'B' バンク(声, 値)/ 'D' ES5510(レジスタ, 値)/ 'V' 音量(番地, 値)/ 'O' ESPHALT(0/1)
 */
(function (root) {
  'use strict';
  const MML = root.MML = root.MML || {}, Emu = MML.Emu = MML.Emu || {};
  const CPU_HZ = 30476180 / 2, CYCLES_PER_SAMPLE = 512, DUART_HZ = 4000000;
  const TX_RDY = Math.round(64.2e-6 * CPU_HZ), TX_EMT = Math.round(352.6e-6 * CPU_HZ);
  const NEVER = Infinity;

  Emu.createEnsoniqBoard = function (opt) {
    const program = opt.program, onWrite = opt.onWrite || null;
    const ram = new Uint8Array(0x10000), dpram = new Uint8Array(0x800);
    const chip = opt.chip || new Emu.Es5505Audio(CPU_HZ, opt.wave);
    const bankMask = Math.max(0, Math.floor(opt.wave.length * 2 / 0x200000) - 1);
    const stats = { unmappedR: 0, unmappedW: 0 };
    let events = [], order = 0, samples = 0, cpu = null;
    const push = (kind, a, b, c) => { if (onWrite) onWrite(kind, a, b, c); else events.push({ t: cpu.cycles / CPU_HZ, o: order++, kind, a, b, c }); };

    // ── MC68681 ──
    const du = { acr: 0, imr: 0, isr: 0, ivr: 0x0f, ctr: 0, opr: 0, opcr: 0, half: 0, timerAt: NEVER, irqLine: 0,
      ch: [{ txEn: false, rxEn: false, rdyAt: 0, emtAt: 0, mr: [0, 0], mrPtr: 0, csr: 0 }, { txEn: false, rxEn: false, rdyAt: 0, emtAt: 0, mr: [0, 0], mrPtr: 0, csr: 0 }] };
    // opt.counterReadyAtBoot: 起動した時点で「カウンタ満了」の印が立っている事にする(MAME のログとの照合用)。
    //   このドライバは起動直後に 10 ミリ秒のカウンタを回して割り込みを待つが、MAME の F3 では待たずに抜ける(MC68681 はサウンド CPU のリセットでは
    //   初期化されず、印が残っているためと見られる。推定)。既定は電源投入と同じ = 印なしで、10 ミリ秒待つ
    if (opt.counterReadyAtBoot) du.isr |= 0x08;
    const ctRate = () => (((du.acr >> 4) & 3) === 3 ? DUART_HZ / 16 : DUART_HZ);
    const startCt = (count, now) => { du.timerAt = now + count * CPU_HZ / ctRate(); };
    const chanSr = (c, now) => (c.txEn ? (now >= c.rdyAt ? 4 : 0) | (now >= c.emtAt ? 8 : 0) : 0);
    function duIsr(now) {
      let v = du.isr & 0x08;
      if (chanSr(du.ch[0], now) & 4) v |= 0x01;
      if (chanSr(du.ch[1], now) & 4) v |= 0x10;
      return v;
    }
    function duIrq(now) { const on = (duIsr(now) & du.imr) ? 1 : 0; if (on !== du.irqLine) { du.irqLine = on; cpu.setIrq(on ? 6 : 0); } }
    function duNextEvent(now) {
      let t = du.timerAt;
      for (const c of du.ch) if (c.txEn && c.rdyAt > now && c.rdyAt < t) t = c.rdyAt;
      return t;
    }
    function duTimer() {
      const at = du.timerAt;
      if (du.acr & 0x40) {   // タイマ: 半周期ごとに反転、1 周で割り込みの印
        du.half ^= 1;
        if (!du.half) du.isr |= 0x08;
        startCt(Math.max(du.ctr, 1), at);
      } else { du.isr |= 0x08; startCt(0xffff, at); }
    }
    function duRead(reg, now) { const r = duRead1(reg, now); if (opt.traceDuart) push('u', reg, r); return r; }
    function duRead1(reg, now) {
      switch (reg) {
        case 0x00: case 0x08: { const c = du.ch[reg >> 3], r = c.mr[c.mrPtr]; c.mrPtr = 1; return r; }
        case 0x01: case 0x09: return chanSr(du.ch[reg >> 3], now);
        case 0x03: case 0x0b: return 0;
        case 0x04: return 0;                                   // IPCR
        case 0x05: return duIsr(now);
        case 0x06: case 0x07: { const left = du.timerAt === NEVER ? 0 : Math.max(0, Math.floor((du.timerAt - now) * ctRate() / CPU_HZ)) & 0xffff; return reg === 6 ? left >> 8 : left & 0xff; }
        case 0x0a: return 0x61;
        case 0x0d: return 0x80 | 0x03;                         // 入力ポート: IP0・IP1 は 5V(Gun Buster の回路図)。IP2〜5 はクロック
        case 0x0e: if (du.acr & 0x40) du.half = 0; startCt(Math.max(du.ctr, 1), now); return 0xff;   // カウンタ開始
        case 0x0f: if (!(du.acr & 0x40)) du.timerAt = NEVER; du.isr &= ~0x08; duIrq(now); return 0xff;   // カウンタ停止(割り込みの印を消す)
        default: return 0xff;
      }
    }
    function duWrite(reg, v, now) {
      if (opt.traceDuart) push('U', reg, v);
      switch (reg) {
        case 0x00: case 0x08: { const c = du.ch[reg >> 3]; c.mr[c.mrPtr] = v; c.mrPtr = 1; break; }
        case 0x01: case 0x09: du.ch[reg >> 3].csr = v; break;
        case 0x02: case 0x0a: {
          const c = du.ch[reg >> 3];
          switch (v >> 4 & 7) { case 1: c.mrPtr = 0; break; case 2: c.rxEn = false; break; case 3: c.txEn = false; break; default: break; }
          if (v & 1) c.rxEn = true; if (v & 2) c.rxEn = false;
          if (v & 4) { if (!c.txEn) { c.txEn = true; c.rdyAt = now; c.emtAt = now; } }
          if (v & 8) c.txEn = false;
          break;
        }
        case 0x03: case 0x0b: { const c = du.ch[reg >> 3]; if (c.txEn) { c.rdyAt = now + TX_RDY; c.emtAt = now + TX_EMT; } break; }
        case 0x04: {
          const old = du.acr; du.acr = v;
          if ((old ^ v) & 0x40) { if (v & 0x40) { du.half = 0; startCt(Math.max(du.ctr, 1), now); } else du.timerAt = NEVER; }
          break;
        }
        case 0x05: du.imr = v; break;
        case 0x06: du.ctr = (du.ctr & 0x00ff) | (v << 8); break;
        case 0x07: du.ctr = (du.ctr & 0xff00) | v; break;
        case 0x0c: du.ivr = v; break;
        case 0x0d: du.opcr = v; break;
        case 0x0e: du.opr |= v; push('O', (du.opr ^ 0xff) & 0x40 ? 1 : 0); break;      // 出力ポート(端子は反転)。OP6 = ESPHALT
        case 0x0f: du.opr &= ~v; push('O', (du.opr ^ 0xff) & 0x40 ? 1 : 0); break;
        default: break;
      }
      duIrq(now);
    }

    // ── ES5510 のホスト側の窓口 ──
    const esp = { gprLatch: 0, instrHi: 0, instrLo: 0, dil: 0, dol: 0, dadr: 0, ramSel: 0, hostCtl: 0, gpr: new Int32Array(0xc0), instrH: new Uint32Array(0xa0), instrL: new Uint32Array(0xa0), reg: new Int32Array(256) };
    function espReadReg(r) {
      if (r < 0xc0) return esp.gpr[r];
      switch (r) { case 252: return 0xffffff; case 253: return 0x800000; case 254: return 0x7fffff; case 255: return 0; case 250: case 251: return (esp.reg[r] << 16) & 0xffffff; default: return esp.reg[r] & 0xffffff; }
    }
    function espWriteReg(r, v) { v &= 0xffffff; if (r < 0xc0) esp.gpr[r] = v; else if (r === 250 || r === 251) esp.reg[r] = v >> 16; else esp.reg[r] = v; }
    function espRead(off) {
      switch (off) {
        case 0x00: return esp.gprLatch >> 16 & 0xff; case 0x01: return esp.gprLatch >> 8 & 0xff; case 0x02: return esp.gprLatch & 0xff;
        case 0x03: return esp.instrHi >> 8 & 0xff; case 0x04: return esp.instrHi & 0xff;
        case 0x05: return esp.instrLo >>> 24; case 0x06: return esp.instrLo >> 16 & 0xff; case 0x07: return esp.instrLo >> 8 & 0xff; case 0x08: return esp.instrLo & 0xff;
        case 0x09: return esp.dil >> 16 & 0xff; case 0x0a: return esp.dil >> 8 & 0xff; case 0x0b: return 0;
        case 0x0c: return esp.dol >> 16 & 0xff; case 0x0d: return esp.dol >> 8 & 0xff; case 0x0e: return 0xff;
        case 0x0f: return esp.dadr >> 16 & 0xff; case 0x10: return esp.dadr >> 8 & 0xff; case 0x11: return esp.dadr & 0xff;
        case 0x16: return 0x27;
        default: return 0;
      }
    }
    function espWrite(off, d) {
      switch (off) {
        case 0x00: esp.gprLatch = (esp.gprLatch & 0x00ffff) | d << 16; break;
        case 0x01: esp.gprLatch = (esp.gprLatch & 0xff00ff) | d << 8; break;
        case 0x02: esp.gprLatch = (esp.gprLatch & 0xffff00) | d; break;
        case 0x03: esp.instrHi = (esp.instrHi & 0x00ff) | d << 8; break;
        case 0x04: esp.instrHi = (esp.instrHi & 0xff00) | d; break;
        case 0x05: esp.instrLo = ((esp.instrLo & 0x00ffffff) | d << 24) >>> 0; break;
        case 0x06: esp.instrLo = ((esp.instrLo & 0xff00ffff) | d << 16) >>> 0; break;
        case 0x07: esp.instrLo = ((esp.instrLo & 0xffff00ff) | d << 8) >>> 0; break;
        case 0x08: esp.instrLo = ((esp.instrLo & 0xffffff00) | d) >>> 0; break;
        case 0x0c: esp.dol = (esp.dol & 0x00ffff) | d << 16; break;
        case 0x0d: esp.dol = (esp.dol & 0xff00ff) | d << 8; break;
        case 0x0e: esp.dol = (esp.dol & 0xffff00) | d; break;
        case 0x0f: esp.dadr = (esp.dadr & 0x00ffff) | d << 16; if (esp.ramSel) esp.dil = 0; break;   // 遅延メモリの読み出しは音の処理側(ここでは 0)
        case 0x10: esp.dadr = (esp.dadr & 0xff00ff) | d << 8; break;
        case 0x11: esp.dadr = (esp.dadr & 0xffff00) | d; break;
        case 0x12: esp.hostCtl = (esp.hostCtl & 4) | (d & 1); break;
        case 0x14: esp.ramSel = d & 0x80; break;
        case 0x80: if (d < 0xa0) { esp.instrHi = esp.instrH[d]; esp.instrLo = esp.instrL[d]; } if (d < 0xc0) esp.gprLatch = esp.gpr[d] & 0xffffff; else if (d >= 0xea) esp.gprLatch = espReadReg(d); break;
        case 0xa0: espWriteReg(d, esp.gprLatch); break;
        case 0xc0: if (d < 0xa0) { esp.instrH[d] = esp.instrHi; esp.instrL[d] = esp.instrLo; } break;
        case 0xe0: if (d < 0xa0) { esp.instrH[d] = esp.instrHi; esp.instrL[d] = esp.instrLo; } espWriteReg(d, esp.gprLatch); break;
        default: break;
      }
      push('D', off, d);
    }

    const bus = {
      read8(a) {
        if (a < 0x40000) return ram[a & 0xffff];
        if (a >= 0xc00000 && a < 0xc80000) return program[a - 0xc00000];
        if (a >= 0xff0000) return ram[a & 0xffff];
        if (a >= 0x140000 && a < 0x141000) return (a & 1) ? 0xff : dpram[(a - 0x140000) >> 1];
        if (a >= 0x280000 && a < 0x280020) return (a & 1) ? duRead((a - 0x280000) >> 1 & 15, cpu.cycles) : 0xff;
        if (a >= 0x260000 && a < 0x260200) return (a & 1) ? espRead((a - 0x260000) >> 1) : 0xff;
        if (a >= 0x200000 && a < 0x200020) { const v = chip.read((a - 0x200000) >> 1); return (a & 1) ? v & 0xff : v >> 8; }
        stats.unmappedR++; return 0xff;
      },
      read16(a) {
        if (a < 0x40000) { const i = a & 0xffff; return ram[i] << 8 | ram[i + 1]; }
        if (a >= 0xc00000 && a < 0xc80000) { const i = a - 0xc00000; return program[i] << 8 | program[i + 1]; }
        if (a >= 0xff0000) { const i = a & 0xffff; return ram[i] << 8 | ram[i + 1]; }
        if (a >= 0x200000 && a < 0x200020) return chip.read((a - 0x200000) >> 1);
        if (a >= 0x140000 && a < 0x141000) return dpram[(a - 0x140000) >> 1] << 8 | 0xff;
        if (a >= 0x280000 && a < 0x280020) return 0xff00 | duRead((a - 0x280000) >> 1 & 15, cpu.cycles);
        if (a >= 0x260000 && a < 0x260200) return 0xff00 | espRead((a - 0x260000) >> 1);
        stats.unmappedR++; return 0xffff;
      },
      write8(a, v) {
        if (a < 0x40000) { ram[a & 0xffff] = v; return; }
        if (a >= 0xff0000) { ram[a & 0xffff] = v; return; }
        if (a >= 0x140000 && a < 0x141000) { if (!(a & 1)) dpram[(a - 0x140000) >> 1] = v; return; }
        if (a >= 0x280000 && a < 0x280020) { if (a & 1) duWrite((a - 0x280000) >> 1 & 15, v, cpu.cycles); return; }
        if (a >= 0x260000 && a < 0x260200) { if (a & 1) espWrite((a - 0x260000) >> 1, v); return; }
        if (a >= 0x200000 && a < 0x200020) { const reg = (a - 0x200000) >> 1, m = (a & 1) ? 0x00ff : 0xff00, d = (a & 1) ? v : v << 8; chip.write(reg, d, m); push('E', reg, d, m); return; }
        if (a >= 0x340000 && a < 0x340004) { if (!(a & 1)) push('V', (a - 0x340000) >> 1, v); return; }
        if (a >= 0x300000 && a < 0x300040) { bus.write16(a & ~1, v << 8 | v); return; }   // バイトで書くと両方のバイトに同じ値が乗る(MAME の 68000 と同じ。使うのは下位の数ビット)
        stats.unmappedW++;
      },
      write16(a, v) {
        if (a < 0x40000) { const i = a & 0xffff; ram[i] = v >> 8; ram[i + 1] = v & 0xff; return; }
        if (a >= 0xff0000) { const i = a & 0xffff; ram[i] = v >> 8; ram[i + 1] = v & 0xff; return; }
        if (a >= 0x200000 && a < 0x200020) { const reg = (a - 0x200000) >> 1; chip.write(reg, v, 0xffff); push('E', reg, v, 0xffff); return; }
        if (a >= 0x300000 && a < 0x300040) { const voice = (a - 0x300000) >> 1; chip.setBank(voice, (v & bankMask) * 0x100000); push('B', voice, v); return; }
        if (a >= 0x140000 && a < 0x141000) { dpram[(a - 0x140000) >> 1] = v >> 8; return; }
        if (a >= 0x280000 && a < 0x280020) { duWrite((a - 0x280000) >> 1 & 15, v & 0xff, cpu.cycles); return; }
        if (a >= 0x260000 && a < 0x260200) { espWrite((a - 0x260000) >> 1, v & 0xff); return; }
        if (a >= 0x340000 && a < 0x340004) { push('V', (a - 0x340000) >> 1, v >> 8); return; }
        stats.unmappedW++;
      },
      irqAck() { return du.ivr; }
    };
    cpu = Emu.createM68000(bus);
    ram.set(program.subarray(0, 8), 0);          // スタックと開始番地
    cpu.reset();
    cpu.cycles = 0;

    // CPU を通しのクロック数 until まで進める。途中のタイマと送信完了の時刻で区切る
    function runTo(until) {
      for (;;) {
        const now = cpu.cycles, ev = duNextEvent(now);
        if (ev > until) { cpu.run(until); break; }
        if (ev > now) cpu.run(ev);
        const t = cpu.cycles;
        if (du.timerAt <= t) duTimer();
        duIrq(t);
      }
      duIrq(cpu.cycles);
    }
    /** n サンプルぶん進める(CPU を 512 クロック、音源を 1 サンプル)。onSample があれば音源の 1 サンプルごとに呼ぶ */
    function run(n, onSample) {
      for (let i = 0; i < n; i++) {
        samples++;
        runTo(samples * CYCLES_PER_SAMPLE);
        chip.clock();
        if (onSample) onSample();
      }
    }
    function takeEvents() { const e = events; events = []; return e; }
    return { run, runTo, takeEvents, cpu, chip, ram, dpram, du, esp, stats,
      get time() { return samples * CYCLES_PER_SAMPLE / CPU_HZ; }, get samples() { return samples; } };
  };
  Emu.ENSONIQ_BOARD = { CPU_HZ, CYCLES_PER_SAMPLE };
})(typeof globalThis !== 'undefined' ? globalThis : this);
