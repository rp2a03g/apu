/*
 * ゲームボーイの PPU(段階 8a: 行単位、DMG)
 * MML.Emu.GbPpu
 *
 * 1 行 = 456T、154 行(0-143 表示、144-153 VBlank)。行の中はモード 2(OAM、0-79)→ 3(描画、80-251)→ 0(HBlank、252-455)の
 * 固定長で、モード 3 の頭でその行をまとめて描く。LY/STAT/割り込みの時刻は合うが、次は合わない(段階 8c でドット単位にする):
 *   - モード 3 の長さ(スプライト数/SCX/ウィンドウで 172〜289T に伸びる)
 *   - 行の途中のレジスタ書き換え、モード 2/3 中の OAM/VRAM アクセスの遮断
 *   - 153 行目の LY=0 の早出し、LCD を点けた直後の 1 行目、STAT 書き込みの癖(DMG)
 * 参考: Pan Docs "Rendering" "STAT"
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const W = 160, H = 144;

  class GbPpu {
    constructor(con) {
      this.con = con; // requestIrq(bit)
      this.vram = new Uint8Array(0x2000);
      this.oam = new Uint8Array(0xA0);
      this.frame = new Uint32Array(W * H); // 0xAABBGGRR
      this.shades = [0xFFFFFFFF, 0xFFAAAAAA, 0xFF555555, 0xFF000000]; // 白 → 黒(設定で差し替える)
      this.lineIdx = new Uint8Array(W);  // その行の BG/ウィンドウの色番号(スプライトの優先判定用)
      this.claimed = new Uint8Array(W);
      this.reset();
    }

    reset() {
      this.vram.fill(0); this.oam.fill(0);
      this.lcdc = 0x91; this.statEn = 0;
      this.scy = 0; this.scx = 0; this.ly = 0; this.lyc = 0;
      this.bgp = 0xFC; this.obp0 = 0xFF; this.obp1 = 0xFF;
      this.wy = 0; this.wx = 0;
      this.dot = 0; this.mode = 2;
      this.winLine = 0; this.wyHit = false;
      this.statLine = false;
      this.vblankStarted = false;
      this.frame.fill(this.shades[0]);
    }

    get on() { return (this.lcdc & 0x80) !== 0; }

    readReg(addr) {
      switch (addr) {
        case 0xFF40: return this.lcdc;
        case 0xFF41: return 0x80 | this.statEn | (this.ly === this.lyc ? 4 : 0) | (this.on ? this.mode : 0);
        case 0xFF42: return this.scy;
        case 0xFF43: return this.scx;
        case 0xFF44: return this.ly;
        case 0xFF45: return this.lyc;
        case 0xFF47: return this.bgp;
        case 0xFF48: return this.obp0;
        case 0xFF49: return this.obp1;
        case 0xFF4A: return this.wy;
        case 0xFF4B: return this.wx;
      }
      return 0xFF;
    }

    writeReg(addr, v) {
      switch (addr) {
        case 0xFF40: {
          const was = this.on;
          this.lcdc = v;
          if (was && !this.on) { // 消灯: LY=0、モード 0、画面は白
            this.ly = 0; this.dot = 0; this.mode = 0; this.winLine = 0; this.wyHit = false;
            this.frame.fill(this.shades[0]);
            this._stat();
          } else if (!was && this.on) { this.ly = 0; this.dot = 0; this.mode = 2; this.winLine = 0; this.wyHit = false; this._stat(); }
          break;
        }
        case 0xFF41: this.statEn = v & 0x78; this._stat(); break;
        case 0xFF42: this.scy = v; break;
        case 0xFF43: this.scx = v; break;
        case 0xFF44: break; // LY は読み出し専用
        case 0xFF45: this.lyc = v; if (this.on) this._stat(); break;
        case 0xFF47: this.bgp = v; break;
        case 0xFF48: this.obp0 = v; break;
        case 0xFF49: this.obp1 = v; break;
        case 0xFF4A: this.wy = v; break;
        case 0xFF4B: this.wx = v; break;
      }
    }

    // STAT の割り込み線は各要因の OR。立ち上がりでだけ割り込む(要因が重なっている間は次が出ない)
    _stat() {
      const e = this.statEn, m = this.mode;
      const line = this.on && (((e & 0x40) && this.ly === this.lyc) || ((e & 0x20) && m === 2) || ((e & 0x10) && m === 1) || ((e & 0x08) && m === 0));
      if (line && !this.statLine) this.con.requestIrq(1);
      this.statLine = !!line;
    }

    // 4T 進める(本体が M サイクルごとに呼ぶ)
    tick() {
      if (!(this.lcdc & 0x80)) return;
      const d = (this.dot += 4);
      if (this.ly < H) {
        if (d === 80) { this.mode = 3; if (!this.noRender) this._renderLine(); this._stat(); }
        else if (d === 252) { this.mode = 0; this._stat(); }
      }
      if (d >= 456) {
        this.dot = 0;
        this.ly++;
        if (this.ly === H) { this.mode = 1; this.vblankStarted = true; this.con.requestIrq(0); }
        else if (this.ly === 154) { this.ly = 0; this.winLine = 0; this.wyHit = false; }
        if (this.ly < H) this.mode = 2;
        this._stat();
      }
    }

    _renderLine() {
      const y = this.ly, lcdc = this.lcdc, vram = this.vram, idx = this.lineIdx, out = this.frame, base = y * W, sh = this.shades;
      if (y === this.wy) this.wyHit = true;
      const signedTiles = !(lcdc & 0x10);
      if (lcdc & 0x01) {
        const map = (lcdc & 0x08) ? 0x1C00 : 0x1800;
        const yy = (y + this.scy) & 0xFF, row = map + (yy >> 3) * 32, fine = (yy & 7) * 2, scx = this.scx;
        let tileX = -1, lo = 0, hi = 0;
        for (let x = 0; x < W; x++) {
          const xx = (x + scx) & 0xFF;
          if ((xx >> 3) !== tileX) {
            tileX = xx >> 3;
            const t = vram[row + tileX];
            const a = (signedTiles ? 0x1000 + ((t << 24) >> 24) * 16 : t * 16) + fine;
            lo = vram[a]; hi = vram[a + 1];
          }
          const bit = 7 - (xx & 7);
          idx[x] = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
        }
        // ウィンドウ: この行で WY に達していて WX が画面内。描いた行だけ内部の行カウンタが進む
        if ((lcdc & 0x20) && this.wyHit && this.wx <= 166) {
          const map2 = (lcdc & 0x40) ? 0x1C00 : 0x1800;
          const wl = this.winLine++, row2 = map2 + (wl >> 3) * 32, fine2 = (wl & 7) * 2, x0 = this.wx - 7;
          for (let x = Math.max(0, x0); x < W; x++) {
            const wx = x - x0, t = vram[row2 + (wx >> 3)];
            const a = (signedTiles ? 0x1000 + ((t << 24) >> 24) * 16 : t * 16) + fine2;
            const bit = 7 - (wx & 7);
            idx[x] = (((vram[a + 1] >> bit) & 1) << 1) | ((vram[a] >> bit) & 1);
          }
        }
        const bgp = this.bgp;
        for (let x = 0; x < W; x++) out[base + x] = sh[(bgp >> (idx[x] * 2)) & 3];
      } else { // DMG: BG 無効は白
        idx.fill(0);
        for (let x = 0; x < W; x++) out[base + x] = sh[0];
      }

      if (lcdc & 0x02) {
        const oam = this.oam, h = (lcdc & 0x04) ? 16 : 8;
        // その行に掛かる先頭 10 個(OAM 順)。優先は X の小さい方、同じなら OAM の若い方(DMG)
        const list = [];
        for (let i = 0; i < 40 && list.length < 10; i++) { const sy = oam[i * 4] - 16; if (y >= sy && y < sy + h) list.push(i); }
        if (list.length) {
          list.sort((a, b) => (oam[a * 4 + 1] - oam[b * 4 + 1]) || (a - b));
          const claimed = this.claimed; claimed.fill(0);
          for (const i of list) {
            const sx = oam[i * 4 + 1] - 8, fl = oam[i * 4 + 3];
            let line = y - (oam[i * 4] - 16), tile = oam[i * 4 + 2];
            if (fl & 0x40) line = h - 1 - line;
            if (h === 16) tile &= 0xFE;
            const a = tile * 16 + line * 2, lo = vram[a], hi = vram[a + 1], pal = (fl & 0x10) ? this.obp1 : this.obp0;
            for (let px = 0; px < 8; px++) {
              const x = sx + px;
              if (x < 0 || x >= W || claimed[x]) continue;
              const bit = (fl & 0x20) ? px : 7 - px;
              const c = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
              if (!c) continue;
              claimed[x] = 1; // 勝ったスプライトが BG の後ろでも、下位のスプライトは出ない
              if ((fl & 0x80) && idx[x]) continue;
              out[base + x] = sh[(pal >> (c * 2)) & 3];
            }
          }
        }
      }
    }
  }

  GbPpu.WIDTH = W; GbPpu.HEIGHT = H;
  Emu.GbPpu = GbPpu;
})(typeof window !== 'undefined' ? window : globalThis);
