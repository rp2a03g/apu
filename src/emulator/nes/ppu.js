/*
 * 2C02 PPU (MML.Emu.PPU) — 自前 NES エミュレータ(DESIGN-CAPTURE.md §7)
 *
 * ドット単位で動く(1 CPU サイクル = 3 ドット、1 行 341 ドット、262 行)。「遊べる」に要る物を実装する:
 *   背景(loopy の v/t/x/w、2 本の 16bit シフトレジスタ)、スプライト(8×8 / 8×16、優先順位、行 8 枚、
 *   溢れフラグ)、スプライト 0 ヒット、NMI(241 行目 1 ドット目)、奇数フレームのドット飛ばし、
 *   $2007 の読み出しバッファ、パレット RAM のミラー、グレースケール、左 8 ドットのクリップ。
 * パターン表の読み出しと NT/属性の読み出しはマッパーの ppuA12(addr, time) にも流す(MMC3 の IRQ カウンタ。NT 読みは A12 が低い印)。
 * 空スロットのスプライト取得も実機どおり行う(スプライトを $1000 に置く曲で A12 が毎行上がるのは
 * これのため。行に 1 枚もスプライトが無くても MMC3 のカウンタは進む)。
 *
 * やらない物: 色強調(ビット 5-7。色は無視)、$2007 のレンダリング中の奇妙な増分、スプライト評価の
 * 溢れバグ(9 枚目以降は正しく数えるだけ)、読み出しの open bus の減衰。
 *
 * 出力: frame(Uint32Array 256×240、canvas の ImageData にそのまま流せる ABGR = リトルエンディアンの RGBA)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // 2C02 の標準パレット(nesdev wiki の表)
  const PALETTE_RGB = [
    84,84,84, 0,30,116, 8,16,144, 48,0,136, 68,0,100, 92,0,48, 84,4,0, 60,24,0, 32,42,0, 8,58,0, 0,64,0, 0,60,0, 0,50,60, 0,0,0, 0,0,0, 0,0,0,
    152,150,152, 8,76,196, 48,50,236, 92,30,228, 136,20,176, 160,20,100, 152,34,32, 120,60,0, 84,90,0, 40,114,0, 8,124,0, 0,118,40, 0,102,120, 0,0,0, 0,0,0, 0,0,0,
    236,238,236, 76,154,236, 120,124,236, 176,98,236, 228,84,236, 236,88,180, 236,106,100, 212,136,32, 160,170,0, 116,196,0, 76,208,32, 56,204,108, 56,180,204, 60,60,60, 0,0,0, 0,0,0,
    236,238,236, 168,204,236, 188,188,236, 212,178,236, 236,174,236, 236,174,212, 236,180,176, 228,196,144, 204,210,120, 180,222,120, 168,226,144, 152,226,180, 160,214,228, 160,162,160, 0,0,0, 0,0,0,
  ];
  const PALETTE = new Uint32Array(64);
  for (let i = 0; i < 64; i++) PALETTE[i] = (0xFF << 24 | PALETTE_RGB[i * 3 + 2] << 16 | PALETTE_RGB[i * 3 + 1] << 8 | PALETTE_RGB[i * 3]) >>> 0;

  const DOTS_PER_LINE = 341, LINES = 262;

  class PPU {
    constructor(mapper) {
      this.mapper = mapper;
      mapper.ppu = this; // MMC5 が描画の位相(ドット・行・$2000/$2001)を見る
      this.palette = new Uint8Array(32);
      this.oam = new Uint8Array(256);
      this.frame = new Uint32Array(256 * 240);
      this.frameIdx = new Uint8Array(256 * 240); // 同じ画面のパレット番号(6bit)。巻き戻しの映像の輪(nesRewind.js)が 8bit で控える
      // 次の行のスプライト(評価済み)と、今の行のスプライト(取得済み)
      this.evalY = new Uint8Array(8); this.evalTile = new Uint8Array(8); this.evalAttr = new Uint8Array(8); this.evalX = new Uint8Array(8);
      this.evalCount = 0; this.evalHasZero = false;
      this.sprX = new Uint8Array(8); this.sprAttr = new Uint8Array(8); this.sprLo = new Uint8Array(8); this.sprHi = new Uint8Array(8);
      this.sprCount = 0; this.sprHasZero = false;
      this.reset();
    }

    reset() {
      this.ctrl = 0; this.mask = 0; this.status = 0; this.oamAddr = 0;
      this.v = 0; this.t = 0; this.x = 0; this.w = 0; this.readBuf = 0; this.openBus = 0;
      this.scanline = 261; this.dot = 0; this.odd = false; this.frameCount = 0; this.frameDone = false;
      this.time = 0; // マッパーの A12 フィルタ用の単調なドット時刻
      this.nmiOccurred = false; this.nmiOutput = false;
      this.vblankStarted = false; // 241 行目 1 ドット目で立つ(本体がフレームの区切り=録音/画面送出の時刻に使う)
      this.ntByte = 0; this.atByte = 0; this.ptLo = 0; this.ptHi = 0;
      this.bgLo = 0; this.bgHi = 0; this.atLo = 0; this.atHi = 0;
      this.sprCount = 0; this.evalCount = 0;
      this.frame.fill(PALETTE[0x0F]);
    }

    // ── VRAM(パレット以外はマッパー) ──
    paletteIndex(addr) { addr &= 0x1F; if ((addr & 0x13) === 0x10) addr &= ~0x10; return addr; }
    vramRead(addr) {
      addr &= 0x3FFF;
      if (addr >= 0x3F00) return this.palette[this.paletteIndex(addr)];
      return this.mapper.ppuRead(addr);
    }
    vramWrite(addr, v) {
      addr &= 0x3FFF;
      if (addr >= 0x3F00) this.palette[this.paletteIndex(addr)] = v & 0x3F;
      else this.mapper.ppuWrite(addr, v);
    }
    // レンダリングのパターン表読み(A12 をマッパーへ)
    fetchPattern(addr) {
      this.mapper.ppuA12(addr, this.time);
      return this.mapper.ppuRead(addr & 0x1FFF);
    }
    // レンダリングの NT/属性読み(A12 が低い読みとしてマッパーへ。MMC3 は「低い読みが続いた後の高い読み」で数える)
    fetchNt(addr) {
      this.mapper.ppuA12(addr, this.time);
      return this.mapper.ppuRead(addr);
    }

    // ── CPU からのレジスタ ──
    readReg(reg) {
      switch (reg & 7) {
        case 2: {
          const v = (this.status & 0xE0) | (this.openBus & 0x1F);
          this.status &= ~0x80; this.nmiOccurred = false; this.w = 0;
          this.openBus = v;
          return v;
        }
        case 4: return this.openBus = this.oam[this.oamAddr];
        case 7: {
          const addr = this.v & 0x3FFF;
          let out;
          if (addr >= 0x3F00) { out = this.palette[this.paletteIndex(addr)]; this.readBuf = this.mapper.ppuRead(addr & 0x2FFF); }
          else { out = this.readBuf; this.readBuf = this.mapper.ppuRead(addr); }
          this.v = (this.v + ((this.ctrl & 0x04) ? 32 : 1)) & 0x7FFF;
          this.mapper.ppuA12(this.v & 0x3FFF, this.time); // CPU 側の VRAM アクセスも A12 を動かす(MMC3 の IRQ カウンタ。Mesen と同じく増やした後の番地)
          return this.openBus = out;
        }
        default: return this.openBus;
      }
    }
    writeReg(reg, v) {
      v &= 0xFF;
      this.openBus = v;
      switch (reg & 7) {
        case 0:
          this.ctrl = v;
          this.t = (this.t & ~0x0C00) | ((v & 3) << 10);
          this.nmiOutput = (v & 0x80) !== 0;
          break;
        case 1: this.mask = v; break;
        case 3: this.oamAddr = v; break;
        case 4: this.oam[this.oamAddr] = v; this.oamAddr = (this.oamAddr + 1) & 0xFF; break;
        case 5:
          if (this.w === 0) { this.t = (this.t & ~0x001F) | (v >> 3); this.x = v & 7; this.w = 1; }
          else { this.t = (this.t & ~0x73E0) | ((v & 7) << 12) | ((v >> 3) << 5); this.w = 0; }
          break;
        case 6:
          if (this.w === 0) { this.t = (this.t & 0x00FF) | ((v & 0x3F) << 8); this.w = 1; }
          else { this.t = (this.t & 0x7F00) | v; this.v = this.t; this.w = 0; this.mapper.ppuA12(this.v & 0x3FFF, this.time); } // 2 回目の書きで v が出る(A12 をマッパーへ)
          break;
        case 7:
          this.vramWrite(this.v, v);
          this.v = (this.v + ((this.ctrl & 0x04) ? 32 : 1)) & 0x7FFF;
          this.mapper.ppuA12(this.v & 0x3FFF, this.time);
          break;
      }
    }
    // $4014 OAM DMA(本体がページを写す)
    dmaWrite(i, v) { this.oam[(this.oamAddr + i) & 0xFF] = v; }

    // ── loopy ──
    incX() {
      if ((this.v & 0x001F) === 31) this.v = (this.v & ~0x001F) ^ 0x0400;
      else this.v++;
    }
    incY() {
      if ((this.v & 0x7000) !== 0x7000) { this.v += 0x1000; return; }
      this.v &= ~0x7000;
      let y = (this.v & 0x03E0) >> 5;
      if (y === 29) { y = 0; this.v ^= 0x0800; }
      else if (y === 31) y = 0;
      else y++;
      this.v = (this.v & ~0x03E0) | (y << 5);
    }
    copyX() { this.v = (this.v & ~0x041F) | (this.t & 0x041F); }
    copyY() { this.v = (this.v & ~0x7BE0) | (this.t & 0x7BE0); }

    reloadShifters() {
      this.bgLo = (this.bgLo & 0xFF00) | this.ptLo;
      this.bgHi = (this.bgHi & 0xFF00) | this.ptHi;
      this.atLo = (this.atLo & 0xFF00) | ((this.atByte & 1) ? 0xFF : 0);
      this.atHi = (this.atHi & 0xFF00) | ((this.atByte & 2) ? 0xFF : 0);
    }

    // 次の行のスプライトを OAM から選ぶ(実機は 65-256 ドットで評価する。ここでは 257 ドット目に一括)
    evaluateSprites(line) {
      const h = (this.ctrl & 0x20) ? 16 : 8;
      let n = 0, hasZero = false;
      for (let i = 0; i < 64; i++) {
        const y = this.oam[i * 4];
        const row = line - y;
        if (row < 0 || row >= h) continue;
        if (n === 8) { this.status |= 0x20; break; }
        this.evalY[n] = row; this.evalTile[n] = this.oam[i * 4 + 1]; this.evalAttr[n] = this.oam[i * 4 + 2]; this.evalX[n] = this.oam[i * 4 + 3];
        if (i === 0) hasZero = true;
        n++;
      }
      this.evalCount = n; this.evalHasZero = hasZero;
    }
    // 257-320 ドット: スロット i のパターン取得(空スロットも $FF タイルを読む=A12 のため)
    fetchSpriteSlot(i, which) {
      const tall = (this.ctrl & 0x20) !== 0;
      let addr;
      if (i < this.evalCount) {
        const attr = this.evalAttr[i];
        let row = this.evalY[i], tile = this.evalTile[i];
        if (attr & 0x80) row = (tall ? 15 : 7) - row;
        if (tall) { addr = ((tile & 1) << 12) | ((tile & 0xFE) << 4) | ((row & 8) << 1) | (row & 7); }
        else addr = ((this.ctrl & 0x08) << 9) | (tile << 4) | row;
      } else {
        addr = ((tall ? 1 : (this.ctrl & 0x08) >> 3) << 12) | 0xFF0;
      }
      const b = this.fetchPattern(addr + (which ? 8 : 0));
      if (i < this.evalCount) {
        if (which) this.sprHi[i] = b; else this.sprLo[i] = b;
        if (which) { this.sprX[i] = this.evalX[i]; this.sprAttr[i] = this.evalAttr[i]; }
      }
      if (which && i === 7) { this.sprCount = this.evalCount; this.sprHasZero = this.evalHasZero; }
    }

    renderPixel(x, line) {
      const mask = this.mask;
      let bgPix = 0, bgPal = 0;
      if ((mask & 0x08) && (x >= 8 || (mask & 0x02))) {
        const bit = 0x8000 >> this.x;
        bgPix = ((this.bgLo & bit) ? 1 : 0) | ((this.bgHi & bit) ? 2 : 0);
        if (bgPix) bgPal = ((this.atLo & bit) ? 1 : 0) | ((this.atHi & bit) ? 2 : 0);
      }
      let sprPix = 0, sprPal = 0, sprBehind = false, sprZero = false;
      if ((mask & 0x10) && (x >= 8 || (mask & 0x04))) {
        for (let i = 0; i < this.sprCount; i++) {
          const dx = x - this.sprX[i];
          if (dx < 0 || dx > 7) continue;
          const attr = this.sprAttr[i];
          const bit = (attr & 0x40) ? dx : 7 - dx;
          const px = ((this.sprLo[i] >> bit) & 1) | (((this.sprHi[i] >> bit) & 1) << 1);
          if (!px) continue;
          sprPix = px; sprPal = attr & 3; sprBehind = (attr & 0x20) !== 0; sprZero = (i === 0 && this.sprHasZero);
          break;
        }
      }
      if (sprZero && bgPix && sprPix && x !== 255) this.status |= 0x40;
      let idx;
      if (!bgPix && !sprPix) idx = this.palette[0];
      else if (sprPix && (!bgPix || !sprBehind)) idx = this.palette[0x10 | (sprPal << 2) | sprPix];
      else idx = this.palette[(bgPal << 2) | bgPix];
      if (mask & 1) idx &= 0x30;
      this.frame[line * 256 + x] = PALETTE[idx & 0x3F];
      this.frameIdx[line * 256 + x] = idx & 0x3F;
    }

    // 1 ドット進める
    step() {
      const line = this.scanline, dot = this.dot;
      const rendering = (this.mask & 0x18) !== 0;
      const visible = line < 240;
      if (visible || line === 261) {
        if (line === 261 && dot === 1) { this.status &= ~0xE0; this.nmiOccurred = false; }
        if (rendering) {
          if ((dot >= 2 && dot <= 257) || (dot >= 322 && dot <= 337)) {
            this.bgLo <<= 1; this.bgHi <<= 1; this.atLo <<= 1; this.atHi <<= 1;
            if (((dot - 1) & 7) === 0) this.reloadShifters();
          }
          if ((dot >= 1 && dot <= 256) || (dot >= 321 && dot <= 336)) {
            switch (dot & 7) {
              case 1: this.ntByte = this.fetchNt(0x2000 | (this.v & 0x0FFF)); break;
              case 3: {
                const at = this.fetchNt(0x23C0 | (this.v & 0x0C00) | ((this.v >> 4) & 0x38) | ((this.v >> 2) & 0x07));
                const shift = ((this.v >> 4) & 4) | (this.v & 2);
                this.atByte = (at >> shift) & 3;
                break;
              }
              case 5: this.ptLo = this.fetchPattern(((this.ctrl & 0x10) << 8) | (this.ntByte << 4) | (this.v >> 12)); break;
              case 7: this.ptHi = this.fetchPattern(((this.ctrl & 0x10) << 8) | (this.ntByte << 4) | (this.v >> 12) | 8); break;
              case 0: this.incX(); if (dot === 256) this.incY(); break;
            }
          }
          if (dot === 257) { this.copyX(); this.evaluateSprites(visible ? line : -1); }
          if (dot >= 257 && dot <= 320) {
            this.oamAddr = 0;
            const k = (dot - 257) & 7;
            if (k === 1) this.fetchNt(0x2000 | (this.v & 0x0FFF)); // ゴミの NT 読み(実機どおり。MMC5 はこれもタイル列として数える)
            else if (k === 3) this.fetchNt(0x23C0 | (this.v & 0x0C00) | ((this.v >> 4) & 0x38) | ((this.v >> 2) & 0x07)); // ゴミの属性読み
            else if (k === 5) this.fetchSpriteSlot((dot - 257) >> 3, 0);
            else if (k === 7) this.fetchSpriteSlot((dot - 257) >> 3, 1);
          }
          if (line === 261 && dot >= 280 && dot <= 304) this.copyY();
          if (dot === 337 || dot === 339) this.fetchNt(0x2000 | (this.v & 0x0FFF)); // ダミーの NT 読み
        } else if (visible && dot >= 1 && dot <= 256) {
          // 描画オフ: 背景色(v がパレットを指していればその色)
          const addr = this.v & 0x3FFF;
          let idx = (addr >= 0x3F00) ? this.palette[this.paletteIndex(addr)] : this.palette[0];
          if (this.mask & 1) idx &= 0x30;
          this.frame[line * 256 + dot - 1] = PALETTE[idx & 0x3F];
          this.frameIdx[line * 256 + dot - 1] = idx & 0x3F;
        }
        if (rendering && visible && dot >= 1 && dot <= 256) this.renderPixel(dot - 1, line);
      }
      if (line === 241 && dot === 1) { this.status |= 0x80; this.nmiOccurred = true; this.vblankStarted = true; }

      // 次のドットへ(奇数フレームは描画中なら 261 行目の最後の 1 ドットを飛ばす)
      this.time++;
      let next = dot + 1;
      if (line === 261 && next === 340 && this.odd && rendering) next = 341;
      if (next >= DOTS_PER_LINE) {
        next = 0;
        this.scanline++;
        if (this.scanline >= LINES) { this.scanline = 0; this.odd = !this.odd; this.frameCount++; this.frameDone = true; }
      }
      this.dot = next;
    }

    nmiLine() { return this.nmiOccurred && this.nmiOutput; }
  }

  PPU.PALETTE = PALETTE;
  PPU.PALETTE = PALETTE; // パレット番号 → RGBA(主スレッドが巻き戻しの 8bit 画面を描くのに使う)
  Emu.PPU = PPU;
})(typeof window !== 'undefined' ? window : globalThis);
