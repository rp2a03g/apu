/*
 * HuC6270(VDC: 絵の石)— 時間の骨組み+VRAM+BG+スプライト+DMA+割り込み
 * MML.Emu.PceVdc(段階 9c)
 *
 * pce/vdcTiming.js(9a。HES 用の「時間だけ」の版)と同じ状態機械に、絵を足した物。時間の決まりは vdcTiming.js の冒頭を参照。
 *   横 = 同期(HSW)→ 表示開始待ち(HDS)→ 表示(HDW)→ 表示終了(HDE)、縦 = 同期(VSW)→ 待ち(VDS)→ 表示(VDW)→ 終了(VCR)。
 *   VCE が 1365 マスタークロックごとに水平同期を、画面の終わりの 3 行で垂直同期を掛けて頭へ戻す。
 *
 * 絵の作り: 1 行ぶんの色を row[] に「今の横位置まで」描き足していく(draw)。レジスタを書かれた時・出来事の時・行の終わりに呼ぶので、
 *   行の途中でスクロールやパレットを変えた効果が、変えた位置から出る。BG のタイルとスプライトも、石が実際に VRAM を読む位置に合わせて
 *   少しずつ取り込む(_loadBg / _evalSprites)。取り込みの間は CPU からの VRAM の読み書きが待たされる(_vramAccess)。
 *   行が終わると out[](242 行 × 682 桁、値は VCE の 9bit の色+白黒の印 $200)へ写す。行ごとのドットクロックは rowDiv[]。
 *   row[] の値には印が 2 つ付く: $4000 = 透明(BG の色 0 か、絵の外)、$8000 = スプライトの画素。SuperGrafx で 2 個の VDC の絵を
 *   重ねる時に使う(pce/vpc.js)。SuperGrafx の時は out へ写さず、host.vdcRowEnd に任せる。2 個目の VDC は画面の区切りを知らせない。
 *
 * 根拠の札(DESIGN-PCE-CAPTURE.md §2.3)。このファイルの決まりは全部 [参照] Mesen 2 の Core/PCE/PceVdc.cpp と PceVpc.cpp(読んで動きを合わせた。写していない)。
 * 確かめ方: tools/headless/pce-mesen-ab.js --rom(画面の全画素と、I/O の時刻つきの並びを Mesen と比べる)。
 * ★ = Mesen 自身が「概算」「要検証」「推測」とコメントしている所、または Mesen の癖をそのまま写した所:
 *   ★ 取り込みの位置: スプライトの選び出しと BG の取り込みは表示開始の 16 ドット前から。スクロールの取り込みは表示開始の 34 ドット前(合わせ込み)
 *   ★ VRAM の読み書きの待ち: 書き込みは 12/18/21、読み出しは 15/24/24 マスタークロック後(10/7/5MHz)に「空いている枠」で通る(試験 ROM からの推測)
 *   ★ 待たされている間の CPU は 3 マスタークロックずつ進む(実機は VDC の枠に合うまでで、3 の倍数とは限らない)
 *   ★ 水平同期の頭 8 ドットは VRAM の読み書きと DMA が止まる(試験 ROM の結果から)
 *   ★ BXR/BYR/CR を取り込みの直後(半ドット以内)に書くと、書いた値で取り込み直す(他のずれの埋め合わせかもしれない)
 *   ★ 表示が水平同期で打ち切られた時、スプライトの読み込みは 36 ドット後から(概算)
 *   ★ CG モード(R09 bit7。VRAM の幅 4 の時にどちらの面を読むか)は、Mesen では取り込まれず常に 0 のまま。同じにしてある
 *   ★ スプライトの読み込みが BG の取り込みと重なる行は、前の行のスプライトがそのまま残る(Mesen の作り。実機でどうなるかは未確認)
 *   ★ $8000 以上の VRAM を読むと、最後に読めた値が返る(範囲外のタイル番号で空のスプライトを期待するソフトがある、というコメント)
 *   [推定] 電源投入時の VRAM とスプライト表の中身は 0(実機は不定)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const LINE = 1365, NEVER = 0xFFFF;
  const ROW_W = 682;                 // 1 行の最大ドット数(1365 ÷ 2)
  const FIRST_LINE = 14, LAST_LINE = 256, ROWS = LAST_LINE - FIRST_LINE; // 映る 242 行
  const H_DS = 0, H_DW = 1, H_DE = 2, H_SW = 3;
  const V_DS = 0, V_DW = 1, V_DE = 2, V_SW = 3;
  const EV_NONE = 0, EV_LATCH_Y = 1, EV_LATCH_X = 2, EV_HDS_IRQ = 3, EV_INC_RCR = 4;
  const ST_COLLISION = 0x01, ST_OVERFLOW = 0x02, ST_RCR = 0x04, ST_SATB = 0x08, ST_DMA = 0x10, ST_VBLANK = 0x20, ST_BUSY = 0x40;
  const GRAY = 0x200, TRANSPARENT = 0x4000, SPRITE = 0x8000;
  const MAX_TILES = 256, MAX_SPR = 128;

  class PceVdc {
    /**
     * @param {object} host - { clock(マスタークロックの通算), vce(PceVce), execFast()(マスタークロック 3 個ぶん本体を進める), onVdcFrame() }
     */
    constructor(host, isVdc2) {
      this.host = host;
      this.isVdc2 = !!isVdc2; // SuperGrafx の 2 個目
      this.vram = new Uint16Array(0x8000);
      this.satb = new Uint16Array(0x100);
      this.row = new Uint16Array(ROW_W + 2);
      this.out = new Uint16Array(ROW_W * ROWS);
      this.rowDiv = new Uint8Array(ROWS);
      // BG のタイル(その行で取り込んだ順)
      this.tAddr = new Uint16Array(MAX_TILES); this.tPal = new Uint8Array(MAX_TILES);
      this.tD0 = new Uint16Array(MAX_TILES); this.tD1 = new Uint16Array(MAX_TILES);
      // 選び出したスプライト(次の行ぶん)
      this.sIdx = new Uint8Array(MAX_SPR); this.sX = new Int16Array(MAX_SPR); this.sAddr = new Uint16Array(MAX_SPR);
      this.sFlag = new Uint8Array(MAX_SPR); this.sPal = new Uint8Array(MAX_SPR);
      // 描くスプライト(今の行ぶん。絵のデータ 4 面つき)
      this.dIdx = new Uint8Array(MAX_SPR); this.dX = new Int16Array(MAX_SPR); this.dFlag = new Uint8Array(MAX_SPR);
      this.dPal = new Uint8Array(MAX_SPR); this.dData = new Uint16Array(MAX_SPR * 4);
      this.xHas = new Uint8Array(1088); // その横位置にスプライトがあるか(位置 +32)
      this.reset();
    }

    reset() {
      this.vram.fill(0); this.satb.fill(0); this.row.fill(0); this.out.fill(0); this.rowDiv.fill(4);
      // レジスタ(書かれた値 reg と、同期の頭で取り込んだ値 lat)。0 になり得ない物は有り得る値で始める
      const init = () => ({ hsw: 0, hds: 0, hdw: 0x1F, hde: 0, vsw: 0, vds: 0, vdw: 239, vcr: 0, bxr: 0, byr: 0, cols: 32, rows: 32, vramMode: 0, sprMode: 0 });
      this.reg = init(); this.lat = init();
      this.currentReg = 0;
      this.mawr = 0; this.marr = 0; this.readBuf = 0; this.vramData = 0; this.inc = 1;
      this.enCollision = false; this.enOverflow = false; this.enRcr = false; this.enVblank = false;
      this.nextSpr = false; this.nextBg = false; this.sprOn = false; this.bgOn = false; this.burst = false;
      this.rcrReg = 0; this.byrPending = false;
      // DMA
      this.satbIrqEn = false; this.dmaIrqEn = false; this.decSrc = false; this.decDst = false; this.repeatSatb = false;
      this.blockSrc = 0; this.blockDst = 0; this.blockLen = 0; this.satbSrc = 0;
      this.satbPending = false; this.satbRunning = false; this.satbCounter = 0; this.satbOffset = 0;
      this.dmaRunning = false; this.dmaReadCycle = false; this.dmaBuf = 0; this.dmaPendingClocks = 0;
      this.allowDma = true;   // 電源投入直後は DMA が走れる(合成 ROM 'vramio' で Mesen と食い違って分かった)
      // 状態
      this.status = 0; this.irq = false;
      this.hClock = 0; this.scanline = 0; this.frameCount = 0;
      this.hMode = H_DS; this.hCounter = 0; this.vMode = V_DS; this.vCounter = 0; this.rcr = 0;
      this.event = EV_NONE; this.eventCounter = 0;
      this.needRcrInc = false; this.needVClock = false; this.needVblank = false; this.vblankDone = false;
      this.hsyncStartClock = 0;
      // 絵
      this.xStart = 0; this.lastDrawHClock = 0; this.screenX = 0;
      this.tileCount = 0; this.loadBgStart = 0; this.loadBgEnd = 0; this.loadBgLast = 0; this.cpuSlot = false;
      this.evalStart = 0; this.evalEnd = 0; this.evalLast = 0; this.spriteCount = 0; this.spriteRow = 0; this.spriteOverflow = false;
      this.drawCount = 0; this.totalCount = 0; this.rowHasSprite0 = false; this.loadSpriteStart = 0;
      this.latchClockX = NEVER; this.latchClockY = NEVER;
      this.pendingRead = false; this.pendingWrite = false; this.transferDelay = 0; this.openBus = 0;
    }

    _dots(n) { return n * this.host.vce.divider; }

    /** マスタークロック 3 個ぶん進める */
    exec() {
      if (this.satbRunning) this._satbStep();
      else if (this.dmaRunning) this._dmaStep();

      if (this.rowHasSprite0 || this.pendingWrite || this.pendingRead) {
        this.draw();
        if (this.pendingRead || this.pendingWrite) this._vramAccess();
      }

      if (this.hCounter <= 3 || this.eventCounter <= 3) {
        for (let i = 0; i < 3; i++) {
          this.hClock++;
          if (--this.hCounter === 0) { this.draw(); this._setHMode((this.hMode + 1) & 3); }
          if (this.eventCounter && --this.eventCounter === 0) this._event();
        }
      } else {
        this.hCounter -= 3;
        if (this.eventCounter > 0) this.eventCounter -= 3;
        this.hClock += 3;
      }
      if (this.hClock === LINE) this._endOfLine();
    }

    // ── 横 ──
    _setHMode(m) {
      this.hMode = m;
      const L = this.lat;
      switch (m) {
        case H_DS: this.hCounter = this._dots((L.hds + 1) * 8); break;
        case H_DW:
          this.needVClock = true; this.needRcrInc = true;
          this.event = EV_INC_RCR;
          this.eventCounter = this._dots((L.hdw - 1) * 8 + 2);
          this.hCounter = this._dots((L.hdw + 1) * 8);
          break;
        case H_DE:
          this.loadBgStart = NEVER; this.evalStart = NEVER;
          this.loadSpriteStart = this.hClock;
          this.hCounter = this._dots((L.hde + 1) * 8);
          break;
        default:
          this.loadBgStart = NEVER; this.evalStart = NEVER;
          this.hCounter = this._dots((L.hsw + 1) * 8);
          this.hsyncStartClock = this.host.clock;
          this._hsyncStart();
          break;
      }
    }

    // 水平同期の頭: 横のレジスタを取り込み、この行の「スプライトの選び出し」「BG の取り込み」「スクロールの取り込み/割り込みの上げ時」を決める
    _hsyncStart() {
      const L = this.lat, R = this.reg;
      L.hsw = R.hsw; L.hds = R.hds; L.hdw = R.hdw; L.hde = R.hde;
      this.event = EV_NONE; this.eventCounter = NEVER;
      this.tileCount = 0; this.screenX = 0;
      const displayStart = (this.hClock + this.hCounter + this._dots((L.hds + 1) * 8)) & 0xFFFF;
      if (displayStart - this._dots(24) >= LINE) return;

      if (this.vMode === V_DW || this.rcr === this.host.vce.lines - 1) {
        const width = this._dots((L.hdw + 1) * 8);
        // スプライトの選び出しは、映る行すべてと、絵が始まる 1 つ前の行で走る
        const start = (displayStart - this._dots(16)) & 0xFFFF;
        this.evalStart = start; this.evalLast = 0;
        this.evalEnd = Math.min(LINE, (start + width + this._dots(8)) & 0xFFFF);
        if (this.vMode === V_DW) {
          this.loadBgStart = start; this.loadBgLast = 0;
          this.loadBgEnd = Math.min(LINE, (start + width + this._dots(16)) & 0xFFFF);
        }
      }

      let lead;
      if (this.vMode === V_DW) { this.event = EV_LATCH_Y; lead = this._dots(34); }
      else { this.event = EV_HDS_IRQ; lead = this._dots(25); }
      if (displayStart - lead <= this.hClock) this._event();
      else this.eventCounter = displayStart - lead - this.hClock;
    }

    _event() {
      this.draw();
      switch (this.event) {
        case EV_LATCH_Y:
          this.needVClock = true;
          this.latchClockY = this.hClock;
          this._incScrollY();
          if (!this.burst) { this.bgOn = this.nextBg; this.sprOn = this.nextSpr; }
          this.event = EV_LATCH_X; this.eventCounter = this._dots(2);
          break;
        case EV_LATCH_X:
          this.lat.bxr = this.reg.bxr;
          this.latchClockX = this.hClock;
          this.event = EV_HDS_IRQ; this.eventCounter = this._dots(6);
          break;
        case EV_HDS_IRQ:
          // 行が始まる所だったのにスプライトを選ぶ時間が無かった: 次の行はスプライト無し
          if (this.evalStart >= LINE) this.spriteCount = 0;
          this._hdsIrqs();
          this.event = EV_NONE; this.eventCounter = NEVER;
          break;
        case EV_INC_RCR:
          this._incRcr();
          this.event = EV_NONE; this.eventCounter = NEVER;
          break;
        default: break;
      }
    }

    _hdsIrqs() {
      if (this.needVblank) this._vblank();
      if (this.spriteOverflow && this.enOverflow) { this.status |= ST_OVERFLOW; this.irq = true; }
      this.spriteOverflow = false;
    }

    // 表示が終わった所。垂直帰線の印と割り込みは許可(R05 bit3)の時だけ。予約されていた SATB の転送はここから始まる
    _vblank() {
      if (this.enVblank) { this.status |= ST_VBLANK; this.irq = true; }
      this.needVblank = false;
      this.allowDma = true;
      if (this.satbPending || this.repeatSatb) { this.satbPending = false; this.satbRunning = true; this.satbCounter = 0; this.satbOffset = 0; }
    }

    // ── 縦 ──
    _setVMode(m) {
      this.vMode = m;
      const L = this.lat;
      switch (m) {
        case V_DS: this.vCounter = L.vds + 2; break;
        case V_DW: this.allowDma = false; this.vCounter = L.vdw + 1; this.rcr = 0; break;
        case V_DE: this.vCounter = L.vcr; break;
        default: { // 垂直同期の頭: 縦のレジスタと、VRAM の幅・仮想画面の大きさを取り込む
          const R = this.reg;
          L.vsw = R.vsw; L.vds = R.vds; L.vdw = R.vdw; L.vcr = R.vcr;
          L.vramMode = R.vramMode; L.sprMode = R.sprMode; L.rows = R.rows; L.cols = R.cols;
          this.vCounter = L.vsw + 1;
          break;
        }
      }
    }

    _clockV() {
      if (--this.vCounter === 0) this._setVMode((this.vMode + 1) & 3);
      this.needVClock = false;
    }

    _incRcr() {
      this.rcr = (this.rcr + 1) & 0xFFFF;
      this.needRcrInc = false;
      this._clockV();
      if (this.vMode === V_DE && this.rcr === this.lat.vdw + 1) { this.needVblank = true; this.vblankDone = true; }
      // 走査線の割り込み(R06 と比べる。$40 が画面の 1 行目)
      if (this.enRcr && this.rcr === this.rcrReg - 0x40) { this.status |= ST_RCR; this.irq = true; }
    }

    _incScrollY() {
      const L = this.lat;
      if (this.rcr === 0) L.byr = this.reg.byr;
      else {
        if (this.byrPending) { L.byr = this.reg.byr; this.byrPending = false; }
        L.byr = (L.byr + 1) & 0xFFFF;
      }
    }

    _endOfLine() {
      this.draw();
      this.hClock = 0;
      this.scanline++;
      this.latchClockX = NEVER; this.latchClockY = NEVER;
      if (this.scanline === LAST_LINE) {
        this.frameCount++;
        if (!this.isVdc2 && this.host.onVdcFrame) this.host.onVdcFrame();
      } else if (this.scanline >= this.host.vce.lines) {
        this.scanline = 0;
        this.vblankDone = false;
        // 画面の頭で、BG もスプライトも切なら「バースト」(その画面のあいだ石は VRAM を読まない)
        this.burst = !this.nextBg && !this.nextSpr;
        this.bgOn = this.nextBg; this.sprOn = this.nextSpr;
      }
      if (!this.isVdc2 && this.host.vdcLineStart) this.host.vdcLineStart();
      if (this.scanline >= FIRST_LINE && this.scanline < LAST_LINE) this.rowDiv[this.scanline - FIRST_LINE] = this.host.vce.divider;

      if (this.needRcrInc) this._incRcr();
      else if (this.needVClock) this._clockV();

      if (this.hMode === H_DW) this.loadSpriteStart = this._dots(36);
      if (this.hMode !== H_SW) { this.hMode = H_SW; this.hsyncStartClock = this.host.clock; }
      this.loadBgStart = NEVER; this.evalStart = NEVER;
      this.hCounter = this._dots(this.host.vce.divider === 3 ? 32 : 24);
      this.xStart = 0; this.lastDrawHClock = 0;
      this._hsyncStart();

      const lines = this.host.vce.lines;
      if (this.scanline === lines - 3) this._setVMode(V_SW);
      else if (this.scanline === lines - 2 && !this.vblankDone) this.needVblank = true;
    }

    // ── VRAM ──
    _readVram(addr) {
      addr &= 0xFFFF;
      if (addr < 0x8000) return (this.openBus = this.vram[addr]);
      return this.openBus;
    }

    // スプライトの選び出し。1 枚に 4 ドットかけて 64 枚を順に見て、次の行に掛かる物を 16 個(幅 32 は 2 個ぶん)まで拾う
    _evalSprites() {
      if (this.hClock < this.evalStart || this.evalLast >= 64 || this.burst) return;
      const div = this.host.vce.divider;
      const end = Math.floor((Math.min(this.evalEnd, this.hClock) - this.evalStart) / div / 4);
      if (this.evalLast >= end) return;
      if (this.evalLast === 0) {
        this._loadSpriteTiles(); // 前の回に選んだ物を「今の行に描く物」へ
        this.spriteCount = 0;
        this.spriteRow = (this.rcr + 1) % this.host.vce.lines;
      }
      const satb = this.satb, row = this.spriteRow;
      for (let i = this.evalLast; i < end; i++) {
        if (i >= 64) break;
        const y = (satb[i * 4] & 0x3FF) - 64;
        if (row < y) continue;
        const flags = satb[i * 4 + 3];
        const hsel = (flags >> 12) & 3;
        const height = hsel === 0 ? 16 : hsel === 1 ? 32 : 64;
        if (row >= y + height) continue;
        const line = row - y;
        const vflip = (flags & 0x8000) !== 0, hflip = (flags & 0x0800) !== 0;
        const l2 = vflip ? height - line - 1 : line;
        const yOffset = l2 & 0x0F, rowOffset = l2 >> 4;
        let tile = (satb[i * 4 + 2] & 0x7FF) >> 1;
        const sp23 = satb[i * 4 + 2] & 1;
        const width = (flags & 0x100) ? 32 : 16;
        if (width === 32) tile &= ~1;
        if (height === 32) tile &= ~2; else if (height === 64) tile &= ~6;
        const tileY = tile | (rowOffset << 1);
        for (let x = 0; x < width; x += 16) {
          if (this.spriteCount >= 16) { this.spriteOverflow = true; break; }
          const col = hflip ? (width - x - 1) >> 4 : x >> 4;
          const n = this.spriteCount++;
          this.sIdx[n] = i;
          this.sX[n] = (satb[i * 4 + 1] & 0x3FF) - 32 + x;
          this.sAddr[n] = ((tileY | col) * 64 + yOffset) & 0xFFFF;
          this.sFlag[n] = (hflip ? 1 : 0) | ((flags & 0x80) ? 2 : 0) | (sp23 ? 4 : 0);
          this.sPal[n] = flags & 0x0F;
        }
      }
      this.evalLast = end;
    }

    // 選んだスプライトの絵を VRAM から読む。表示の終わりから次の BG の取り込みまでの時間で読める枚数だけ
    _loadSpriteTiles() {
      this.drawCount = 0;
      this.rowHasSprite0 = false;
      if (this.burst || (this.loadSpriteStart >= this.loadBgStart && this.loadSpriteStart < this.loadBgEnd)) return;
      const div = this.host.vce.divider;
      const clocks = this.loadSpriteStart > this.loadBgStart ? (LINE - this.loadSpriteStart) + this.loadBgStart : this.loadBgStart - this.loadSpriteStart;
      const mode = this.lat.sprMode;
      const per = mode === 2 ? 8 : mode === 3 ? 16 : 4;
      this.xHas.fill(0);
      this.drawCount = Math.min(this.spriteCount, Math.floor(clocks / div / per));
      this.totalCount = this.drawCount;
      let has0 = false;
      for (let i = 0; i < this.totalCount; i++) {
        this.dIdx[i] = this.sIdx[i]; this.dX[i] = this.sX[i]; this.dFlag[i] = this.sFlag[i]; this.dPal[i] = this.sPal[i];
        const x = this.sX[i] + 32;
        for (let k = 0; k < 16; k++) this.xHas[x + k] = 1;
        const a = this.sAddr[i];
        if (mode !== 1) {
          this.dData[i * 4] = this._readVram(a); this.dData[i * 4 + 1] = this._readVram(a + 16);
          this.dData[i * 4 + 2] = this._readVram(a + 32); this.dData[i * 4 + 3] = this._readVram(a + 48);
        } else { // 2 面だけ読む幅。どちらの 2 面かはスプライトの番地の bit0
          const b = a + ((this.sFlag[i] & 4) ? 32 : 0);
          this.dData[i * 4] = this._readVram(b); this.dData[i * 4 + 1] = this._readVram(b + 16);
          this.dData[i * 4 + 2] = 0; this.dData[i * 4 + 3] = 0;
        }
        if (this.sIdx[i] === 0) has0 = true;
      }
      // スプライト 0 が居る行は 1 サイクルごとに描く(衝突の割り込みの時刻を合わせるため)
      if (has0 && this.drawCount > 1) this.rowHasSprite0 = true;
    }

    // BG の取り込み。8 ドットで 1 タイル(BAT → 面 0/1 → 面 2/3)。空いたドットは CPU が VRAM を使える
    _loadBg() {
      if (this.hClock < this.loadBgStart || this.burst) return;
      const div = this.host.vce.divider;
      const end = Math.floor((Math.min(this.loadBgEnd, this.hClock) - this.loadBgStart) / div);
      if (this.loadBgLast >= end) return;
      const L = this.lat;
      const colMask = L.cols - 1, scroll = L.bxr >> 3, y = L.byr & (L.rows * 8 - 1);
      const mode = L.vramMode;
      for (let i = this.loadBgLast; i < end; i++) {
        const n = this.tileCount & (MAX_TILES - 1);
        const ph = i & 7;
        if (mode === 0) {
          if (!(ph & 1)) this.cpuSlot = true;
          else if (ph === 1) this._loadBat(n, scroll, colMask, y);
          else if (ph === 3) this.cpuSlot = false;
          else if (ph === 5) { this.tD0[n] = this._readVram(this.tAddr[n] + (y & 7)); this.cpuSlot = false; }
          else { this.tD1[n] = this._readVram(this.tAddr[n] + (y & 7) + 8); this.cpuSlot = false; this.tileCount++; }
        } else if (mode === 3) { // 1 回の読みに 4 ドット。CPU の枠は無く、面は 2 つだけ
          this.cpuSlot = false;
          if (ph === 3) this._loadBat(n, scroll, colMask, y);
          else if (ph === 7) { this.tD0[n] = this._readVram(this.tAddr[n] + (y & 7)); this.tD1[n] = 0; this.tileCount++; }
        } else {                // 1 回の読みに 2 ドット
          this.cpuSlot = false;
          if (ph === 1) this._loadBat(n, scroll, colMask, y);
          else if (ph === 2 || ph === 3) this.cpuSlot = true;
          else if (ph === 5) { this.tD0[n] = this._readVram(this.tAddr[n] + (y & 7)); this.cpuSlot = false; }
          else if (ph === 7) { this.tD1[n] = this._readVram(this.tAddr[n] + (y & 7) + 8); this.cpuSlot = false; this.tileCount++; }
        }
      }
      this.loadBgLast = end;
    }
    _loadBat(n, scroll, colMask, y) {
      const col = (scroll + this.tileCount) & colMask;
      const e = this._readVram((y >> 3) * this.lat.cols + col);
      this.tPal[n] = e >> 12;
      this.tAddr[n] = ((e & 0xFFF) * 16) & 0xFFFF;
      this.cpuSlot = false;
    }

    /** 今の横位置まで、この行の絵を描き足す */
    draw() {
      if (this.scanline < FIRST_LINE || this.scanline >= LAST_LINE) return;
      this._evalSprites();
      this._loadBg();
      this._render();
    }

    _render() {
      const vce = this.host.vce, div = vce.divider, pal = vce.pal, row = this.row;
      let x = this.xStart;
      const xMax = Math.min(ROW_W, x + Math.floor((this.hClock - this.lastDrawHClock) / div));
      const gray = vce.grayscale ? GRAY : 0;
      const inPicture = this.hMode === H_DW && this.tileCount > 0;
      if (inPicture && (this.bgOn || this.sprOn)) {
        const bgOn = this.bgOn, sprOn = this.sprOn, total = this.totalCount, fine = this.lat.bxr & 7;
        const xHas = this.xHas, dX = this.dX, dFlag = this.dFlag, dData = this.dData, dIdx = this.dIdx, dPal = this.dPal;
        for (; x < xMax; x++) {
          let color = pal[0] | TRANSPARENT, bg = 0;
          const sx = this.screenX;
          if (bgOn) {
            const px = fine + sx, t = (px >> 3) & (MAX_TILES - 1), sh = 7 - (px & 7);
            const c0 = this.tD0[t], c1 = this.tD1[t];
            bg = ((c0 >> sh) & 1) | (((c0 >> (sh + 8)) & 1) << 1) | (((c1 >> sh) & 1) << 2) | (((c1 >> (sh + 8)) & 1) << 3);
            if (bg) color = pal[this.tPal[t] * 16 + bg];
          }
          if (total > 0 && sprOn && xHas[sx + 32]) {
            let over0 = false; // スプライト 0 の上にもう 1 枚重なるかを見ている最中
            for (let i = 0; i < total; i++) {
              let o = sx - dX[i];
              if (o < 0 || o >= 16) continue;
              if (!(dFlag[i] & 1)) o = 15 - o;
              const c = ((dData[i * 4] >> o) & 1) | (((dData[i * 4 + 1] >> o) & 1) << 1) | (((dData[i * 4 + 2] >> o) & 1) << 2) | (((dData[i * 4 + 3] >> o) & 1) << 3);
              if (!c) continue;
              if (over0) {
                if (this.enCollision && i < this.drawCount) { this.status |= ST_COLLISION; this.irq = true; }
              } else if (bg === 0 || (dFlag[i] & 2)) {
                color = pal[256 + dPal[i] * 16 + c] | SPRITE;
              }
              if (dIdx[i] === 0 && this.rowHasSprite0) over0 = true; else break;
            }
          }
          row[x] = color | gray;
          this.screenX = sx + 1;
        }
      } else {
        // 絵の中だが BG もスプライトも切 = 背景色。絵の外 = 枠の色(スプライトのパレット 0 番)
        const color = (inPicture ? pal[0] : pal[256]) | TRANSPARENT;
        for (; x < xMax; x++) row[x] = color;
      }
      if (this.hClock === LINE) {
        // 行の終わり。SuperGrafx は本体(優先順位の石)が 2 個ぶんを重ねてから消す。普通の本体はそのまま out へ
        if (this.host.vdcRowEnd) this.host.vdcRowEnd(this, this.scanline);
        else { this.out.set(row.subarray(0, ROW_W), (this.scanline - FIRST_LINE) * ROW_W); row.fill(0); }
      }
      this.xStart = x;
      this.lastDrawHClock = Math.floor(this.hClock / div) * div;
    }

    // ── CPU からの VRAM の読み書き(待たされる) ──
    _vramAccess() {
      if (this.transferDelay) { this.transferDelay -= 3; if (this.transferDelay > 0) return; }
      this.transferDelay = 0;
      const div = this.host.vce.divider;
      const inBgFetch = !this.burst && this.hClock >= this.loadBgStart && this.hClock < this.loadBgEnd && this.scanline >= FIRST_LINE && this.scanline < LAST_LINE;
      const oddDot = (Math.floor(this.hClock / div) & 1) !== 0;
      let blocked;
      if (this.vMode !== V_DW || this.burst || ((!this.sprOn || this.spriteCount === 0) && !inBgFetch)) {
        // 垂直帰線中・バースト中・読むスプライトが無い時: 1 ドットおきに通る。DMA 中は全部止まる
        blocked = this.satbRunning || this.dmaRunning || oddDot;
      } else {
        blocked = inBgFetch && !this.cpuSlot;
        if (!blocked && !inBgFetch && this.sprOn) {
          // スプライトの絵を読んでいる間は止まる。読み終わったら 1 ドットおき
          const clocks = this.hClock > this.loadBgEnd ? this.hClock - this.loadBgEnd : LINE - this.loadBgEnd + this.hClock;
          const mode = this.lat.sprMode, per = mode === 2 ? 8 : mode === 3 ? 16 : 4;
          blocked = Math.floor(clocks / div) < this.spriteCount * per ? true : oddDot;
        }
      }
      if (blocked) return;
      if (this.hMode === H_SW && this.host.clock - this.hsyncStartClock < 8 * div) return;
      if (this.pendingRead) {
        this.readBuf = this._readVram(this.marr);
        this.marr = (this.marr + this.inc) & 0xFFFF;
        this.pendingRead = false;
      } else if (this.pendingWrite) {
        if (this.mawr < 0x8000) this.vram[this.mawr] = this.vramData;
        this.mawr = (this.mawr + this.inc) & 0xFFFF;
        this.pendingWrite = false;
      }
    }
    _queueRead() { this.pendingRead = true; const d = this.host.vce.divider; this.transferDelay = d === 2 ? 15 : 24; }
    _queueWrite() { this.pendingWrite = true; const d = this.host.vce.divider; this.transferDelay = d === 2 ? 12 : d === 3 ? 18 : 21; }
    // 前の読み書きが通るまで CPU を止める
    _wait() {
      let guard = 0;
      while ((this.pendingRead || this.pendingWrite) && ++guard < 200000) { this.host.execFast(); this.draw(); }
    }

    // ── DMA ──
    _dmaAllowed() {
      if (!this.allowDma && !this.burst) return false; // 表示中は走らない
      if (this.hMode === H_SW && this.host.clock - this.hsyncStartClock <= this._dots(8)) return false;
      return true;
    }
    // VRAM → スプライト表(256 語)。4 ドットに 1 語
    _satbStep() {
      if (!this._dmaAllowed()) return;
      const div = this.host.vce.divider;
      this.satbCounter += 3;
      if (Math.floor(this.satbCounter / div) >= 4) {
        this.satbCounter -= 4 * div;
        this.satb[this.satbOffset] = this._readVram(this.satbSrc + this.satbOffset);
        this.satbOffset = (this.satbOffset + 1) & 0xFF;
        if (this.satbOffset === 0) {
          this.satbRunning = false;
          if (this.satbIrqEn) { this.status |= ST_SATB; this.irq = true; }
        }
      }
    }
    // VRAM → VRAM。読みと書きに 2 ドットずつ
    _dmaStep() {
      if (!this._dmaAllowed()) return;
      this.dmaPendingClocks += 3;
      const per = this.host.vce.divider * 2;
      while (this.dmaPendingClocks >= per) {
        if (this.dmaReadCycle) {
          this.dmaBuf = this._readVram(this.blockSrc);
          this.dmaReadCycle = false;
        } else {
          this.blockLen = (this.blockLen - 1) & 0xFFFF;
          if (this.blockDst < 0x8000) this.vram[this.blockDst] = this.dmaBuf;
          this.blockSrc = (this.blockSrc + (this.decSrc ? -1 : 1)) & 0xFFFF;
          this.blockDst = (this.blockDst + (this.decDst ? -1 : 1)) & 0xFFFF;
          this.dmaReadCycle = true;
          if (this.blockLen === 0xFFFF) {
            this.dmaRunning = false; this.dmaPendingClocks = 0;
            if (this.dmaIrqEn) { this.status |= ST_DMA; this.irq = true; }
            break;
          }
        }
        this.dmaPendingClocks -= per;
      }
    }

    // ── ポート ──
    read(port) {
      this.draw();
      switch (port & 3) {
        case 0: {
          const v = this.status | ((this.pendingRead || this.pendingWrite) ? ST_BUSY : 0);
          this.status = 0; this.irq = false; // 読むと印と割り込みの線が消える
          return v;
        }
        case 1: return 0;
        case 2:
          if (this.pendingRead) this._wait();
          return this.readBuf & 0xFF;
        default: {
          if (this.pendingRead) this._wait();
          const v = this.readBuf >> 8;
          if (this.currentReg === 0x02) this._queueRead(); // 読み番地が進むのは R02 を選んでいる時だけ
          return v;
        }
      }
    }

    _latchWindow(clock) {
      const div = this.host.vce.divider;
      const start = Math.floor(clock / div) * div, end = start + ((div + 1) >> 1);
      return this.hClock > start && this.hClock < end;
    }

    write(port, value) {
      this.draw();
      port &= 3;
      if (port === 0) { this.currentReg = value & 0x1F; return; }
      if (port === 1) return;
      const msb = port === 3, R = this.reg;
      const put = (old, mask) => (msb ? (old & 0xFF) | (value << 8) : (old & 0xFF00) | value) & mask;
      switch (this.currentReg) {
        case 0x00: this._wait(); this.mawr = put(this.mawr, 0xFFFF); break;
        case 0x01: this._wait(); this.marr = put(this.marr, 0xFFFF); if (msb) this._queueRead(); break;
        case 0x02: this._wait(); this.vramData = put(this.vramData, 0xFFFF); if (msb) this._queueWrite(); break;
        case 0x05:
          if (msb) this.inc = [1, 0x20, 0x40, 0x80][(value >> 3) & 3];
          else {
            this.enCollision = (value & 0x01) !== 0; this.enOverflow = (value & 0x02) !== 0;
            this.enRcr = (value & 0x04) !== 0; this.enVblank = (value & 0x08) !== 0;
            this.nextSpr = (value & 0x40) !== 0; this.nextBg = (value & 0x80) !== 0;
            if (this._latchWindow(this.latchClockY) && !this.burst) { this.sprOn = this.nextSpr; this.bgOn = this.nextBg; }
          }
          break;
        case 0x06: this.rcrReg = put(this.rcrReg, 0x3FF); break;
        case 0x07:
          R.bxr = put(R.bxr, 0x3FF);
          if (this._latchWindow(this.latchClockX)) this.lat.bxr = R.bxr;
          break;
        case 0x08:
          R.byr = put(R.byr, 0x1FF);
          this.byrPending = true;
          if (this._latchWindow(this.latchClockY)) this._incScrollY();
          break;
        case 0x09:
          if (!msb) {
            const w = (value >> 4) & 3;
            R.cols = w === 0 ? 32 : w === 1 ? 64 : 128;
            R.rows = (value & 0x40) ? 64 : 32;
            R.vramMode = value & 3; R.sprMode = (value >> 2) & 3;
          }
          break;
        case 0x0A: if (msb) R.hds = value & 0x7F; else R.hsw = value & 0x1F; break;
        case 0x0B: if (msb) R.hde = value & 0x7F; else R.hdw = value & 0x7F; break;
        case 0x0C: if (msb) R.vds = value; else R.vsw = value & 0x1F; break;
        case 0x0D: R.vdw = put(R.vdw, 0x1FF); break;
        case 0x0E: if (!msb) R.vcr = value; break;
        case 0x0F:
          if (!msb) {
            this.satbIrqEn = (value & 0x01) !== 0; this.dmaIrqEn = (value & 0x02) !== 0;
            this.decSrc = (value & 0x04) !== 0; this.decDst = (value & 0x08) !== 0; this.repeatSatb = (value & 0x10) !== 0;
          }
          break;
        case 0x10: this.blockSrc = put(this.blockSrc, 0xFFFF); break;
        case 0x11: this.blockDst = put(this.blockDst, 0xFFFF); break;
        case 0x12: this.blockLen = put(this.blockLen, 0xFFFF); if (msb) { this.dmaRunning = true; this.dmaReadCycle = true; } break;
        case 0x13: this.satbSrc = put(this.satbSrc, 0xFFFF); if (msb) this.satbPending = true; break;
        default: break;
      }
    }
  }

  PceVdc.ROW_W = ROW_W;
  PceVdc.ROWS = ROWS;
  PceVdc.FIRST_LINE = FIRST_LINE;
  PceVdc.TRANSPARENT = TRANSPARENT;
  PceVdc.SPRITE = SPRITE;
  Emu.PceVdc = PceVdc;
})(typeof window !== 'undefined' ? window : globalThis);
