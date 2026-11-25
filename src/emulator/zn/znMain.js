/*
 * MML.Emu.createZnMain({ bios, rom, cat1, cat2, sound, dsw, onSound })
 *
 * ソニー ZN-1(PlayStation 相当の業務用基板)+タイトー FX-1B のメイン側。本物の BIOS とゲームの ROM をそのまま走らせる。
 * 目的はテストモードの画面を出して、ゲーム本体が音源基板(ZOOM、zsg2/zoomBoard.js)へ送る指令をそのまま使うこと。
 * 配置と周辺の動きは MAME の写し(BSD-3-Clause):
 *   src/mame/sony/zn.cpp(smf、R. Belmont)… 配置、保護チップの選択、入力
 *   src/mame/sony/znmcu.cpp(smf)… DIP スイッチを読む MCU
 *   src/devices/machine/cat702.cpp(smf)… 保護チップ CAT702
 *   src/devices/cpu/psx/sio.cpp(smf)… シリアル
 *   src/devices/machine/at28c16.cpp、mb3773.cpp(smf)… EEPROM、ウォッチドッグ
 *
 * 配置(物理番地):
 *   0x00000000 RAM 4MB / 0x1F000000-0x1F7FFFFF ゲームの ROM(8MB ずつのバンク)/ 0x1F800000 スクラッチパッド
 *   0x1F801000 PlayStation の入出力(割り込み、DMA、タイマ、SIO、GPU、SPU)/ 0x1FC00000 BIOS 512KB
 *   0x1FA00000 P1 / 0x1FA00100 P2 / 0x1FA00200 サービス / 0x1FA00300 システム / 0x1FA10200 基板の構成
 *   0x1FA10300 保護チップの選択 / 0x1FA20000 コイン / 0x1FAF0000 AT28C16 / 0x1FB00000 FRAM(偶数バイト)
 *   0x1FB40000 バンクとウォッチドッグ / 0x1FB80000 音源基板のレジスタ(値、番号)/ 0x1FBA0000 音源基板への割り込み
 *   0x1FBC0000 その読み出し / 0x1FBE0000 音源基板との共有 RAM(偶数バイト)
 *
 * 時間: CPU のサイクル = 33.8688MHz。1 命令のサイクル数は cpuR3000.js の固定値(MAME と起動の時間が合う値を znCpi で渡す)。
 * 周辺(タイマ、VBlank、SPU、SIO、音源基板)は、CPU を短い区切りで走らせるたびに追いつかせる。
 * GPU は差し替え式(opt.gpu)。渡さなければ「いつでも受け取れる」とだけ答える空の物を使う(画面は出ない)。
 */
