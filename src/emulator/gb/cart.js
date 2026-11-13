/*
 * ゲームボーイのカートリッジ(ヘッダ解析と MBC)
 * MML.Emu.GbCart
 *
 * 段階 8a: ROM のみ / MBC1 / MBC2 / MBC3(時計) / MBC5(振動ビット)。
 * MBC6 / MBC7 / MMM01 / HuC1 / HuC3 / カメラ、MBC1 の多本入り判別は段階 8e(DESIGN-GB-CAPTURE.md §9)。
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
  };

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
      ramSize: info && info.mbc === 'mbc2' ? 0x200 : (RAM_SIZES[rom[0x149]] || 0),
      checksumOk: headerChecksum(rom) === rom[0x14D],
    };
  }

  class GbCart {
    constructor(bytes) {
      if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
      // バンク境界(16K)へ切り上げて持つ(端数のある吸い出しでも範囲外を読まない)
      const size = Math.max(0x8000, Math.ceil(bytes.length / 0x4000) * 0x4000);
      this.rom = new Uint8Array(size).fill(0xFF); this.rom.set(bytes);
      this.header = parseHeader(this.rom);
      const info = this.header.info;
      this.unsupported = !info;                 // 未対応の種別は ROM のみとして動かす(起動画面くらいは出る)
      this.mbc = info ? info.mbc : 'rom';
      this.hasBattery = !!(info && info.battery);
      this.hasRtc = !!(info && info.rtc);
      this.hasRumble = !!(info && info.rumble);
      this.romMask = (this.rom.length >> 14) - 1; // バンク数は 2 のべき(違う吸い出しは下の % で畳む)
      this.romBanks = this.rom.length >> 14;
      // MBC1 の多本入り(1MB で、$40000 のバンクにもロゴがある): BANK2 が 4bit 上にずれ、BANK1 は下位 4bit だけ効く
      this.multicart = this.mbc === 'mbc1' && this.rom.length === 0x100000 && [0x104, 0x105, 0x106, 0x107].every(a => this.rom[0x40000 + a] === this.rom[a]) && this.rom[0x104] === 0xCE;
      this.ram = new Uint8Array(this.header.ramSize || (info && info.ram ? 0x2000 : 0));
      this.dirty = false;     // セーブ RAM/時計に書いた(本体が batteryDirty として見る)
      this.rumble = false;    // 振動モータ(MBC5 の RAM バンクレジスタ bit3)
      this.reset();
    }

    reset() {
      this.ramEnable = false;
      this.bank1 = 1; this.bank2 = 0; this.mode = 0; // MBC1
      this.romBank = 1; this.ramBank = 0;            // MBC2/3/5
      this.rtcSel = -1; this.rtcLatchPrev = 1;
      if (!this.rtc) this.rtc = { s: 0, m: 0, h: 0, dl: 0, dh: 0, latched: new Uint8Array(5), sub: 0 };
      this._map();
    }

    _map() {
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

    read(addr) { return addr < 0x4000 ? this.rom[this.lo + addr] : this.rom[this.hi + (addr & 0x3FFF)]; }

    write(addr, v) {
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
      if (!this.ramEnable) return 0xFF;
      if (this.mbc === 'mbc3' && this.rtcSel >= 0) return this.hasRtc ? this.rtc.latched[this.rtcSel] : 0xFF;
      if (!this.ram.length) return 0xFF;
      if (this.mbc === 'mbc2') return this.ram[addr & 0x1FF] | 0xF0; // 4bit RAM。上位は 1
      return this.ram[(this.ramOff + (addr & 0x1FFF)) % this.ram.length];
    }

    writeRam(addr, v) {
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

    // 時計を t T ぶん進める(本体が 1 フレームごとに呼ぶ)。エミュレータ内の時間で進む
    // (実時刻との同期=電源を切っていた間の経過は段階 8e で battery に時刻を控えて足す)
    tickRtc(t, clockHz) {
      if (!this.hasRtc) return;
      const r = this.rtc;
      if (r.dh & 0x40) return; // 停止ビット
      r.sub += t;
      while (r.sub >= clockHz) {
        r.sub -= clockHz;
        r.s = (r.s + 1) & 0x3F;
        if (r.s !== 60) continue; // 60 以上を書かれた時は 63→0 で桁上がりしない(実機の癖)
        r.s = 0; r.m = (r.m + 1) & 0x3F; if (r.m !== 60) continue;
        r.m = 0; r.h = (r.h + 1) & 0x1F; if (r.h !== 24) continue;
        r.h = 0; r.dl = (r.dl + 1) & 0xFF; if (r.dl !== 0) continue;
        if (r.dh & 1) r.dh = (r.dh & 0xFE) | 0x80; else r.dh |= 1; // 512 日であふれフラグ
      }
    }

    // セーブ: RAM の後ろに時計 8 バイト(s m h dl dh + 予約 3)。段階 8e で実時刻を足す
    getBattery() {
      if (!this.hasBattery) return null;
      const out = new Uint8Array(this.ram.length + (this.hasRtc ? 8 : 0));
      out.set(this.ram);
      if (this.hasRtc) { const r = this.rtc, o = this.ram.length; out[o] = r.s; out[o + 1] = r.m; out[o + 2] = r.h; out[o + 3] = r.dl; out[o + 4] = r.dh; }
      return out;
    }
    setBattery(bytes) {
      if (!this.hasBattery || !bytes || bytes.length < this.ram.length) return false;
      this.ram.set(bytes.subarray(0, this.ram.length));
      if (this.hasRtc && bytes.length >= this.ram.length + 5) { const r = this.rtc, o = this.ram.length; r.s = bytes[o]; r.m = bytes[o + 1]; r.h = bytes[o + 2]; r.dl = bytes[o + 3]; r.dh = bytes[o + 4]; }
      this.dirty = false;
      return true;
    }
  }

  GbCart.isGb = isGb;
  GbCart.parseHeader = parseHeader;
  GbCart.headerChecksum = headerChecksum;
  Emu.GbCart = GbCart;
})(typeof window !== 'undefined' ? window : globalThis);
