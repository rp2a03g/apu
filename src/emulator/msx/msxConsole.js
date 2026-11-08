/*
 * MSX 本体 (MML.Emu.MsxConsole) — 自前 MSX エミュレータ(DESIGN-MSX-CAPTURE.md、段階 7a/7b)
 *
 * NES 本体(nes/nesConsole.js)と同じ外形: DOM に依存せず、ヘッドレス(tools/headless/msx-run.js)/AudioWorklet
 * (src/audio/nes-worklet-impl.js)/主スレッド(src/ui/nesScreen.js)のどこでも同じ物が動く。
 *   runFrame()/runSamples(out)/setSampleRate(sr)/frame/frameCount/onFrame/onWrite/startRecording()/stopRecording()/
 *   setController(port, bits, turbo)(NES と同じビット: A=1 B=2 Up=16 Down=32 Left=64 Right=128 → ジョイスティックのトリガ 1/2 と方向)/
 *   setKey(code, down)(PC のキー)/reset()/hasBattery・getBattery・setBattery(SRAM/FM-PAC/RTC、7c)
 *
 * ■ 構成(機種は opts.machine: 'msx1' | 'msx2' | 'msx2plus' | 'turbor')
 *   turboR(7e): スロット 0-0 メイン BIOS、0-2 内蔵 MSX-MUSIC、3-0 サブ ROM(+漢字ドライバ 32K bios.kdr を $4000〜)、3-2 ディスク(TC8566AF)、
 *   3-3 マッパー RAM 256K(FS-A1ST の配置。パナソニックの内蔵ソフト ROM(3-1、512K の専用マッパー)は載せない)。S1990(I/O $E4-$E7: CPU モードと
 *   255.68kHz の 16bit タイマ)、PCM(I/O $A4/$A5、8bit D/A、15.75kHz の 2bit カウンタ。A/D は無し)、PAUSE($A7、押せない)。
 *   R800 は cpuZ80.js の r800 フラグ(MULUB/MULUW と時間の近似)。実 BIOS は利用者の物(C-BIOS に turboR は無い)
 *   Z80 3.58MHz(M1 ウェイト 1)、PPI 8255($A8-$AB: 一次スロット選択/キーボード行/キー読み)、拡張スロットレジスタ($FFFF)、
 *   メモリマッパー RAM($FC-$FF、msx1 64K / msx2〜 128K〜)、VDP(msx/vdp.js、$98-$9B)、PSG(expansion/ay8910Msx.js、$A0-$A2。
 *   R14 はジョイスティック、R15 は口の選択)、カートリッジ(msx/cartridge.js、スロット 1 と 2)、BIOS ROM(利用者または同梱 C-BIOS)。
 *   スロット配置(C-BIOS と大半の実機に合う既定): 0-0 メイン ROM(+$8000 にロゴ ROM)、1 カートリッジ A(ゲーム)、2 カートリッジ B、
 *   3-0 サブ ROM(MSX2〜)、3-2 マッパー RAM(msx1 は 3-0 に RAM、拡張無し)、3-3 内蔵 MSX-MUSIC(msx2plus/turbor、music ROM があるとき)。
 * ■ 音源(7b)
 *   PSG(常に)、SCC/SCC+(カートリッジ A が konamiScc/konamiSccI、または B が SCC-I)、OPLL=MSX-MUSIC(カートリッジ B が FM-PAC、
 *   または MSX2+/turboR の内蔵。expansion/opllMsx.js → 既定は Nuked コア。I/O $7C/$7D)、Y8950=MSX-AUDIO(カートリッジ B、
 *   expansion/opl.js type y8950、I/O $C0/$C1、ADPCM RAM 256K。タイマ割り込みは未実装)、コナミ DAC(カートリッジ A が konamiDac、
 *   expansion/majutsushiDac.js)。カートリッジ B は opts.cartB = { kind: 'fmpac'|'msxaudio'|'scci'|'rom', rom?, mapperType? }。
 *   ★FM-PAC の OPLL I/O は実機では $7FF6 bit0 で有効化されるが、ここでは挿した時点で常に有効にしている(値は fm.enable に覚える。
 *     内蔵 MSX-MUSIC の機種と同じ扱い。ROM 検出のみで $7FF6 を書かないソフトを鳴らすため)。
 * ■ 時間
 *   1 命令ごとに消費サイクルぶん VDP/音源を進める。INT は VDP の線(F∧IE0 ∨ FH∧IE1)を命令境界で見る(IFF1 かつ EI の直後でない)。
 *   フレームの区切り=VDP の VBlank の頭(表示最終行の次の行)。60Hz なら 262 行×228=59,736 サイクル、50Hz(R9 bit1)は 313 行。
 * ■ 録音(列を積む。VGM への符号化は vgm/vgmRecord.js encodeMsxRecording)
 *   書き込み { chip, addr, value, t }。chip と addr: 'psg'=レジスタ番号(0〜13。14/15 は I/O なので載せない)、'scc'=メモリ番地
 *   ($9800-$9FFF classic / $B800-$BFFF SCC+、それにモード $BFFE と窓の開閉 $B000)、'opll'=レジスタ番号($00-$3F)、
 *   'opl'=Y8950 のレジスタ番号(ADPCM 再生開始の書き込みには adpcm:{start,data} を添える。§5.3)、'dac'=番地($5000 台)。
 *   t はフレーム内のサンプル位置(60Hz: 0〜734、50Hz: 0〜881)。フレームの配列には spf(そのフレームのサンプル数)を付ける。
 *   開始時に各音源の像(P-4)を先頭に置く。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const CPU_CLOCK = 3579545;
  const AUDIO_RING = 1 << 14;
  const PSG_GAIN = 1.99 / 1.56; // KSS 再生(stream-player 1.99)と同じ大きさに。画面側の GainNode は NES と同じ 1.56
  const SCC_GAIN = 1.99 / 1.56;
  const OPLL_GAIN = 1.99 / 1.56;       // kssPlayer は OPLL を素通し(×1)
  const OPL_GAIN = 0.7 * 1.99 / 1.56;  // kssPlayer の MSX-AUDIO は ×0.7(VGM 側の較正比)
  const DAC_GAIN = 1.99 / 1.56;
  const PAGE = 0x2000;
  const Y8950_ADPCM_UNIT = 5; // ADPCM の開始/停止番地は 32 バイト単位(opl.js addrShift=5)

  const MACHINES = {
    msx1: { vdp: 'tms9918', vramKB: 16, ramKB: 64, expanded: [false, false, false, false], sub: false, fm: false },
    msx2: { vdp: 'v9938', vramKB: 128, ramKB: 128, expanded: [false, false, false, true], sub: true, fm: false },
    msx2plus: { vdp: 'v9958', vramKB: 128, ramKB: 128, expanded: [false, false, false, true], sub: true, fm: true },
    turbor: { vdp: 'v9958', vramKB: 128, ramKB: 256, expanded: [false, false, false, true], sub: true, fm: true, turbor: true,
      layout: { sub: [3, 0], disk: [3, 2], ram: [3, 3], music: [0, 2] } },
  };
  // 内蔵物のスロット(一次, 二次)。msx2/2+ は 7a〜7d の配置のまま(C-BIOS と実 BIOS の両方で動いている)
  const DEFAULT_LAYOUT = { sub: [3, 0], disk: [3, 1], ram: [3, 2], music: [3, 3] };
  const PCM_TICK = 3579545 / 15750; // PCM のカウンタ(2bit)の 1 刻み(Z80 サイクル)
  const S1990_TICK = 14;            // S1990 のタイマ: 3.579545MHz / 14 = 255.68kHz

  // turboR の S1990(システム制御): $E4 レジスタ番号、$E5 データ、$E6/$E7 タイマ(読み=下位/上位、$E6 書き=リセット)。
  //   レジスタ 6 = CPU モード(bit5: 1=Z80 0=R800、bit6: 1=ROM モード 0=DRAM モード。リセット時 $60)。5 = PAUSE LED 等(読み書きだけ)。
  //   13/14 は openMSX が固定値を返している記憶(0x03/0x2F)による推定。DRAM モードは速度の違いだけ(BIOS の RAM への写しは模擬しない)
  class S1990 {
    constructor(owner) { this.owner = owner; this.sel = 0; this.regs = new Uint8Array(16); this.timerBase = 0; this.reset(); }
    reset() { this.sel = 0; this.regs.fill(0); this.regs[6] = 0x60; this.timerBase = 0; this._applyCpu(); }
    ioRead(port) {
      switch (port) {
        case 0xE4: return this.sel;
        case 0xE5: return this.sel === 13 ? 0x03 : this.sel === 14 ? 0x2F : this.regs[this.sel & 15];
        case 0xE6: return this._timer() & 0xFF;
        case 0xE7: return (this._timer() >> 8) & 0xFF;
        default: return 0xFF;
      }
    }
    ioWrite(port, v) {
      switch (port) {
        case 0xE4: this.sel = v & 0x0F; return;
        case 0xE5: this.regs[this.sel] = v; if (this.sel === 6) this._applyCpu(); return;
        case 0xE6: this.timerBase = this.owner.cpuCycles; return;
        default: return;
      }
    }
    _timer() { return Math.floor((this.owner.cpuCycles - this.timerBase) / S1990_TICK) & 0xFFFF; }
    get r800() { return !(this.regs[6] & 0x20); }
    get dram() { return !(this.regs[6] & 0x40); }
    _applyCpu() { const cpu = this.owner.cpu; if (!cpu) return; cpu.r800 = this.r800; cpu.r800Scale = this.dram ? 0.2 : 0.35; }
  }
  // turboR の PCM(8bit D/A。A/D は模擬しない): $A4 データ(書き=D/A、読み=最後の値)、$A5 制御/状態。
  //   $A5 書き: bit0 SMPL、bit1 SEL(1 のとき $A4 の書き込みが D/A に出る)、bit2 FILT、bit3 MUTE(1=消音)。読み: bit1-0 = $A4 アクセスからの
  //   15.75kHz カウンタ(2bit。BIOS/ゲームはこれを待って 1 サンプルずつ書く)、bit4-2 = 書いた値、bit7 = 比較器(A/D 無しなので 0)。
  //   ビット配置は MSX Datapack の記述の記憶による(SEL/MUTE の極性は推定。録音には SEL のときの $A4 を載せる)。音は牌の魔術師の D/A と同じ零次ホールド
  class TurboRPcm {
    constructor(owner) { this.owner = owner; this.dac = new Emu.MajutsushiDAC(); this.status = 0; this.value = 0x80; this.lastAccess = 0; }
    reset() { this.dac.reset(); this.status = 0; this.value = 0x80; this.lastAccess = 0; }
    get outputOn() { return (this.status & 0x02) !== 0; }
    ioRead(port) {
      if (port === 0xA4) { this.lastAccess = this.owner.cpuCycles; return this.value; }
      const ticks = Math.floor((this.owner.cpuCycles - this.lastAccess) / PCM_TICK) & 3;
      return (this.status & 0x1C) | ticks;
    }
    ioWrite(port, v) {
      if (port === 0xA4) { this.lastAccess = this.owner.cpuCycles; this.value = v & 0xFF; if (this.outputOn) this.dac.write(v); return true; }
      this.status = v & 0x1F; return false;
    }
    mixSample() { return (this.status & 0x08) ? 0 : this.dac.mixSample(); }
    get mute() { return this.dac.mute; } get vol() { return this.dac.vol; }
  }

  const CART_B_KINDS = ['none', 'fmpac', 'msxaudio', 'scci', 'rom'];

  const EMPTY_PAGE = new Uint8Array(PAGE).fill(0xFF);

  // ── スロットに挿す物(read(addr)/write(addr,v)) ──
  class RomDevice {
    /** @param {Uint8Array} rom @param {number} base 置く番地 */
    constructor(rom, base) { this.rom = rom; this.base = base; this.end = base + rom.length; }
    read(a) { return (a >= this.base && a < this.end) ? this.rom[a - this.base] : 0xFF; }
    write() {}
  }
  class MultiRomDevice { // 1 スロットに複数の ROM(メイン+ロゴ など)
    constructor(list) { this.list = list; }
    read(a) { for (const d of this.list) { if (a >= d.base && a < d.end) return d.rom[a - d.base]; } return 0xFF; }
    write() {}
  }
  class MapperRam {
    constructor(kb) {
      this.ram = new Uint8Array(kb * 1024);
      this.segments = this.ram.length >> 14;
      this.segMask = this.segments - 1;
      this.sel = new Uint8Array(4); // ページ(16K)ごとのセグメント
      this.reset();
    }
    reset() { this.sel[0] = 3; this.sel[1] = 2; this.sel[2] = 1; this.sel[3] = 0; this.ram.fill(0); }
    read(a) { return this.ram[((this.sel[a >> 14] & this.segMask) << 14) | (a & 0x3FFF)]; }
    write(a, v) { this.ram[((this.sel[a >> 14] & this.segMask) << 14) | (a & 0x3FFF)] = v; }
    ioWrite(port, v) { this.sel[port & 3] = v; }
    ioRead(port) { return this.sel[port & 3] | ~this.segMask; } // 未使用上位ビットは 1(実機のマッパーもそう読める物が多い)
  }
  class CartDevice {
    constructor(cart) { this.cart = cart; }
    read(a) { const s = this.cart.readScc(a); return s >= 0 ? s : this.cart.read(a); }
    write(a, v) { this.cart.write(a, v); }
  }
  // FM-PAC / 内蔵 MSX-MUSIC: ROM(16K、または 64K を $7FF7 で 16K バンク)を $4000-$7FFF に、$7FF6 bit0=OPLL I/O 有効(値だけ覚える)、
  // $5FFE/$5FFF に 0x4D/0x69 を書くと $4000-$5FFF が SRAM 8K(PAC のセーブ。7b は保存しない)
  class FmPacDevice {
    constructor(rom) {
      this.rom = rom || new Uint8Array(0);
      this.sram = new Uint8Array(0x2000);
      this.bank = 0; this.enable = 0; this.magic = new Uint8Array(2); this.dirty = false;
      this.bankMask = Math.max(0, (this.rom.length >> 14) - 1);
    }
    reset() { this.bank = 0; this.enable = 0; this.magic.fill(0); }
    get sramOn() { return this.magic[0] === 0x4D && this.magic[1] === 0x69; }
    read(a) {
      if (a < 0x4000 || a >= 0x8000) return 0xFF;
      if (a === 0x7FF6) return this.enable & 0x11;
      if (a === 0x7FF7) return this.bank & 3;
      if (a < 0x6000 && this.sramOn) return this.sram[a & 0x1FFF];
      const off = ((this.bank & this.bankMask) << 14) | (a & 0x3FFF);
      return off < this.rom.length ? this.rom[off] : 0xFF;
    }
    write(a, v) {
      if (a === 0x7FF6) { this.enable = v; return; }
      if (a === 0x7FF7) { this.bank = v & 3; return; }
      if (a === 0x5FFE) { this.magic[0] = v; return; }
      if (a === 0x5FFF) { this.magic[1] = v; return; }
      if (a >= 0x4000 && a < 0x5FFE && this.sramOn && this.sram[a & 0x1FFF] !== v) { this.sram[a & 0x1FFF] = v; this.dirty = true; }
    }
  }

  // RTC RP5C01(I/O $B4 レジスタ番号、$B5 データ。MSX2〜)。モード 0 = 時計(JS の時計から読む。書き込みは無視)、1 = アラーム/12・24 時間/うるう年、
  // 2・3 = 13 ニブルずつの RAM(BIOS が画面色・ビープ・起動ロゴ等の設定を置く。バッテリー保存に含める)。レジスタ 13 = モード(bit0-1)+タイマ有効(bit3)
  class Rp5c01 {
    constructor() { this.ram = new Uint8Array(26); this.mode = 0x08; this.reg = 0; this.alarm = new Uint8Array(13); this.dirty = false; }
    reset() { this.reg = 0; this.mode = 0x08; }
    ioWrite(port, v) {
      if ((port & 1) === 0) { this.reg = v & 0x0F; return; }
      v &= 0x0F;
      if (this.reg === 13) { this.mode = v; return; }
      if (this.reg >= 13) return; // 14 テスト、15 リセット
      const m = this.mode & 3;
      if (m === 0) return; // 時計は JS の物
      if (m === 1) { this.alarm[this.reg] = v; return; }
      const i = (m - 2) * 13 + this.reg;
      if (this.ram[i] !== v) { this.ram[i] = v; this.dirty = true; }
    }
    ioRead(port) {
      if ((port & 1) === 0) return 0xFF;
      if (this.reg === 13) return this.mode | 0xF0;
      if (this.reg >= 13) return 0xFF;
      const m = this.mode & 3;
      if (m === 0) return this._clock(this.reg) | 0xF0;
      if (m === 1) return this.alarm[this.reg] | 0xF0;
      return this.ram[(m - 2) * 13 + this.reg] | 0xF0;
    }
    _clock(r) {
      const d = new Date();
      const h24 = (this.alarm[10] & 1) !== 0; // モード 1 レジスタ 10 bit0: 1=24 時間
      const h = d.getHours(), hh = h24 ? h : (h % 12), pm = h >= 12 ? 2 : 0;
      switch (r) {
        case 0: return d.getSeconds() % 10; case 1: return (d.getSeconds() / 10) | 0;
        case 2: return d.getMinutes() % 10; case 3: return (d.getMinutes() / 10) | 0;
        case 4: return hh % 10; case 5: return ((hh / 10) | 0) | (h24 ? 0 : pm);
        case 6: return d.getDay(); case 7: return d.getDate() % 10; case 8: return (d.getDate() / 10) | 0;
        case 9: return (d.getMonth() + 1) % 10; case 10: return ((d.getMonth() + 1) / 10) | 0;
        case 11: return (d.getFullYear() - 1980) % 10; case 12: return (((d.getFullYear() - 1980) / 10) | 0) % 10;
        default: return 0;
      }
    }
  }
  // 漢字 ROM(I/O $D8/$D9 = JIS 第一水準 128K、$DA/$DB = 第二水準 128K。書き込み 2 回で文字番号、読み出しは 32 バイト順送り)
  class KanjiRom {
    constructor(rom) { this.rom = rom; this.addr = [0, 0]; this.lo = [0, 0]; }
    reset() { this.addr.fill(0); this.lo.fill(0); }
    ioWrite(port, v) {
      const k = (port >> 1) & 1; // $D8/$D9 → 0、$DA/$DB → 1
      if ((port & 1) === 0) this.lo[k] = v & 0x3F; else this.addr[k] = (((v & 0x3F) << 6) | this.lo[k]) << 5;
    }
    ioRead(port) {
      if ((port & 1) === 0) return 0xFF;
      const k = (port >> 1) & 1;
      const base = k ? 0x20000 : 0;
      const a = base + (this.addr[k] & 0x1FFFF);
      const v = a < this.rom.length ? this.rom[a] : 0xFF;
      this.addr[k] = (this.addr[k] & ~0x1F) | ((this.addr[k] + 1) & 0x1F);
      return v;
    }
  }

  class MsxConsole {
    /**
     * @param {Uint8Array} romBytes カートリッジ ROM(.rom)。null なら BIOS だけで起動
     * @param {object} [opts] { machine, bios: { main, sub, logo, disk, kanji, kdr(漢字ドライバ 32K、2+/turboR), music }, mapperType, ramKB,
     *                          cartB: { kind: 'fmpac'|'msxaudio'|'scci'|'rom', rom?: Uint8Array, mapperType? } | Uint8Array(=rom),
     *                          disks: Uint8Array[](.dsk 画像。bios.disk=ディスク ROM 16K が要る), fdc: 'wd2793'|'tc8566af' }
     */
    constructor(romBytes, opts) {
      opts = opts || {};
      this.opts = opts;
      this.machine = MACHINES[opts.machine] ? opts.machine : 'msx2';
      const mc = MACHINES[this.machine];
      // BIOS: 渡された物 → 同梱の C-BIOS(msx/cbiosData.js、mk-cbios-data.js が作る。turboR には無い)→ 無ければ例外
      this.bios = (opts.bios && opts.bios.main) ? opts.bios : MsxConsole.defaultBios(this.machine);
      if (!this.bios || !this.bios.main) throw new Error('MSX の BIOS(メイン ROM)がありません');
      this.cpu = new Emu.CPUZ80(this);
      this.cpu.m1Wait = 1;
      this.vdp = new Emu.MsxVdp({ type: mc.vdp, vramKB: mc.vramKB });
      this.psg = new Emu.AY8910Audio();
      this.keyboard = new Emu.MsxKeyboard();
      this.rtc = mc.sub ? new Rp5c01() : null; // MSX2 以降
      this.kanji = this.bios.kanji && this.bios.kanji.length >= 0x20000 ? new KanjiRom(this.bios.kanji) : null;
      this.ramDev = new MapperRam(opts.ramKB || mc.ramKB);
      // カートリッジ B の指定を正規化
      let cb = opts.cartB || null;
      if (cb instanceof Uint8Array || (cb && cb.buffer && !cb.kind)) cb = { kind: 'rom', rom: cb };
      if (cb && (!CART_B_KINDS.includes(cb.kind) || cb.kind === 'none')) cb = null;
      if (cb && cb.kind === 'rom' && !cb.rom) cb = null;
      this.cartBKind = cb ? cb.kind : 'none';
      // 音源(載せる物だけ作る)
      const typeA = opts.mapperType || (romBytes ? Emu.MsxCartridge.guessType(romBytes) : null);
      const sccA = typeA === 'konamiScc' || typeA === 'konamiSccI';
      this.scc = (sccA || this.cartBKind === 'scci') && Emu.SCCAudio ? new Emu.SCCAudio() : null;
      this.dac = typeA === 'konamiDac' && Emu.MajutsushiDAC ? new Emu.MajutsushiDAC() : null;
      const fmRom = (cb && cb.kind === 'fmpac' && cb.rom) ? cb.rom : (this.bios.music || null);
      this.fmInternal = !!mc.fm && !!fmRom;
      this.opll = ((cb && cb.kind === 'fmpac') || this.fmInternal) && Emu.OPLLAudio ? new Emu.OPLLAudio() : null;
      this.fm = this.opll ? new FmPacDevice(fmRom) : null;
      this.opl = cb && cb.kind === 'msxaudio' && Emu.OPLAudio ? new Emu.OPLAudio(CPU_CLOCK, { type: 'y8950' }) : null;
      this.cpuCycles = 0;
      this.s1990 = mc.turbor ? new S1990(this) : null; // turboR(7e)
      this.pcm = mc.turbor && Emu.MajutsushiDAC ? new TurboRPcm(this) : null;
      this.cart = romBytes ? new Emu.MsxCartridge(romBytes, { type: opts.mapperType, scc: sccA ? this.scc : null, dac: this.dac }) : null;
      this.cartB = null;
      if (cb && cb.kind === 'rom') this.cartB = new Emu.MsxCartridge(cb.rom, { type: cb.mapperType, scc: null });
      else if (cb && cb.kind === 'scci') this.cartB = new Emu.MsxCartridge(cb.rom || null, { type: 'konamiSccI', scc: this.scc });
      if (this.cart) this.cart.onWrite = (kind, a, v) => this._logWrite(kind, a, v);
      if (this.cartB) this.cartB.onWrite = (kind, a, v) => this._logWrite(kind, a, v);
      // スロット表 slot[primary][secondary]
      this.expanded = mc.expanded.slice();
      this.slot = [[null, null, null, null], [null, null, null, null], [null, null, null, null], [null, null, null, null]];
      const lay = mc.layout || DEFAULT_LAYOUT;
      const mainList = [new RomDevice(this.bios.main, 0)];
      if (this.bios.logo) mainList.push(new RomDevice(this.bios.logo, 0x8000));
      this.slot[0][0] = new MultiRomDevice(mainList);
      if (this.cart) this.slot[1][0] = new CartDevice(this.cart);
      if (this.cartB) this.slot[2][0] = new CartDevice(this.cartB);
      else if (this.fm && !this.fmInternal) this.slot[2][0] = this.fm; // FM-PAC はカートリッジ B
      if (mc.sub) {
        // サブ ROM(+turboR/2+ の漢字ドライバ 32K を $4000〜 に同居: FS-A1ST/WSX の 3-0 と同じ)
        const subList = [];
        if (this.bios.sub) subList.push(new RomDevice(this.bios.sub, 0));
        if (this.bios.kdr && this.bios.kdr.length === 0x8000) subList.push(new RomDevice(this.bios.kdr, 0x4000));
        if (subList.length) this.slot[lay.sub[0]][lay.sub[1]] = subList.length === 1 ? subList[0] : new MultiRomDevice(subList);
        this.slot[lay.ram[0]][lay.ram[1]] = this.ramDev;
      }
      else this.slot[3][0] = this.ramDev;
      // ディスク(7d): ディスク ROM(利用者の物)+FDC をスロット 3-1 に。画像が無くても ROM があればドライブ(空)は付く
      this.disk = null;
      if (opts.disks && opts.disks.length && !this.bios.disk) throw new Error('ディスク ROM がありません');
      if (this.bios.disk && Emu.MsxDiskInterface) {
        const images = (opts.disks || []).map((b) => new Emu.MsxDiskImage(b));
        this.disk = new Emu.MsxDiskInterface(this.bios.disk, opts.fdc || 'wd2793', images);
        this.slot[lay.disk[0]][lay.disk[1]] = this.disk;
      }
      if (this.fm && this.fmInternal) this.slot[lay.music[0]][lay.music[1]] = this.fm; // 内蔵 MSX-MUSIC(2+ は 3-3、turboR は 0-2)
      this.pageDev = new Array(8).fill(null);
      this.ppiA = 0; this.ppiC = 0; this.ssl = new Uint8Array(4);
      this.joy = [0, 0]; this.joyHeld = [0, 0]; this.joyTurbo = [0, 0]; this.turboRate = 2; this.turboPhase = 0;
      this.sampleRate = 0; this.cycleAccum = 0;
      this.ring = new Float32Array(AUDIO_RING); this.ringHead = 0; this.ringLen = 0;
      this.underruns = 0;
      this.cpuCycles = 0; this.frameCount = 0; this._frameFlag = false;
      this.onWrite = null; this.onFrame = null; this.rec = null;
      this.opllLatch = 0; this.oplLatch = 0;
      this.reset();
    }

    reset() {
      this.ppiA = 0; this.ppiC = 0; this.ssl.fill(0);
      this.ramDev.reset();
      this.vdp.reset();
      this.psg.reset();
      if (this.scc) this.scc.reset();
      if (this.opll) this.opll.reset();
      if (this.opl) this.opl.reset();
      if (this.dac) this.dac.reset();
      if (this.fm) this.fm.reset();
      if (this.rtc) this.rtc.reset();
      if (this.kanji) this.kanji.reset();
      if (this.disk) this.disk.reset();
      if (this.s1990) this.s1990.reset();
      if (this.pcm) this.pcm.reset();
      if (this.cart) this.cart.reset();
      if (this.cartB) this.cartB.reset();
      this.keyboard.releaseAll();
      this.cpu.reset();
      this.cpu.pc = 0; this.cpu.sp = 0xF380; this.cpu.im = 1;
      this.opllLatch = 0; this.oplLatch = 0;
      this._remapAll();
      this.cpuCycles = 0;
    }

    // 同梱 C-BIOS を Uint8Array に戻す(機種に無ければ null)。turbor は msx2plus の C-BIOS で代用しない(実 BIOS が要る)
    static defaultBios(machine) {
      const C = Emu.CBIOS;
      if (!C || !C[machine] || !C[machine].main) return null;
      const dec = (b) => { if (!b) return null; if (typeof atob === 'function') { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; } return new Uint8Array(Buffer.from(b, 'base64')); };
      const e = C[machine];
      return { main: dec(e.main), sub: dec(e.sub), logo: dec(e.logo), music: dec(C.music || null), name: 'C-BIOS ' + (C.version || '') };
    }
    static hasDefaultBios(machine) { const C = Emu.CBIOS; return !!(C && C[machine] && C[machine].main); }
    // 同梱の MSX-MUSIC ROM(C-BIOS の cbios_music.rom)。FM-PAC を挿すときの ROM の既定
    static defaultMusicRom() {
      const C = Emu.CBIOS;
      if (!C || !C.music) return null;
      return MsxConsole.defaultBios(Object.keys(C).find((k) => C[k] && C[k].main) || 'msx2').music;
    }
    static describe(c) {
      const parts = [{ msx1: 'MSX1', msx2: 'MSX2', msx2plus: 'MSX2+', turbor: 'MSX turbo R' }[c.machine] + (c.r800Active ? ' (R800)' : '')];
      if (c.cart) parts.push(c.cart.title + (c.cart.hasSram ? '+SRAM' : ''));
      if (c.kanji) parts.push('漢字');
      const b = { fmpac: 'FM-PAC', msxaudio: 'MSX-AUDIO', scci: 'SCC-I' }[c.cartBKind];
      if (b) parts.push('+' + b); else if (c.cartB) parts.push('+' + c.cartB.title);
      if (c.fmInternal) parts.push('+MSX-MUSIC');
      if (c.disk) parts.push((c.disk.kind === 'tc8566af' ? 'TC8566AF' : 'WD2793') + (c.disk.diskCount ? ' ' + c.disk.diskCount + ' disk' : ''));
      parts.push(`RAM ${(c.ramDev.ram.length / 1024) | 0}K`);
      if (c.bios.name) parts.push(c.bios.name);
      return parts.join(' / ');
    }
    get biosName() { return this.bios.name || null; }
    // 録音/ライブ表示に載る音源
    chips() {
      const out = ['psg'];
      if (this.scc) out.push('scc');
      if (this.opll) out.push('opll');
      if (this.opl) out.push('opl');
      if (this.dac) out.push('dac');
      if (this.pcm) out.push('pcm');
      return out;
    }
    get r800Active() { return !!(this.s1990 && this.s1990.r800); }
    get sccPlus() { return !!((this.cart && this.cart.sccPlusMode) || (this.cartB && this.cartB.sccPlusMode)); }
    extBits() { return 0; }
    // バッテリーバックアップ(7c): カートリッジの SRAM + FM-PAC の SRAM + RTC の RAM を 1 本に("MSXB" + [tag len32 data]...)。
    // 書き込みがあると batteryDirty(主スレッド/Worklet が 1 秒ごとに見て保存し、clearBatteryDirty() で下ろす)。NES と同じ経路(IndexedDB)
    get hasBattery() { return !!((this.cart && this.cart.hasSram) || (this.cartB && this.cartB.hasSram) || this.fm || this.rtc || this.disk); }
    get batteryDirty() { return !!((this.cart && this.cart.sramDirty) || (this.cartB && this.cartB.sramDirty) || (this.fm && this.fm.dirty) || (this.rtc && this.rtc.dirty) || (this.disk && this.disk.dirty)); }
    clearBatteryDirty() { if (this.cart) this.cart.sramDirty = false; if (this.cartB) this.cartB.sramDirty = false; if (this.fm) this.fm.dirty = false; if (this.rtc) this.rtc.dirty = false; if (this.disk) this.disk.clearDirty(); }
    getBattery() {
      if (!this.hasBattery) return null;
      const parts = [];
      const put = (tag, data) => { if (data) parts.push({ tag, data }); };
      put(1, this.cart && this.cart.hasSram ? this.cart.getSram() : null);
      put(2, this.fm ? this.fm.sram.slice() : null);
      put(3, this.rtc ? this.rtc.ram.slice() : null);
      put(4, this.cartB && this.cartB.hasSram ? this.cartB.getSram() : null);
      // 5: 書き込みのあったディスク画像([番号 1 バイト]+画像。開いた .dsk への書き戻し。次に同じ .dsk を開くと復元される)
      if (this.disk) this.disk.images.forEach((im, i) => { if (im.dirty || im.wasDirty) { const d = new Uint8Array(1 + im.img.length); d[0] = i; d.set(im.img, 1); put(5, d); im.wasDirty = true; } });
      let n = 4; for (const p of parts) n += 5 + p.data.length;
      const out = new Uint8Array(n); out.set([0x4D, 0x53, 0x58, 0x42], 0);
      let o = 4;
      for (const p of parts) { out[o] = p.tag; out[o + 1] = p.data.length & 0xFF; out[o + 2] = (p.data.length >> 8) & 0xFF; out[o + 3] = (p.data.length >> 16) & 0xFF; out[o + 4] = (p.data.length >>> 24) & 0xFF; out.set(p.data, o + 5); o += 5 + p.data.length; }
      return out;
    }
    setBattery(bytes) {
      if (!this.hasBattery || !bytes || bytes.length < 4 || bytes[0] !== 0x4D || bytes[1] !== 0x53 || bytes[2] !== 0x58 || bytes[3] !== 0x42) return false;
      let o = 4;
      while (o + 5 <= bytes.length) {
        const tag = bytes[o], len = (bytes[o + 1] | (bytes[o + 2] << 8) | (bytes[o + 3] << 16) | (bytes[o + 4] << 24)) >>> 0;
        const data = bytes.subarray(o + 5, o + 5 + len); o += 5 + len;
        if (tag === 1 && this.cart && this.cart.hasSram) this.cart.setSram(data);
        else if (tag === 2 && this.fm) this.fm.sram.set(data.subarray(0, Math.min(data.length, this.fm.sram.length)));
        else if (tag === 3 && this.rtc) this.rtc.ram.set(data.subarray(0, Math.min(data.length, this.rtc.ram.length)));
        else if (tag === 4 && this.cartB && this.cartB.hasSram) this.cartB.setSram(data);
        else if (tag === 5 && this.disk && data.length > 1) { const im = this.disk.images[data[0]]; if (im && im.img.length === data.length - 1) { im.img.set(data.subarray(1)); im.wasDirty = true; } }
      }
      this.clearBatteryDirty();
      return true;
    }
    get diskCount() { return this.disk ? this.disk.diskCount : 0; }
    insertDisk(n) { if (this.disk) this.disk.insertDisk(n); }
    ejectDisk() { if (this.disk) this.disk.ejectDisk(); }
    addDisk(bytes) { return this.disk ? this.disk.addImage(new Emu.MsxDiskImage(bytes)) : -1; }
    get diskInserted() { return this.disk ? this.disk.inserted : -1; }
    get frame() { return this.vdp.frame; }
    get frameIdx() { return this.vdp.frameIdx; }
    get frameWidth() { return this.vdp.frameWidth; }      // そのフレームの幅(256/512。モードで変わる)
    get frameHeight() { return Emu.MsxVdp.H; }
    get frameIdxWidth() { return this.vdp.frameIdxWidth; } // 巻き戻しの映像の輪(frameIdx)の幅(常に 256)
    get frameIdxKind() { return this.vdp.frameIdxKind; }   // 0=パレット番号、1=GRB332(GRAPHIC7)
    idxPalette(kind) { return kind ? Emu.MsxVdp.G7_PALETTE : this.vdp.palette; }
    get samplesPerFrame() { return this.vdp.linesPerFrame === 313 ? 882 : 735; }
    get frameRate() { return CPU_CLOCK / this.vdp.cyclesPerFrame; }

    setSampleRate(sr) { this.sampleRate = sr; this.cycleAccum = 0; this.ringHead = 0; this.ringLen = 0; }
    // NES と同じビット割り当てで受ける(UI 共通)。A=トリガ 1、B=トリガ 2
    setController(port, bits, turbo) { port &= 1; this.joyHeld[port] = bits & 0xFF; this.joyTurbo[port] = (turbo | 0) & 0xFF; this._applyJoy(port); }
    setTurboRate(frames) { this.turboRate = Math.max(1, frames | 0); this.turboPhase = 0; this._applyJoy(0); this._applyJoy(1); }
    _applyJoy(p) {
      const on = ((this.turboPhase / this.turboRate) | 0) === 0;
      const b = this.joyHeld[p] | (on ? this.joyTurbo[p] : 0);
      // NES ビット → PSG R14 のビット(上 1、下 2、左 4、右 8、トリガ A 16、トリガ B 32)
      this.joy[p] = ((b & 16) ? 1 : 0) | ((b & 32) ? 2 : 0) | ((b & 64) ? 4 : 0) | ((b & 128) ? 8 : 0) | ((b & 1) ? 16 : 0) | ((b & 2) ? 32 : 0);
    }
    /** PC のキー(KeyboardEvent.code)。対応が無ければ false */
    setKey(code, down) { return this.keyboard.setPcKey(code, down); }
    setMsxKey(name, down) { return this.keyboard.setKey(name, down); }

    // ── スロット ──
    _remapAll() { for (let p = 0; p < 8; p++) this._remapPage(p); }
    _remapPage(p) {
      const pri = (this.ppiA >> ((p >> 1) * 2)) & 3;
      const sec = this.expanded[pri] ? (this.ssl[pri] >> ((p >> 1) * 2)) & 3 : 0;
      this.pageDev[p] = this.slot[pri][sec];
    }
    _primaryOfPage3() { return (this.ppiA >> 6) & 3; }

    // ── バス(Z80 から) ──
    read(addr) {
      addr &= 0xFFFF;
      if (addr === 0xFFFF) { const pri = this._primaryOfPage3(); if (this.expanded[pri]) return (~this.ssl[pri]) & 0xFF; }
      const d = this.pageDev[addr >>> 13];
      return d ? d.read(addr) : 0xFF;
    }
    write(addr, v) {
      addr &= 0xFFFF; v &= 0xFF;
      if (addr === 0xFFFF) { const pri = this._primaryOfPage3(); if (this.expanded[pri]) { this.ssl[pri] = v; this._remapAll(); return; } }
      const d = this.pageDev[addr >>> 13];
      if (d) d.write(addr, v);
    }
    ioRead(port) {
      port &= 0xFF;
      switch (port) {
        case 0x98: case 0x99: case 0x9A: case 0x9B: return this.vdp.readPort(port);
        case 0xA2: return this.psg.addr === 14 ? this._readJoy() : this.psg.readData();
        case 0xA8: return this.ppiA;
        case 0xA9: return this.keyboard.readRow(this.ppiC & 0x0F);
        case 0xAA: return this.ppiC;
        case 0xAB: return 0xFF;
        case 0xB4: case 0xB5: return this.rtc ? this.rtc.ioRead(port) : 0xFF;
        case 0xD8: case 0xD9: case 0xDA: case 0xDB: return this.kanji ? this.kanji.ioRead(port) : 0xFF;
        case 0xA4: case 0xA5: return this.pcm ? this.pcm.ioRead(port) : 0xFF; // turboR PCM
        case 0xA7: return this.s1990 ? 0x00 : 0xFF;                            // turboR PAUSE(bit0: 押されていない)
        case 0xE4: case 0xE5: case 0xE6: case 0xE7: return this.s1990 ? this.s1990.ioRead(port) : 0xFF;
        case 0xC0: return this.opl ? this.opl.readStatus() : 0xFF; // MSX-AUDIO: ステータス(無ければ 0xFF=無し)
        case 0xC1: return this.opl ? this.opl.readData() : 0xFF;
        case 0xFC: case 0xFD: case 0xFE: case 0xFF: return this.ramDev.ioRead(port);
        default: return 0xFF; // OPLL は書き込み専用
      }
    }
    ioWrite(port, v) {
      port &= 0xFF; v &= 0xFF;
      switch (port) {
        case 0x98: case 0x99: case 0x9A: case 0x9B: this.vdp.writePort(port, v); return;
        case 0xA0: this.psg.ioWrite(port, v); return;
        case 0xA1: {
          const reg = this.psg.addr;
          this.psg.ioWrite(port, v);
          if (reg < 14) this._logWrite('psg', reg, v);
          return;
        }
        case 0xA8: this.ppiA = v; this._remapAll(); return;
        case 0xAA: this.ppiC = v; return;
        case 0xAB: if (!(v & 0x80)) { const bit = (v >> 1) & 7; this.ppiC = (v & 1) ? (this.ppiC | (1 << bit)) : (this.ppiC & ~(1 << bit)); } return;
        case 0x7C: if (this.opll) { this.opllLatch = v & 0x3F; this.opll.ioWrite(0x7C, v); } return; // MSX-MUSIC(FM-PAC/内蔵)
        case 0x7D: if (this.opll) { this.opll.ioWrite(0x7D, v); this._logWrite('opll', this.opllLatch, v); } return;
        case 0xB4: case 0xB5: if (this.rtc) this.rtc.ioWrite(port, v); return;
        case 0xD8: case 0xD9: case 0xDA: case 0xDB: if (this.kanji) this.kanji.ioWrite(port, v); return;
        case 0xA4: case 0xA5: if (this.pcm) { const out = this.pcm.ioWrite(port, v); if (out || port === 0xA5) this._logWrite('pcm', port, v); } return; // turboR PCM($A4 は D/A に出た物だけ録音)
        case 0xA7: return;
        case 0xE4: case 0xE5: case 0xE6: case 0xE7: if (this.s1990) this.s1990.ioWrite(port, v); return;
        case 0xC0: if (this.opl) { this.oplLatch = v; this.opl.ioWrite(0xC0, v); } return; // MSX-AUDIO
        case 0xC1: if (this.opl) this._oplData(v); return;
        case 0xFC: case 0xFD: case 0xFE: case 0xFF: this.ramDev.ioWrite(port, v); return;
        default: return;
      }
    }
    // Y8950 のデータ書き込み: ADPCM の再生開始($07 bit7、録音でなく外部メモリ)なら、鳴らす範囲の RAM を書き込みに添える(§5.3)。
    // $0F(メモリへのデータ)は本体が RAM へ入れる。録音には載せない(符号化側で落とす)
    _oplData(v) {
      const reg = this.oplLatch, opl = this.opl;
      let adpcm = null;
      if (reg === 0x07 && (v & 0xE0) === 0xA0) {
        const r = opl.regs;
        const start = (r[0x09] | (r[0x0A] << 8)) << Y8950_ADPCM_UNIT;
        const stop = ((r[0x0B] | (r[0x0C] << 8)) + 1) << Y8950_ADPCM_UNIT;
        const ram = opl.romB;
        if (ram && stop > start) adpcm = { start, data: ram.slice(start, Math.min(stop, ram.length)) };
      }
      opl.ioWrite(0xC1, v);
      if (this.rec) { const w = { chip: 'opl', addr: reg, value: v, t: this._t() }; if (adpcm) w.adpcm = adpcm; this.rec.cur.push(w); }
      if (this.onWrite) this.onWrite('opl', reg, v, this.vdp.frameFrac());
    }
    // PSG R14: R15 bit6 で選んだ口のジョイスティック(押している=0)。bit6 カセット入力=1、bit7 キーボード配列=0(日本語)
    _readJoy() {
      const p = (this.psg.regs[15] >> 6) & 1;
      return (0x3F & ~this.joy[p]) | 0x40;
    }

    // ── 録音 ──
    _t() { const n = this.samplesPerFrame; return Math.min(n - 1, Math.floor(this.vdp.frameFrac() * n)); }
    _logWrite(chip, addr, v) {
      if (this.rec) this.rec.cur.push({ chip, addr, value: v, t: this._t() });
      if (this.onWrite) this.onWrite(chip, addr, v, this.vdp.frameFrac());
    }
    // 今の音源の像(P-4): PSG R0-R13、SCC(波形、周波数、音量、有効)、OPLL($00-$07 音色、$30-$38、$10-$18、$0E、$20-$28 キーオン)、
    // Y8950(音色/周波数、$BD、$B0-$B8 キーオン)。音を出す物(R7、SCC 有効、キーオン)は最後
    audioImage() {
      const out = [];
      const put = (chip, addr, value) => out.push({ chip, addr, value: value & 0xFF, t: 0 });
      const r = this.psg.regs;
      for (let i = 0; i < 14; i++) if (i !== 7) put('psg', i, r[i]);
      put('psg', 7, r[7]);
      if (this.scc) {
        const s = this.scc;
        if (this.sccPlus) {
          put('scc', 0xBFFE, 0x20); put('scc', 0xB000, 0x80); // 配置と窓(読み手の SCC デコーダ用)
          for (let ch = 0; ch < 5; ch++) for (let i = 0; i < 32; i++) put('scc', 0xB800 + ch * 32 + i, s.wave[ch][i]);
          for (let ch = 0; ch < 5; ch++) { put('scc', 0xB8A0 + ch * 2, s.freq[ch]); put('scc', 0xB8A1 + ch * 2, (s.freq[ch] >> 8) & 0x0F); }
          for (let ch = 0; ch < 5; ch++) put('scc', 0xB8AA + ch, s.volume[ch] & 0x0F);
          put('scc', 0xB8AF, s.enable & 0x1F);
        } else {
          put('scc', 0x9000, 0x3F);
          for (let ch = 0; ch < 4; ch++) for (let i = 0; i < 32; i++) put('scc', 0x9800 + ch * 32 + i, s.wave[ch][i]);
          for (let ch = 0; ch < 5; ch++) { put('scc', 0x9880 + ch * 2, s.freq[ch]); put('scc', 0x9881 + ch * 2, (s.freq[ch] >> 8) & 0x0F); }
          for (let ch = 0; ch < 5; ch++) put('scc', 0x988A + ch, s.volume[ch] & 0x0F);
          put('scc', 0x988F, s.enable & 0x1F);
        }
      }
      if (this.opll) {
        const sh = this.opll.regShadow || this.opll.reg || null;
        if (sh) {
          for (let i = 0; i <= 0x07; i++) put('opll', i, sh[i]);
          for (let i = 0; i < 9; i++) put('opll', 0x30 + i, sh[0x30 + i]);
          for (let i = 0; i < 9; i++) put('opll', 0x10 + i, sh[0x10 + i]);
          put('opll', 0x0E, sh[0x0E]);
          for (let i = 0; i < 9; i++) put('opll', 0x20 + i, sh[0x20 + i]);
        }
      }
      if (this.opl) {
        const rg = this.opl.regs;
        put('opl', 0x01, rg[0x01]); put('opl', 0x08, rg[0x08]);
        for (const base of [0x20, 0x40, 0x60, 0x80, 0xE0]) for (let i = 0; i <= 0x15; i++) put('opl', base + i, rg[base + i]);
        for (let i = 0; i < 9; i++) put('opl', 0xC0 + i, rg[0xC0 + i]);
        for (let i = 0; i < 9; i++) put('opl', 0xA0 + i, rg[0xA0 + i]);
        put('opl', 0xBD, rg[0xBD]);
        for (let i = 0; i < 9; i++) put('opl', 0xB0 + i, rg[0xB0 + i]);
      }
      if (this.pcm) put('pcm', 0xA5, this.pcm.status);
      return out;
    }
    startRecording() { this.rec = { frames: [], cur: this.audioImage() }; }
    stopRecording() {
      const rec = this.rec;
      if (!rec) return [];
      this.rec = null;
      if (rec.cur.length) { rec.cur.spf = this.samplesPerFrame; rec.frames.push(rec.cur); }
      return rec.frames;
    }

    // ── 実行 ──
    step() {
      const cpu = this.cpu;
      let cycles;
      if (cpu.iff1 && !cpu.eiPending && this.vdp.intLine()) cycles = cpu.interrupt();
      else cycles = cpu.step();
      this.advance(cycles);
      return cycles;
    }
    advance(cycles) {
      const vdp = this.vdp, psg = this.psg, scc = this.scc, opll = this.opll, opl = this.opl, dac = this.dac, pcm = this.pcm;
      this.cpuCycles += cycles;
      vdp.step(cycles);
      if (this.disk) this.disk.clock(cycles);
      if (vdp.vblankStarted) { vdp.vblankStarted = false; this.frameCount++; this._frameEnd(); }
      const sr = this.sampleRate;
      for (let c = 0; c < cycles; c++) {
        psg.clock();
        if (scc) scc.clock();
        if (opll) opll.clock();
        if (opl) opl.clock();
        if (sr) {
          this.cycleAccum += sr;
          if (this.cycleAccum >= CPU_CLOCK) {
            this.cycleAccum -= CPU_CLOCK;
            if (this.ringLen < AUDIO_RING) {
              let s = psg.mixSample() * PSG_GAIN;
              if (scc) s += scc.mixSample() * SCC_GAIN;
              if (opll) s += opll.mixSample() * OPLL_GAIN;
              if (opl) s += opl.mixSample() * OPL_GAIN;
              if (dac) s += dac.mixSample() * DAC_GAIN;
              if (pcm) s += pcm.mixSample() * DAC_GAIN;
              this.ring[(this.ringHead + this.ringLen) & (AUDIO_RING - 1)] = s;
              this.ringLen++;
            }
          }
        }
      }
    }
    _frameEnd() {
      this._frameFlag = true;
      if (this.joyTurbo[0] || this.joyTurbo[1] || this.turboPhase) { this.turboPhase = (this.turboPhase + 1) % (this.turboRate * 2); this._applyJoy(0); this._applyJoy(1); }
      if (this.rec) { this.rec.cur.spf = this.samplesPerFrame; this.rec.frames.push(this.rec.cur); this.rec.cur = []; }
      if (this.onFrame) this.onFrame();
    }
    runFrame() {
      this._frameFlag = false;
      let guard = 0;
      while (!this._frameFlag) { this.step(); if (++guard > 400000) break; }
      return this.sampleRate ? this.takeAudio(this.ringLen) : null;
    }
    runSamples(out) {
      const n = out.length;
      if (!this.sampleRate) { out.fill(0); return; }
      let guard = 0;
      while (this.ringLen < n && ++guard < 800000) this.step();
      if (this.ringLen < n) this.underruns++;
      this.takeAudioInto(out, n);
    }
    takeAudio(n) { const out = new Float32Array(n); this.takeAudioInto(out, n); return out; }
    takeAudioInto(out, n) {
      const take = Math.min(n, this.ringLen);
      for (let i = 0; i < take; i++) out[i] = this.ring[(this.ringHead + i) & (AUDIO_RING - 1)];
      for (let i = take; i < n; i++) out[i] = 0;
      this.ringHead = (this.ringHead + take) & (AUDIO_RING - 1);
      this.ringLen -= take;
    }

    // 鍵盤表示のミュート/音量(worklet の mix メッセージ)。psg: [3]、scc: [5]、opll: [14]、opl: [15]、dac: [1]
    applyMix(mute, volume) {
      const put = (target, source, conv) => { if (!target || !source) return; for (let i = 0; i < target.length; i++) if (source[i] !== undefined) target[i] = conv(source[i]); };
      const chips = { psg: this.psg, scc: this.scc, opll: this.opll, opl: this.opl, dac: this.dac, pcm: this.pcm };
      for (const k of Object.keys(chips)) {
        const c = chips[k];
        if (!c) continue;
        if (k === 'pcm') { if (mute && mute.dac) put(c.mute, mute.dac, (v) => !!v); if (volume && volume.dac) put(c.vol, volume.dac, (v) => Math.max(0, Math.min(2, +v || 0))); continue; } // turboR PCM は dac(KDA 行)の指定に従う
        if (mute && mute[k]) put(c.mute, mute[k], (v) => !!v);
        if (volume && volume[k] && c.vol) put(c.vol, volume[k], (v) => Math.max(0, Math.min(2, +v || 0)));
      }
    }
    // ステート復元の後(msxState.js): 参照の張り替えだけの物を作り直す
    afterRestore() {
      if (this.cart) { if (this.cart.type === 'plain') this.cart._mapPlain(); else this.cart._remap(); }
      if (this.cartB) { if (this.cartB.type === 'plain') this.cartB._mapPlain(); else this.cartB._remap(); }
      if (this.opl && this.opl._pitchCache) this.opl._pitchCache.clear();
      if (this.s1990) { this.s1990.owner = this; this.s1990._applyCpu(); }
      if (this.pcm) this.pcm.owner = this;
      this._remapAll();
    }
  }
  MsxConsole.CPU_CLOCK = CPU_CLOCK;
  MsxConsole.MACHINES = MACHINES;
  MsxConsole.CART_B_KINDS = CART_B_KINDS;
  MsxConsole.BUTTON = { A: 1, B: 2, UP: 16, DOWN: 32, LEFT: 64, RIGHT: 128 };
  // ファイル名/中身から MSX の物か(ゲーム画面の機種自動判別)
  MsxConsole.isMsxFile = (name, bytes) => (/\.(rom|mx1|mx2)$/i.test(name || '') && !(bytes && bytes.length >= 4 && bytes[0] === 0x4E && bytes[1] === 0x45 && bytes[2] === 0x53 && bytes[3] === 0x1A)) || MsxConsole.isDskFile(name, bytes);
  MsxConsole.isDskFile = (name, bytes) => /\.dsk$/i.test(name || '') && !!(bytes && Emu.MsxDiskImage && Emu.MsxDiskImage.isDsk(bytes));
  Emu.MsxConsole = MsxConsole;
})(typeof window !== 'undefined' ? window : globalThis);
