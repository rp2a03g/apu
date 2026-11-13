/*
 * ゲームボーイの PPU(DMG)
 * MML.Emu.GbPpu
 *
 * 1 行 = 456T、154 行(0-143 表示、144-153 VBlank)。行の中はモード 2(OAM 走査、0-79)→ 3(描画)→ 0(HBlank)。
 *
 * ★2026-11-13 段階 8c で行単位から作り直し(DESIGN-GB-CAPTURE.md §3):
 *   - モード 3 の長さは 172T+(SCX の下位 3bit)+ウィンドウ 6T+スプライトごとの遅れ(Pan Docs の OBJ penalty の式)。
 *     HBlank の STAT 割り込みで音ドライバや演出を回すソフトの時刻が合う
 *   - 画素はモード 3 の間、時間の進みに合わせて左から描く(本体は 4T ずつ進むので 4 画素刻み)。行の途中で
 *     SCX/SCY/LCDC/パレット/ウィンドウを書き換えるとその位置から効く。スプライトの遅れによる画素位置のずれまでは追わない
 *   - モード 2/3 の間の OAM、モード 3 の間の VRAM は CPU から触れない(読むと $FF、書きは捨てる)
 *   - 153 行目は 4T で LY=0 になる。LCD を点けた直後の 1 行目はモード 2 が無く 4T 短い。LCD が消えている間 LY=LYC の旗は動かない
 *   まだ無い物: 画素 FIFO の細部(スプライトの遅れによる画素位置、WX=166 などの癖)、STAT 書き込みの癖(DMG)、OAM 破壊バグ
 *
 * 参考: Pan Docs "Rendering" "STAT" "OAM"。細部は mooneye の acceptance/ppu と dmg-acid2 で確かめる(tools/headless/gb-testroms.js)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const W = 160, H = 144;
  const FIRST_PIXEL_DOT = 92; // モード 3 の頭(80)から最初の画素が出るまで 12T(+SCX の下位 3bit)

  class GbPpu {
    constructor(con) {
      this.con = con; // requestIrq(bit)
      this.vram = new Uint8Array(0x2000);
      this.oam = new Uint8Array(0xA0);
      this.frame = new Uint32Array(W * H);   // 0xAABBGGRR
      this.frameIdx = new Uint8Array(W * H); // 階調番号 0-3(巻き戻しの映像の輪が控える。色は shades で引く)
      this.shades = [0xFFFFFFFF, 0xFFAAAAAA, 0xFF555555, 0xFF000000]; // 白 → 黒(設定で差し替える)
      this.sprList = new Uint8Array(10); // その行のスプライト(OAM 番号、優先順)
      this.noRender = false;             // true: 絵は描かない(GBS プレイヤー)
      this.reset();
    }

    reset() {
      this.vram.fill(0); this.oam.fill(0);
      this.lcdc = 0x91; this.statEn = 0;
      this.scy = 0; this.scx = 0; this.ly = 0; this.lyc = 0;
      this.bgp = 0xFC; this.obp0 = 0xFF; this.obp1 = 0xFF;
      this.wy = 0; this.wx = 0;
      this.line = 0;          // 内部の行(153 行目でも 153 のまま。ly は読み出し値)
      this.dot = 0; this.mode = 2;
      this.mode3End = 252;    // この行のモード 3 が終わる位置(T)
      this.px = 0;            // この行で次に描く画素
      this.scxFine = 0;
      this.sprCount = 0;
      this.winLine = 0; this.wyHit = false; this.winActive = false; this.winX = 0;
      this.firstLine = false; // LCD を点けた直後の 1 行目(モード 2 が無い)
      this.lycFlag = true;    // 起動直後は LY=LYC=0
      this.statLine = false;
      this.vblankStarted = false;
      this.frame.fill(this.shades[0]); this.frameIdx.fill(0);
    }

    get on() { return (this.lcdc & 0x80) !== 0; }
    // CPU から見て触れない間(本体のバスが見る)
    oamBlocked() { return (this.lcdc & 0x80) !== 0 && this.line < H && !this.firstLine && (this.mode === 2 || this.mode === 3); }
    vramBlocked() { return (this.lcdc & 0x80) !== 0 && this.line < H && this.mode === 3; }

    readReg(addr) {
      switch (addr) {
        case 0xFF40: return this.lcdc;
        case 0xFF41: return 0x80 | this.statEn | (this.lycFlag ? 4 : 0) | (this.on ? (this.firstLine && this.mode === 2 ? 0 : this.mode) : 0);
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
          if (was && !this.on) { // 消灯: LY=0、モード 0、画面は白。LY=LYC の旗はそのまま残る
            this.ly = 0; this.line = 0; this.dot = 0; this.mode = 0; this.winLine = 0; this.wyHit = false; this.firstLine = false;
            this.frame.fill(this.shades[0]); this.frameIdx.fill(0);
            this._stat();
          } else if (!was && this.on) { // 点灯: 1 行目は 4T 短く、モード 2 の間も STAT はモード 0 を返す(OAM にも触れる)
            this.ly = 0; this.line = 0; this.dot = 4; this.mode = 2; this.firstLine = true;
            this.winLine = 0; this.wyHit = false; this.px = 0;
            this.lycFlag = this.lyc === 0;
            this._stat();
          }
          break;
        }
        case 0xFF41: this.statEn = v & 0x78; this._stat(); break;
        case 0xFF42: this.scy = v; break;
        case 0xFF43: this.scx = v; break;
        case 0xFF44: break; // LY は読み出し専用
        case 0xFF45: this.lyc = v; if (this.on) { this.lycFlag = this._lyCmp() === v; this._stat(); } break;
        case 0xFF47: this.bgp = v; break;
        case 0xFF48: this.obp0 = v; break;
        case 0xFF49: this.obp1 = v; break;
        case 0xFF4A: this.wy = v; break;
        case 0xFF4B: this.wx = v; break;
      }
    }

    // LYC と比べる値。153 行目は LY が 0 に変わった後もしばらく 153 と比べ、その後 0 と比べる
    _lyCmp() { return this.line === 153 ? (this.dot < 12 ? 153 : 0) : this.line; }

    // STAT の割り込み線は各要因の OR。立ち上がりでだけ割り込む(要因が重なっている間は次が出ない)
    _stat() {
      const e = this.statEn, m = this.firstLine && this.mode === 2 ? 0 : this.mode;
      const line = this.on && (((e & 0x40) && this.lycFlag) || ((e & 0x20) && m === 2) || ((e & 0x10) && m === 1) || ((e & 0x08) && m === 0) ||
        ((e & 0x20) && this.line === H && this.dot < 4)); // VBlank の頭ではモード 2 の要因でも割り込む(実機の癖)
      if (line && !this.statLine) this.con.requestIrq(1);
      this.statLine = !!line;
    }

    // 4T 進める(本体が M サイクルごとに呼ぶ)
    tick() {
      if (!(this.lcdc & 0x80)) return;
      const d = (this.dot += 4);
      if (this.line < H) {
        if (this.mode === 2) {
          if (d >= 80) this._startMode3();
        } else if (this.mode === 3) {
          if (!this.noRender) this._renderTo(d - FIRST_PIXEL_DOT - this.scxFine + 4);
          if (d >= this.mode3End) {
            if (!this.noRender) this._renderTo(W);
            if (this.winActive) this.winLine++;
            this.mode = 0; this.firstLine = false;
            this._stat();
          }
        }
      } else if (this.line === 153) {
        if (d === 4) this.ly = 0;
        else if (d === 12) { this.lycFlag = this.lyc === 0; this._stat(); }
      } else if (d === 4 && this.line === H && this.statLine) this._stat(); // VBlank 頭だけのモード 2 要因を下ろす
      // LY の読み出し値は行の終わりの 4T 前に次の行へ進む(DMG。mooneye の hblank_ly_scx_timing が見る)
      if (d === 452 && this.line < 153) this.ly = this.line + 1;
      // 新しい行の LY=LYC は行頭の 4T 後に立つ
      if (d === 4 && !this.firstLine) { this.lycFlag = this.line === this.lyc; this._stat(); }
      if (d >= 456) {
        this.dot = 0;
        this.line++;
        if (this.line === 154) { this.line = 0; this.winLine = 0; this.wyHit = false; }
        if (this.line !== 0) this.ly = this.line;
        if (this.line !== 0) this.lycFlag = false; // 行頭の 4T は比較が外れる(0 行目は 153 行目の途中から LY=0 として比べている)
        if (this.line === H) { this.mode = 1; this.vblankStarted = true; this.con.requestIrq(0); }
        else if (this.line < H) { this.mode = 2; this.px = 0; }
        this._stat();
      }
    }

    // モード 2 の終わり: その行のスプライトを集め、モード 3 の長さを決める
    _startMode3() {
      const y = this.line, lcdc = this.lcdc, oam = this.oam;
      if (y === this.wy) this.wyHit = true;
      const h = (lcdc & 0x04) ? 16 : 8;
      let n = 0;
      const list = this.sprList;
      if (lcdc & 0x02) for (let i = 0; i < 40 && n < 10; i++) { const sy = oam[i * 4] - 16; if (y >= sy && y < sy + h) list[n++] = i; }
      // 優先順(X の小さい方、同じなら OAM の若い方)に並べる。挿入ソート(高々 10 個)
      for (let i = 1; i < n; i++) { const v = list[i]; let j = i - 1; while (j >= 0 && oam[list[j] * 4 + 1] > oam[v * 4 + 1]) { list[j + 1] = list[j]; j--; } list[j + 1] = v; }
      this.sprCount = n;
      this.scxFine = this.scx & 7;
      const winOnLine = (lcdc & 0x20) && this.wyHit && this.wx <= 166;
      let len = 172 + this.scxFine + (winOnLine ? 6 : 0);
      // スプライトの遅れ: 左端の画素が乗る BG/ウィンドウのタイルごとに 1 回だけ「そのタイルの残り画素 − 2(0 未満は 0)」、どのスプライトにも一律 6
      let lastTile = -999;
      for (let i = 0; i < n; i++) {
        const ox = oam[list[i] * 4 + 1];
        if (ox >= 168) continue;
        let tile, right;
        if (winOnLine && ox >= this.wx + 1) { const wxp = ox - (this.wx + 1); tile = 0x1000 + (wxp >> 3); right = 7 - (wxp & 7); }
        else { const bx = (ox + this.scx) & 0xFF; tile = bx >> 3; right = 7 - (bx & 7); }
        if (tile !== lastTile) { lastTile = tile; len += Math.max(0, right - 2); }
        len += 6;
      }
      this.mode3End = 80 + len;
      this.mode = 3; this.px = 0; this.winActive = false; this.winX = 0;
      this._stat();
    }

    // この行の画素を x1 の手前まで描く(今のレジスタで)
    _renderTo(x1) {
      if (x1 > W) x1 = W;
      let x = this.px;
      if (x >= x1) return;
      const y = this.line, lcdc = this.lcdc, vram = this.vram, oam = this.oam, sh = this.shades;
      const out = this.frame, outIdx = this.frameIdx, base = y * W;
      const bgOn = (lcdc & 0x01) !== 0, signedTiles = !(lcdc & 0x10);
      const winOk = bgOn && (lcdc & 0x20) && this.wyHit && this.wx <= 166, wx0 = this.wx - 7;
      const bgMap = (lcdc & 0x08) ? 0x1C00 : 0x1800, winMap = (lcdc & 0x40) ? 0x1C00 : 0x1800;
      const yy = (y + this.scy) & 0xFF, bgRow = bgMap + (yy >> 3) * 32, bgFine = (yy & 7) * 2, scx = this.scx;
      const wl = this.winLine, winRow = winMap + (wl >> 3) * 32, winFine = (wl & 7) * 2;
      const sprOn = (lcdc & 0x02) !== 0, n = this.sprCount, list = this.sprList, h = (lcdc & 0x04) ? 16 : 8;
      const bgp = this.bgp;
      for (; x < x1; x++) {
        let c = 0;
        if (bgOn) {
          // ウィンドウはその行で WX に達した所から始まり、行の終わりまで続く(WX<7 は左が欠ける)
          if (winOk && !this.winActive && x >= wx0) { this.winActive = true; this.winX = x - wx0; }
          let a, bit;
          if (this.winActive && (lcdc & 0x20)) {
            const wxp = this.winX++;
            const t = vram[winRow + ((wxp >> 3) & 31)];
            a = (signedTiles ? 0x1000 + ((t << 24) >> 24) * 16 : t * 16) + winFine; bit = 7 - (wxp & 7);
          } else {
            const xx = (x + scx) & 0xFF;
            const t = vram[bgRow + (xx >> 3)];
            a = (signedTiles ? 0x1000 + ((t << 24) >> 24) * 16 : t * 16) + bgFine; bit = 7 - (xx & 7);
          }
          c = (((vram[a + 1] >> bit) & 1) << 1) | ((vram[a] >> bit) & 1);
        }
        let shade = (bgp >> (c * 2)) & 3;
        if (sprOn) {
          for (let i = 0; i < n; i++) {
            const o = list[i] * 4, sx = oam[o + 1] - 8;
            if (x < sx || x >= sx + 8) continue;
            const fl = oam[o + 3];
            let ln = y - (oam[o] - 16), tile = oam[o + 2];
            if (fl & 0x40) ln = h - 1 - ln;
            if (h === 16) tile &= 0xFE;
            const sa = tile * 16 + ln * 2, sb = (fl & 0x20) ? x - sx : 7 - (x - sx);
            const sc = (((vram[sa + 1] >> sb) & 1) << 1) | ((vram[sa] >> sb) & 1);
            if (!sc) continue;
            // 勝ったスプライトが BG の後ろなら BG が出る(下位のスプライトは出ない)
            if (!((fl & 0x80) && c)) shade = (((fl & 0x10) ? this.obp1 : this.obp0) >> (sc * 2)) & 3;
            break;
          }
        }
        outIdx[base + x] = shade;
        out[base + x] = sh[shade];
      }
      this.px = x;
    }
  }

  GbPpu.WIDTH = W; GbPpu.HEIGHT = H;
  Emu.GbPpu = GbPpu;
})(typeof window !== 'undefined' ? window : globalThis);
