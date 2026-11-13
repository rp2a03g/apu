/*
 * ゲームボーイのカートリッジ(ヘッダ解析と MBC)
 * MML.Emu.GbCart
 *
 * ROM のみ / MBC1(多本入り含む) / MBC2 / MBC3(時計) / MBC5(振動) / MBC7(傾き+EEPROM) / HuC1(赤外線)。
 * MBC6 / MMM01 / HuC3 / ポケットカメラは gb/cartMore.js(下の EXTRA の差し込み口に登録する。このファイルの後に読む)。
 *
 * 時計(MBC3): 動いている間はエミュレータ内の時間で進む(巻き戻し/ステートと食い違わない)。セーブには実時刻も控え、
 *   次に読み込んだ時に「電源を切っていた間」の分を進める。
 * MBC7: $A000 台はレジスタ(加速度の取り込みと値、EEPROM 93LC56 の 4 本の線)。傾きは tiltX/tiltY(−1〜+1、右/下が正、1 = 重力 1 個ぶん)。
 * HuC1: $0000 台に $0E で $A000 台が赤外線レジスタになる(読むと $C0 = 光なし / $C1 = 光あり。irIn を本体が入れる)。
 *
 * 本体(gbConsole.js)からは read(addr)/write(addr,v)($0000-$7FFF)と readRam(addr)/writeRam(addr,v)($A000-$BFFF)で触る。
 * 参考: Pan Docs "The Cartridge Header" "MBCs"
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const RAM_SIZES = { 0: 0, 1: 0x800, 2: 0x2000, 3: 0x8000, 4: 0x20000, 5: 0x10000 };
  // ヘッダ $0147 → { mbc, ram, battery, rtc, rumble }
  const TYPES = {
    0x00: { mbc: 'rom' }, 0x08: { mbc: 'rom', ram: 1 }, 0x09: { mbc: 'rom', ram: 1, battery: 1 },
    0x01: { mbc: 'mbc1' }, 0x02: { mbc: 'mbc1', ram: 1 }, 0x03: { mbc: 'mbc1', ram: 1, battery: 1 },
    0x05: { mbc: 'mbc2' }, 0x06: { mbc: 'mbc2', battery: 1 },
    0x0F: { mbc: 'mbc3', battery: 1, rtc: 1 }, 0x10: { mbc: 'mbc3', ram: 1, battery: 1, rtc: 1 },
    0x11: { mbc: 'mbc3' }, 0x12: { mbc: 'mbc3', ram: 1 }, 0x13: { mbc: 'mbc3', ram: 1, battery: 1 },
    0x19: { mbc: 'mbc5' }, 0x1A: { mbc: 'mbc5', ram: 1 }, 0x1B: { mbc: 'mbc5', ram: 1, battery: 1 },
    0x1C: { mbc: 'mbc5', rumble: 1 }, 0x1D: { mbc: 'mbc5', ram: 1, rumble: 1 }, 0x1E: { mbc: 'mbc5', ram: 1, battery: 1, rumble: 1 },
    0x22: { mbc: 'mbc7', battery: 1, tilt: 1 },
    0xFF: { mbc: 'huc1', ram: 1, battery: 1, ir: 1 },
  };

  // 追加の基板(gb/cartMore.js が登録する)。EXTRA[mbc] = { detect?, init?, reset?, map?, read?, write?, readRam?, writeRam?, tick?, getBattery?, setBattery? }
  const EXTRA = {};

  // ヘッダのチェックサム($0134-$014C)。実機のブート ROM が確かめるのと同じ式
  function headerChecksum(rom) {
    let x = 0;
    for (let a = 0x134; a <= 0x14C; a++) x = (x - rom[a] - 1) & 0xFF;
    return x;
  }
  function isGb(bytes) {
    return !!bytes && bytes.length >= 0x150 && headerChecksum(bytes) === bytes[0x14D] &&
      bytes[0x104] === 0xCE && bytes[0x105] === 0xED; // 任天堂ロゴの先頭 2 バイト(ロゴ全体は持たない)
  }

  function parseHeader(rom) {
    const cgbFlag = rom[0x143];
    let title = '';
    for (let a = 0x134; a < (cgbFlag & 0x80 ? 0x13F : 0x144); a++) { const c = rom[a]; if (!c) break; title += c >= 0x20 && c < 0x7F ? String.fromCharCode(c) : '?'; }
    const type = rom[0x147];
    const info = TYPES[type] || null;
    return {
      title: title.trim(), type, info,
      cgb: (cgbFlag & 0x80) !== 0, cgbOnly: (cgbFlag & 0xC0) === 0xC0,
      sgb: rom[0x146] === 0x03 && rom[0x14B] === 0x33,
      romBanks: Math.max(2, rom.length >> 14),
      ramSize: info && info.mbc === 'mbc2' ? 0x200 : info && info.mbc === 'mbc7' ? 0x100 : (RAM_SIZES[rom[0x149]] || 0), // MBC7 は EEPROM 256 バイト
      checksumOk: headerChecksum(rom) === rom[0x14D],
    };
  }

  class GbCart {
    constructor(bytes) {
      if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
      // バンク境界(16K)へ切り上げて持つ(端数のある吸い出しでも範囲外を読まない)
      const size = Math.max(0x8000, Math.ceil(bytes.length / 0x4000) * 0x4000);
      this.rom = new Uint8Array(size).fill(0xFF); this.rom.set(bytes);
      // 中身で決まる基板(MMM01 はメニューが ROM の最後の 32K にあり、ヘッダもそこ)
      for (const k of Object.keys(EXTRA)) if (EXTRA[k].detect) { const r = EXTRA[k].detect(this.rom); if (r) { this.rom = r.rom; this.headerAt = r.headerAt; break; } }
      this.header = parseHeader(this.headerAt ? this.rom.subarray(this.headerAt) : this.rom);
      if (this.headerAt) this.header.romBanks = this.rom.length >> 14;
      const info = this.header.info;
      this.unsupported = !info;                 // 未対応の種別は ROM のみとして動かす(起動画面くらいは出る)
      this.mbc = info ? info.mbc : 'rom';
      this.hasBattery = !!(info && info.battery);
      this.hasRtc = !!(info && info.rtc);
      this.hasRumble = !!(info && info.rumble);
      this.hasTilt = !!(info && info.tilt);
      this.hasIr = !!(info && info.ir);
      this.tiltX = 0; this.tiltY = 0; // 傾き(本体が入れる)
      this.irIn = false; this.irOut = false; // 赤外線: 受光している/発光している
      this.romMask = (this.rom.length >> 14) - 1; // バンク数は 2 のべき(違う吸い出しは下の % で畳む)
      this.romBanks = this.rom.length >> 14;
      // MBC1 の多本入り(1MB で、$40000 のバンクにもロゴがある): BANK2 が 4bit 上にずれ、BANK1 は下位 4bit だけ効く
      this.multicart = this.mbc === 'mbc1' && this.rom.length === 0x100000 && [0x104, 0x105, 0x106, 0x107].every(a => this.rom[0x40000 + a] === this.rom[a]) && this.rom[0x104] === 0xCE;
      this.x = EXTRA[this.mbc] || null;
      this.ram = new Uint8Array((this.x && this.x.ramSize) || this.header.ramSize || (info && info.ram ? 0x2000 : 0));
      this.hasBuzzer = !!(info && info.buzzer); this.hasCamera = !!(info && info.camera);
      this.buzzQueue = [];    // 鳴らしたブザーの音番号(本体が takeBuzz で取る)
      if (this.x && this.x.init) this.x.init(this);
      if (this.mbc === 'mbc7') this.ram.fill(0xFF); // 新品の EEPROM は全ビット 1
      this.dirty = false;     // セーブ RAM/時計に書いた(本体が batteryDirty として見る)
      this.rumble = false;    // 振動モータ(MBC5 の RAM バンクレジスタ bit3)
      this.reset();
    }

    reset() {
      this.ramEnable = false;
      this.bank1 = 1; this.bank2 = 0; this.mode = 0; // MBC1
      this.romBank = 1; this.ramBank = 0;            // MBC2/3/5
      this.rtcSel = -1; this.rtcLatchPrev = 1;
      this.irMode = false;                           // HuC1
      this.ramEnable2 = false; this.accX = 0x8000; this.accY = 0x8000; this.accErased = false; // MBC7
      this.ee = { cs: 0, clk: 0, di: 0, dout: 1, bits: 0, n: 0, state: 0, addr: 0, data: 0, left: 0, wen: false };
      if (!this.rtc) this.rtc = { s: 0, m: 0, h: 0, dl: 0, dh: 0, latched: new Uint8Array(5), sub: 0 };
      if (this.x && this.x.reset) this.x.reset(this);
      this._map();
    }

    _map() {
      if (this.x && this.x.map) { this.x.map(this); return; }
      const n = this.romBanks;
      if (this.mbc === 'mbc1') {
        const sh = this.multicart ? 4 : 5, b1 = this.multicart ? this.bank1 & 0x0F : this.bank1;
        this.lo = (this.mode ? (this.bank2 << sh) % n : 0) << 14;
        this.hi = (((this.bank2 << sh) | b1) % n) << 14;
        this.ramOff = this.ram.length > 0x2000 && this.mode ? (this.bank2 << 13) % this.ram.length : 0;
      } else {
        this.lo = 0;
        this.hi = (this.romBank % n) << 14;
        this.ramOff = this.ram.length > 0x2000 ? (this.ramBank << 13) % this.ram.length : 0;
      }
    }

    read(addr) {
      if (this.x && this.x.read) return this.x.read(this, addr);
      return addr < 0x4000 ? this.rom[this.lo + addr] : this.rom[this.hi + (addr & 0x3FFF)];
    }
    takeBuzz() { return this.buzzQueue.length ? this.buzzQueue.splice(0) : null; }

    write(addr, v) {
      if (this.x && this.x.write) { this.x.write(this, addr, v); this._map(); return; }
      switch (this.mbc) {
        case 'mbc1':
          if (addr < 0x2000) this.ramEnable = (v & 0x0F) === 0x0A;
          else if (addr < 0x4000) { this.bank1 = v & 0x1F; if (!this.bank1) this.bank1 = 1; }
          else if (addr < 0x6000) this.bank2 = v & 3;
          else this.mode = v & 1;
          break;
        case 'mbc2': // $0000-$3FFF: 番地の bit8 が 0 なら RAM 許可、1 なら ROM バンク
          if (addr < 0x4000) { if (addr & 0x100) { this.romBank = v & 0x0F; if (!this.romBank) this.romBank = 1; } else this.ramEnable = (v & 0x0F) === 0x0A; }
          break;
        case 'mbc3':
          if (addr < 0x2000) this.ramEnable = (v & 0x0F) === 0x0A;
          else if (addr < 0x4000) { this.romBank = v & 0x7F; if (!this.romBank) this.romBank = 1; }
          else if (addr < 0x6000) { if (v >= 0x08 && v <= 0x0C) this.rtcSel = v - 8; else { this.rtcSel = -1; this.ramBank = v & 3; } }
          else { // 0 → 1 で時計を控える
            if (this.rtcLatchPrev === 0 && (v & 1) === 1) { const r = this.rtc; r.latched[0] = r.s; r.latched[1] = r.m; r.latched[2] = r.h; r.latched[3] = r.dl; r.latched[4] = r.dh; }
            this.rtcLatchPrev = v & 1;
          }
          break;
        case 'huc1': // RAM は常に使える。$0E で赤外線レジスタへ切り替え
          if (addr < 0x2000) this.irMode = (v & 0x0F) === 0x0E;
          else if (addr < 0x4000) { this.romBank = v & 0x3F; if (!this.romBank) this.romBank = 1; }
          else if (addr < 0x6000) this.ramBank = v & 3;
          break;
        case 'mbc7': // RAM(レジスタ)の許可は 2 か所とも要る
          if (addr < 0x2000) this.ramEnable = (v & 0x0F) === 0x0A;
          else if (addr < 0x4000) this.romBank = v & 0x7F;
          else if (addr < 0x6000) this.ramEnable2 = v === 0x40;
          break;
        case 'mbc5':
          if (addr < 0x2000) this.ramEnable = (v & 0x0F) === 0x0A;
          else if (addr < 0x3000) this.romBank = (this.romBank & 0x100) | v;
          else if (addr < 0x4000) this.romBank = (this.romBank & 0xFF) | ((v & 1) << 8);
          else if (addr < 0x6000) { if (this.hasRumble) { this.rumble = (v & 8) !== 0; this.ramBank = v & 7; } else this.ramBank = v & 0x0F; }
          break;
      }
      this._map();
    }

    readRam(addr) {
      if (this.x && this.x.readRam) return this.x.readRam(this, addr);
      if (this.mbc === 'huc1') return this.irMode ? (this.irIn ? 0xC1 : 0xC0) : (this.ram.length ? this.ram[(this.ramOff + (addr & 0x1FFF)) % this.ram.length] : 0xFF);
      if (this.mbc === 'mbc7') return this._mbc7Read(addr);
      if (!this.ramEnable) return 0xFF;
      if (this.mbc === 'mbc3' && this.rtcSel >= 0) return this.hasRtc ? this.rtc.latched[this.rtcSel] : 0xFF;
      if (!this.ram.length) return 0xFF;
      if (this.mbc === 'mbc2') return this.ram[addr & 0x1FF] | 0xF0; // 4bit RAM。上位は 1
      return this.ram[(this.ramOff + (addr & 0x1FFF)) % this.ram.length];
    }

    writeRam(addr, v) {
      if (this.x && this.x.writeRam) { this.x.writeRam(this, addr, v); return; }
      if (this.mbc === 'huc1') {
        if (this.irMode) this.irOut = (v & 1) !== 0;
        else if (this.ram.length) { this.ram[(this.ramOff + (addr & 0x1FFF)) % this.ram.length] = v; this.dirty = true; }
        return;
      }
      if (this.mbc === 'mbc7') { this._mbc7Write(addr, v); return; }
      if (!this.ramEnable) return;
      if (this.mbc === 'mbc3' && this.rtcSel >= 0) {
        if (!this.hasRtc) return;
        const r = this.rtc;
        switch (this.rtcSel) {
          case 0: r.s = v & 0x3F; r.sub = 0; break;
          case 1: r.m = v & 0x3F; break;
          case 2: r.h = v & 0x1F; break;
          case 3: r.dl = v; break;
          case 4: r.dh = v & 0xC1; break;
        }
        this.dirty = true;
        return;
      }
      if (!this.ram.length) return;
      if (this.mbc === 'mbc2') this.ram[addr & 0x1FF] = v & 0x0F;
      else this.ram[(this.ramOff + (addr & 0x1FFF)) % this.ram.length] = v;
      this.dirty = true;
    }

    // ── MBC7 ──
    _mbc7Read(addr) {
      if (!this.ramEnable || !this.ramEnable2 || addr >= 0xB000) return 0xFF;
      switch ((addr >> 4) & 0x0F) {
        case 2: return this.accX & 0xFF;
        case 3: return this.accX >> 8;
        case 4: return this.accY & 0xFF;
        case 5: return this.accY >> 8;
        case 6: return 0x00;
        case 8: { const e = this.ee; return (e.dout ? 1 : 0) | (e.di ? 2 : 0) | (e.clk ? 0x40 : 0) | (e.cs ? 0x80 : 0); }
      }
      return 0xFF;
    }
    _mbc7Write(addr, v) {
      if (!this.ramEnable || !this.ramEnable2 || addr >= 0xB000) return;
      switch ((addr >> 4) & 0x0F) {
        case 0: if (v === 0x55) { this.accErased = true; this.accX = 0x8000; this.accY = 0x8000; } break;
        case 1: // $55 で消した後の $AA でだけ取り込む。中心 $81D0、重力 1 個で約 $70。X は右へ傾けると小さく、Y は下へ傾けると小さく
          if (v === 0xAA && this.accErased) {
            this.accErased = false;
            const cl = (t) => Math.max(-2, Math.min(2, +t || 0));
            this.accX = (0x81D0 - Math.round(cl(this.tiltX) * 0x70)) & 0xFFFF;
            this.accY = (0x81D0 - Math.round(cl(this.tiltY) * 0x70)) & 0xFFFF;
          }
          break;
        case 8: this._eeWrite(v); break;
      }
    }
    // EEPROM 93LC56(16bit × 128 語。語 n の上位バイトが ram[n*2]、下位が ram[n*2+1])。bit7=CS、bit6=CLK、bit1=DI、読み出しの bit0=DO。
    // CLK の立ち上がりで DI を 1 ビット取り込む。開始ビット 1 の後に 10 ビット(命令 2+番地 8)。命令: 10=READ、01=WRITE、11=ERASE、
    // 00 は番地の上位 2 ビットで 11=EWEN、00=EWDS、10=ERAL、01=WRAL。書き込み系は EWEN の後だけ効く
    _eeWrite(v) {
      const e = this.ee, cs = (v >> 7) & 1, clk = (v >> 6) & 1, di = (v >> 1) & 1;
      const rise = cs && clk && !e.clk;
      if (!cs) { e.state = 0; e.n = 0; e.bits = 0; e.dout = 1; }
      e.cs = cs; e.clk = clk; e.di = di;
      if (!rise) return;
      const ram = this.ram;
      switch (e.state) {
        case 0: if (di) { e.state = 1; e.bits = 0; e.n = 0; } break;          // 開始ビット待ち
        case 1:                                                               // 命令+番地の 10 ビット
          e.bits = (e.bits << 1) | di;
          if (++e.n < 10) break;
          { const op = (e.bits >> 8) & 3, a = e.bits & 0x7F, sub = (e.bits >> 6) & 3;
            e.addr = a; e.n = 0; e.data = 0;
            if (op === 2) { e.data = (ram[a * 2] << 8) | ram[a * 2 + 1]; e.left = 16; e.state = 2; e.dout = 0; }
            else if (op === 1) { e.state = 3; e.left = 16; e.wral = false; }
            else if (op === 3) { if (e.wen) { ram[a * 2] = 0xFF; ram[a * 2 + 1] = 0xFF; this.dirty = true; } e.state = 4; e.dout = 1; }
            else if (sub === 3) { e.wen = true; e.state = 4; }
            else if (sub === 0) { e.wen = false; e.state = 4; }
            else if (sub === 2) { if (e.wen) { ram.fill(0xFF); this.dirty = true; } e.state = 4; e.dout = 1; }
            else { e.state = 3; e.left = 16; e.wral = true; } }
          break;
        case 2:                                                               // READ: 上位ビットから 16 ビット出す
          e.dout = (e.data >> 15) & 1; e.data = (e.data << 1) & 0xFFFF;
          if (--e.left === 0) e.state = 4;
          break;
        case 3:                                                               // WRITE / WRAL: 16 ビット受ける
          e.data = ((e.data << 1) | di) & 0xFFFF;
          if (--e.left === 0) {
            if (e.wen) {
              if (e.wral) for (let i = 0; i < ram.length; i += 2) { ram[i] = e.data >> 8; ram[i + 1] = e.data & 0xFF; }
              else { ram[e.addr * 2] = e.data >> 8; ram[e.addr * 2 + 1] = e.data & 0xFF; }
              this.dirty = true;
            }
            e.state = 4; e.dout = 1; // 書き終わり(RDY)
          }
          break;
        default: break;                                                       // 命令の終わり: CS が下がるまで何もしない
      }
    }

    // 時計を t T ぶん進める(本体が 1 フレームごとに呼ぶ)。エミュレータ内の時間で進む
    tickRtc(t, clockHz) {
      if (this.x && this.x.tick) this.x.tick(this, t, clockHz);
      if (!this.hasRtc) return;
      const r = this.rtc;
      if (r.dh & 0x40) return; // 停止ビット
      r.sub += t;
      while (r.sub >= clockHz) {
        r.sub -= clockHz;
        this.dirty = true; // 時計が進んだ(セーブに実時刻を控え直す)
        r.s = (r.s + 1) & 0x3F;
        if (r.s !== 60) continue; // 60 以上を書かれた時は 63→0 で桁上がりしない(実機の癖)
        r.s = 0; r.m = (r.m + 1) & 0x3F; if (r.m !== 60) continue;
        r.m = 0; r.h = (r.h + 1) & 0x1F; if (r.h !== 24) continue;
        r.h = 0; r.dl = (r.dl + 1) & 0xFF; if (r.dl !== 0) continue;
        if (r.dh & 1) r.dh = (r.dh & 0xFE) | 0x80; else r.dh |= 1; // 512 日であふれフラグ
      }
    }

    // 時計を秒数ぶんまとめて進める(電源を切っていた間の分)
    advanceRtc(seconds) {
      const r = this.rtc;
      if (!this.hasRtc || (r.dh & 0x40) || !(seconds > 0)) return;
      let total = Math.floor(seconds) + (r.s % 60) + (r.m % 60) * 60 + (r.h % 24) * 3600 + (r.dl | ((r.dh & 1) << 8)) * 86400;
      r.s = total % 60; total = Math.floor(total / 60);
      r.m = total % 60; total = Math.floor(total / 60);
      r.h = total % 24; total = Math.floor(total / 24);
      if (total > 511) { r.dh |= 0x80; total %= 512; }
      r.dl = total & 0xFF; r.dh = (r.dh & 0xFE) | ((total >> 8) & 1);
    }
    // セーブ: RAM の後ろに時計 16 バイト(s m h dl dh、予約 3、控えた時の実時刻 = 1970 年からのミリ秒を倍精度 8 バイト)
    getBattery() {
      if (!this.hasBattery) return null;
      if (this.x && this.x.getBattery) return this.x.getBattery(this);
      const out = new Uint8Array(this.ram.length + (this.hasRtc ? 16 : 0));
      out.set(this.ram);
      if (this.hasRtc) {
        const r = this.rtc, o = this.ram.length; out[o] = r.s; out[o + 1] = r.m; out[o + 2] = r.h; out[o + 3] = r.dl; out[o + 4] = r.dh;
        new DataView(out.buffer).setFloat64(o + 8, GbCart.now(), true);
      }
      return out;
    }
    setBattery(bytes) {
      if (this.hasBattery && bytes && this.x && this.x.setBattery) { const ok = this.x.setBattery(this, bytes); if (ok) this.dirty = false; return ok; }
      if (!this.hasBattery || !bytes || bytes.length < this.ram.length) return false;
      this.ram.set(bytes.subarray(0, this.ram.length));
      if (this.hasRtc && bytes.length >= this.ram.length + 5) {
        const r = this.rtc, o = this.ram.length; r.s = bytes[o]; r.m = bytes[o + 1]; r.h = bytes[o + 2]; r.dl = bytes[o + 3]; r.dh = bytes[o + 4];
        if (bytes.length >= o + 16) { // 電源を切っていた間の分を進める
          const saved = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(o + 8, true);
          if (saved > 0 && isFinite(saved)) this.advanceRtc((GbCart.now() - saved) / 1000);
        }
      }
      this.dirty = false;
      return true;
    }
  }

  GbCart.now = () => Date.now(); // 実時刻(試験で差し替える)
  GbCart.EXTRA = EXTRA;
  GbCart.TYPES = TYPES;
  GbCart.isGb = isGb;
  GbCart.parseHeader = parseHeader;
  GbCart.headerChecksum = headerChecksum;
  Emu.GbCart = GbCart;
})(typeof window !== 'undefined' ? window : globalThis);
