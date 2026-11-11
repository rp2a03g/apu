/*
 * MSX VDP (MML.Emu.MsxVdp) — TMS9918A / V9938 / V9958 を 1 本で(DESIGN-MSX-CAPTURE.md §3.4、段階 7a/7c)
 *
 * 画面モード: TMS9918 系(GRAPHIC1=SCREEN1、GRAPHIC2=SCREEN2、MULTICOLOR=SCREEN3、TEXT1=SCREEN0)+スプライトモード 1、
 * V9938(7c): GRAPHIC3=SCREEN4、GRAPHIC4=SCREEN5(256×212 4bpp)、GRAPHIC5=SCREEN6(512×212 2bpp)、GRAPHIC6=SCREEN7(512×212 4bpp)、
 * GRAPHIC7=SCREEN8(256×212 8bpp GRB332)、TEXT2=SCREEN0 WIDTH80 と スプライトモード 2(行 8 枚、行ごとの色、EC/CC/IC)、
 * 212 ライン、縦スクロール(R23)、パレット 16×9bit、ライン割り込み(R19/S1)、ステータス S0〜S9、VDP コマンド(下記)。
 * V9958(7e): 横スクロール(R26 bit0-4 ×8 ドット、R27 bit0-2 の右ずらし、R25 bit0 SP2=2 ページ(ページは R26 bit5、R2 の bit5 は無視)、
 * R25 bit1 MSK=左 8 ドットをボーダー色で隠す。全モードに効き、スプライトは動かない)、YJK(R25 bit3、GRAPHIC7 のバイト列を 4 ドット 1 組の
 * Y5+J6/K6 で色にする=SCREEN12。R25 bit4 YAE=バイトの bit3 が 1 のドットはパレット(bit7-4)=SCREEN10/11)、R25 bit6 CMD=ビットマップ以外の
 * モードでもコマンドが動く(GRAPHIC7 の配置として扱う: openMSX の挙動の記憶による推定)。S1 bit2 で V9958 を名乗る。
 * YJK の frameIdx(巻き戻し用)は GRB332 への丸め(表示は frame の正確な色)。
 * インターレース(R9 bit3 IL): フレームを 480 行にし、偶奇フィールドを交互の行に描く(frameHeight が 480 になる。interlaced で分かる)。
 * EO(R9 bit2): フィールドごとに名前表のページ(R2 bit5)を 0/1 に切り替える(IL 無しなら 240 行のままフレームごとに切替)。巻き戻し用の frameIdx は偶数フィールドだけ。
 *
 * ■ 時間
 *   行単位。1 行 = 228 Z80 サイクル(VDP 1368 サイクル/6)、NTSC 262 行・PAL(R9 bit1)313 行。1 行の終わりでその行を描く
 *   (行の途中の VRAM 書き込みは行全体に効く近似)。フレームの区切り(本体が録音/画面送出に使う)は表示の最終行の次=F フラグが
 *   立つ行の頭(vblankStarted)。VRAM アクセススロットの待ちは模擬しない。
 * ■ VDP コマンド(R32〜R46。R46 の上位 4bit が命令、下位 4bit が論理演算)
 *   HMMC/YMMM/HMMM/HMMV/LMMC/LMCM/LMMM/LMMV/LINE/SRCH/PSET/POINT/STOP。GRAPHIC4〜7 でだけ動く(V9938 と同じ。V9958 の他モード対応は 7e)。
 *   時間は openMSX の表(表示中・スプライト有効)を Z80 サイクルに丸めた近似: 1 ドットあたり HMMV 8 / HMMM 15 / YMMM 11 / LMMV 12 /
 *   LMMM 20 / LINE 20 / PSET 12 / SRCH 15 / POINT 8。VBlank 中と表示 OFF は半分。MSX2 のゲームは S2 の CE で完了を待つので
 *   速すぎても遅すぎても画が変わる(近似であることに注意)。HMMC/LMMC は CPU の R44 書き込みに合わせて 1 ドットずつ進む(TR)。
 * ■ 出力
 *   frame(Uint32Array、ABGR)。幅はそのフレームのモードで 256 か 512(frameWidth。GRAPHIC5/6・TEXT2 が 512)、高さ 240。
 *   192 行は上下 24 行、212 行は上下 14 行がボーダー。frameIdx(Uint8Array 256×240)は巻き戻しの映像の輪用: 幅 512 のモードは 1 ドットおき、
 *   GRAPHIC7 のフレームはパレット番号でなく GRB332 の値(frameIdxKind=1。表示色は MsxVdp.G7_PALETTE)。
 *   幅の違う行(フレームの途中でモードを変えた)はフレームの幅に合わせて 2 倍/間引きで描く。
 *
 * レジスタの要点:
 *   R0: bit1-3 M3/M4/M5、bit4 IE1(ライン割り込み)  R1: bit6 BL(表示)、bit5 IE0、bit4 M1、bit3 M2、bit1 SI(16×16)、bit0 MAG
 *   R2 名前表(G1-3/T1: ×$400、G4/5: bit6-5=A16-15、G6/7: bit5=A16、T2: bit6-2 ×$1000)  R3/R10 色表  R4 パターン表  R5/R11 スプライト属性表
 *   R6 スプライトパターン ×$800  R7 文字色<<4|背景色(G7 ではボーダー色 8bit)  R8: bit1 SPD(スプライト無効)、bit5 TP(色 0 もパレット)
 *   R9: bit7 LN(212 行)、bit1 NT(PAL)  R12/R13 TEXT2 の点滅色/周期(未対応: 常に文字色)  R14: VRAM 番地の A16-14  R15: 読むステータス番号
 *   R16/R17: パレット/間接レジスタの番地  R18: 表示位置調整(縦のみ反映)  R19: ライン割り込みの行  R23: 縦スクロール
 *   R25(V9958): bit0 SP2、bit1 MSK、bit3 YJK、bit4 YAE、bit6 CMD  R26/R27(V9958): 横スクロール(上記)
 *   R32-R46: コマンドの SX/SY/DX/DY/NX/NY/CLR/ARG/CMD
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const W = 256, WIDE = 512, H = 240;
  const CYCLES_PER_LINE = 228;
  const LINES_NTSC = 262, LINES_PAL = 313;

  // TMS9918A の固定パレット(RGB)。V9938 の初期パレットは同じ色の 3bit 版
  const TMS_RGB = [
    [0, 0, 0], [0, 0, 0], [33, 200, 66], [94, 220, 120], [84, 85, 237], [125, 118, 252], [212, 82, 77], [66, 235, 245],
    [252, 85, 84], [255, 121, 120], [212, 193, 84], [230, 206, 128], [33, 176, 59], [201, 91, 186], [204, 204, 204], [255, 255, 255],
  ];
  const V9938_DEFAULT_PALETTE = [ // [R,G,B] 各 0-7
    [0, 0, 0], [0, 0, 0], [1, 6, 1], [3, 7, 3], [1, 1, 7], [2, 3, 7], [5, 1, 1], [2, 6, 7],
    [7, 1, 1], [7, 3, 3], [6, 6, 1], [6, 6, 4], [1, 4, 1], [6, 2, 5], [5, 5, 5], [7, 7, 7],
  ];
  function abgr(r, g, b) { return (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0; }
  const TMS_PALETTE = new Uint32Array(16);
  for (let i = 0; i < 16; i++) TMS_PALETTE[i] = abgr(TMS_RGB[i][0], TMS_RGB[i][1], TMS_RGB[i][2]);
  const LEVEL3 = [0, 36, 73, 109, 146, 182, 219, 255];
  const LEVEL5 = Array.from({ length: 32 }, (_, i) => Math.round(i * 255 / 31)); // YJK の 5bit
  const LEVEL2 = [0, 85, 170, 255];
  // GRAPHIC7 の 8bit 色(GGGRRRBB → 表示色)
  const G7_PALETTE = new Uint32Array(256);
  for (let c = 0; c < 256; c++) G7_PALETTE[c] = abgr(LEVEL3[(c >> 2) & 7], LEVEL3[(c >> 5) & 7], LEVEL2[c & 3]);
  // GRAPHIC7 のスプライト色(パレットでなく固定の 8bit 色。V9938 の仕様表の GRB)
  const G7_SPRITE_COLOR = [0x00, 0x02, 0x03, 0x07, 0x24, 0x64, 0x80, 0x1B, 0xC0, 0xE4, 0x90, 0xB5, 0x0C, 0xD6, 0xDB, 0xFF];

  // コマンドの 1 ドットあたりの時間(Z80 サイクル、表示中)。VBlank/表示 OFF は半分(_cmdCost)
  // コマンド 1 歩(H 系はバイト、L 系/LINE/SRCH はドット)の所要時間。VDP の 21.48MHz 刻み(Z80 の 6 倍)で [表示 OFF/帰線, 表示 ON+スプライトあり, 表示 ON+スプライトなし]。
  // 2026-11-11: openMSX の VDPCmdEngine の表の記憶(推定)。HMMV の表示 OFF(8.1 Z80 サイクル/バイト)とスプライトあり(VBlank 込みで 10.2)は openMSX の
  //  残り行数の減り方で実測して一致。以前は「表示 OFF と VBlank の間は半分」にしていて、画面を消して塗るゲームで 2 倍速になり流れが変わった
  const CMD_TICKS = { 0xC: [49, 65, 62], 0x8: [98, 137, 124], 0xE: [65, 125, 68], 0xD: [92, 136, 97], 0x9: [129, 197, 132], 0x7: [120, 147, 120], 0x6: [92, 125, 92], 0x5: [72, 72, 72], 0x4: [48, 48, 48] };

  class MsxVdp {
    /** @param {object} [opts] { type: 'tms9918' | 'v9938' | 'v9958', vramKB: 16 | 64 | 128 } */
    constructor(opts) {
      opts = opts || {};
      this.type = opts.type || 'v9938';
      this.isTms = this.type === 'tms9918';
      this.isV9958 = this.type === 'v9958';
      const kb = opts.vramKB || (this.isTms ? 16 : 128);
      this.vram = new Uint8Array(kb * 1024);
      this.vramMask = this.vram.length - 1;
      this.regs = new Uint8Array(64);
      this.status = new Uint8Array(10);
      this.palette = new Uint32Array(16);   // 表示色(ABGR)
      this.paletteRaw = new Uint16Array(16); // V9938 の 9bit 値(保存/録音用)
      this.frame = new Uint32Array(WIDE * H * 2); // 幅 256 のフレームは先頭 256×240 だけ使う(frameWidth)。インターレース中は 480 行(frameHeight)
      this.frameIdx = new Uint8Array(W * H);
      this.lineBuf = new Uint8Array(WIDE);   // 1 行の色番号(0 は透明=背景色)。G7 は 8bit 色そのもの
      this.sprBuf = new Uint8Array(W);       // 1 行のスプライト色(0 無し、bit4 = スプライトあり)
      this.lineRgb = new Uint32Array(W);     // YJK(V9958)の 1 行の表示色(lb は GRB332 への丸め。スプライトと索引は lb で)
      this.lineTmpA = new Uint8Array(WIDE); this.lineTmpB = new Uint8Array(WIDE); this.lineRgbA = new Uint32Array(W); this.lineRgbB = new Uint32Array(W); this.yjkBg = new Uint8Array(W); // 横スクロール/YJK の作業用
      this.onInt = null;                     // 割り込み線の変化(本体が見てもよい。線は intLine() で読む)
      this.reset();
    }

    reset() {
      this.regs.fill(0);
      this.status.fill(0);
      this.status[2] = 0x0C; // bit2-3 は常に 1(TR/CE は読むときにコマンドの状態から作る。ここでは BD=bit4 だけを持つ)
      this.vram.fill(0);
      this.addr = 0; this.latch = -1; this.readBuf = 0; this.palLatch = -1;
      this.line = 0;              // 今の行(0 = フレームの先頭。表示は displayStart 行から)
      this.cycle = 0;             // 行内のサイクル
      this.frameCount = 0;
      this.vblankStarted = false; // 表示の最終行の次の行の頭で立つ(本体が落とす)
      this.unsupportedMode = false;
      this.outW = W;              // 今描いているフレームの幅
      this.frameWidthOut = W;     // 本体に見せる幅(VBlank で確定)
      this.frameIdxKind = 0;      // 0=パレット番号、1=GRB332(G7)
      this.idxKindCur = 0;
      this.field = 0; this.ilCur = false; this.eoCur = false; this.frameHeightOut = H; this.interlacedOut = false; // インターレース(IL/EO)
      this.cmd = { op: 0, sx: 0, sy: 0, dx: 0, dy: 0, nx: 0, ny: 0, anx: 0, any: 0, clr: 0, arg: 0, lop: 0, dix: 1, diy: 1, cx: 0, cy: 0, maj: 0, eq: 0, lineAcc: 0, budget: 0, tr: false };
      for (let i = 0; i < 16; i++) this._setPalette(i, V9938_DEFAULT_PALETTE[i][0], V9938_DEFAULT_PALETTE[i][1], V9938_DEFAULT_PALETTE[i][2]);
      this.frame.fill(this.palette[0]); this.frameIdx.fill(0);
      this._updateTiming();
    }

    _setPalette(i, r, g, b) {
      this.paletteRaw[i] = (r << 8) | (g << 4) | b;
      this.palette[i] = this.isTms ? TMS_PALETTE[i] : abgr(LEVEL3[r & 7], LEVEL3[g & 7], LEVEL3[b & 7]);
    }

    // ── 画面モード ──
    get mode() {
      const r0 = this.regs[0], r1 = this.regs[1];
      // M1=R1 bit4, M2=R1 bit3, M3=R0 bit1, M4=R0 bit2, M5=R0 bit3 → ビット列 M5 M4 M3 M2 M1
      return ((r1 >> 4) & 1) | ((r1 >> 2) & 2) | ((r0 << 1) & 4) | ((r0 << 1) & 8) | ((r0 << 1) & 16);
    }
    static modeName(m) { return { 0: 'G1', 1: 'T1', 2: 'MC', 4: 'G2', 8: 'G3', 9: 'T2', 12: 'G4', 16: 'G5', 20: 'G6', 28: 'G7' }[m] || ('?' + m); }
    get isBitmap() { const m = this.mode; return m === 12 || m === 16 || m === 20 || m === 28; }
    get modeWidth() { const m = this.mode; return (m === 16 || m === 20 || m === 9) ? WIDE : W; }
    get displayLines() { return (!this.isTms && (this.regs[9] & 0x80)) ? 212 : 192; }
    get linesPerFrame() { return (!this.isTms && (this.regs[9] & 0x02)) ? LINES_PAL : LINES_NTSC; }
    get cyclesPerFrame() { return this.linesPerFrame * CYCLES_PER_LINE; }
    get displayEnabled() { return (this.regs[1] & 0x40) !== 0; }
    get frameWidth() { return this.frameWidthOut; }
    get frameHeight() { return this.frameHeightOut; } // 240、インターレース中は 480
    get interlaced() { return this.interlacedOut; }
    _row(fy) { return this.ilCur ? fy * 2 + this.field : fy; } // frame 上の行(インターレースはフィールドで交互)
    get frameIdxWidth() { return W; }
    _updateTiming() {
      // 表示の先頭行: 垂直同期 3 + 上の消去 13 + 上のボーダー(192 行: 26、212 行: 16)+ R18 の縦調整(符号付き 4bit)
      const adj = this.isTms ? 0 : (((this.regs[18] >> 4) ^ 8) - 8); // -7..+8 → 上へ/下へ
      this.displayStart = 3 + 13 + (this.displayLines === 212 ? 16 : 26) - adj;
      this.displayEnd = this.displayStart + this.displayLines; // この行の頭が VBlank の始まり
      this.frameY0 = this.displayLines === 212 ? 14 : 24;      // frame 上の表示開始 y
    }

    // ── 割り込み線 ──
    intLine() {
      return ((this.status[0] & 0x80) && (this.regs[1] & 0x20)) || ((this.status[1] & 0x01) && (this.regs[0] & 0x10));
    }
    // フレーム内の位置(0〜1)。フレームの頭 = VBlank の始まり(displayEnd 行)
    frameFrac() {
      const total = this.cyclesPerFrame;
      let l = this.line - this.displayEnd; if (l < 0) l += this.linesPerFrame;
      return (l * CYCLES_PER_LINE + this.cycle) / total;
    }
    get inVBlank() { return this.line < this.displayStart || this.line >= this.displayEnd; }

    // ── I/O ポート ──
    // 0x98 VRAM / 0x99 制御・ステータス / 0x9A パレット / 0x9B 間接レジスタ
    readPort(port) {
      switch (port & 3) {
        case 0: { // VRAM 読み: 先読みバッファを返し、次を読む
          const v = this.readBuf;
          this.readBuf = this.vram[this.addr & this.vramMask];
          this._incAddr();
          this.latch = -1;
          return v;
        }
        case 1: { // ステータス(R15 で選んだ物。TMS は S0 のみ)
          const n = this.isTms ? 0 : (this.regs[15] & 0x0F);
          this.latch = -1;
          if (n === 0) { const v = this.status[0]; this.status[0] &= 0x1F; return v; } // F/5S/C は読むと消える
          if (n === 1) { const v = this.status[1]; this.status[1] &= ~0x01; return v | (this.type === 'v9958' ? 0x04 : 0x00); } // FH は読むと消える。ID: V9958=bit2
          if (n === 2) { // TR/VR/HR/BD/CE
            const vr = this.inVBlank ? 0x40 : 0x00;
            const hr = this.cycle >= 200 ? 0x20 : 0x00; // 水平帰線(行末 28 サイクルを近似)
            const c = this.cmd;
            // TR はコマンドの最中でデータを受け渡せるときだけ 1。コマンドが無い間は 0(2026-11-11、openMSX の S#2 で確認: 待機中 $6C、HMMC 中 $ED。
            //  待機中 1 にしていたら、割り込み処理が S#2 を選んだまま割り込まれたゲームが「VBlank 来た」と読み違え、要因を消さずに戻って入れ子の割り込みでスタックがあふれた)
            return ((c.op && c.tr) ? 0x80 : 0x00) | 0x0C | vr | hr | (this.status[2] & 0x10) | (c.op ? 0x01 : 0x00);
          }
          if (n === 7) { const v = this.status[7]; if (this.cmd.op === 0xA) this._lmcmNext(); return v; } // LMCM: 読むと次のドットへ
          return n < 10 ? this.status[n] : 0xFF;
        }
        default: return 0xFF;
      }
    }
    writePort(port, v) {
      v &= 0xFF;
      switch (port & 3) {
        case 0: // VRAM 書き
          this.vram[this.addr & this.vramMask] = v;
          this.readBuf = v;
          this._incAddr();
          this.latch = -1;
          return;
        case 1: // 制御: 2 バイト目で レジスタ書き(bit7) / 番地設定(bit6=書き、0=読み先読み)
          if (this.latch < 0) { this.latch = v; return; }
          {
            const lo = this.latch; this.latch = -1;
            if (v & 0x80) { this.writeReg(v & 0x3F, lo); return; }
            const hi = (this.isTms ? 0 : (this.regs[14] & 0x07) << 14);
            this.addr = hi | ((v & 0x3F) << 8) | lo;
            if (!(v & 0x40)) { this.readBuf = this.vram[this.addr & this.vramMask]; this._incAddr(); }
          }
          return;
        case 2: // パレット(V9938): 1 バイト目 0RRR0BBB、2 バイト目 00000GGG → R16 が指す色、R16 を +1
          if (this.isTms) return;
          if (this.palLatch < 0) { this.palLatch = v; return; }
          {
            const i = this.regs[16] & 0x0F;
            this._setPalette(i, (this.palLatch >> 4) & 7, v & 7, this.palLatch & 7);
            this.palLatch = -1;
            this.regs[16] = (i + 1) & 0x0F;
          }
          return;
        case 3: // 間接レジスタ(V9938): R17 が指すレジスタへ。bit7 が 0 なら R17 を +1
          if (this.isTms) return;
          {
            const r = this.regs[17] & 0x3F;
            if (r !== 17) this.writeReg(r, v);
            if (!(this.regs[17] & 0x80)) this.regs[17] = (this.regs[17] & 0x80) | ((r + 1) & 0x3F);
          }
          return;
      }
    }
    // VRAM の番地を 1 進める。V9938 のモード(G3〜G7/T2)では下位 14bit が 0 に戻ったら R14 も +1(128K を通しで)、それ以外のモードと TMS は 16K の中で回る
    // (2026-11-11、openMSX の作りの記憶による推定)
    _incAddr() {
      const lo = (this.addr + 1) & 0x3FFF;
      if (this.isTms) { this.addr = lo; return; }
      if (lo === 0 && (this.mode & 0x18)) this.regs[14] = (this.regs[14] + 1) & 0x07;
      this.addr = (this.regs[14] << 14) | lo;
    }
    writeReg(r, v) {
      if (this.isTms) { if (r > 7) return; }
      else if (r >= 47) return;
      const old = this.regs[r];
      this.regs[r] = v;
      if (r === 9 || r === 18) this._updateTiming();
      if (r === 1 && ((old ^ v) & 0x20) && this.onInt) this.onInt(this.intLine());
      if (r === 0 && ((old ^ v) & 0x10) && this.onInt) this.onInt(this.intLine());
      if (r === 15) this.regs[15] = v & 0x0F;
      // R14(VRAM 番地の上位 3bit)は読み書きのたびに使われる: 番地(下位 14bit)を設定した後に R14 を書いても効く(2026-11-11。
      //  番地→R14 の順で書くゲームで、設定時の R14 で番地を決めていたため部品が別のページに書かれ画面が崩れていた)
      if (r === 14 && !this.isTms) { this.regs[14] = v & 0x07; this.addr = (this.regs[14] << 14) | (this.addr & 0x3FFF); }
      if (r === 44) this._cmdData(v);        // HMMC/LMMC のデータ
      else if (r === 46) this._cmdStart(v);  // コマンド開始
    }

    // ── 実行 ──
    /** Z80 の cycles サイクルぶん進める。行の終わりで描き、表示の最終行の次の行の頭で VBlank(F)を立てる */
    step(cycles) {
      if (this.cmd.op) this._cmdRun(cycles);
      this.cycle += cycles;
      while (this.cycle >= CYCLES_PER_LINE) {
        this.cycle -= CYCLES_PER_LINE;
        this._endLine();
      }
    }
    _endLine() {
      const l = this.line;
      if (l === this.displayStart) { this.outW = this.modeWidth; this.idxKindCur = (this.mode === 28) ? 1 : 0; this.ilCur = !this.isTms && (this.regs[9] & 0x08) !== 0; this.eoCur = !this.isTms && (this.regs[9] & 0x04) !== 0; } // このフレームの幅/索引の種類/インターレースはモードで決める
      if (l >= this.displayStart && l < this.displayEnd) this._renderLine(l - this.displayStart);
      // ライン割り込み(V9938): 表示行 R19(縦スクロール R23 ぶんずれる)の終わりで FH。FH は IE1(R0 bit4)が立っている時だけ立てる
      // (2026-11-11。IE1=0 でも立てていたら、割り込みのたびに S#1 の FH で「行割り込みか VBlank か」を見分けるゲームが
      //  VBlank を行割り込みと取り違え、空のラスタ表で BIOS の先頭を VDP レジスタへ流し込んで画面が崩れていた。openMSX も IE1 の時だけ、の記憶による推定)
      if (!this.isTms && (this.regs[0] & 0x10) && l >= this.displayStart && l < this.displayEnd) {
        const dl = l - this.displayStart;
        if (((dl + this.regs[23]) & 0xFF) === this.regs[19]) { this.status[1] |= 0x01; if (this.onInt) this.onInt(this.intLine()); }
      }
      this.line++;
      if (this.line >= this.linesPerFrame) { this.line = 0; }
      if (this.line === this.displayEnd) {
        // VBlank の頭: F フラグ、フレームの区切り。ボーダー行はここで一括で塗る(表示部は毎行描いた)
        this.status[0] |= 0x80;
        this._fillBorders();
        this.frameWidthOut = this.outW;
        this.frameIdxKind = this.idxKindCur;
        this.frameHeightOut = this.ilCur ? H * 2 : H; this.interlacedOut = this.ilCur;
        this.field = (this.ilCur || this.eoCur) ? (this.field ^ 1) : 0;
        this.frameCount++;
        this.vblankStarted = true;
        if (this.onInt && (this.regs[1] & 0x20)) this.onInt(true);
      }
    }
    _borderColor() { // 表示色と索引(G7 はボーダーも 8bit 色)
      if (this.mode === 28 && !this.isTms) { const c = this.regs[7]; return [G7_PALETTE[c], c]; }
      const bd = this.regs[7] & 0x0F;
      return [this.palette[bd], this.idxKindCur ? this._toGrb(bd) : bd];
    }
    _toGrb(palIdx) { const p = this.paletteRaw[palIdx]; return (((p >> 4) & 7) << 5) | (((p >> 8) & 7) << 2) | ((p & 7) >> 1); } // パレット → GRB332(G7 の索引に混ぜる時)
    _fillBorders() {
      const [c, ci] = this._borderColor();
      const ow = this.outW, y0 = this.frameY0, y1 = y0 + this.displayLines;
      if (this.ilCur) { for (let r = 0; r < H; r++) if (r < y0 || r >= y1) { const b = (r * 2 + this.field) * ow; this.frame.fill(c, b, b + ow); } }
      else { this.frame.fill(c, 0, y0 * ow); this.frame.fill(c, y1 * ow, H * ow); }
      if (!this.ilCur || this.field === 0) { this.frameIdx.fill(ci, 0, y0 * W); this.frameIdx.fill(ci, y1 * W); }
    }

    // 表示行 y(0〜displayLines-1)を描く
    _renderLine(y) {
      const regs = this.regs;
      const fy = this.frameY0 + y;
      if (fy >= H) return;
      const lb = this.lineBuf;
      const mode = this.mode;
      const mw = this.modeWidth;
      const g7 = mode === 28 && !this.isTms;
      let spritesOn = false;
      if (!this.displayEnabled) { lb.fill(0, 0, mw); }
      else {
        // 縦スクロール(V9938 R23): パターン行/ビットマップ行をずらす
        const sy = this.isTms ? y : ((y + regs[23]) & 0xFF);
        const yjk = g7 && this.isV9958 && (regs[25] & 0x08) !== 0;
        // 横スクロール(V9958 R26/R27): SP2 の 2 ページはビットマップでだけ(ページは R26 bit5 が R2 bit5 の代わり)
        const hs = this.isV9958 && ((regs[26] & 0x1F) || (regs[27] & 0x07));
        const sp2 = hs && (regs[25] & 0x01) && (mode === 12 || mode === 16 || mode === 20 || mode === 28);
        const r2eo = regs[2];
        if (this.eoCur && (mode === 12 || mode === 16 || mode === 20 || mode === 28)) regs[2] = (r2eo & ~0x20) | (this.field << 5); // EO: 偶奇フィールドでページ 0/1
        const r2 = regs[2];
        if (sp2) regs[2] = (r2 & ~0x20) | (regs[26] & 0x20);
        this._lineBg(mode, sy, lb, mw, yjk ? this.lineRgb : null);
        if (hs) this._hScroll(mode, sy, mw, sp2, yjk);
        if (sp2) regs[2] = r2;
        regs[2] = r2eo;
        if (yjk) this.yjkBg.set(lb.subarray(0, W)); // スプライトの前の背景(合成で「スプライトが上書きした所」を見分ける)
        if (mode !== 1 && mode !== 9 && !(regs[8] & 0x02)) {
          // スプライトの Y は縦スクロール後の行で比べる(V9938: スプライトも R23 で背景と一緒にずれる。2026-11-11、推定。
          //  画面の途中で R23 を変えるゲームで自機の表示が当たり判定より下にずれていた)
          if (this.isTms || mode === 0 || mode === 2 || mode === 4) this._spritesMode1(sy, lb, mw);
          else this._spritesMode2(sy, lb, mw, g7);
          spritesOn = true;
        }
      }
      void spritesOn;
      if (!this.isTms && (regs[18] & 0x0F)) this._hAdjust(lb, mw, g7);
      // 合成: frame(フレームの幅 outW に合わせる)と frameIdx(常に 256)
      const ow = this.outW, row = this._row(fy), base = row * ow, pal = this.palette, tp = !this.isTms && (regs[8] & 0x20);
      const frame = this.frame, idx = this.frameIdx, ibase = fy * W, wIdx = !this.ilCur || this.field === 0; // 巻き戻し用の索引は偶数フィールドだけ
      const [bdc, bdi] = this._borderColor();
      const kind = this.idxKindCur;
      if (g7) {
        // G7: lb は 8bit 色(ボーダー色 R7 を透明 0 の代わりに使う: 背景の 0 は黒ではなく 0 色そのもの。スプライトは _spritesMode2 が 8bit 色に直して上書き済み)
        // YJK(V9958): 背景の正確な色は lineRgb。lb が背景のまま(スプライトに上書きされていない)なら lineRgb を出す
        const yjk = this.isV9958 && this.displayEnabled && (regs[25] & 0x08) !== 0, rgb = this.lineRgb, bgc = this.yjkBg;
        for (let x = 0; x < W; x++) {
          const c = lb[x];
          const col = (yjk && c === bgc[x]) ? rgb[x] : G7_PALETTE[c];
          if (ow === W) { frame[base + x] = col; } else { frame[base + x * 2] = col; frame[base + x * 2 + 1] = col; }
          if (wIdx) idx[ibase + x] = kind ? c : (c & 0x0F);
        }
        void bdc; void bdi;
        this._maskLeft(fy, row, ow);
        return;
      }
      for (let x = 0; x < mw; x++) {
        let c = lb[x];
        if (c === 0 && !tp) c = regs[7] & 0x0F;
        const col = pal[c];
        if (ow === mw) frame[base + x] = col;
        else if (ow === WIDE) { frame[base + x * 2] = col; frame[base + x * 2 + 1] = col; }
        else if (!(x & 1)) frame[base + (x >> 1)] = col;
        if (!wIdx) continue;
        if (mw === W) idx[ibase + x] = kind ? this._toGrb(c) : c;
        else if (!(x & 1)) idx[ibase + (x >> 1)] = kind ? this._toGrb(c) : c;
      }
      this._maskLeft(fy, row, ow);
    }
    // 横の set adjust(R18 下位 4bit): 表示全体(背景+スプライト)を横にずらす。0=中央、1〜7=左へ 1〜7、8〜15=右へ 8〜1 ドット(幅 512 のモードは 2 倍)。
    // 空いた所はボーダー色。2026-11-11(画面の途中で R18 を 8/A/C/E と変えて 2 ドットずつ横スクロールするゲームで、背景が 8 ドットずつ飛んでいた)
    _hAdjust(lb, mw, g7) {
      const h = this.regs[18] & 0x0F, sh = -(((h ^ 8) - 8)) * (mw / W);
      const fill = g7 ? this.regs[7] : (this.regs[7] & 0x0F);
      const yjk = g7 && this.isV9958 && (this.regs[25] & 0x08) !== 0;
      for (const a of yjk ? [lb, this.lineRgb, this.yjkBg] : [lb]) {
        const f = a === lb ? fill : (a === this.yjkBg ? -1 : G7_PALETTE[this.regs[7]]);
        if (sh > 0) { a.copyWithin(sh, 0, mw - sh); a.fill(f, 0, sh); }
        else { a.copyWithin(0, -sh, mw); a.fill(f, mw + sh, mw); }
      }
    }
    // 背景の 1 行をモードで描く(lb に色番号/G7 は 8bit 色。rgb を渡すと YJK として lineRgb に表示色も)
    _lineBg(mode, sy, lb, mw, rgb) {
      switch (mode) {
        case 0: this._lineG1(sy, lb); break;                 // GRAPHIC1 (SCREEN 1)
        case 1: this._lineT1(sy, lb); break;                 // TEXT1 (SCREEN 0)
        case 2: this._lineMC(sy, lb); break;                 // MULTICOLOR (SCREEN 3)
        case 4: this._lineG2(sy, lb); break;                 // GRAPHIC2 (SCREEN 2)
        case 8: this._lineG2(sy, lb); break;                 // GRAPHIC3 (SCREEN 4): 背景は G2 と同じ、スプライトはモード 2
        case 9: if (this.isTms) { this.unsupportedMode = true; lb.fill(0, 0, mw); } else this._lineT2(sy, lb); break; // TEXT2 (SCREEN 0 WIDTH 80)
        case 12: this._lineG4(sy, lb); break;                // GRAPHIC4 (SCREEN 5)
        case 16: this._lineG5(sy, lb); break;                // GRAPHIC5 (SCREEN 6)
        case 20: this._lineG6(sy, lb); break;                // GRAPHIC6 (SCREEN 7)
        case 28: if (rgb) this._lineYjk(sy, lb, rgb); else this._lineG7(sy, lb); break; // GRAPHIC7 (SCREEN 8) / YJK (SCREEN 10-12)
        default: this.unsupportedMode = true; lb.fill(0, 0, mw); break;
      }
    }
    // 横スクロール(V9958): lb(と YJK の lineRgb)を R26/R27 ぶんずらす。幅 512 のモードは 2 倍。SP2 はもう一方のページ(R2 bit5 を反転)を
    // 右側(と、R27 で右にずれた左端)に続ける。SP2 でなければ同じページで巻く
    _hScroll(mode, sy, mw, sp2, yjk) {
      const regs = this.regs, lb = this.lineBuf, A = this.lineTmpA, B = this.lineTmpB, rgb = this.lineRgb, rgbA = this.lineRgbA, rgbB = this.lineRgbB;
      const unit = mw === WIDE ? 2 : 1;
      const x0 = (((regs[26] & 0x1F) << 3) - (regs[27] & 0x07)) * unit; // 画面の左端に出る元の x(負あり)
      A.set(lb.subarray(0, mw)); if (yjk) rgbA.set(rgb);
      if (sp2) { regs[2] ^= 0x20; this._lineBg(mode, sy, B, mw, yjk ? rgbB : null); regs[2] ^= 0x20; }
      for (let x = 0; x < mw; x++) {
        let sx = x + x0, other = false;
        if (sx < 0) { sx += mw; other = true; } else if (sx >= mw) { sx -= mw; other = true; }
        const src = (sp2 && other) ? B : A;
        lb[x] = src[sx];
        if (yjk) rgb[x] = (sp2 && other) ? rgbB[sx] : rgbA[sx];
      }
    }
    // 左 8 ドット(幅 512 は 16)をボーダー色で隠す(V9958 R25 bit1 MSK)。横スクロールの R27 で欠けた端を隠すための物
    _maskLeft(fy, row, ow) {
      if (!this.isV9958 || !(this.regs[25] & 0x02)) return;
      const [c, ci] = this._borderColor();
      const n = ow === WIDE ? 16 : 8, base = row * ow;
      for (let x = 0; x < n; x++) this.frame[base + x] = c;
      if (!this.ilCur || this.field === 0) for (let x = 0; x < 8; x++) this.frameIdx[fy * W + x] = ci;
    }
    // YJK(V9958 SCREEN 10-12): 4 ドット 1 組。各バイトの bit7-3 が Y(5bit)、bit2-0 が 4 バイトで K(下位 3+上位 3、符号つき 6bit)と J。
    //   R = Y + J、G = Y + K、B = (5Y - 2J - K) / 4(各 0-31 に飽和、5bit → 8bit は ×255/31)。YAE(R25 bit4)のとき bit3=1 のドットはパレット bit7-4
    // lb には GRB332 への丸め(索引/スプライト合成/巻き戻しの画用)、rgb に表示色
    _lineYjk(y, lb, rgb) {
      const vram = this.vram, m = this.vramMask, base = ((this.regs[2] & 0x20) << 11) + (y << 8);
      const yae = (this.regs[25] & 0x10) !== 0, pal = this.palette;
      for (let x = 0; x < 256; x += 4) {
        const b0 = vram[(base + x) & m], b1 = vram[(base + x + 1) & m], b2 = vram[(base + x + 2) & m], b3 = vram[(base + x + 3) & m];
        let k = (b0 & 7) | ((b1 & 7) << 3), j = (b2 & 7) | ((b3 & 7) << 3);
        if (k & 0x20) k -= 64; if (j & 0x20) j -= 64;
        for (let i = 0; i < 4; i++) {
          const b = i === 0 ? b0 : i === 1 ? b1 : i === 2 ? b2 : b3;
          if (yae && (b & 0x08)) { const p = b >> 4; rgb[x + i] = pal[p]; lb[x + i] = this._toGrb(p); continue; }
          const yy = b >> 3;
          let r = yy + j, g = yy + k, bl = ((5 * yy - 2 * j - k) >> 2);
          r = r < 0 ? 0 : r > 31 ? 31 : r; g = g < 0 ? 0 : g > 31 ? 31 : g; bl = bl < 0 ? 0 : bl > 31 ? 31 : bl;
          rgb[x + i] = abgr(LEVEL5[r], LEVEL5[g], LEVEL5[bl]);
          lb[x + i] = ((g >> 2) << 5) | ((r >> 2) << 2) | (bl >> 3);
        }
      }
    }
    _lineG1(y, lb) {
      const regs = this.regs, vram = this.vram, m = this.vramMask;
      const nt = (regs[2] & 0x7F) << 10, ct = regs[3] << 6, pg = (regs[4] & 0x3F) << 11;
      const row = y >> 3, pr = y & 7;
      for (let col = 0; col < 32; col++) {
        const ch = vram[(nt + row * 32 + col) & m];
        const pat = vram[(pg + ch * 8 + pr) & m];
        const color = vram[(ct + (ch >> 3)) & m];
        const fg = color >> 4, bg = color & 0x0F;
        for (let b = 0; b < 8; b++) lb[col * 8 + b] = (pat & (0x80 >> b)) ? fg : bg;
      }
    }
    _lineG2(y, lb) {
      const regs = this.regs, vram = this.vram, m = this.vramMask;
      const nt = (regs[2] & 0x7F) << 10;
      const row = y >> 3, pr = y & 7, block = row >> 3;
      // 色表/パターン表の基準とマスク(R3 bit7 / R4 bit2 が基準、下位ビットはマスク)。V9938 は R10 が色表の上位
      const ctBase = (((regs[10] & 0x07) << 8) | (regs[3] & 0x80)) << 6, ctMask = ((regs[3] & 0x7F) << 6) | 0x3F;
      const pgBase = (regs[4] & 0x3C) << 11, pgMask = ((regs[4] & 0x03) << 11) | 0x7FF;
      for (let col = 0; col < 32; col++) {
        const ch = vram[(nt + row * 32 + col) & m];
        const off = ((block << 11) | (ch << 3) | pr);
        const pat = vram[(pgBase | (off & pgMask)) & m];
        const color = vram[(ctBase | (off & ctMask)) & m];
        const fg = color >> 4, bg = color & 0x0F;
        for (let b = 0; b < 8; b++) lb[col * 8 + b] = (pat & (0x80 >> b)) ? fg : bg;
      }
    }
    _lineMC(y, lb) {
      const regs = this.regs, vram = this.vram, m = this.vramMask;
      const nt = (regs[2] & 0x7F) << 10, pg = (regs[4] & 0x3F) << 11;
      const row = y >> 3, sub = (y >> 2) & 1;
      for (let col = 0; col < 32; col++) {
        const ch = vram[(nt + row * 32 + col) & m];
        const color = vram[(pg + ch * 8 + ((row & 3) << 1) + sub) & m];
        const left = color >> 4, right = color & 0x0F;
        for (let b = 0; b < 4; b++) { lb[col * 8 + b] = left; lb[col * 8 + 4 + b] = right; }
      }
    }
    _lineT1(y, lb) {
      const regs = this.regs, vram = this.vram, m = this.vramMask;
      const nt = (regs[2] & 0x7F) << 10, pg = (regs[4] & 0x3F) << 11;
      const fg = regs[7] >> 4, bg = regs[7] & 0x0F;
      const row = y >> 3, pr = y & 7;
      for (let x = 0; x < 8; x++) { lb[x] = bg; lb[248 + x] = bg; } // 左右 8 ドットはボーダー(背景色)
      for (let col = 0; col < 40; col++) {
        const ch = vram[(nt + row * 40 + col) & m];
        const pat = vram[(pg + ch * 8 + pr) & m];
        for (let b = 0; b < 6; b++) lb[8 + col * 6 + b] = (pat & (0x80 >> b)) ? fg : bg;
      }
    }
    // TEXT2(80 桁、幅 512): 名前表 R2 bit6-2 ×$1000(80×27 行)、パターン R4、点滅表 R3/R10(未対応: 文字色で描く)。左右 16 ドットは背景色
    _lineT2(y, lb) {
      const regs = this.regs, vram = this.vram, m = this.vramMask;
      const nt = (regs[2] & 0x7C) << 10, pg = (regs[4] & 0x3F) << 11;
      const fg = regs[7] >> 4, bg = regs[7] & 0x0F;
      const row = y >> 3, pr = y & 7;
      for (let x = 0; x < 16; x++) { lb[x] = bg; lb[496 + x] = bg; }
      for (let col = 0; col < 80; col++) {
        const ch = vram[(nt + row * 80 + col) & m];
        const pat = vram[(pg + ch * 8 + pr) & m];
        for (let b = 0; b < 6; b++) lb[16 + col * 6 + b] = (pat & (0x80 >> b)) ? fg : bg;
      }
    }
    // ビットマップ(V9938)。名前表の基準: G4/G5 は R2 bit6-5(A16-15)、G6/G7 は R2 bit5(A16)
    _lineG4(y, lb) {
      const vram = this.vram, m = this.vramMask, base = ((this.regs[2] & 0x60) << 10) + (y << 7);
      for (let x = 0; x < 128; x++) { const b = vram[(base + x) & m]; lb[x * 2] = b >> 4; lb[x * 2 + 1] = b & 0x0F; }
    }
    _lineG5(y, lb) {
      const vram = this.vram, m = this.vramMask, base = ((this.regs[2] & 0x60) << 10) + (y << 7);
      for (let x = 0; x < 128; x++) { const b = vram[(base + x) & m]; lb[x * 4] = b >> 6; lb[x * 4 + 1] = (b >> 4) & 3; lb[x * 4 + 2] = (b >> 2) & 3; lb[x * 4 + 3] = b & 3; }
    }
    _lineG6(y, lb) {
      const vram = this.vram, m = this.vramMask, base = ((this.regs[2] & 0x20) << 11) + (y << 8);
      for (let x = 0; x < 256; x++) { const b = vram[(base + x) & m]; lb[x * 2] = b >> 4; lb[x * 2 + 1] = b & 0x0F; }
    }
    _lineG7(y, lb) {
      const vram = this.vram, m = this.vramMask, base = ((this.regs[2] & 0x20) << 11) + (y << 8);
      for (let x = 0; x < 256; x++) lb[x] = vram[(base + x) & m];
    }
    // スプライトモード 1(TMS/G1/G2/MC): 行に 4 枚まで、5 枚目で 5S、重なりで C。色 0 は透明。EC(bit7)で 32 ドット左へ
    _spritesMode1(y, lb, mw) {
      const regs = this.regs, vram = this.vram, m = this.vramMask;
      const sat = ((regs[5] & 0x7F) << 7) | (this.isTms ? 0 : ((regs[11] & 0x03) << 15));
      const spg = (regs[6] & 0x3F) << 11;
      const size = (regs[1] & 0x02) ? 16 : 8, mag = (regs[1] & 0x01) ? 2 : 1, h = size * mag;
      const sb = this.sprBuf; sb.fill(0);
      let count = 0, collision = false;
      for (let i = 0; i < 32; i++) {
        const a = (sat + i * 4) & m;
        let sy = vram[a];
        if (sy === 0xD0) break; // 終端
        sy = sy > 0xE0 ? sy - 0x100 : sy; // 画面上端より上
        const top = sy + 1;
        const d = this.isTms ? y - top : ((y - top) & 0xFF); // V9938 は 8bit で折り返す(縦スクロールで行が 255 を越える)
        if (d < 0 || d >= h) continue;
        if (count === 4) { if (!(this.status[0] & 0x40)) this.status[0] = (this.status[0] & 0xE0) | 0x40 | (i & 0x1F); break; }
        count++;
        let sx = vram[a + 1];
        const pat = vram[a + 2], attr = vram[a + 3];
        const color = attr & 0x0F;
        if (attr & 0x80) sx -= 32;
        const ly = (d / mag) | 0;
        const pbase = spg + ((size === 16 ? (pat & 0xFC) : pat) << 3);
        for (let px = 0; px < size; px++) {
          const byte = vram[(pbase + ly + ((px >> 3) << 4)) & m];
          if (!(byte & (0x80 >> (px & 7)))) continue;
          for (let k = 0; k < mag; k++) {
            const x = sx + px * mag + k;
            if (x < 0 || x >= W) continue;
            if (sb[x]) { collision = true; continue; } // 先に描いた(番号の小さい)方が手前
            sb[x] = 0x10 | color; // 色 0 でも「ここにスプライトがある」印(衝突判定に要る)
          }
        }
      }
      if (collision) this.status[0] |= 0x20;
      if (count < 5 && !(this.status[0] & 0x40)) this.status[0] = (this.status[0] & 0xE0) | 0x1F; // 5 枚目が無い間は番号 31
      this._composeSprites(lb, mw, false);
    }
    // スプライトモード 2(G3〜G7): 行に 8 枚まで(9 枚目で 5S)、行ごとの色(属性表-$200 の色表、16 バイト/枚: bit7 EC、bit6 CC、bit5 IC、bit3-0 色)。
    // CC=1 は重なった所で先に描いた物と色を OR(衝突しない)。IC=1 は衝突を数えない。Y の終端は $D8
    _spritesMode2(y, lb, mw, g7) {
      const regs = this.regs, vram = this.vram, m = this.vramMask;
      const sat = ((regs[11] & 0x03) << 15) | ((regs[5] & 0xFC) << 7);
      const sct = (sat - 0x200) & 0x1FFFF;
      const spg = (regs[6] & 0x3F) << 11;
      const size = (regs[1] & 0x02) ? 16 : 8, mag = (regs[1] & 0x01) ? 2 : 1, h = size * mag;
      const sb = this.sprBuf; sb.fill(0);
      const owner = this._sprOwner || (this._sprOwner = new Uint8Array(W)); owner.fill(0); // その x の最前面のスプライト(1+番号)。IC/CC 判定用
      let count = 0, collision = false;
      for (let i = 0; i < 32; i++) {
        const a = (sat + i * 4) & m;
        let sy = vram[a];
        if (sy === 0xD8) break;
        sy = sy > 0xE0 ? sy - 0x100 : sy;
        const top = sy + 1;
        const d = this.isTms ? y - top : ((y - top) & 0xFF); // V9938 は 8bit で折り返す(縦スクロールで行が 255 を越える)
        if (d < 0 || d >= h) continue;
        if (count === 8) { if (!(this.status[0] & 0x40)) this.status[0] = (this.status[0] & 0xE0) | 0x40 | (i & 0x1F); break; }
        count++;
        const ly = (d / mag) | 0;
        const cattr = vram[(sct + i * 16 + ly) & m];
        let sx = vram[a + 1];
        const pat = vram[a + 2];
        const color = cattr & 0x0F, ec = cattr & 0x80, cc = cattr & 0x40, ic = cattr & 0x20;
        if (ec) sx -= 32;
        const pbase = spg + ((size === 16 ? (pat & 0xFC) : pat) << 3);
        for (let px = 0; px < size; px++) {
          const byte = vram[(pbase + ly + ((px >> 3) << 4)) & m];
          if (!(byte & (0x80 >> (px & 7)))) continue;
          for (let k = 0; k < mag; k++) {
            const x = sx + px * mag + k;
            if (x < 0 || x >= W) continue;
            if (sb[x]) {
              if (cc) { sb[x] |= color; continue; }    // CC: 手前の物と OR
              if (!ic) collision = true;
              continue;
            }
            if (cc) continue; // CC のスプライトは手前の物が無い所には出ない
            sb[x] = 0x10 | color; owner[x] = i + 1;
          }
        }
      }
      if (collision) this.status[0] |= 0x20;
      if (count < 9 && !(this.status[0] & 0x40)) this.status[0] = (this.status[0] & 0xE0) | 0x1F;
      this._composeSprites(lb, mw, g7);
    }
    // スプライトの行を背景の上に(色 0 は透明)。幅 512 のモードはスプライトの 1 ドット=2 ドット。G7 は固定の 8bit 色に
    _composeSprites(lb, mw, g7) {
      const sb = this.sprBuf;
      if (g7) { for (let x = 0; x < W; x++) { const c = sb[x] & 0x0F; if (sb[x] && c) lb[x] = G7_SPRITE_COLOR[c]; } return; }
      if (mw === W) { for (let x = 0; x < W; x++) { const c = sb[x] & 0x0F; if (sb[x] && c) lb[x] = c; } return; }
      for (let x = 0; x < W; x++) { const c = sb[x] & 0x0F; if (sb[x] && c) { lb[x * 2] = c; lb[x * 2 + 1] = c; } }
    }

    // ── VDP コマンド(V9938) ──
    // ビットマップのドット単位アクセス。モードごとの 1 行のバイト数と 1 バイトのドット数
    _pixInfo() {
      switch (this.mode) {
        case 12: return { shift: 7, ppb: 2, w: 256 }; // G4: 128 バイト/行、2 ドット/バイト
        case 16: return { shift: 7, ppb: 4, w: 512 }; // G5
        case 20: return { shift: 8, ppb: 2, w: 512 }; // G6
        case 28: return { shift: 8, ppb: 1, w: 256 }; // G7
        default: return (this.isV9958 && (this.regs[25] & 0x40)) ? { shift: 8, ppb: 1, w: 256 } : null; // V9958 R25 CMD: ビットマップ以外でも G7 の配置で動く(推定)
      }
    }
    _addrOf(pi, x, y) { return (((y & 0x3FF) << pi.shift) + ((x & (pi.w - 1)) / pi.ppb | 0)) & this.vramMask; }
    _readPix(pi, x, y) {
      const b = this.vram[this._addrOf(pi, x, y)];
      if (pi.ppb === 1) return b;
      if (pi.ppb === 2) return (x & 1) ? (b & 0x0F) : (b >> 4);
      return (b >> ((3 - (x & 3)) * 2)) & 3;
    }
    _writePix(pi, x, y, c, lop) {
      const a = this._addrOf(pi, x, y);
      const old = this.vram[a];
      let mask, shift;
      if (pi.ppb === 1) { mask = 0xFF; shift = 0; }
      else if (pi.ppb === 2) { shift = (x & 1) ? 0 : 4; mask = 0x0F << shift; }
      else { shift = (3 - (x & 3)) * 2; mask = 0x03 << shift; }
      const cur = (old & mask) >> shift;
      c &= mask >> shift;
      if ((lop & 0x08) && c === 0) return; // 透明演算: 色 0 は書かない
      let nv;
      switch (lop & 0x07) {
        case 0: nv = c; break;
        case 1: nv = cur & c; break;
        case 2: nv = cur | c; break;
        case 3: nv = cur ^ c; break;
        case 4: nv = (~c) & (mask >> shift); break;
        default: nv = c; break;
      }
      this.vram[a] = (old & ~mask) | (nv << shift);
    }
    _cmdStart(v) {
      const c = this.cmd, r = this.regs;
      c.op = v >> 4; c.lop = v & 0x0F;
      if (c.op === 0) { c.tr = false; this.status[2] &= ~0x10; return; } // STOP
      if (!this._pixInfo()) { c.op = 0; c.tr = false; return; }          // ビットマップ以外では何もしない(V9938)
      c.sx = r[32] | ((r[33] & 1) << 8); c.sy = r[34] | ((r[35] & 3) << 8);
      c.dx = r[36] | ((r[37] & 1) << 8); c.dy = r[38] | ((r[39] & 3) << 8);
      c.nx = (r[40] | ((r[41] & 1) << 8)) || 512; c.ny = (r[42] | ((r[43] & 3) << 8)) || 1024;
      // LINE の NX/NY は長辺/短辺の長さそのもの(0 は 0。範囲のコマンドの「0 = 512/1024」は当てない)。2026-11-11: 短辺 0 の水平線/垂直線が
      //  1024 として斜め線になっていた(お絵描きソフトの格子、openMSX との突き合わせで判明)
      if ((v >> 4) === 0x7) { c.nx = r[40] | ((r[41] & 1) << 8); c.ny = r[42] | ((r[43] & 3) << 8); }
      c.clr = r[44]; c.arg = r[45];
      c.dix = (c.arg & 0x04) ? -1 : 1; c.diy = (c.arg & 0x08) ? -1 : 1;
      c.maj = (c.arg & 0x01); c.eq = (c.arg & 0x02);
      c.anx = 0; c.any = 0; c.budget = 0; c.lineAcc = 0;
      c.tr = false;
      this.status[2] &= ~0x10;
      const pi = this._pixInfo();
      // 横幅 NX は画面の端で打ち切る(右へ進むなら 幅-X、左へなら X+1。転送は転送元と転送先の両方で)。2026-11-11: SCREEN 5 で NX=512 の HMMC を
      //  出すゲームで、打ち切らないと 1 行で 2 行ぶんのデータを使って絵が崩れた(openMSX の clipNX の記憶による推定、ab.js で一致を確認)
      {
        const w = pi.w, room = (x) => c.dix > 0 ? w - (x & (w - 1)) : (x & (w - 1)) + 1;
        let lim = (c.op === 0xA) ? room(c.sx) : room(c.dx);
        if (c.op === 0xD || c.op === 0x9) lim = Math.min(lim, room(c.sx));
        if (c.op !== 0xE && c.op !== 0x4 && c.op !== 0x5 && c.op !== 0x6 && c.op !== 0x7) c.nx = Math.min(c.nx, lim);
      }
      // バイト単位のコマンド(HMMV/HMMM/YMMM/HMMC)は x をバイト境界に
      if (c.op === 0xC || c.op === 0xD || c.op === 0xE || c.op === 0xF) { const q = pi.ppb; c.nx = Math.max(1, (c.nx / q) | 0) * q; }
      switch (c.op) {
        case 0xF: case 0xB: c.tr = true; this._cmdData(c.clr); break; // HMMC/LMMC: 開始時の R44(CLR)が最初のデータ。以後は CPU の R44 書き込み待ち
        case 0xA: this._lmcmFetch(); break;                           // LMCM: 最初のドットを S7 へ
        case 0x4: { this.status[7] = this._readPix(pi, c.sx, c.sy); c.op = 0; break; } // POINT: 即時
        case 0x5: { this._writePix(pi, c.dx, c.dy, c.clr, c.lop); c.op = 0; break; }   // PSET: 即時(時間は無視)
        case 0x6: c.budget = 0; break;                                // SRCH
        default: break;
      }
    }
    _cmdCost() {
      const c = this.cmd;
      const t = CMD_TICKS[c.op]; if (!t) return 10;
      if (!this.displayEnabled || this.inVBlank) return t[0] / 6;
      const m = this.mode, spr = m !== 1 && m !== 9 && !(this.regs[8] & 0x02); // テキスト(T1/T2)はスプライト無し、R8 bit1 SPD=1 で消える
      return t[spr ? 1 : 2] / 6;
    }
    // 時間を進めてコマンドを実行する(HMMC/LMMC は CPU 駆動なのでここでは進まない)
    _cmdRun(cycles) {
      const c = this.cmd;
      if (c.op === 0xF || c.op === 0xB || c.op === 0xA) return;
      const pi = this._pixInfo();
      if (!pi) { c.op = 0; return; }
      c.budget += cycles;
      const cost = this._cmdCost();
      let guard = 0;
      while (c.op && c.budget >= cost && ++guard < 100000) {
        c.budget -= cost;
        this._cmdStep(pi);
      }
    }
    _cmdStep(pi) {
      const c = this.cmd;
      switch (c.op) {
        case 0xC: { // HMMV: バイト塗り
          this.vram[this._addrOf(pi, c.dx + c.anx * c.dix, c.dy)] = c.clr;
          c.anx += pi.ppb; if (c.anx >= c.nx) { c.anx = 0; c.dy = (c.dy + c.diy) & 0x3FF; if (--c.ny <= 0) c.op = 0; }
          break;
        }
        case 0xD: { // HMMM: バイト転送
          this.vram[this._addrOf(pi, c.dx + c.anx * c.dix, c.dy)] = this.vram[this._addrOf(pi, c.sx + c.anx * c.dix, c.sy)];
          c.anx += pi.ppb; if (c.anx >= c.nx) { c.anx = 0; c.dy = (c.dy + c.diy) & 0x3FF; c.sy = (c.sy + c.diy) & 0x3FF; if (--c.ny <= 0) c.op = 0; }
          break;
        }
        case 0xE: { // YMMM: 縦方向の転送(DX から行末まで)
          const x = c.dx + c.anx * c.dix;
          this.vram[this._addrOf(pi, x, c.dy)] = this.vram[this._addrOf(pi, x, c.sy)];
          c.anx += pi.ppb;
          const remain = c.dix > 0 ? (pi.w - c.dx) : (c.dx + 1);
          if (c.anx >= remain) { c.anx = 0; c.dy = (c.dy + c.diy) & 0x3FF; c.sy = (c.sy + c.diy) & 0x3FF; if (--c.ny <= 0) c.op = 0; }
          break;
        }
        case 0x8: { // LMMV: ドット塗り(論理演算)
          this._writePix(pi, c.dx + c.anx * c.dix, c.dy, c.clr, c.lop);
          if (++c.anx >= c.nx) { c.anx = 0; c.dy = (c.dy + c.diy) & 0x3FF; if (--c.ny <= 0) c.op = 0; }
          break;
        }
        case 0x9: { // LMMM: ドット転送(論理演算)
          this._writePix(pi, c.dx + c.anx * c.dix, c.dy, this._readPix(pi, c.sx + c.anx * c.dix, c.sy), c.lop);
          if (++c.anx >= c.nx) { c.anx = 0; c.dy = (c.dy + c.diy) & 0x3FF; c.sy = (c.sy + c.diy) & 0x3FF; if (--c.ny <= 0) c.op = 0; }
          break;
        }
        case 0x7: { // LINE: 長辺 NX(MAJ=0: X が長辺)、短辺 NY。ブレゼンハム
          this._writePix(pi, c.dx, c.dy, c.clr, c.lop);
          const maj = c.nx, min = c.ny;
          if (c.anx >= maj) { c.op = 0; break; }
          c.anx++;
          c.lineAcc += min;
          if (c.maj === 0) { c.dx += c.dix; if (c.lineAcc >= maj) { c.lineAcc -= maj; c.dy = (c.dy + c.diy) & 0x3FF; } }
          else { c.dy = (c.dy + c.diy) & 0x3FF; if (c.lineAcc >= maj) { c.lineAcc -= maj; c.dx += c.dix; } }
          if (c.dx < 0 || c.dx >= pi.w) c.op = 0;
          break;
        }
        case 0x6: { // SRCH: SX から横に CLR と同じ(EQ=0)/違う(EQ=1)色を探す。見つかれば BD と S8/S9
          const x = c.sx + c.anx * c.dix;
          if (x < 0 || x >= pi.w) { this.status[2] &= ~0x10; c.op = 0; break; }
          const p = this._readPix(pi, x, c.sy);
          const hit = c.eq ? (p !== c.clr) : (p === c.clr);
          if (hit) { this.status[2] |= 0x10; this.status[8] = x & 0xFF; this.status[9] = (x >> 8) & 1; c.op = 0; break; }
          c.anx++;
          break;
        }
        default: c.op = 0; break;
      }
      if (!c.op) c.tr = false;
    }
    // R44 への書き込み: HMMC/LMMC の 1 ドット(バイト)
    _cmdData(v) {
      const c = this.cmd;
      if (!(c.op === 0xF || c.op === 0xB) || !c.tr) return;
      const pi = this._pixInfo();
      if (!pi) { c.op = 0; c.tr = false; return; }
      if (c.op === 0xF) {
        this.vram[this._addrOf(pi, c.dx + c.anx * c.dix, c.dy)] = v;
        c.anx += pi.ppb;
      } else {
        this._writePix(pi, c.dx + c.anx * c.dix, c.dy, v, c.lop);
        c.anx++;
      }
      if (c.anx >= c.nx) { c.anx = 0; c.dy = (c.dy + c.diy) & 0x3FF; if (--c.ny <= 0) { c.op = 0; c.tr = false; } }
    }
    // LMCM: S7 に今のドットを置く / 読まれたら次へ
    _lmcmFetch() {
      const c = this.cmd, pi = this._pixInfo();
      if (!pi) { c.op = 0; return; }
      this.status[7] = this._readPix(pi, c.sx + c.anx * c.dix, c.sy);
      c.tr = true;
    }
    _lmcmNext() {
      const c = this.cmd;
      c.anx++;
      if (c.anx >= c.nx) { c.anx = 0; c.sy = (c.sy + c.diy) & 0x3FF; if (--c.ny <= 0) { c.op = 0; c.tr = false; return; } }
      this._lmcmFetch();
    }
  }
  MsxVdp.W = W; MsxVdp.WIDE = WIDE; MsxVdp.H = H;
  MsxVdp.CYCLES_PER_LINE = CYCLES_PER_LINE;
  MsxVdp.TMS_PALETTE = TMS_PALETTE;
  MsxVdp.G7_PALETTE = G7_PALETTE;
  Emu.MsxVdp = MsxVdp;
})(typeof window !== 'undefined' ? window : globalThis);
