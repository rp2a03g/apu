/*
 * CD-ROM² 装置(レジスタ $1800-$180F、割り込み、SCSI のバス、ドライブ、CD-DA、フェーダ)
 * MML.Emu.PceCdRom(段階 9e)。ADPCM は pce/adpcm.js、イメージは pce/cdImage.js
 *
 * host は PceConsole(時計 host.clock、割り込み線 host.irq2、バックアップ RAM の鍵 host.bramLocked)。
 * exec() はマスタークロック 3 個ごと(CD をつないでいる時だけ本体が呼ぶ。タイマ → VDC → ここ の順)。
 *
 * レジスタ(下位 10bit):
 *   $00 読み = バスの状態(bit7 BSY、6 REQ、5 MSG、4 C/D、3 I/O)、書き = SEL を一瞬立てる   $01 データの口
 *   $02 bit7 = ACK、下位 7bit = 割り込み許可   $03 読み = 割り込み要因(bit2 ADPCM 半分、3 ADPCM 終わり、4 サブコード、5 状態/メッセージ、6 データ)
 *   $04 bit1 = ドライブのリセット   $05/$06 CD-DA の今の値(書くと左右を入れ替えて掴む)   $07 読み = サブコード、書き = バックアップ RAM の鍵
 *   $08 読み = データを 1 個読んで自動で ACK   $08-$0E ADPCM   $0F フェーダ   $C0-$C3 Super CD-ROM² の印
 *
 * 根拠の札(DESIGN-PCE-CAPTURE.md §2.3)。[参照] は Mesen 2 の Core/PCE/CdRom/(PceCdRom / PceScsiBus / PceCdAudioPlayer / PceAudioFader。読んだだけで写していない):
 *   [参照] SCSI の段(空き → コマンド → データ入力 → 状態 → メッセージ入力 → 空き、ほかに「忙しい」)と信号の組、REQ/ACK の握手、
 *          割り込み要因の立て方(REQ・I/O・BSY が揃った時、C/D が立っていれば「状態/メッセージ」、そうでなければ「データ」)
 *   [参照] コマンド: $00 準備確認(6)、$08 読み出し(6)、$D8 音声の始まり、$D9 音声の終わり、$DA 一時停止、$DD サブコード Q、$DE TOC(各 10)。
 *          知らないコマンドは 1 個目で「正常終了」を返す
 *   [参照] 読み出しの速さ: 1 セクタ = 2048 / 153600 秒(75 セクタ/秒)。その前にシークの時間。前のセクタを読み切らないうちに次が来たら 290ms の罰
 *   [参照] CD-DA: マスタークロック 487 個ごとに 1 個(約 44101Hz)。6 個ごとにサブコードの割り込み要因(再生していなくても)。
 *          終わりの動き 3 通り(止まる/頭へ戻る/止まって「正常終了」を返す=割り込み)
 *   [参照] フェーダ($180F): bit3 = 入、bit1 = 相手(1 ADPCM、0 CD-DA)、bit2 = 速い。書いた時からの時間で直線に下げる(1% に 0.06 秒、速い時 0.025 秒)
 *   [参照] ドライブのリセット中は割り込み要因を立てない。リセットは BSY と SEL を下ろさない(Mesen の作りのまま)
 *   ★ 遅れの値(コマンドの段になるまで 3×25000 クロック、1 個ごとの REQ まで 3×1000、TOC の返事まで 3×3000、準備確認 3×150000、
 *      ACK の自動解除 21、$1805 の連続書き込みを無視する 700)は Mesen の値。Mesen のコメント: どれも近似で、試験 ROM が通る範囲で決めた
 *   ★ 準備確認の遅れは Mesen が実機の約 1/100 に縮めてある(起動を速くするため、と書いてある)。同じにした
 *   [参照] シークの時間の表と式: pce-devel/PCECD_seek(Dave Shadoff、MIT ライセンス)の実機測定に基づく物。Mesen も同じ表を使う
 *   [推定] 音量: CD-DA は 16bit の値そのまま、ADPCM は (出力-2048)×10 を、波形メモリ音源 1ch の最大 = 31×255 と同じ物差しで足す(Mesen の比)。
 *          実機の音量の比は未確認
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const MASTER = 21477270;
  const IRQ_SUB = 0x10, IRQ_STATUS = 0x20, IRQ_DATA = 0x40;
  const PH_FREE = 0, PH_CMD = 1, PH_DATAIN = 2, PH_MSGIN = 4, PH_STATUS = 6, PH_BUSY = 7;
  const UP_CMD = 0, UP_REQ = 1, UP_DATAIN = 3, UP_GOOD = 5;
  const AU_PLAY = 0, AU_IDLE = 1, AU_PAUSE = 2, AU_STOP = 3;
  const END_STOP = 0, END_LOOP = 1, END_IRQ = 2;
  const SECTOR_CLOCKS = Math.floor(MASTER * 2048 / 153600);
  const LATE_CLOCKS = Math.floor(MASTER * (290.0 / 1000.0));
  const CDDA_CLOCKS = 487;
  const SIGNATURE = [0x00, 0xAA, 0x55, 0x03];
  // 波形メモリ音源の 1ch の最大(31×255)が本体の物差しで 31/96 になる、という換算
  const UNIT = (31 / 96) / (31 * 255);

  // シークの時間(ミリ秒)。帯ごとの「1 周のセクタ数、最初と最後のセクタ、1 周の時間」
  const ZONES = [
    [10, 0, 12572, 133.47], [11, 12573, 30244, 146.82], [12, 30245, 49523, 160.17], [13, 49524, 70408, 173.51],
    [14, 70409, 92900, 186.86], [15, 92901, 116998, 200.21], [16, 116999, 142703, 213.56], [17, 142704, 170014, 226.90],
    [18, 170015, 198932, 240.25], [19, 198933, 229456, 253.60], [20, 229457, 261587, 266.95], [21, 261588, 295324, 280.29],
    [22, 295325, 330668, 293.64], [23, 330669, 333012, 306.99],
  ];
  const zoneOf = (lba) => { for (let i = 0; i < ZONES.length; i++) if (lba >= ZONES[i][1] && lba <= ZONES[i][2]) return i; return 0; };
  const idiv = (a, b) => Math.floor(a / b);
  function seekMs(from, to) {
    const src = zoneOf(from), dst = zoneOf(to), gap = Math.abs(to - from);
    let tracks;
    if (dst === src) tracks = idiv(gap, ZONES[dst][0]);
    else if (dst > src) tracks = idiv((ZONES[src][2] - from) >>> 0, ZONES[src][0]) + idiv((to - ZONES[dst][1]) >>> 0, ZONES[dst][0]) + 1606.48 * (dst - src - 1);
    else tracks = idiv((from - ZONES[src][1]) >>> 0, ZONES[src][0]) + idiv((ZONES[dst][2] - to) >>> 0, ZONES[dst][0]) + 1606.48 * (src - dst - 1);
    const half = ZONES[dst][3] / 2;
    let ms;
    if (gap < 2) ms = 150;
    else if (gap < 5) ms = 150 + half;
    else if (tracks <= 80) ms = 300 + half;
    else if (tracks <= 160) ms = 366 + half;
    else if (tracks <= 644) ms = 366 + half + (tracks - 161) * 16.66 / 80;
    else ms = 800 + (tracks - 644) * 16.66 / 195;
    return Math.floor(ms);
  }
  const seekClocks = (from, to) => Math.floor(MASTER * (seekMs(from, to) / 1000.0));
  const bcd = (v) => ((Math.floor(v / 10) << 4) | (v % 10)) & 0xFF;
  const unbcd = (v) => ((v >> 4) & 0x0F) * 10 + (v & 0x0F);
  const CMD_SIZE = { 0x00: 6, 0x08: 6, 0xD8: 10, 0xD9: 10, 0xDA: 10, 0xDD: 10, 0xDE: 10 };

  class PceCdRom {
    constructor(host, disc, opts) {
      opts = opts || {};
      this.host = host;
      this.disc = disc || new Emu.PceDisc();
      this.superCd = opts.superCd !== false; // $18C0-$18C3 に Super CD-ROM² の印を出すか
      this.adpcm = new Emu.PceAdpcm(this);
      // レジスタ
      this.activeIrqs = 0; this.enabledIrqs = 0; this.resetReg = 0;
      this.readRight = false; this.sampleLatch = 0; this.latchLockUntil = 0;
      // SCSI
      this.ack = false; this.bsy = false; this.cdl = false; this.io = false; this.msg = false; this.req = false; this.rst = false; this.sel = false;
      this.phase = PH_FREE; this.messageDone = false; this.dataPort = 0; this.readPort = 0;
      this.sector = 0; this.sectorsToRead = 0;
      this.changed = false; this.readCounter = 0; this.ackClear = 0; this.updCounter = 0; this.updType = UP_CMD; this.need = true;
      this.cmd = [];
      this.buf = new Uint8Array(2048); this.bufPos = 0; this.bufLen = 0;
      // CD-DA
      this.auStatus = AU_IDLE; this.auStart = 0; this.auEnd = 0; this.auEndMode = END_STOP; this.auSector = 0; this.auSample = 0;
      this.left = 0; this.right = 0;
      this.auClock = 0; this.subIrqCount = 0; this.subPos = 0; this.subSector = 0; this.subNext = 0; this.seekDelay = 0;
      // フェーダ
      this.fadeReg = 0; this.fadeOn = false; this.fadeAdpcm = false; this.fadeFast = false; this.fadeStart = 0;
      // 音に出す側
      this.audPL = 0; this.audPR = 0; this.audCL = 0; this.audCR = 0; this.audAt = 0;
      this.outL = 0; this.outR = 0;
      this.mute = { cdda: false, adpcm: false }; this.vol = { cdda: 1, adpcm: 1 };
      this.onCommand = null; // (コマンドの並び) SCSI のコマンドを実行する時(確認用)
      // CD-DA の状態が変わった時(録音用。VGM の規格外ブロック PCEX 種類 2 の中身と同じ並び。vgmHeader.js):
      //   [1, 始まり LBA×3, 終わり LBA×3, 終わりの動き(0 止まる 1 繰り返す 2 止まって割り込み), 一時停止で始めるか, 今の位置 LBA×3] 再生(音が出るのはシークの後)
      //   [2] 一時停止 / [3] 停止 / [4, $180F の値, 入ってからの時間(10ms 単位、2 バイト)] フェーダ / [5, 終わり LBA×3, 終わりの動き] 終わりの指定(再生を始める)
      this.onOp = null;
      this.reads = 0;        // 読んだセクタの数(表示・確認用)
    }

    // ── 割り込み ──
    setIrq(src) {
      if (this.resetReg & 0x02) return;
      if (!(this.activeIrqs & src)) { this.activeIrqs |= src; this._irq(); }
    }
    clearIrq(src) { if (this.activeIrqs & src) { this.activeIrqs &= ~src; this._irq(); } }
    _irq() { this.host.irq2 = (this.enabledIrqs & this.activeIrqs) !== 0; }

    get clock() { return this.host.clock; }
    currentSector() { return this.auStatus === AU_IDLE ? this.sector : this.auSector; }

    // ── ADPCM から見た SCSI の口 ──
    scsiDataPort() { return (this.phase === PH_STATUS || this.phase === PH_DATAIN || this.phase === PH_MSGIN) ? this.readPort : this.dataPort; }
    scsiDataReady() { return this.bufLen > this.bufPos; }
    scsiAckAuto() { this._set('ack', true); this._busIrq(); this.ackClear = 21; this.need = true; }

    // ── SCSI ──
    _set(name, v) { if (this[name] !== v) { this[name] = v; this.changed = true; this.need = true; } }
    _busIrq() {
      if (this.req && this.io && this.bsy) this.setIrq(this.cdl ? IRQ_STATUS : IRQ_DATA);
      else { this.clearIrq(IRQ_STATUS); this.clearIrq(IRQ_DATA); }
    }
    _setReq(v) { this._set('req', v); this._busIrq(); }
    _setPhase(p) {
      if (this.phase === p) return;
      this.updCounter = 0; this.changed = true; this.need = true; this.phase = p;
      this._set('bsy', false); this._set('cdl', false); this._set('io', false); this._set('msg', false); this._set('req', false);
      this._busIrq();
      switch (p) {
        case PH_CMD: this.readCounter = 0; this._set('bsy', true); this._set('cdl', true); this._set('req', true); break;
        case PH_DATAIN: this._set('bsy', true); this._set('io', true); break;
        case PH_MSGIN: this._set('bsy', true); this._set('cdl', true); this._set('io', true); this._set('msg', true); this._set('req', true); break;
        case PH_STATUS: this._set('bsy', true); this._set('cdl', true); this._set('io', true); this._set('req', true); break;
        case PH_BUSY: this._set('bsy', true); break;
        default: break;
      }
      this._busIrq();
      this._busIrq();
    }
    _busReset() {
      this._set('ack', false); this._set('cdl', false); this._set('io', false); this._set('msg', false); this._set('req', false);
      this._busIrq();
      this.phase = PH_FREE; this.dataPort = 0; this.readPort = 0; this.sectorsToRead = 0; this.readCounter = 0;
      this.cmd.length = 0; this.bufPos = 0; this.bufLen = 0;
      if (this.onOp && this.auStatus !== AU_STOP) this.onOp([3]);
      this.auStatus = AU_STOP;
      this._busIrq();
    }
    /** 「状態」の段へ(status を返し、続けて data を length 個) */
    _status(data, length) {
      const n = length || 1;
      this.buf.fill(data, 0, n); this.bufPos = 0; this.bufLen = n;
      this.messageDone = false; this.readPort = 0;
      this._setPhase(PH_STATUS);
    }
    setGoodStatus() { this._status(0, 1); }
    _queue(type, delay) { if (type !== this.updType || this.updCounter === 0) { this.updType = type; this.updCounter = delay; this.need = true; } }

    _update() {
      if (!this.changed) return;
      if (this.rst) { this._busReset(); return; }
      do {
        this.changed = false;
        if (this.sel) {
          this.updCounter = 0;
          if (this.phase !== PH_DATAIN) this._queue(UP_CMD, 25000);
          else { this._status(0, 8); this._queue(UP_CMD, 300000); break; } // 読み出しの途中で打ち切ると 8 個のメッセージが出る(Mesen のコメント: 試験 ROM による)
        } else {
          switch (this.phase) {
            case PH_CMD: this._phaseCommand(); break;
            case PH_DATAIN: this._phaseDataIn(); break;
            case PH_MSGIN: this._phaseMessageIn(); break;
            case PH_STATUS: this._phaseStatus(); break;
            default: break;
          }
        }
      } while (this.changed);
    }
    _phaseStatus() {
      if (this.req && this.ack) this._setReq(false);
      else if (!this.req && !this.ack && this.bufLen > this.bufPos) {
        this.readPort = this.buf[this.bufPos++];
        if (this.bufPos >= this.bufLen) this._setPhase(PH_MSGIN); else this._setReq(true);
      }
    }
    _phaseMessageIn() {
      if (this.req && this.ack) { this._setReq(false); this.messageDone = true; }
      else if (!this.req && !this.ack && this.messageDone) { this.messageDone = false; this._setPhase(PH_FREE); }
    }
    _phaseDataIn() {
      if (this.req && this.ack) this._setReq(false);
      else if (!this.req && !this.ack) {
        if (this.bufLen > this.bufPos) { this.readPort = this.buf[this.bufPos++]; this._setReq(true); }
        else if (this.sectorsToRead === 0) this._queue(UP_GOOD, 1000);
      }
    }
    _phaseCommand() {
      if (this.req && this.ack) { this._setReq(false); this.cmd.push(this.dataPort); }
      else if (!this.req && !this.ack && this.cmd.length > 0) {
        const size = CMD_SIZE[this.cmd[0]] || 0;
        if (size === 0) { this._status(0, 1); this.cmd.length = 0; }
        else if (size <= this.cmd.length) { if (this.onCommand) this.onCommand(this.cmd); this._command(this.cmd[0]); this.cmd.length = 0; }
        else this._queue(UP_REQ, 1000);
      }
    }

    _command(op) {
      const c = this.cmd, disc = this.disc;
      switch (op) {
        case 0x00: this._queue(UP_GOOD, 150000); break;
        case 0x08: {
          const sector = c[3] | (c[2] << 8) | ((c[1] & 0x1F) << 16), count = c[4];
          if (count === 0 || sector >= disc.sectorCount) { this._status(0, 1); break; }
          this.readCounter = (seekClocks(this.currentSector(), sector) >>> 0) + SECTOR_CLOCKS; // シークの時間は 32bit に丸まる(Mesen と同じ)
          this.need = true;
          this.sector = sector; this.sectorsToRead = count;
          this._setPhase(PH_DATAIN); // 段はすぐ「データ入力」にする(待たせると絵が乱れるソフトがある、と Mesen のコメント)
          if (this.onOp && (this.auStatus === AU_PLAY || this.auStatus === AU_PAUSE)) this.onOp([3]);
          this.auStatus = AU_IDLE;
          break;
        }
        case 0xD8: {
          const start = this._audioLba();
          if (start >= disc.sectorCount) { this._status(0, 1); break; }
          this._play(start, c[1] === 0);
          this._setPhase(PH_BUSY); // 音が出始めるまで「忙しい」のまま
          break;
        }
        case 0xD9: {
          const end = this._audioLba();
          switch (c[1]) {
            case 0: this.auStatus = AU_STOP; if (this.onOp) this.onOp([3]); break;
            case 1: this._setEnd(end, END_LOOP); break;
            case 2: this._setEnd(end, END_IRQ); break;
            case 3: this._setEnd(end, END_STOP); break;
            default: break;
          }
          if (c[1] === 1 || c[1] === 2) this._setPhase(PH_BUSY); else this._status(0, 1);
          break;
        }
        case 0xDA: this.auStatus = AU_PAUSE; if (this.onOp) this.onOp([2]); this._status(0, 1); break;
        case 0xDD: {
          const sector = this.currentSector(), ti = disc.trackOf(sector);
          const isData = ti >= 0 ? !disc.tracks[ti].audio : false;
          const rel = ti >= 0 ? sector - disc.tracks[ti].first : 0;
          const b = this.buf;
          b[0] = this.auStatus; b[1] = 0x01 | (isData ? 0x40 : 0); b[2] = bcd(ti + 1); b[3] = 1;
          b[4] = bcd(Math.floor(rel / 75 / 60)); b[5] = bcd(Math.floor(rel / 75) % 60); b[6] = bcd(rel % 75);
          b[7] = bcd(Math.floor(sector / 75 / 60)); b[8] = bcd(Math.floor(sector / 75) % 60); b[9] = bcd(sector % 75);
          this.bufPos = 0; this.bufLen = 10;
          this._queue(UP_DATAIN, 1000);
          break;
        }
        case 0xDE: {
          const b = this.buf;
          const putMsf = (lba) => { b[0] = bcd(Math.floor(lba / 75 / 60)); b[1] = bcd(Math.floor(lba / 75) % 60); b[2] = bcd(lba % 75); };
          if (c[1] === 0) { b[0] = 1; b[1] = bcd(disc.tracks.length & 0xFF); b[2] = 0; b[3] = 0; }
          else if (c[1] === 1) { putMsf(disc.endLba); b[3] = 0; }
          else if (c[1] === 2) {
            let track = unbcd(c[2]); if (track === 0) track = 1;
            const over = track > disc.tracks.length;
            putMsf(over ? disc.endLba : disc.tracks[track - 1].first + 150);
            b[3] = (over || disc.tracks[track - 1].audio) ? 0 : 4;
          } else break; // 知らない種類は返事をしない
          this.bufPos = 0; this.bufLen = 4;
          this._queue(UP_DATAIN, 3000);
          break;
        }
        default: break;
      }
    }

    /** 音声の位置の指定(コマンドの 10 個目の上位 2bit: 0 = LBA、$40 = 分秒フレーム、$80 = トラック番号) */
    _audioLba() {
      const c = this.cmd, disc = this.disc;
      switch (c[9] & 0xC0) {
        case 0x00: return ((c[3] << 16) | (c[4] << 8) | c[5]) >>> 0;
        case 0x40: return (Emu.PceDisc.msf(unbcd(c[2]), unbcd(c[3]), unbcd(c[4])) - 150) >>> 0;
        case 0x80: {
          const n = unbcd(c[2]) - 1, t = disc.tracks;
          if (n >= 0 && n < t.length) return t[n].first;
          if (n > 0 && n === t.length) return t[n - 1].last; // 最後のトラックの次を指した時は、最後のトラックの終わり(Mesen のコメント: これが無いと進めなくなるソフトがある)
          return 0;
        }
        default: return 0;
      }
    }

    _play(start, pause) {
      const ti = this.disc.trackOf(start);
      if (ti < 0) return;
      this.seekDelay = seekClocks(this.currentSector(), start) >>> 0;
      this.auStart = start; this.auStatus = pause ? AU_PAUSE : AU_PLAY;
      this.auEnd = this.disc.tracks[ti].last; this.auEndMode = END_STOP;
      this.auSample = 0; this.auSector = start;
      this.auClock = 0;
      if (this.onOp) this.onOp(this.audioState());
    }
    _setEnd(end, mode) {
      if (end >= this.disc.sectorCount) end = (this.disc.sectorCount - 1) >>> 0;
      this.auEnd = end; this.auEndMode = mode; this.auStatus = AU_PLAY;
      if (this.onOp) this.onOp([5, (end >> 16) & 0xFF, (end >> 8) & 0xFF, end & 0xFF, mode]);
    }
    /** 今の CD-DA の状態を操作の形で(再生を始めた時と、録音の頭に置く)。鳴っていなければ null */
    audioState() {
      if (this.auStatus !== AU_PLAY && this.auStatus !== AU_PAUSE) return null;
      const lba3 = (v) => [(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF];
      return [1].concat(lba3(this.auStart), lba3(this.auEnd), [this.auEndMode, this.auStatus === AU_PAUSE ? 1 : 0], lba3(this.auSector));
    }
    /** 今のフェーダを操作の形で。入っていなければ null */
    fadeState() {
      if (!this.fadeOn) return null;
      const el = Math.min(0xFFFF, Math.floor((this.host.clock - this.fadeStart) / (MASTER / 100)));
      return [4, this.fadeReg, el & 0xFF, el >> 8];
    }

    _discRead() {
      this.readCounter -= 3;
      if (this.readCounter > 0) return;
      if (this.bufLen <= this.bufPos) {
        this.bufPos = 0; this.bufLen = this.disc.readData(this.sector, this.buf);
        this.reads++;
        this.sector = (this.sector + 1) & 0x1FFFFF;
        this.sectorsToRead = (this.sectorsToRead - 1) & 0xFF;
        this.changed = true; this.need = true;
        this.readCounter = this.sectorsToRead === 0 ? 0 : SECTOR_CLOCKS;
        this._setPhase(PH_DATAIN);
      } else {
        this.readCounter = LATE_CLOCKS; // 前のセクタが読み切られていない
        this.need = true;
      }
    }

    _scsiExec() {
      if (this.ackClear > 0) { this.ackClear -= 3; if (this.ackClear === 0) this._set('ack', false); }
      if (this.updCounter && --this.updCounter === 0) {
        switch (this.updType) {
          case UP_CMD: this._setPhase(PH_CMD); break;
          case UP_REQ: this._setReq(true); break;
          case UP_DATAIN: this._setPhase(PH_DATAIN); break;
          default: this._status(0, 1); break;
        }
      }
      if (this.readCounter > 0) this._discRead();
      if (this.changed) this._update();
      this.need = this.changed || this.readCounter > 0 || this.ackClear > 0 || this.updCounter > 0;
    }

    // ── CD-DA ──
    _cddaTick() {
      if (++this.subIrqCount >= 6) {
        this.setIrq(IRQ_SUB);
        this.subIrqCount = 0;
        if (++this.subPos >= 98) {
          this.subPos = 0;
          if (!this.seekDelay) { this.subSector = this.subNext; this.subNext = this.currentSector(); } // シーク中は前のセクタのサブコードを繰り返す
        }
      }
      if (this.seekDelay === 0) {
        if (this.auStatus === AU_PLAY) {
          const disc = this.disc;
          this.left = disc.sample(this.auSector, this.auSample, 0);
          this.right = disc.sample(this.auSector, this.auSample, 2);
          if (++this.auSample === 588) {
            this.auSample = 0; this.auSector++;
            if (this.auSector > this.auEnd) {
              if (this.auSector >= disc.sectorCount) this.auSector = disc.sectorCount - 1;
              if (this.auEndMode === END_LOOP) this.auSector = this.auStart;
              else { this.auStatus = AU_STOP; if (this.onOp) this.onOp([3]); if (this.auEndMode === END_IRQ) this.setGoodStatus(); }
            }
          }
        } else { this.left = 0; this.right = 0; }
        this.audPL = this.audCL; this.audPR = this.audCR; this.audCL = this.left; this.audCR = this.right; this.audAt = this.host.clock;
      } else {
        if (this.seekDelay <= CDDA_CLOCKS) { this.seekDelay = 0; this.setGoodStatus(); } // 音の出始め: 「正常終了」を返す
        else this.seekDelay -= CDDA_CLOCKS;
        this.audPL = this.audCL; this.audPR = this.audCR; this.audCL = 0; this.audCR = 0; this.audAt = this.host.clock;
      }
    }

    /** マスタークロック 3 個ぶん */
    exec() {
      if (this.need) this._scsiExec();
      if (this.adpcm.need) this.adpcm.exec();
      this.auClock += 3;
      if (this.auClock > CDDA_CLOCKS) { this.auClock -= CDDA_CLOCKS; this._cddaTick(); }
    }

    // ── フェーダ ──
    _fade(forAdpcm) {
      if (!this.fadeOn || this.fadeAdpcm !== forAdpcm) return 1;
      const per = Math.floor((this.fadeFast ? 0.025 : 0.06) * MASTER);
      const v = 1 - Math.floor((this.host.clock - this.fadeStart) / per) / 100; // 1% 刻みで下がる(Mesen は整数の割り算)
      return v < 0 ? 0 : v;
    }

    /** 今の音を outL / outR に入れる(本体の物差し。波形メモリ音源に足す値) */
    mix(clock) {
      let l = 0, r = 0;
      if (!this.mute.cdda) {
        let f = (clock - this.audAt) / CDDA_CLOCKS; if (f > 1) f = 1;
        const g = UNIT * this._fade(false) * this.vol.cdda;
        l = (this.audPL + (this.audCL - this.audPL) * f) * g;
        r = (this.audPR + (this.audCR - this.audPR) * f) * g;
      }
      const a = this.adpcm.level(clock);
      if (a !== 0 && !this.mute.adpcm) { const v = a * UNIT * this._fade(true) * this.vol.adpcm; l += v; r += v; }
      this.outL = l; this.outR = r;
    }

    // ── レジスタ ──
    write(reg, value) {
      switch (reg) {
        case 0x00: this._set('sel', true); this._update(); this._set('sel', false); this._update(); break;
        case 0x01: this.dataPort = value; this._update(); break;
        case 0x02:
          this._set('ack', (value & 0x80) !== 0); this._update();
          this.enabledIrqs = value & 0x7F; this._irq();
          break;
        case 0x04: {
          this.resetReg = value & 0x0F;
          const reset = (value & 0x02) !== 0;
          this._set('rst', reset); this._update();
          if (reset) { this.enabledIrqs &= 0x8F; this._irq(); }
          break;
        }
        case 0x05:
          if (this.host.clock >= this.latchLockUntil) {
            this.readRight = !this.readRight;
            this.sampleLatch = (this.readRight ? this.right : this.left) & 0xFFFF;
            this.latchLockUntil = this.host.clock + 700;
          }
          break;
        case 0x07: this.host.bramLocked = (value & 0x80) === 0; break;
        case 0x08: case 0x09: case 0x0A: case 0x0B: case 0x0C: case 0x0D: case 0x0E: this.adpcm.write(reg, value); break;
        case 0x0F:
          this.fadeReg = value; this.fadeOn = (value & 0x08) !== 0; this.fadeAdpcm = (value & 0x02) !== 0; this.fadeFast = (value & 0x04) !== 0;
          this.fadeStart = this.host.clock;
          if (this.onOp) this.onOp([4, value & 0xFF, 0, 0]);
          break;
        default: break;
      }
    }

    read(reg) {
      switch (reg) {
        case 0x00: return (this.io ? 0x08 : 0) | (this.cdl ? 0x10 : 0) | (this.msg ? 0x20 : 0) | (this.req ? 0x40 : 0) | (this.bsy ? 0x80 : 0);
        case 0x01: return this.scsiDataPort();
        case 0x02: return this.enabledIrqs | (this.ack ? 0x80 : 0);
        case 0x03: this.host.bramLocked = true; return this.activeIrqs | (this.readRight ? 0 : 0x02);
        case 0x04: return this.resetReg;
        case 0x05: return this.sampleLatch & 0xFF;
        case 0x06: return (this.sampleLatch >> 8) & 0xFF;
        case 0x07: { const v = this.disc.subByte(this.subSector * 98 + this.subPos); this.clearIrq(IRQ_SUB); return v; }
        case 0x08: {
          const v = this.scsiDataPort();
          if (this.req && this.io && !this.cdl) { this.scsiAckAuto(); this._update(); }
          return v;
        }
        case 0x09: case 0x0A: case 0x0B: case 0x0C: case 0x0D: case 0x0E: return this.adpcm.read(reg);
        case 0x0F: return this.fadeReg;
        case 0xC0: case 0xC1: case 0xC2: case 0xC3: return this.superCd ? SIGNATURE[reg & 3] : 0xFF;
        default: return 0xFF;
      }
    }
  }

  PceCdRom.seekMs = seekMs;
  PceCdRom.UNIT = UNIT;
  Emu.PceCdRom = PceCdRom;
})(typeof window !== 'undefined' ? window : globalThis);
