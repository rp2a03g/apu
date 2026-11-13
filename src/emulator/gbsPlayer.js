/*
 * GBS プレイヤー
 * MML.Emu.GbsPlayer
 *
 * ★2026-11-13 本体コア(gb/gbConsole.js)の上に載せ替え(DESIGN-GB-CAPTURE.md §2.3)。
 *   旧実装は「ヘッダから求めた頻度で PLAY をサブルーチンとして直接呼ぶ」作りで、タイマも割り込みも無かった。
 *   今は実機と同じく、タイマ割り込み(TAC bit2=1)か VBlank 割り込みのハンドラから PLAY を呼ぶ。
 *   曲が TMA/TAC を書き換えてテンポを変えても追従し、PLAY の中の時刻(フレーム内のどこで書いたか)も実機どおりになる。
 *
 * 仕組み: GBS のデータを「カートリッジ」(GbsCart)として本体に挿し、呼び出しの枠はホスト側で作る(ROM 側にコードを置かない。
 *   loadAddr が $70 の曲もあり、空き番地を当てにできない):
 *   - INIT: スタックに IDLE($FEA0、未使用領域)を積んで PC=INIT。PC が IDLE に着いたら戻ったとみなす
 *   - IDLE に居る間は HALT 相当で割り込みを待つ
 *   - 割り込みで PC が $40(VBlank)/$50(タイマ)に来たら、RET_MAGIC を積んで PC=PLAY。PC が RET_MAGIC に着いたら RETI 相当
 *   - $00-$38 の RST は JP loadAddr+n(GBS の規約。loadAddr より下だけ)
 *   採取の「フレーム」は PLAY の呼び出しから次の呼び出しの直前まで(=実機の 1 周期)。フレーム末の音源の状態は
 *   PLAY が書き終えた後の落ち着いた値になる(抽出はこれを読む)
 *
 * - initSong(songIndex): INIT を呼んで待ちループに着くまで回す
 * - renderFrame(sampleRate, regsOnly, stereo): 1/playFps 秒ぶん進める(「フレーム」は採取の刻みで、PLAY の呼び出しとは独立)
 * - bus.onWrite(addr, value, t): 音源レジスタ($FF10-$FF3F)への書き込み。t は renderFrame の頭からの T
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const IDLE = 0xFEA0, RET_MAGIC = 0xFEB0; // どちらも未使用領域の番地(実行はさせず、PC がここに来たのをホストが見る)

  // GBS のデータを本体コアに挿すための「カートリッジ」。簡略 MBC1($2000-$3FFF でバンク、RAM は常に許可)
  class GbsCart {
    constructor(header, data) {
      this.gbsHeader = header;
      this.data = data;
      this.loadAddr = header.loadAddr;
      this.ram = new Uint8Array(0x2000);
      this.rom = data; // describe 用
      this.mbc = 'gbs'; this.unsupported = false; this.hasBattery = false; this.hasRtc = false; this.dirty = false;
      this.header = { title: header.title || '', type: 0, cgb: false, cgbOnly: false, sgb: false, checksumOk: true };
      const L = this.loadAddr;
      // バンク数は 2 のべきに切り上げる(実カートリッジと同じ。足りない上位ビットは無視され、同じ中身が繰り返し見える)
      let bc = 2; while (bc * 0x4000 < L + data.length) bc *= 2;
      this.bankCount = bc;
      const low = this.low = new Uint8Array(0x40);
      for (let i = 0; i <= 0x38; i += 8) { const t = (L + i) & 0xFFFF; low[i] = 0xC3; low[i + 1] = t & 0xFF; low[i + 2] = t >> 8; }
      this.reset();
    }
    reset() { this.bank = 1; this.ram.fill(0); }
    read(addr) {
      const L = this.loadAddr;
      if (addr < L) return addr < 0x40 ? this.low[addr] : 0;
      // $4000 までが固定、$4000-$7FFF はバンク 1 がその続き、バンク 2 以降は $4000 バイトずつ後ろ
      const off = addr < 0x4000 ? addr - L : (0x4000 - L) + (this.bank - 1) * 0x4000 + (addr - 0x4000);
      return off >= 0 && off < this.data.length ? this.data[off] : 0;
    }
    write(addr, v) {
      if (addr >= 0x2000 && addr < 0x4000) {
        // MBC1 と同じ: 0 は 1 に読み替えてから、ある分のビットだけ見る。2 バンクしか無い曲データが上位ビットの立った番号を書いても
        // 正しいバンクが出る(2026-11-13 まで番号をそのまま使っていて、データの外=0 を読んで暴走する曲があった。Mesen との突き合わせで判明)
        let n = this.bankCount <= 32 ? v & 0x1F : v;
        if (n === 0) n = 1;
        this.bank = n % this.bankCount;
      }
    }
    readRam(addr) { return this.ram[addr & 0x1FFF]; }
    writeRam(addr, v) { this.ram[addr & 0x1FFF] = v; }
    tickRtc() {}
    getBattery() { return null; }
    setBattery() { return false; }
  }

  class GbsPlayer {
    /**
     * @param {Uint8Array} gbsBytes - GBSファイルの完全なバイナリ
     */
    constructor(gbsBytes) {
      this.header = MML.GBS.parseHeader(gbsBytes);
      this.cart = new GbsCart(this.header, gbsBytes.slice(this.header.dataOffset));
      // lcdAlwaysOn: VBlank 駆動の曲が LCDC を触っても割り込みが止まらないように。noRender: 絵は描かない
      // ヘッダの TAC bit7 が立っている曲は CGB の倍速で動かす(CPU とタイマが 2 倍速。音源は元の速さのまま)
      this.fast = ((this.header.tac | 0) & 0x80) !== 0;
      this.con = new Emu.GbConsole(null, { cart: this.cart, lcdAlwaysOn: true, noRender: true, model: this.fast ? 'cgb' : 'dmg' });
      this.apu = this.con.apu;
      this.cpu = this.con.cpu;
      // 旧 API 互換: player.bus.onWrite に関数を入れると音源レジスタの書き込みが届く
      this.bus = { onWrite: null };
      this.con.onWrite = (addr, value) => { if (this.bus.onWrite) this.bus.onWrite(addr, value, this.con.cpuCycles - this._frameStartT); };

      this.clockHz = MML.GBS.CPU_CLOCK;
      // 採取の刻み = PLAY の周期。ヘッダの TMA/TAC が基本だが、曲ごとに INIT や最初の PLAY でタイマを書き換えてテンポを変える作品がある
      // (ヘッダ 89Hz に対して曲により 69〜108Hz など)。initSong がその曲の実際の値に直す(GbsPlayer.songFps)
      this.bytes = gbsBytes;
      this.frameRate = this.header.playFps;
      this.speedFactor = 1;
      this._playAccum = 0;
      this._frameStartT = 0;
      this._boundary = false;   // 次の PLAY の入口に着いた(フレームの区切り)
      this._atEntry = false;    // その入口をまだ処理していない
    }

    /**
     * 指定した曲番号(0始まり)で初期化する
     * @param {number} songIndex
     */
    initSong(songIndex) {
      const con = this.con, cpu = con.cpu, h = this.header;
      con.reset();
      if (this.fast) { con.doubleSpeed = true; con.stepT = 2; con.apuBit = 1 << 13; }
      con.apu.reset(); // 音源は起動チャイム後の値でなく素の状態から(GBS はブート ROM を通らない。旧実装と同じ出発点)
      // ヘッダの TMA/TAC を先に入れる(GBS の規約)。TAC bit2=1 ならタイマ割り込み、0 なら VBlank。bit6 は両方
      const tac = h.tac | 0, timer = (tac & 0x04) !== 0;
      this.irqMask = timer ? ((tac & 0x40) ? 0x05 : 0x04) : 0x01;
      con.ie = 0; con.if = 0;
      con._setDiv(0);
      con.write(0xFF06, h.tma | 0); con.write(0xFF05, h.tma | 0); con.write(0xFF07, tac & 0x07);
      cpu.ime = false; cpu.halted = false; cpu.stopped = false;
      cpu.a = songIndex & 0xFF; cpu.setBC(IDLE); cpu.setDE(IDLE); cpu.setHL(IDLE); // INIT も釣り合わない戻り方に備える
      cpu.sp = h.stackPointer; this._push(IDLE);
      cpu.pc = h.initAddr;
      // INIT が戻るまで(最大 1 秒ぶん)。HALT/STOP で止まる INIT は戻ったものとして扱う(旧実装と同じ)
      this._frameStartT = con.cpuCycles;
      const limit = con.cpuCycles + this.clockHz;
      while (cpu.pc !== IDLE && con.cpuCycles < limit && !cpu.stopped && !(cpu.halted && !con.irqPending())) con.step();
      cpu.pc = IDLE; cpu.halted = false; cpu.stopped = false; cpu.haltBug = false;
      con.ie = this.irqMask; cpu.ime = true;
      // 最初の PLAY の入口まで進めておく(フレーム 0 が PLAY から始まるように)。ここまでの音は捨てる
      this._boundary = false; this._atEntry = false; this._playAccum = 0; this._inPlay = false;
      const limit2 = con.cpuCycles + this.clockHz / 4;
      while (!this._boundary && con.cpuCycles < limit2) this._step();
      con.ringHead = 0; con.ringLen = 0; con.cycleAccum = 0;
      this._frameStartT = con.cpuCycles;
      this._due = 0;
      if (!this._probe) this.frameRate = GbsPlayer.songFps(this.bytes, songIndex);
    }
    // 今のタイマの設定での PLAY の周期(Hz)。VBlank 駆動なら 59.7275
    _fpsNow() {
      const con = this.con;
      if (!(this.irqMask & 4) || !(con.tac & 4)) return MML.GBS.VBLANK_FPS;
      const div = [1024, 16, 64, 256][con.tac & 3] * (256 - con.tma);
      return this.clockHz / div * (this.fast ? 2 : 1);
    }

    // 1 命令進める。IDLE/割り込みの入口/PLAY からの戻りはここで捌く
    _step() {
      const con = this.con, cpu = con.cpu, pc = cpu.pc;
      if (pc === IDLE) { this._inPlay = false; con.ie = this.irqMask; cpu.ime = true; cpu.halted = true; con.step(); return; }
      if ((pc === 0x40 || pc === 0x50) && !cpu.ime && !cpu.halted) {
        if (!this._atEntry) { this._atEntry = true; this._boundary = true; return; } // ここがフレームの区切り。処理は次のフレームの頭で
        this._atEntry = false;
        // PLAY の外(待ちループ)から来た時は、スタックを毎回ヘッダの位置へ戻す。INIT が自分で SP を動かしたまま終わる曲や、
        // HALT で止まった INIT の続きから来る曲があり、戻さないと PLAY が音源レジスタの番地をスタックにして壊す(Mesen との突き合わせで判明)
        if (!this._inPlay) { cpu.sp = this.header.stackPointer; this._push(IDLE); }
        // 再生速度(1/1〜1/8): PLAY を何回かに 1 回だけ呼ぶ(音程は変えずテンポだけ落とす)
        let call = true;
        if (this.speedFactor < 1) { this._playAccum += this.speedFactor; if (this._playAccum >= 1) this._playAccum -= 1; else call = false; }
        // PLAY の最中に(曲が自分で EI して)割り込みが重なった時は、重ねて呼ばずに戻る(旧実装の「実行中なら次のフレームは呼ばない」と同じ)
        if (this._inPlay) call = false;
        // レジスタも全部 RET_MAGIC にしておく: 「PUSH を 4 つ積んで CALL して、POP せずに RET」という釣り合わない PLAY を持つ曲データがあり、
        // その RET は積んだレジスタの値へ飛ぶ(GBS は PLAY に入る時のレジスタを決めていない)。どのレジスタが一番上でも「戻った」と分かる
        if (call) { this._inPlay = true; this._push(RET_MAGIC); cpu.a = RET_MAGIC >> 8; cpu.f = RET_MAGIC & 0xF0; cpu.setBC(RET_MAGIC); cpu.setDE(RET_MAGIC); cpu.setHL(RET_MAGIC); cpu.pc = this.header.playAddr; }
        else { cpu.pc = this._pop(); cpu.ime = true; }
        return;
      }
      // PLAY から戻った: 待ちループへ(スタックは次の PLAY の頭でヘッダの位置へ戻すので、釣り合っていなくてよい)
      if (pc === RET_MAGIC) { this._inPlay = false; cpu.sp = this.header.stackPointer; cpu.pc = IDLE; cpu.ime = true; return; }
      // 曲が自分で IE を書き換えて STAT/シリアル/ジョイパッドの割り込みが来た時は何もせず戻る
      if ((pc === 0x48 || pc === 0x58 || pc === 0x60) && !cpu.ime && !cpu.halted && pc < this.cart.loadAddr) { cpu.pc = this._pop(); cpu.ime = true; return; }
      // PLAY の中で HALT/STOP して割り込みも来ない: 戻ったものとして待ちループへ
      if (cpu.stopped || (cpu.halted && !(con.ie & 0x1F))) { cpu.stopped = false; cpu.halted = false; cpu.sp = this.header.stackPointer; cpu.pc = IDLE; con.ie = this.irqMask; return; }
      con.step();
    }
    // 時間を進めないスタック操作(ホストが作る呼び出しの枠用)
    _push(v) { const con = this.con, cpu = con.cpu; cpu.sp = (cpu.sp - 1) & 0xFFFF; con.write(cpu.sp, (v >> 8) & 0xFF); cpu.sp = (cpu.sp - 1) & 0xFFFF; con.write(cpu.sp, v & 0xFF); }
    _pop() { const con = this.con, cpu = con.cpu; const lo = con._busRead(cpu.sp); cpu.sp = (cpu.sp + 1) & 0xFFFF; const hi = con._busRead(cpu.sp); cpu.sp = (cpu.sp + 1) & 0xFFFF; return lo | (hi << 8); }

    /**
     * 1 フレーム(PLAY の呼び出しから次の呼び出しの直前まで)ぶん進める。長さは実機の周期どおりで、
     * サンプル数はフレームごとに 1 前後ゆれる(旧実装は round(sampleRate/playFps) に固定していた)。
     * @param {number} sampleRate
     * @param {boolean} [regsOnly] - true なら音は作らず CPU と音源の状態だけ進める(先読みキャプチャ用)
     * @param {boolean} [stereo] - true なら {left, right} を返す
     * @returns {Float32Array|{left:Float32Array,right:Float32Array}|null}
     */
    renderFrame(sampleRate, regsOnly, stereo) {
      const con = this.con;
      const want = regsOnly ? 0 : sampleRate;
      if (con.sampleRate !== want) con.setSampleRate(want);
      this._frameStartT = con.cpuCycles;
      this._boundary = false;
      // 区切りは次の PLAY の入口。PLAY が 1 周期に収まらない時(HALT で間を取りながら PCM を流し続ける曲など)は入口が来ないので、
      // 公称の周期の格子(_due)で区切る。入口が来たら格子をそこへ合わせ直す(時間軸がずれていかない)
      const period = this.clockHz / this.frameRate;
      if (!(this._due > 0)) this._due = con.cpuCycles;
      this._due += period;
      const limit = this._due + period * 0.02;
      while (!this._boundary && con.cpuCycles < limit) this._step();
      if (this._boundary) this._due = con.cpuCycles;
      if (regsOnly) return null;
      const n = con.ringLen;
      const outL = new Float32Array(n);
      if (stereo) { const outR = new Float32Array(n); con.takeAudioInto(outL, n, outR); return { left: outL, right: outR }; }
      con.takeAudioInto(outL, n);
      return outL;
    }
  }

  // APUのライブ状態を1フレーム分スナップショットする(gbs2mml向け)。
  // GBはCH1の周波数スイープ・エンベロープの減衰/増加が「レジスタ再書込み無しに
  // 内部クロックだけで」進行するため、writeLogの再生(SCC方式)では追えない
  // (N163のRAMスナップショットが必要だった事情と同種。src/emulator/capture.js参照)。
  // ライブのAPUオブジェクトから直接値を読む方が単純かつ正確なので、GBSは
  // 全チャンネルをこの方式に統一する(波形メモリも書込み再生ではなくch3.waveを直接読む)。
  function snapshotApu(apu) {
    return {
      // envInitVol/envDir/envPeriod: NRx2の生値(トリガー時に固定される、実機の
      // エンベロープハードウェアパラメータそのもの)。gbs2mml側でこれを起点(anchor)に
      // 「64Hz固定クロック×period」で音量を解析的に計算し直すために必要
      // (src/gbs2mml/expansion/hwEnvelope.js参照。駆動フレーム境界(playFps、曲毎に
      // 可変)で単純にvolを読むと、実機の64Hzエンベロープクロックとの位相ズレにより
      // 同一形状のエンベロープでも観測される段数が変わってしまう問題への対処)。
      ch1: { freq: apu.ch1.freq, duty: apu.ch1.duty, vol: apu.ch1.envelope.volume, enabled: apu.ch1.enabled, triggerSeq: apu.ch1.triggerSeq,
             envInitVol: apu.ch1.envelope.initialVolume, envDir: apu.ch1.envelope.direction, envPeriod: apu.ch1.envelope.period },
      ch2: { freq: apu.ch2.freq, duty: apu.ch2.duty, vol: apu.ch2.envelope.volume, enabled: apu.ch2.enabled, triggerSeq: apu.ch2.triggerSeq,
             envInitVol: apu.ch2.envelope.initialVolume, envDir: apu.ch2.envelope.direction, envPeriod: apu.ch2.envelope.period },
      ch3: { freq: apu.ch3.freq, volumeShift: apu.ch3.volumeShift, wave: Array.from(apu.ch3.wave), enabled: apu.ch3.enabled, dacOn: apu.ch3.dacOn, triggerSeq: apu.ch3.triggerSeq },
      ch4: { vol: apu.ch4.envelope.volume, clockShift: apu.ch4.clockShift, widthMode: apu.ch4.widthMode, divisorCode: apu.ch4.divisorCode, enabled: apu.ch4.enabled, triggerSeq: apu.ch4.triggerSeq,
             envInitVol: apu.ch4.envelope.initialVolume, envDir: apu.ch4.envelope.direction, envPeriod: apu.ch4.envelope.period },
      // NR50(マスター音量/VIN)・NR51(パンニング)。以前はここに含まれておらず、
      // GbsReplayStreamPlayerが常にAPUGbコンストラクタのブート後既定値(nr50=$77,
      // nr51=$F3)のまま再生し続けていた(実際にゲームが書き込んだ値を無視)。
      // $F3はCH3/CH4の右chビットだけ0なので、曲を問わず常にCH3/CH4が左chにしか
      // 出力されないように聴こえる不具合の直接の原因だった。
      nr50: apu.nr50, nr51: apu.nr51
    };
  }

  /**
   * GBSを指定秒数分オフラインレンダリングし、音声・フレーム毎のレジスタ書込ログ・
   * フレーム毎のAPUライブスナップショットを返す。WAV書き出し・gbs2mml変換・
   * ピアノロールの先読みキャプチャで使う共通キャプチャ関数(captureKssSongAsyncと同型)。
   * @param {Uint8Array} gbsBytes
   * @param {object} opt - {songIndex, durationSeconds, sampleRate, mute, regsOnly}
   * @param {(done:number,total:number,data:{writeLog:Array,snapshots:Array})=>void} [onProgress]
   * @returns {Promise<{audio:Float32Array, writeLog:Array, snapshots:Array, player:GbsPlayer, frameRate:number}>}
   */
  Emu.captureGbsSongAsync = async function (gbsBytes, opt, onProgress) {
    const player = new GbsPlayer(gbsBytes);
    // INIT中の書込みもフレーム0の先頭に含める(NSF/KSSのinitWritesと同じ考え方。
    // INITで一度だけ設定されPLAY中は二度と書かれないレジスタの取りこぼし防止)。
    const initWrites = [];
    player.bus.onWrite = (addr, value) => initWrites.push({ addr, value, t: 0 });
    player.initSong(opt.songIndex || 0);
    player.bus.onWrite = null;
    if (opt.mute) Object.assign(player.apu.mute, opt.mute);

    const sampleRate = opt.sampleRate || 44100;
    const regsOnly = !!opt.regsOnly;
    const totalFrames = Math.max(1, Math.ceil((opt.durationSeconds || 30) * player.frameRate));
    const totalOutSamples = regsOnly ? 0 : Math.round((opt.durationSeconds || 30) * sampleRate);
    const audio = new Float32Array(totalOutSamples);
    const writeLog = [];
    const snapshots = [];
    let outPos = 0;
    // ★2026-08-20 スライスを「フレーム数固定」から「時間予算固定」へ変更(NSFの
    // capture.js captureSongAsync・captureKssSongAsyncと同じ方式・同じ理由)。
    // Worker実行時はopt.yieldFn/sliceBudgetMsで上書きされる。
    const sliceBudgetMs = opt.sliceBudgetMs > 0 ? opt.sliceBudgetMs : (regsOnly ? 5 : 15);
    const yieldFn = opt.yieldFn || (() => new Promise(r => setTimeout(r, 0)));
    let sliceStart = performance.now();

    for (let f = 0; f < totalFrames; f++) {
      const frameWrites = f === 0 ? initWrites : [];
      player.bus.onWrite = (addr, value, t) => frameWrites.push({ addr, value, t }); // t: フレーム頭からの T
      const frameBuf = player.renderFrame(sampleRate, regsOnly);
      player.bus.onWrite = null;
      writeLog.push(frameWrites);
      snapshots.push(snapshotApu(player.apu));
      if (!regsOnly) { for (let i = 0; i < frameBuf.length && outPos < audio.length; i++) audio[outPos++] = frameBuf[i]; }
      if (f === 0 || performance.now() - sliceStart >= sliceBudgetMs) {
        if (onProgress) onProgress(f, totalFrames, { writeLog, snapshots });
        await yieldFn();
        if (opt.shouldCancel && opt.shouldCancel()) return { audio, writeLog, snapshots, player, frameRate: player.frameRate };
        sliceStart = performance.now();
      }
    }
    if (onProgress) onProgress(totalFrames, totalFrames, { writeLog, snapshots });
    return { audio, writeLog, snapshots, player, frameRate: player.frameRate };
  };

  // その曲の PLAY の周期(Hz): INIT と最初の数回の PLAY を試しに回して、落ち着いたタイマの設定から出す。
  // 画面の時間軸、変換のテンポ、写し再生の速さはこの値を使う(ヘッダの playFps ではなく)。結果は (データ, 曲) ごとに覚える
  const fpsCache = new WeakMap();
  GbsPlayer.songFps = function (gbsBytes, songIndex) {
    let m = fpsCache.get(gbsBytes);
    if (!m) { m = new Map(); fpsCache.set(gbsBytes, m); }
    const k = songIndex | 0;
    if (m.has(k)) return m.get(k);
    let fps;
    try {
      const p = new GbsPlayer(gbsBytes);
      p._probe = true;
      p.initSong(k);
      for (let i = 0; i < 4; i++) p.renderFrame(44100, true);
      fps = p._fpsNow();
      if (!(fps > 1 && fps < 2000)) fps = p.header.playFps;
    } catch (e) { fps = MML.GBS.parseHeader(gbsBytes).playFps; }
    m.set(k, fps);
    return fps;
  };
  Emu.GbsPlayer = GbsPlayer;
  Emu.GbsCart = GbsCart;
  // VGM(vgmPlayer.js captureVgmSongAsync)がGB DMGチップのフレームスナップショットを
  // gbs2mml抽出器と同じ形で積むために公開する(GBS自身はモジュール内で直接呼ぶ)。
  Emu.snapshotGbApuForCapture = snapshotApu;
})(window);