(function (root) {
  'use strict';
  const MML = root.MML = root.MML || {}, Emu = MML.Emu = MML.Emu || {};
  const CPU_HZ = 33868800, GPU_HZ = 53693175, RAM_SIZE = 0x400000, RAM_MASK = RAM_SIZE - 1;
  const IRQ_VBLANK = 1, IRQ_DMA = 8, IRQ_SIO0 = 128, IRQ_SPU = 512;
  const SIO_TX_RDY = 1, SIO_RX_RDY = 2, SIO_TX_EMPTY = 4, SIO_OVERRUN = 0x10, SIO_DSR = 0x80, SIO_IRQ = 0x200;
  const SIOC_TX_ENA = 1, SIOC_DTR = 2, SIOC_IACK = 0x10, SIOC_RESET = 0x40, SIOC_TX_IENA = 0x400, SIOC_RX_IENA = 0x800, SIOC_DSR_IENA = 0x1000;
  const CAT_INIT = [0xff, 0xfe, 0xfc, 0xf8, 0xf0, 0xe0, 0xc0, 0x7f];

  /** 保護チップ CAT702。8 バイトの表で中身が決まる。out(bit) = データ出力の線 */
  function createCat702(table, out) {
    let select = 1, clock = 1, datain = 1, state = 0, bit = 0;
    const coef = (sel, b) => {
      if (!sel) return table[b];
      let r = coef((sel - 1) & 7, (b - 1) & 7);
      r = ((r << 1) | (((r >> 7) ^ (r >> 6)) & 1)) & 0xff;
      return b !== 7 ? r : r ^ coef(sel, 0);
    };
    // 係数は 8×8 通りしか無いので前もって表にする
    const C = []; for (let s = 0; s < 8; s++) { C.push([]); for (let b = 0; b < 8; b++) C[s].push(coef(s, b)); }
    const apply = (box) => { let r = 0; for (let i = 0; i < 8; i++) if (state >> i & 1) r ^= box[i]; state = r; };
    return {
      select(s) { if (select !== s) { if (!s) { state = 0xfc; bit = 0; } else out(1); select = s; } },
      datain(s) { datain = s; },
      clock(s) {
        if (!s && clock && !select) { if (bit === 0) apply(CAT_INIT); out(state >> bit & 1); }
        if (s && !clock && !select) { if (!datain) apply(C[bit]); bit = (bit + 1) & 7; }
        clock = s;
      }
    };
  }

  /** 何も描かない GPU。命令は捨て、状態は「いつでも受け取れる」と答える */
  function createNullGpu() {
    let mode = 0, dmaDir = 0, info = 0;
    return {
      gp0() {}, read() { return info; },
      gp1(v) {
        const c = v >>> 24;
        if (c === 0) { mode = 0; dmaDir = 0; }
        else if (c === 4) dmaDir = v & 3;
        else if (c === 8) mode = v & 0xff;
        else if (c === 0x10) info = (v & 7) === 7 ? 2 : 0;
      },
      // bit26 命令を受け取れる、bit27 読み出せる、bit28 DMA を受け取れる。bit31(奇偶)は基板側で足す
      stat() { return 0x1C000000 | dmaDir << 29 | (dmaDir ? 1 << 25 : 0) | (mode & 0x3f) << 17 | (mode & 0x40) << 10; },
      get interlace() { return !!(mode & 0x20); }, vblank() {}
    };
  }

  Emu.createZnMain = function (opt) {
    const bios = opt.bios, rom = opt.rom, sound = opt.sound || null, onSound = opt.onSound || null;
    const ramBuf = new ArrayBuffer(RAM_SIZE), ram = new Uint8Array(ramBuf), ram16 = new Uint16Array(ramBuf), ram32 = new Int32Array(ramBuf);
    const scrBuf = new ArrayBuffer(0x400), scr = new Uint8Array(scrBuf), scr16 = new Uint16Array(scrBuf), scr32 = new Int32Array(scrBuf);
    const al = (u8) => { const b = new Uint8Array((u8.length + 3) & ~3); b.set(u8); return b; };
    const biosB = al(bios), bios16 = new Uint16Array(biosB.buffer), bios32 = new Int32Array(biosB.buffer), BIOS_MASK = 0x7ffff;
    const romB = al(rom), rom16 = new Uint16Array(romB.buffer), rom32 = new Int32Array(romB.buffer), ROM_LEN = romB.length;
    const at28 = new Uint8Array(0x800).fill(0xff), fram = new Uint8Array(0x200).fill(0xff);
    if (opt.at28) at28.set(opt.at28.subarray(0, 0x800)); if (opt.fram) fram.set(opt.fram.subarray(0, 0x200));
    const spu = opt.spu || new Emu.SpuPsx(), gpu = opt.gpu || createNullGpu();
    const inp = { p1: 0xff, p2: 0xff, service: 0xff, system: 0xff, p3: 0xff, p4: 0xff, dsw: opt.dsw === undefined ? 0xf : opt.dsw & 0xf };
    const stats = { unmappedR: 0, unmappedW: 0, where: new Map(), sioBytes: 0, dma: [0, 0, 0, 0, 0, 0, 0] };
    const miss = (k, p) => { if (stats.where.size < 64) { const key = k + p.toString(16); stats.where.set(key, (stats.where.get(key) || 0) + 1); } };

    let iStat = 0, iMask = 0, dpcr = 0x07654321, dicr = 0, ramSizeReg = 0xB88, cacheCtrl = 0;
    const memCtrl = new Int32Array(9), dmaMadr = new Int32Array(7), dmaBcr = new Int32Array(7), dmaChcr = new Int32Array(7);
    let bank = 0, coin = 0, secsel = 0, regAddr = 0, wdCk = 0, wdAt = 0, resets = 0;
    let frame = 0, frameAt = 0, synced = 0, spuAcc = 0, at28Last = -1;
    let memSeq = 0, ioSeq = 0, idleCycles = 0;
    const idleSkip = opt.idleSkip !== false, snap = new Int32Array(38);
    const cyclesPerFrame = 3413 * 263 * CPU_HZ / GPU_HZ, cyclesPerLine = cyclesPerFrame / 263;

    // ── 時刻で起きる物(SIO の 1 ビット、MCU の応答、EEPROM の書き込み待ち)──
    const T_SIO = 0, T_MCU = 1, T_AT28 = 2, timers = [Infinity, Infinity, Infinity], timerArg = [0, 0, 0];
    let nextTimer = Infinity;
    let sliceLim = 0;
    const setTimer = (i, at, arg) => { timers[i] = at; timerArg[i] = arg | 0; nextTimer = Math.min(timers[0], timers[1], timers[2]); if (nextTimer < sliceLim) sliceLim = nextTimer; };

    const bus = {
      irqLine: false, cyclesPerDot: CPU_HZ / GPU_HZ * 8, cyclesPerHblank: cyclesPerLine,
      raiseIrq(bit) { iStat |= bit; bus.irqLine = (iStat & iMask) !== 0; },
      read8, read16, read32, write8, write16, write32
    };
    const irqUpdate = () => { bus.irqLine = (iStat & iMask) !== 0; };
    const counters = [new Emu.PsxRootCounter(0, bus), new Emu.PsxRootCounter(1, bus), new Emu.PsxRootCounter(2, bus)];
    const cpu = new Emu.CPUR3000(bus);
    if (opt.cpi) cpu.cpi = opt.cpi;
    // 1 命令 = 2 サイクルの固定(MAME の PlayStation の CPU と同じ数え方。起動の時間を MAME と比べるため)。opt.memCyc で読み書きの上乗せを戻せる
    cpu.memCyc = opt.memCyc | 0; cpu.mulCyc = 0; cpu.divCyc = 0;
    spu.onIrq = () => bus.raiseIrq(IRQ_SPU);

    // ── 保護チップと MCU(SIO0 の先)──
    const catOut = [1, 1]; let mcuOut = 1, sioRxd = 1;
    const rxdUpdate = () => { sioRxd = catOut[0] && catOut[1] && mcuOut ? 1 : 0; };
    const cat = [createCat702(opt.cat1, (b) => { catOut[0] = b; rxdUpdate(); }), createCat702(opt.cat2, (b) => { catOut[1] = b; rxdUpdate(); })];
    const mcu = { sck: 1, select: 1, bit: 0, byte: 0, databytes: 0, send: new Uint8Array(9), analogRead: 0, trackRead: 0 };
    const US = CPU_HZ / 1e6;
    function mcuSelect(s) {
      if (mcu.select === s) return;
      if (!s) { mcu.bit = 0; mcu.byte = 0; setTimer(T_MCU, cpu.cycles + 50 * US, 0); }
      else { mcuOut = 1; rxdUpdate(); sioDsr(1); setTimer(T_MCU, Infinity, 0); }
      mcu.select = s;
    }
    function mcuSck(s) {
      if (mcu.sck === s) return;
      if (!s && !mcu.select) {
        const data = mcu.byte <= mcu.databytes && mcu.byte < mcu.send.length ? mcu.send[mcu.byte] : 0;
        mcuOut = data >> mcu.bit & 1; rxdUpdate();
        if (++mcu.bit === 8) { if (mcu.byte < mcu.databytes) setTimer(T_MCU, cpu.cycles + 50 * US, 0); mcu.bit = 0; mcu.byte++; }
      }
      mcu.sck = s;
    }
    function mcuTick(param) {
      sioDsr(param);
      if (!param) {
        if (mcu.byte === 0) {
          mcu.databytes = mcu.analogRead ? 8 : mcu.trackRead ? 6 : 1;
          mcu.send.fill(0); mcu.send[0] = mcu.databytes << 4 | (inp.dsw & 0xf);
          if (mcu.analogRead) for (let i = 0; i < 8; i++) mcu.send[1 + i] = 0xff;
        }
        setTimer(T_MCU, cpu.cycles + 5 * US, 1);
      } else setTimer(T_MCU, Infinity, 0);
    }

    // ── SIO0 ──
    const sio = { status: SIO_TX_EMPTY | SIO_TX_RDY, mode: 0, control: 0, baud: 0, txData: 0, rxData: 0, txShift: 0, rxShift: 0, txBits: 0, rxBits: 0 };
    const sioIrq = () => { sio.status |= SIO_IRQ; bus.raiseIrq(IRQ_SIO0); };
    function sioDsr(state) {
      if (state) sio.status &= ~SIO_DSR;
      else if (!(sio.status & SIO_DSR)) { sio.status |= SIO_DSR; if (sio.control & SIOC_DSR_IENA) sioIrq(); }
    }
    function sioTimer() {
      if (!(sio.status & SIO_TX_EMPTY) || sio.txBits !== 0) {
        const pre = [0, 1, 16, 64][sio.mode & 3];
        setTimer(T_SIO, sio.baud && pre ? cpu.cycles + pre * sio.baud : Infinity, 0);
      } else setTimer(T_SIO, Infinity, 0);
    }
    const sioSck = (s) => { cat[0].clock(s); cat[1].clock(s); mcuSck(s); };
    const sioTxd = (s) => { cat[0].datain(s); cat[1].datain(s); };
    function sioTick() {
      if (sio.txBits === 0 && (sio.control & SIOC_TX_ENA) && !(sio.status & SIO_TX_EMPTY)) {
        sio.txBits = 8; sio.txShift = sio.txData; sio.rxBits = 8; sio.rxShift = 0;
        sio.status |= SIO_TX_EMPTY | SIO_TX_RDY;
      }
      if (sio.txBits !== 0) {
        sioSck(0); sioTxd(sio.txShift & 1); sio.txShift >>= 1; sio.txBits--; sioSck(1);
        if (sio.txBits === 0 && (sio.control & SIOC_TX_IENA)) sioIrq();
      }
      if (sio.rxBits !== 0) {
        sio.rxShift = (sio.rxShift >> 1) | (sioRxd << 7);
        if (--sio.rxBits === 0) {
          if (sio.status & SIO_RX_RDY) sio.status |= SIO_OVERRUN; else { sio.rxData = sio.rxShift; sio.status |= SIO_RX_RDY; }
          stats.sioBytes++;
          if (sio.control & SIOC_RX_IENA) sioIrq();
        }
      }
      sioTimer();
    }
    function sioWrite16(off, v) {
      switch (off) {
        case 0x0: sio.txData = v & 0xff; sio.status &= ~(SIO_TX_RDY | SIO_TX_EMPTY); sioTimer(); break;
        case 0x8: sio.mode = v; break;
        case 0xa:
          sio.control = v;
          if (v & SIOC_RESET) { sio.status |= SIO_TX_EMPTY | SIO_TX_RDY; sio.status &= ~(SIO_RX_RDY | SIO_OVERRUN | SIO_IRQ); sio.txBits = 0; sio.rxBits = 0; sioTxd(1); }
          if (v & SIOC_IACK) { sio.status &= ~SIO_IRQ; sio.control &= ~SIOC_IACK; }
          break;
        case 0xe: sio.baud = v; break;
        default: break;
      }
    }
    function sioRead16(off) {
      switch (off) {
        case 0x0: { const d = sio.rxData; sio.status &= ~SIO_RX_RDY; sio.rxData = 0xff; return d; }
        case 0x4: return sio.status;
        case 0x8: return sio.mode;
        case 0xa: return sio.control;
        case 0xe: return sio.baud;
        default: return 0;
      }
    }

    // ── 音源基板 ──
    const soundSync = () => { if (sound) sound.runToCycle(Math.floor(cpu.cycles * (6250000 / CPU_HZ))); };
    function soundReg16(a, v) {          // 0x1FB80000 = 値、0x1FB80002 = 番号
      if (a & 2) { regAddr = v & 0xff; return; }
      if (onSound) onSound('G', regAddr, v);
    }
    function soundIrq() {
      if (sound) { soundSync(); sound.cpu.setInput(0, 1); sound.cpu.setInput(0, 0); }
      if (onSound) onSound('I', 0, 0);
    }

    // ── ZN と FX-1B の入出力(バイト単位)──
    function znRead8(p) {
      if (p >= 0x1FBE0000 && p < 0x1FBE0200) { if (p & 1) return 0; soundSync(); return sound ? sound.shared[(p - 0x1FBE0000) >> 1] : 0; }
      if (p >= 0x1FAF0000 && p < 0x1FAF0800) return at28Last >= 0 ? at28Last ^ 0x80 : at28[p - 0x1FAF0000];
      if (p >= 0x1FB00000 && p < 0x1FB00400) return p & 1 ? 0 : fram[(p - 0x1FB00000) >> 1];
      switch (p) {
        case 0x1FA00000: return inp.p1;
        case 0x1FA00100: return inp.p2;
        case 0x1FA00200: return inp.service;
        case 0x1FA00300: return inp.system;
        case 0x1FA10000: return inp.p3;
        case 0x1FA10100: return inp.p4;
        case 0x1FA10200: return 64 | 32 | 8 | 1;      // 基板の構成: VRAM 2MB、RAM 4MB
        case 0x1FA10300: return secsel;
        case 0x1FA20000: return coin;
        default: break;
      }
      if (p >= 0x1FA00000 && p < 0x1FA00400 || p >= 0x1FA10000 && p < 0x1FA10400) return 0xff;   // 入力ポートの上位バイト
      if (p >= 0x1FB20000 && p < 0x1FB20008) return 0xff;
      if (p >= 0x1FBC0000 && p < 0x1FBC0002) return 0;                                           // 音源基板への割り込みの読み出し(使用中の印か)
      if (p >= 0x1FA30000 && p < 0x1FA30004 || p >= 0x1FA40000 && p < 0x1FA40004) return 0;
      stats.unmappedR++; miss('r', p); return 0xff;
    }
    function znWrite8(p, v) {
      if (p >= 0x1FBE0000 && p < 0x1FBE0200) {
        if (p & 1) return;
        const o = (p - 0x1FBE0000) >> 1;
        if (sound) { soundSync(); sound.shared[o] = v; }
        if (onSound) onSound('M', o, v);
        return;
      }
      if (p >= 0x1FAF0000 && p < 0x1FAF0800) {
        const o = p - 0x1FAF0000;
        if (at28Last < 0 && at28[o] !== v) { at28[o] = v; at28Last = v; setTimer(T_AT28, cpu.cycles + 200 * US, 0); }
        return;
      }
      if (p >= 0x1FB00000 && p < 0x1FB00400) { if (!(p & 1)) fram[(p - 0x1FB00000) >> 1] = v; return; }
      switch (p) {
        case 0x1FA10300:
          cat[0].select(v >> 2 & 1); cat[1].select(v >> 3 & 1);
          mcu.analogRead = v >> 4 & 1; mcu.trackRead = v >> 5 & 1;
          mcuSelect((v & 0x8c) !== 0x8c ? 1 : 0);
          secsel = v; return;
        case 0x1FA20000: coin = v; return;
        case 0x1FB40000: {
          const ck = v >> 5 & 1;
          if (!ck && wdCk) wdAt = cpu.cycles;
          wdCk = ck; bank = v & 3; return;
        }
        default: break;
      }
      if (p >= 0x1FA30000 && p < 0x1FA30004) return;
      if (p >= 0x1FA00000 && p < 0x1FC00000 && (p & 3)) return;    // 8bit の口への 16/32bit 書き込みの残りのバイト
      stats.unmappedW++; miss('w', p);
    }
    const isZn = (p) => p >= 0x1FA00000 && p < 0x1FC00000;

    // ── 時間 ──
    function sync() {
      const now = cpu.cycles, el = now - synced;
      if (el > 0) {
        synced = now;
        counters[0].advance(el); counters[1].advance(el); counters[2].advance(el);
        while (now - frameAt >= cyclesPerFrame) { frameAt += cyclesPerFrame; frame++; gpu.vblank(frame); bus.raiseIrq(IRQ_VBLANK); }
        spuAcc += el;
        while (spuAcc >= 768) { spuAcc -= 768; spu.clock(); if (opt.onSpuSample) opt.onSpuSample(spu); }
      }
      while (nextTimer <= now) {
        for (let i = 0; i < 3; i++) if (timers[i] <= now) {
          const arg = timerArg[i]; timers[i] = Infinity;
          if (i === T_SIO) sioTick(); else if (i === T_MCU) mcuTick(arg); else at28Last = -1;
        }
        nextTimer = Math.min(timers[0], timers[1], timers[2]);
      }
      if (now - wdAt > 5 * CPU_HZ) reset();
    }
    function gpuStat() {
      // bit31: インターレースなら今のフィールド、そうでなければ表示中の走査線の偶奇(VBlank の間は 0)
      const line = Math.floor((cpu.cycles - frameAt) / cyclesPerLine);
      const odd = line >= 240 ? 0 : gpu.interlace ? frame & 1 : line & 1;
      return (gpu.stat() | (odd ? 0x80000000 : 0)) | 0;
    }

    // ── PlayStation の入出力 ──
    function ioRead32(p) {
      if (p < 0x1F801024) return memCtrl[(p - 0x1F801000) >> 2];
      switch (p) {
        case 0x1F801040: return sioRead16(0);
        case 0x1F801044: return sioRead16(4);
        case 0x1F801048: return sioRead16(8) | sioRead16(0xa) << 16;
        case 0x1F80104C: return sioRead16(0xe) << 16;
        case 0x1F801054: return 5;
        case 0x1F801060: return ramSizeReg;
        case 0x1F801070: return iStat;
        case 0x1F801074: return iMask;
        case 0x1F8010F0: return dpcr;
        case 0x1F8010F4: return dicr;
        case 0x1F801810: return gpu.read() | 0;
        case 0x1F801814: return gpuStat();
        default: break;
      }
      if (p >= 0x1F801080 && p < 0x1F8010F0) {
        const ch = (p - 0x1F801080) >> 4;
        switch (p & 0xC) { case 0: return dmaMadr[ch]; case 4: return dmaBcr[ch]; case 8: return dmaChcr[ch]; default: return 0; }
      }
      if (p >= 0x1F801100 && p < 0x1F801130) {
        sync();
        const c = counters[(p - 0x1F801100) >> 4];
        switch (p & 0xC) { case 0: return c.count & 0xFFFF; case 4: return c.readMode(); case 8: return c.target; default: return 0; }
      }
      return 0;
    }
    function timerWrite(p, v) {
      sync(); sliceLim = 0;
      const c = counters[(p - 0x1F801100) >> 4];
      switch (p & 0xC) { case 0: c.count = v & 0xFFFF; break; case 4: c.writeMode(v); break; case 8: c.target = v & 0xFFFF; break; default: break; }
    }
    function ioWrite32(p, v) {
      if (p < 0x1F801024) { memCtrl[(p - 0x1F801000) >> 2] = v; return; }
      switch (p) {
        case 0x1F801040: sioWrite16(0, v & 0xffff); return;
        case 0x1F801048: sioWrite16(8, v & 0xffff); sioWrite16(0xa, v >>> 16); return;
        case 0x1F80104C: sioWrite16(0xe, v >>> 16); return;
        case 0x1F801060: ramSizeReg = v; return;
        case 0x1F801070: iStat &= v; irqUpdate(); return;
        case 0x1F801074: iMask = v & 0x7FF; irqUpdate(); return;
        case 0x1F8010F0: dpcr = v; return;
        case 0x1F8010F4: dicrWrite(v); return;
        case 0x1F801810: gpu.gp0(v >>> 0); return;
        case 0x1F801814: gpu.gp1(v >>> 0); return;
        default: break;
      }
      if (p >= 0x1F801080 && p < 0x1F8010F0) {
        const ch = (p - 0x1F801080) >> 4;
        switch (p & 0xC) { case 0: dmaMadr[ch] = v & 0x00FFFFFF; return; case 4: dmaBcr[ch] = v; return; case 8: dmaChcrWrite(ch, v); return; default: return; }
      }
      if (p >= 0x1F801100 && p < 0x1F801130) timerWrite(p, v & 0xFFFF);
    }

    // ── DMA(転送はその場で済ませる)──
    function dicrMaster() {
      const flagged = (dicr >>> 24 & 0x7F) & (dicr >>> 16 & 0x7F);
      if ((dicr & 0x8000) || ((dicr & 0x800000) && flagged)) dicr |= 0x80000000; else dicr &= 0x7FFFFFFF;
    }
    function dicrWrite(v) { dicr = (v & 0x00FFFFFF) | (dicr & 0x7F000000 & ~(v & 0x7F000000)); dicrMaster(); }
    function dmaComplete(ch) {
      dmaChcr[ch] &= ~0x11000000;
      if ((dicr & 0x800000) && (dicr & 1 << (16 + ch))) {
        dicr |= 1 << (24 + ch);
        const before = dicr & 0x80000000; dicrMaster();
        if (!before && (dicr & 0x80000000)) bus.raiseIrq(IRQ_DMA);
      }
    }
    function dmaChcrWrite(ch, v) {
      dmaChcr[ch] = v;
      if (!(v & 0x01000000) || !(dpcr & 8 << ch * 4)) return;
      const syncMode = v >> 9 & 3;
      if (syncMode === 0 && !(v & 0x10000000)) return;
      const toDev = !!(v & 1), step = v & 2 ? -4 : 4, M = RAM_MASK & ~3;
      let addr = dmaMadr[ch] & M, words;
      const bcr = dmaBcr[ch];
      if (syncMode === 0) words = (bcr & 0xFFFF) || 0x10000;
      else if (syncMode === 1) words = ((bcr & 0xFFFF) || 0x10000) * ((bcr >>> 16 & 0xFFFF) || 0x10000);
      else words = 0;
      stats.dma[ch]++;
      if (ch === 4) {
        for (let i = 0; i < words; i++) { if (toDev) spu.dmaWrite32(ram32[addr >> 2]); else ram32[addr >> 2] = spu.dmaRead32(); addr = (addr + step) & M; }
      } else if (ch === 6) {
        for (let i = 0; i < words; i++) { ram32[addr >> 2] = i === words - 1 ? 0xFFFFFF : (addr - 4) & M; addr = (addr - 4) & M; }
      } else if (ch === 2) {
        if (syncMode === 2) {
          let node = dmaMadr[ch] & 0xFFFFFF, guard = 0;
          while (guard++ < 0x40000) {
            const hdr = ram32[(node & M) >> 2], n = hdr >>> 24;
            for (let i = 1; i <= n; i++) gpu.gp0(ram32[((node + i * 4) & M) >> 2] >>> 0);
            node = hdr & 0xFFFFFF;
            if (node & 0x800000) break;
          }
          addr = node;
        } else {
          for (let i = 0; i < words; i++) { if (toDev) gpu.gp0(ram32[addr >> 2] >>> 0); else ram32[addr >> 2] = gpu.read() | 0; addr = (addr + step) & M; }
        }
      } else if (!toDev) {
        for (let i = 0; i < words; i++) { ram32[addr >> 2] = 0; addr = (addr + step) & M; }
      }
      dmaMadr[ch] = addr;
      dmaComplete(ch);
    }

    // ── メモリ ──
    const romAt = (p) => bank * 0x800000 + (p - 0x1F000000);
    function read8(addr) {
      const p = addr & 0x1FFFFFFF;
      if (p < 0x800000) return ram[p & RAM_MASK];
      if (p >= 0x1FC00000) return biosB[p & BIOS_MASK];
      if (p < 0x1F800000) { if (p < 0x1F000000) return 0; const a = romAt(p); return a < ROM_LEN ? romB[a] : 0; }
      if (p < 0x1F800400) return scr[p & 0x3FF];
      ioSeq++;
      if (isZn(p)) return znRead8(p);
      if ((p & 0x1FFFF000) === 0x1F801000) {
        if (p >= 0x1F801C00) { const h = spu.readReg((p - 0x1F801C00) >> 1); return p & 1 ? h >> 8 & 0xFF : h & 0xFF; }
        if (p >= 0x1F801040 && p < 0x1F801050) return sioRead16(p & 0xe) >> ((p & 1) * 8) & 0xFF;
        return ioRead32(p & ~3) >>> ((p & 3) * 8) & 0xFF;
      }
      return 0;
    }
    function read16(addr) {
      const p = addr & 0x1FFFFFFF;
      if (p & 1) return read8(addr) | read8(addr + 1) << 8;
      if (p < 0x800000) return ram16[(p & RAM_MASK) >> 1];
      if (p >= 0x1FC00000) return bios16[(p & BIOS_MASK) >> 1];
      if (p < 0x1F800000) { if (p < 0x1F000000) return 0; const a = romAt(p); return a < ROM_LEN ? rom16[a >> 1] : 0; }
      if (p < 0x1F800400) return scr16[(p & 0x3FF) >> 1];
      ioSeq++;
      if (isZn(p)) return znRead8(p) | znRead8(p + 1) << 8;
      if ((p & 0x1FFFF000) === 0x1F801000) {
        if (p >= 0x1F801C00) return spu.readReg((p - 0x1F801C00) >> 1);
        if (p >= 0x1F801040 && p < 0x1F801050) return sioRead16(p & 0xe);
        return ioRead32(p & ~3) >>> ((p & 2) * 8) & 0xFFFF;
      }
      return 0;
    }
    function read32(addr) {
      const p = addr & 0x1FFFFFFF;
      if (p < 0x800000 && !(p & 3)) return ram32[(p & RAM_MASK) >> 2];
      if (p & 3) return read16(addr) | read16(addr + 2) << 16;
      if (p >= 0x1FC00000) return bios32[(p & BIOS_MASK) >> 2];
      if (p < 0x1F800000) { if (p < 0x1F000000) return 0; const a = romAt(p); return a < ROM_LEN ? rom32[a >> 2] : 0; }
      if (p < 0x1F800400) return scr32[(p & 0x3FF) >> 2];
      if (isZn(p)) { ioSeq++; return znRead8(p) | znRead8(p + 1) << 8 | znRead8(p + 2) << 16 | znRead8(p + 3) << 24; }
      if ((p & 0x1FFFF000) === 0x1F801000) {
        if (p >= 0x1F801C00) { ioSeq++; const i = (p - 0x1F801C00) >> 1; return spu.readReg(i) | spu.readReg(i + 1) << 16; }
        if (!(p === 0x1F801814 || (p === 0x1F801110 && (counters[1].mode & 0x100)))) ioSeq++;
        return ioRead32(p);
      }
      if ((addr >>> 0) === 0xFFFE0130) return cacheCtrl;
      return 0;
    }
    function write8(addr, v) {
      const p = addr & 0x1FFFFFFF;
      if (p < 0x800000) { const i = p & RAM_MASK; if (ram[i] !== (v & 0xff)) { ram[i] = v; memSeq++; } return; }
      memSeq++;
      if (p >= 0x1F800000 && p < 0x1F800400) { scr[p & 0x3FF] = v; return; }
      if (isZn(p)) { znWrite8(p, v & 0xff); return; }
      if ((p & 0x1FFFF000) === 0x1F801000) {
        if (p >= 0x1F801C00) { if (!(p & 1)) spu.writeReg((p - 0x1F801C00) >> 1, v & 0xFF); return; }
        if (p === 0x1F801040) sioWrite16(0, v & 0xff);
      }
    }
    function write16(addr, v) {
      const p = addr & 0x1FFFFFFF;
      if (p & 1) { write8(addr, v & 0xFF); write8(addr + 1, v >>> 8 & 0xFF); return; }
      if (p < 0x800000) { const i = (p & RAM_MASK) >> 1; if (ram16[i] !== (v & 0xffff)) { ram16[i] = v; memSeq++; } return; }
      memSeq++;
      if (p >= 0x1F800000 && p < 0x1F800400) { scr16[(p & 0x3FF) >> 1] = v; return; }
      if (isZn(p)) {
        if (p >= 0x1FB80000 && p < 0x1FB80004) { soundReg16(p, v & 0xffff); return; }
        if (p === 0x1FBA0000) { soundIrq(); return; }
        if (p === 0x1FBA0002) return;
        znWrite8(p, v & 0xff); znWrite8(p + 1, v >>> 8 & 0xff); return;
      }
      if ((p & 0x1FFFF000) === 0x1F801000) {
        if (p >= 0x1F801C00) { spu.writeReg((p - 0x1F801C00) >> 1, v & 0xFFFF); return; }
        if (p >= 0x1F801040 && p < 0x1F801050) { sioWrite16(p & 0xe, v & 0xffff); return; }
        if (p >= 0x1F801100 && p < 0x1F801130) { timerWrite(p, v & 0xFFFF); return; }
        if (p === 0x1F801070) { iStat &= v | 0xFFFF0000; irqUpdate(); return; }
        if (p === 0x1F801074) { iMask = v & 0x7FF; irqUpdate(); return; }
      }
    }
    function write32(addr, v) {
      const p = addr & 0x1FFFFFFF;
      if (p & 3) { write16(addr, v & 0xFFFF); write16(addr + 2, v >>> 16 & 0xFFFF); return; }
      if (p < 0x800000) { const i = (p & RAM_MASK) >> 2; if (ram32[i] !== (v | 0)) { ram32[i] = v; memSeq++; } return; }
      memSeq++;
      if (p >= 0x1F800000 && p < 0x1F800400) { scr32[(p & 0x3FF) >> 2] = v; return; }
      if (isZn(p)) { write16(addr, v & 0xFFFF); write16(addr + 2, v >>> 16 & 0xFFFF); return; }
      if ((p & 0x1FFFF000) === 0x1F801000) {
        if (p >= 0x1F801C00) { const i = (p - 0x1F801C00) >> 1; spu.writeReg(i, v & 0xFFFF); spu.writeReg(i + 1, v >>> 16 & 0xFFFF); return; }
        ioWrite32(p, v); return;
      }
      if ((addr >>> 0) === 0xFFFE0130) cacheCtrl = v;
    }

    /** リセット(電源投入とウォッチドッグ)。RAM と不揮発メモリはそのまま */
    function reset() {
      const c = cpu.cycles;
      cpu.reset(); cpu.cycles = c;
      iStat = 0; iMask = 0; irqUpdate(); dpcr = 0x07654321; dicr = 0; bank = 0; wdAt = c; wdCk = 0;
      for (const k of counters) k.reset();
      sio.status = SIO_TX_EMPTY | SIO_TX_RDY; sio.mode = 0; sio.control = 0; sio.baud = 0; sio.txBits = 0; sio.rxBits = 0;
      setTimer(T_SIO, Infinity, 0); setTimer(T_MCU, Infinity, 0);
      gpu.gp1(0); resets++;
    }
    cpu.reset(); resets = 0; wdAt = 0;

    function saveCpu(a) { a.set(cpu.r); a[32] = cpu.hi; a[33] = cpu.lo; a[34] = cpu.pc; a[35] = cpu.nextPc; a[36] = cpu.sr; a[37] = cpu.cause | (cpu.branchDelay ? 0x40000000 : 0); }
    function sameCpu(a) {
      if (a[34] !== cpu.pc || a[35] !== cpu.nextPc || a[36] !== cpu.sr || a[32] !== cpu.hi || a[33] !== cpu.lo || a[37] !== (cpu.cause | (cpu.branchDelay ? 0x40000000 : 0))) return false;
      const r = cpu.r; for (let i = 1; i < 32; i++) if (a[i] !== r[i]) return false;
      return true;
    }
    // 待ちループの中から見える値(GPU の状態の奇偶、水平帰線を数えるタイマ 1)と、割り込みの元(VBlank、タイマ)が次に変わるまでのサイクル数。分からない時は 0(飛ばさない)
    // 割り込みを出す設定のタイマが、次に目標か桁あふれに届く時刻(通しのサイクル数)。出さないタイマはいつ進んでも外から見えないので数えない
    function counterEventAt() {
      let at = Infinity;
      for (let i = 0; i < 3; i++) {
        const c = counters[i];
        if (!(c.mode & 0x30) || c.stopped()) continue;
        const div = c.divisor(), tgt = c.target & 0xFFFF;
        const toTarget = c.count < tgt ? tgt - c.count : (c.mode & 8) && c.count === tgt ? 1 : 0x10000, toOver = 0x10000 - c.count;
        const t = synced + Math.max(1, Math.min(toTarget, toOver) * div - (div === 1 ? 0 : c.frac));
        if (t < at) at = t;
      }
      return at;
    }
    // 区切りの終わり: 次に何か(VBlank、SPU の 1 サンプル、タイマ、SIO など)が起きる時刻。出来事はその時刻ちょうどで処理するので、区切りの切り方で結果は変わらない
    function sliceEnd(target) {
      let lim = target;
      if (nextTimer < lim) lim = nextTimer;
      const vb = frameAt + cyclesPerFrame; if (vb < lim) lim = vb;
      const sp = synced + 768 - spuAcc; if (sp < lim) lim = sp;
      const ce = counterEventAt(); if (ce < lim) lim = ce;
      return lim;
    }
    // 待ちループの中から見える値と割り込みの元が、次に変わる時刻。待ちループが読んでよいのは GPU の状態(走査線の偶奇)と、水平帰線を数えるタイマ 1 の値だけ(read32 の ioSeq)
    function quietUntil() {
      const now = cpu.cycles;
      let q = frameAt + cyclesPerFrame;
      const lineEnd = frameAt + (Math.floor((now - frameAt) / cyclesPerLine) + 1) * cyclesPerLine; if (lineEnd < q) q = lineEnd;
      if (nextTimer < q) q = nextTimer;
      const wd = wdAt + 5 * CPU_HZ; if (wd < q) q = wd;
      const c1 = counters[1]; if (c1.mode & 0x100) { const t = synced + c1.divisor() - c1.frac; if (t < q) q = t; }
      const ce = counterEventAt(); if (ce < q) q = ce;
      if (spu.readReg(0xD5) & 0x40) { const sp = synced + 768 - spuAcc; if (sp < q) q = sp; }   // SPU の割り込みが有効なら、次のサンプルまで
      return q;
    }
    /**
     * 通しのサイクル数 target まで進める。
     * 待ちループの省略(厳密): 区切りの頭の番地へ 64 命令以内に戻ってきて、CPU の状態が完全に同じで、その間にメモリの中身が変わらず、
     * 時間や外の状態で値が変わる読み出しも無ければ、その 1 周は「何もしない」。次に何かが変わる時刻までに丸ごと収まる周回の数だけ、時間だけを進める。
     * 実行した時と同じ結果になる(省略あり/なしで、音源基板への指令の時刻・RAM・VRAM が一致するのを tools/zsg2 で確認)
     */
    function runTo(target) {
      while (cpu.cycles < target) {
        sliceLim = sliceEnd(target);
        // 外れは 1 区切りに 3 回まで(走査線の変わり目をまたいだ周回は値が変わるので外れる。その次の周回でまた当たる)。当たった後も区切りの終わりまで続けて試す
        for (let miss = 0; miss < 3 && idleSkip && !bus.irqLine && !cpu.branchDelay && cpu.cycles < sliceLim;) {
          saveCpu(snap);
          // 「変わる時刻」は周回を始める前の時点で求める(周回の途中で変わり目を過ぎても、読んだのがその前なら状態は同じに見えるため。後から求めると変わり目を見落とす)
          const m0 = memSeq, i0 = ioSeq, c0 = cpu.cycles, pc0 = cpu.pc, quiet = Math.min(quietUntil(), target);
          let k = 0;
          while (k < 64 && cpu.cycles < sliceLim) { cpu.step(); k++; if (cpu.pc === pc0) break; }
          if (!(cpu.pc === pc0 && cpu.cycles < sliceLim && memSeq === m0 && ioSeq === i0 && !bus.irqLine && sameCpu(snap))) { if (cpu.pc !== pc0) break; miss++; continue; }
          const per = cpu.cycles - c0, n = Math.floor((quiet - cpu.cycles) / per);
          if (n > 0) { cpu.cycles += n * per; idleCycles += n * per; } else miss++;
        }
        while (cpu.cycles < sliceLim) cpu.step();
        sync();
      }
      soundSync();
    }
    function runFrame() { const f = frame; while (frame === f) runTo(Math.min(cpu.cycles + 4096, frameAt + cyclesPerFrame)); }

    return { runTo, runFrame, reset, cpu, bus, ram, at28, fram, inp, spu, gpu, stats, sio, counters,
      get frame() { return frame; }, get resets() { return resets; }, get time() { return cpu.cycles / CPU_HZ; }, get bank() { return bank; },
      get iStat() { return iStat; }, get iMask() { return iMask; }, get idleCycles() { return idleCycles; } };
  };
  Emu.ZN_MAIN = { CPU_HZ, FRAME_HZ: GPU_HZ / (3413 * 263) };
  Emu.createCat702 = createCat702;
})(typeof globalThis !== 'undefined' ? globalThis : this);
