/*
 * VGM プレイヤー (コマンドインタプリタ + 既存音源エミュレータの配線)
 * MML.Emu.VgmPlayer / MML.Emu.captureVgmSongAsync
 *
 * VGMはCPUを持たないレジスタ書込みログなので、NSF/KSS/GBS/HESプレイヤーと違い
 * CPUコアは無い。「44100Hzのサンプルクロックを進めながらコマンドを消化し、書込みを
 * 各チップへ流す」だけ。チップ本体はすべて既存実装を流用する:
 *   NES APU(+FDS)=apu2a03.js/fds.js, GB DMG=apuGb.js, HuC6280=apuHuC6280.js,
 *   AY8910=ay8910Msx.js, K051649(SCC)=sccAudio.js, YM2413=opllMsx.js,
 *   SN76489(SMS/GG/SG-1000/MD PSG)=expansion/sn76489.js(VGM段階2で新規実装),
 *   YM2612(OPN2、MD FM)=expansion/ym2612.js(VGM段階4で新規実装。データブロック0x00のPCM、
 *   0xE0シーク、0x8n DAC書込+待ち、DACストリーム制御0x90-0x95もここで扱う)、
 *   YM2610(OPNB、Neo Geo)=expansion/ym2610.js(FM=レジスタ配置がYM2612と同一なのでYM2612コアの
 *   ラッパー、ADPCM-A/B=ymfm移植。ROMはデータブロック0x82/0x83)+AY8910Audio(SSG流用)
 * ヘッダのクロックが非ゼロでも未実装のチップは、コマンド長規則で読み飛ばすだけ
 * (ROADMAP.md VGM節: 全チップ実装は不要)。
 *
 * 時間の扱い:
 *  - VGMの待ちはすべて44100Hzサンプル数。0x70-0x7Fの1〜16サンプル待ちも潰さず
 *    サンプル単位で消化する(フレーム近似禁止)。
 *  - 各チップのclock()は「そのチップの実クロック」で進める。速度変更(speedFactor)は
 *    VGMサンプルクロックの進みだけに掛ける(GBS等と同じ: 音程は変わらずテンポだけ変わる)。
 *  - 「フレーム」は本ツール内部の便宜上の単位で、VGM時間の1/60秒(=735 VGMサンプル)。
 *    鍵盤表示/ピアノロールの採取粒度として使う。
 *
 * 既存エミュレータのclock()呼び出しレートとVGMヘッダのクロック値の対応(実測):
 *  - AY8910: エミュレータは3.58MHz(Z80)ティックでclock()、実チップクロックはその1/2
 *    (MSX=1789772Hz)。ヘッダ値×2でclock()する。
 *  - K051649: 同上(ヘッダ値1789772、エミュレータは3.58MHzティック前提)。
 *  - YM2413: ヘッダ値(3579545)そのまま(72ティックで1サンプル=49716Hz)。
 *  - NES APU: ヘッダ値(1789772)そのまま(=CPUサイクル)。FDSも同じクロック。
 *  - GB DMG: ヘッダ値(4194304)そのまま。
 *  - HuC6280: ヘッダ値(3579545)そのまま(PSGクロック)。
 *  - SN76489: ヘッダ値(3579545)そのまま(内部/16分周はチップ側)。
 *  - YM2612: ヘッダ値(7670453)そのまま(内部/144で1サンプル=53267Hz)。
 *  - YM2610: FMはヘッダ値そのまま(内部/144でYM2612と同じ、Neo Geo: 8000000Hz→55555Hz、
 *    ymfm裏取り済み)。SSGはヘッダ値/2でAY8910Audio.clock()を呼ぶ(実SSGクロックはヘッダ値/4、
 *    AY8910Audioは実クロックの2倍で叩く既存規約のため)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const VGM_RATE = 44100;
  const FRAME_RATE = 60;
  const SAMPLES_PER_FRAME = VGM_RATE / FRAME_RATE; // 735

  // 各フォーマットのストリームプレイヤーが使っている実測校正済みgain
  // (src/audio/*-stream-player.js 参照)。VGMは複数チップの合算なので、チップごとに
  // 由来フォーマットのgainを掛けてから足し、出力段のgainは1.0にする。
  // ym2610(FM+ADPCM、チップ内ミックス比はymfm準拠)/ym2610ssg: Neo Geoの曲はYM2612(MD)よりTLを詰めて
  // 鳴らすものが多く、YM2612と同じ2.0だとFMだけでMD FMの2〜4倍になる。FM+ADPCM込みの全体RMSが
  // 他形式(MD全体0.13、SPC基準)に近づくよう1.0(実測: Metal Slug 0.17〜0.21、Last Resort 0.10〜0.12、
  // Neo Turf Masters 0.29〜0.42=元々ホットな曲、ピークはリミッタ任せ)。SSGはFMに対して MAME neogeo
  // ドライバのルーティング比(SSG 0.28 : FM 0.98)を目安に0.8(暫定。実機録音との比較は未実施)。
  const CHIP_GAIN = { nes: 1.56, gb: 1.35, huc6280: 1.65, ay8910: 1.99, k051649: 1.99, ym2413: 1.99, sn76489: 2.0, ym2612: 2.0, pwm: 0.9, rf5c164: 1.6, rf5c68: 1.6, ym2610: 1.0, ym2610ssg: 0.8 };

  // ---------------------------------------------------------------------------
  // チップアダプタ: { id, clockHz, accum, chip, clock(), mix(out2), write..., snapshot() }
  // ---------------------------------------------------------------------------

  function makeNesAdapter(info) {
    const ram = new Uint8Array(0x10000);
    const bus = { read: (addr) => ram[addr & 0xFFFF] };
    const apu = new Emu.APU2A03(bus);
    apu.reset();
    const fds = info.fds && Emu.FDSAudio ? new Emu.FDSAudio() : null;
    // 鍵盤表示のNES行はレジスタスナップショット($4000-$4017, $4040-$408A)を読む
    const regs = {};
    return {
      id: 'nes', clockHz: info.clock, accum: 0, apu, fds, ram, bus, regs, gain: CHIP_GAIN.nes,
      write(aa, dd) {
        let addr;
        if (aa < 0x20) addr = 0x4000 + aa;
        else if (aa < 0x3F) addr = 0x4080 + (aa - 0x20);
        else if (aa === 0x3F) addr = 0x4023;
        else addr = 0x4040 + (aa - 0x40); // 0x40-0x7F
        regs[addr] = dd;
        if (addr <= 0x4017) apu.writeRegister(addr, dd);
        else if (fds) fds.writeRegister(addr, dd);
        return addr;
      },
      // VGMのデータブロック(0x67 type=0xC2 "NES APU RAM write")。DPCMサンプル本体が
      // ここでCPUアドレス空間へ流し込まれる。ramLoaded=一度でも流し込まれたか
      // (DMCを使わない曲と「サンプルが全部0の曲」を区別するため。captureVgmSongAsync参照)
      ramLoaded: false,
      ramWrite(start, data) { this.ramLoaded = true; for (let i = 0; i < data.length && start + i < 0x10000; i++) ram[start + i] = data[i]; },
      clock() { apu.clock(); if (fds) fds.clock(); },
      mix(out) { const s = apu.mixSample() + (fds ? fds.mixSample() : 0); out[0] += s * this.gain; out[1] += s * this.gain; },
      applyMute(m) { if (m.apu) Emu.applyMute(apu.mute, m.apu); if (fds && m.expansion && m.expansion.fds) Emu.applyMute(fds.mute, m.expansion.fds); },
      applyVolume(v) { if (v.apu) Emu.applyVolume(apu.vol, v.apu); if (fds && v.expansion && v.expansion.fds) Emu.applyVolume(fds.vol, v.expansion.fds); }
    };
  }

  function makeGbAdapter(info) {
    const apu = new Emu.APUGb();
    return {
      id: 'gb', clockHz: info.clock, accum: 0, apu, gain: CHIP_GAIN.gb,
      write(aa, dd) { apu.writeRegister(0xFF10 + (aa & 0x3F), dd); },
      clock() { apu.clock(); },
      mix(out) { const s = apu.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain; },
      applyMute(m) { const e = m.expansion || m; if (e.gb) Object.assign(apu.mute, e.gb); },
      applyVolume(v) { const e = v.expansion || v; if (e.gb) Emu.applyVolume(apu.vol, e.gb); }
    };
  }

  function makeHucAdapter(info) {
    const apu = new Emu.APUHuC6280();
    return {
      id: 'huc6280', clockHz: info.clock, accum: 0, apu, gain: CHIP_GAIN.huc6280,
      write(aa, dd) { apu.writeRegister(0x0800 + (aa & 0x0F), dd); },
      clock() { apu.clock(); },
      mix(out) { const s = apu.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain; },
      applyMute(m) { const e = m.expansion || m; if (e.hes) Object.assign(apu.mute, e.hes); },
      applyVolume(v) { const e = v.expansion || v; if (e.hes) Emu.applyVolume(apu.vol, e.hes); }
    };
  }

  function makeAyAdapter(info) {
    const chip = new Emu.AY8910Audio();
    return {
      id: 'ay8910', clockHz: info.clock * 2, accum: 0, chip, gain: CHIP_GAIN.ay8910,
      write(aa, dd) { chip.writeInternal(aa & 0x0F, dd); },
      clock() { chip.clock(); },
      mix(out) { const s = chip.mixSample() * this.gain; out[0] += s; out[1] += s; },
      // 2個目のチップ(this.second)は鍵盤のKP4-6行=配列index 3-5 を自分のch0-2として読む
      applyMute(m) { const e = m.expansion || m; if (e.psg) Emu.applyMute(chip.mute, this.second ? e.psg.slice(3) : e.psg); },
      applyVolume(v) { const e = v.expansion || v; if (e.psg) Emu.applyVolume(chip.vol, this.second ? e.psg.slice(3) : e.psg); }
    };
  }

  function makeSccAdapter(info) {
    const chip = new Emu.SCCAudio();
    const plus = !!info.sccPlus;
    return {
      id: 'k051649', clockHz: info.clock * 2, accum: 0, chip, plus, gain: CHIP_GAIN.k051649,
      // 0xD2 pp aa dd: pp 0=波形 / 1=周波数 / 2=音量 / 3=キーオン / 4=波形ch5(SCC+) / 5=テスト
      // → sccAudio.jsのclassic(0x9800基準)/plus(0xB800基準)オフセットへ写像。
      // 戻り値は kss2mml/expansion/scc.js が読むメモリアドレス(writeLog用)。
      write(pp, aa, dd) {
        let off;
        if (plus) {
          switch (pp) {
            case 0: off = aa & 0x7F; break;
            case 1: off = 0xA0 + (aa & 0x0F); break;
            case 2: off = 0xAA + (aa & 0x07); break;
            case 3: off = 0xAF; break;
            case 4: off = 0x80 + (aa & 0x1F); break;
            default: return -1;
          }
          chip.writePlus(off, dd);
          return 0xB800 + off;
        }
        switch (pp) {
          case 0: off = aa & 0x7F; break;
          case 1: off = 0x80 + (aa & 0x0F); break;
          case 2: off = 0x8A + (aa & 0x07); break;
          case 3: off = 0x8F; break;
          default: return -1;
        }
        chip.writeClassic(off, dd);
        return 0x9800 + off;
      },
      clock() { chip.clock(); },
      mix(out) { const s = chip.mixSample() * this.gain; out[0] += s; out[1] += s; },
      applyMute(m) { const e = m.expansion || m; if (e.scc) Emu.applyMute(chip.mute, e.scc); },
      applyVolume(v) { const e = v.expansion || v; if (e.scc) Emu.applyVolume(chip.vol, e.scc); }
    };
  }

  function makeOpllAdapter(info) {
    const chip = new Emu.OPLLAudio();
    return {
      id: 'ym2413', clockHz: info.clock, accum: 0, chip, gain: CHIP_GAIN.ym2413,
      write(aa, dd) { chip.writeReg(aa & 0x3F, dd); },
      clock() { chip.clock(); },
      mix(out) { const s = chip.mixSample() * this.gain; out[0] += s; out[1] += s; },
      applyMute(m) { const e = m.expansion || m; if (e.opll) Emu.applyMute(chip.mute, e.opll); },
      applyVolume(v) { const e = v.expansion || v; if (e.opll) Emu.applyVolume(chip.vol, e.opll); }
    };
  }

  function makeSnAdapter(info) {
    // LFSRの幅/帰還はヘッダ0x28/0x2A(vgmHeader.jsがv1.10未満や0をSega既定へ補正済み)。
    // 0x2Bフラグ: bit0=周期0を0x400扱い, bit3=内部分周/8。
    const chip = new Emu.SN76489Audio({ feedback: info.feedback, shiftWidth: info.shiftWidth,
      freq0Is0x400: !!(info.flags & 1), clockDiv8: !!(info.flags & 8) });
    return {
      id: 'sn76489', clockHz: info.clock, accum: 0, chip, gain: CHIP_GAIN.sn76489,
      write(dd) { chip.write(dd); },
      writeStereo(dd) { chip.writeStereo(dd); },
      clock() { chip.clock(); },
      mix(out) { const s = chip.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain; },
      // 2個目のチップ(this.second)は鍵盤のSN4-6/SNN2行=配列index 4-7 を自分のch0-3として読む
      applyMute(m) { const e = m.expansion || m; if (e.sn76489) Emu.applyMute(chip.mute, this.second ? e.sn76489.slice(4) : e.sn76489); },
      applyVolume(v) { const e = v.expansion || v; if (e.sn76489) Emu.applyVolume(chip.vol, this.second ? e.sn76489.slice(4) : e.sn76489); }
    };
  }

  // YM2612コアの選択: 既定は Nuked-OPN2 移植版(実機準拠、重い)、Emu.ym2612CorePref = 'fast' で
  // 自作の近似コア(高速)。切替はアダプタ生成時(再生開始/シーク時)に効く。
  // 同じ設定を YM2610(expansion/ym2610.js、Nukedはラダー無しの ym3438 モード)も見る。
  function makeYm2612Adapter(info) {
    // 既定(Emu.ym2612CorePref未設定)は Nuked-OPN2。'fast' を明示した時だけ近似コア
    const useNuked = Emu.ym2612CorePref !== 'fast' && Emu.YM2612Nuked;
    const chip = useNuked ? new Emu.YM2612Nuked(info.clock) : new Emu.YM2612Audio(info.clock);
    return {
      id: 'ym2612', clockHz: info.clock, accum: 0, chip, gain: CHIP_GAIN.ym2612, core: useNuked ? 'nuked' : 'fast',
      // 0x52 aa dd(port0=ch1-3) / 0x53(port1=ch4-6)。DAC(0x2A)もここを通る
      write(port, aa, dd) { chip.writeReg(port, aa, dd); },
      clock() { chip.clock(); },
      mix(out) { const s = chip.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain; },
      // Nukedは書込みをキュー経由でclock()内に適用するので、clock()を回さない経路(先読み/シーク)は
      // これで適用させる(VgmPlayer._flushWrites)。高速コアはメソッド無し=何もしない
      flushWrites() { if (chip.flushWrites) chip.flushWrites(); },
      applyMute(m) { const e = m.expansion || m; if (e.ym2612) Emu.applyMute(chip.mute, e.ym2612); },
      applyVolume(v) { const e = v.expansion || v; if (e.ym2612) Emu.applyVolume(chip.vol, e.ym2612); }
    };
  }

  // YM2610(Neo Geo): FM(4ch)+ADPCM-A(6ch)+ADPCM-B(1ch)(expansion/ym2610.js)+SSG(3ch、Emu.AY8910Audio
  // を流用)を1アダプタでまとめて鳴らす(NESアダプタのapu+fdsと同じ構成)。SSGの実クロックは
  // ymfm(aaronsgiles/ymfm)裏取り: チップクロック/4。AY8910Audioは「実クロックの2倍で叩く」既存規約
  // (標準AY8910アダプタと同じ)のため、呼び出しはチップクロック/2(=fm.clock()を2回に1回ssg.clock())。
  // ADPCMのROMはデータブロック0x82(ADPCM-A)/0x83(ADPCM-B)を _dataBlock → loadRom で渡す。
  function makeYm2610Adapter(info) {
    const fm = new Emu.YM2610Audio(info.clock, { ym2610b: !!info.ym2610b });
    const ssg = new Emu.AY8910Audio();
    return {
      id: 'ym2610', clockHz: info.clock, accum: 0, fm, ssg, gain: CHIP_GAIN.ym2610, ssgGain: CHIP_GAIN.ym2610ssg, core: fm.coreName,
      _ssgToggle: 0,
      write(port, aa, dd) {
        if (port === 0 && aa < 0x0E) { ssg.writeInternal(aa & 0x0F, dd); return; }
        fm.writeReg(port, aa, dd);
      },
      loadRom(kind, romSize, start, data) { fm.loadRom(kind, romSize, start, data); },
      clock() { fm.clock(); if ((this._ssgToggle ^= 1) === 0) ssg.clock(); },
      flushWrites() { fm.flushWrites(); },
      mix(out) {
        const s = fm.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain;
        const sg = ssg.mixSample() * this.ssgGain; out[0] += sg; out[1] += sg;
      },
      // 鍵盤: FMはNF1-4(6)行(chip 'ym2610fm')、ADPCM-A/BはNA1-6/NB行(chip 'ym2610adpcm'、0-5=A, 6=B)、
      // SSGはKSS PSG表示のKP1-3行(chip 'psg')を流用
      applyMute(m) {
        const e = m.expansion || m;
        if (e.ym2610fm) { Emu.applyMute(fm.mute, e.ym2610fm); fm.syncMuteVol(); }
        if (e.ym2610adpcm) Emu.applyMute(fm.muteAdpcm, e.ym2610adpcm);
        if (e.psg) Emu.applyMute(ssg.mute, e.psg);
      },
      applyVolume(v) {
        const e = v.expansion || v;
        if (e.ym2610fm) { Emu.applyVolume(fm.vol, e.ym2610fm); fm.syncMuteVol(); }
        if (e.ym2610adpcm) Emu.applyVolume(fm.volAdpcm, e.ym2610adpcm);
        if (e.psg) Emu.applyVolume(ssg.vol, e.psg);
      },
      // 拡張ヘッダのチップ音量/全体音量(reset()が掛ける)はFM/SSG両方に効かせる
      scaleGain(f) { this.gain *= f; this.ssgGain *= f; }
    };
  }

  function makePwmAdapter(info) {
    const chip = new Emu.PWM32XAudio();
    return {
      id: 'pwm', clockHz: 0, accum: 0, chip, gain: CHIP_GAIN.pwm,
      // 0xB2 ad dd: reg=a(上位ニブル), 12bit値=((ad&0x0F)<<8)|dd
      write(reg, data) { chip.write(reg, data); },
      clock() {},
      mix(out) { const s = chip.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain; },
      applyMute(m) { const e = m.expansion || m; if (e.pwm) Emu.applyMute(chip.mute, e.pwm); },
      applyVolume(v) { const e = v.expansion || v; if (e.pwm) Emu.applyVolume(chip.vol, e.pwm); }
    };
  }

  // RF5C68(X68000/FM TOWNS)とRF5C164(メガCD)は同じコア(クロックとVGMコマンド番号だけ違う)
  function makeRfAdapter(id) {
    return function (info) {
      const chip = new Emu.RF5C164Audio(info.clock);
      return {
        id, clockHz: info.clock, accum: 0, chip, gain: CHIP_GAIN[id],
        write(reg, dd) { chip.write(reg, dd); },
        memWrite(off, dd) { chip.memWrite(off, dd); },
        ramWrite(start, data) { chip.ramWrite(start, data); },
        clock() { chip.clock(); },
        mix(out) { const s = chip.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain; },
        applyMute(m) { const e = m.expansion || m; if (e[id]) Emu.applyMute(chip.mute, e[id]); },
        applyVolume(v) { const e = v.expansion || v; if (e[id]) Emu.applyVolume(chip.vol, e[id]); }
      };
    };
  }

  const ADAPTERS = {
    nes: makeNesAdapter, gb: makeGbAdapter, huc6280: makeHucAdapter,
    ay8910: makeAyAdapter, k051649: makeSccAdapter, ym2413: makeOpllAdapter,
    sn76489: makeSnAdapter, ym2612: makeYm2612Adapter, pwm: makePwmAdapter,
    rf5c68: makeRfAdapter('rf5c68'), rf5c164: makeRfAdapter('rf5c164'), ym2610: makeYm2610Adapter
  };

  // ---------------------------------------------------------------------------
  // コマンド長(オペコードの後に続くバイト数)。可変長(0x67)と特別扱い(0x64等)は switch 側。
  // ---------------------------------------------------------------------------
  function operandLength(op) {
    if (op >= 0x30 && op <= 0x3F) return 1;
    if (op >= 0x40 && op <= 0x4E) return 2;
    if (op === 0x4F || op === 0x50) return 1;
    if (op >= 0x51 && op <= 0x5F) return 2;
    if (op === 0x61) return 2;
    if (op === 0x62 || op === 0x63 || op === 0x66) return 0;
    if (op === 0x64) return 3;
    if (op === 0x68) return 11;
    if (op >= 0x70 && op <= 0x8F) return 0;
    if (op === 0x90 || op === 0x91) return 4;
    if (op === 0x92) return 5;
    if (op === 0x93) return 10;
    if (op === 0x94) return 1;
    if (op === 0x95) return 4;
    if (op >= 0xA0 && op <= 0xBF) return 2;
    if (op >= 0xC0 && op <= 0xDF) return 3;
    if (op >= 0xE0 && op <= 0xFF) return 4;
    return -1; // 0x00-0x2F, 0x60, 0x65, 0x69-0x6F, 0x96-0x9F: 未定義
  }

  class VgmPlayer {
    /**
     * @param {Uint8Array} bytes - 解凍済みVGM(MML.Archive.gunzipIfNeeded済み)
     */
    constructor(bytes) {
      this.header = MML.VGM.parseHeader(bytes);
      if (!this.header.magicOk) throw new Error('not a VGM');
      this.data = bytes;
      this.frameRate = FRAME_RATE;
      this.speedFactor = 1;
      this.adapters = [];      // 実装済みチップのアダプタ(ヘッダ順)。reset()が作る
      this.adapterById = {};
      this.unimplemented = this.header.usedChips.filter(i => !ADAPTERS[i.id]).map(i => i.name); // 読み飛ばすチップ名(表示用)
      // 書込みフック: (chipId, a, b, c) — 引数の意味はチップ依存(capture側で解釈)
      this.onWrite = null;
      this.reset();
    }

    reset() {
      const h = this.header;
      // チップは作り直さず reset(): NES APUだけは reset() を持ち、他は再生成が簡単なので
      // アダプタごと作り直す(FDS/GB/HuC/AY/SCC/OPLLのreset()の有無に依存しないため)。
      this.adapters = [];
      this.adapterById = {};
      const extra = h.extra || { chipClocks: {}, chipVolumes: {} };
      const globalVol = h.volumeFactor || 1;
      for (const info of h.usedChips) {
        const mk = ADAPTERS[info.id];
        if (!mk) continue;
        // 拡張ヘッダのチップ別音量(0x100=100%)と全体音量(0x7C)をアダプタのgainへ掛ける
        // (VGMPlayと同じ扱い。Exed Exes(Arcade)はAY8910に16%を指定している)。
        const a = mk(info);
        // 複数gainを持つアダプタ(YM2610のFM/SSG)は scaleGain() で両方へ
        const scale1 = globalVol * (extra.chipVolumes[info.id] !== undefined ? extra.chipVolumes[info.id] : 1);
        if (a.scaleGain) a.scaleGain(scale1); else a.gain *= scale1;
        // メガドライブ/32X(SN76489+YM2612)の実機ミックスではPSGはFMよりかなり小さい。VGMPlayも
        // YM2612同居時はSN76496の音量を0x80(50%)に落としている。ユーザー実測でも「PSGが明らかに大きい、
        // 50%くらいで丁度よい」だったので同じ比率にする(SMS/GG等のPSG単独構成は従来どおり)。
        if (info.id === 'sn76489' && h.chips.ym2612) a.gain *= 0.5;
        this.adapters.push(a); this.adapterById[info.id] = a;
        if (info.dual) {
          // デュアルチップ(クロック値bit30): 2個目は同じ設定で別インスタンス。クロックは
          // 拡張ヘッダのchip clock表に2個目用の値があればそれを使う。書込みはコマンド側の
          // 「2個目」印(SN=0x30、その他はレジスタ/ポートのbit7)で振り分ける。
          const info2 = Object.assign({}, info, { clock: extra.chipClocks[info.id] || info.clock });
          const b = mk(info2);
          const scale2 = globalVol * (extra.chipVolumes[info.id + '_2'] !== undefined ? extra.chipVolumes[info.id + '_2'] : 1);
          if (b.scaleGain) b.scaleGain(scale2); else b.gain *= scale2;
          if (info.id === 'sn76489' && h.chips.ym2612) b.gain *= 0.5;
          b.second = true;
          this.adapters.push(b); this.adapterById[info.id + '_2'] = b;
        }
      }
      this.pos = h.dataOffset;
      this.samplePos = 0;      // VGMサンプル位置(44100Hz)
      this.waitRemaining = 0;  // 消化待ちのサンプル数
      this.ended = false;
      this.loopCount = 0;
      this._lastLoopSample = -1;
      this.vgmAccum = 0;
      this.dataBlocks = [];    // {type, size}(表示用)
      // データバンク(0x67 の非圧縮ストリーム 0x00-0x3F): type → { data: Uint8Array(連結), blocks: [{start,len}] }
      // YM2612 PCM(type 0x00)は 0x8n(DAC書込+待ち)と 0xE0(シーク)が使う
      this.dataBanks = {};
      this.pcmPos = 0;         // 0xE0 シーク位置(YM2612 PCMバンク内)
      // DACストリーム制御(0x90-0x95): id → {chipType, port, cmd, bankType, stepSize, stepBase, freq, acc, pos, end, loop, reverse, active}
      this.streams = {};
      this.overrideWait62 = 0; // 0x64 による 0x62/0x63 の待ち上書き
      this.overrideWait63 = 0;
      this.unknownOps = 0;
    }

    /** 曲全体をループを含めて何サンプル鳴らすか(ヘッダの総サンプル数)。 */
    get totalSamples() { return this.header.totalSamples; }

    // --- コマンド消化 --------------------------------------------------------
    // waitRemaining が 0 の間コマンドを実行し続け、待ち命令で止まる。
    _runCommands() {
      const d = this.data;
      const h = this.header;
      while (this.waitRemaining === 0 && !this.ended) {
        // eofOffset(0x04)が壊れている/データ開始より手前のファイルは無視してデータ長だけを見る
        const eof = (h.eofOffset && h.eofOffset > h.dataOffset) ? Math.min(h.eofOffset, d.length) : d.length;
        if (this.pos >= eof) { this._endOfData(); return; }
        const op = d[this.pos];
        const p = this.pos + 1;
        switch (op) {
          case 0x61: this.waitRemaining = d[p] | (d[p + 1] << 8); this.pos = p + 2; break;
          case 0x62: this.waitRemaining = this.overrideWait62 || 735; this.pos = p; break;
          case 0x63: this.waitRemaining = this.overrideWait63 || 882; this.pos = p; break;
          case 0x64: { // 0x64 cc nn nn: 0x62/0x63 の待ち時間を上書き
            const cc = d[p], nn = d[p + 1] | (d[p + 2] << 8);
            if (cc === 0x62) this.overrideWait62 = nn; else if (cc === 0x63) this.overrideWait63 = nn;
            this.pos = p + 3; break;
          }
          case 0x66: this._endOfData(); return;
          case 0x67: { // データブロック: 0x67 0x66 tt ss ss ss ss data...
            const type = d[p + 1];
            let size = (d[p + 2] | (d[p + 3] << 8) | (d[p + 4] << 16) | (d[p + 5] << 24)) >>> 0;
            size &= 0x7FFFFFFF; // bit31 = デュアルチップ2個目のフラグ
            const start = p + 6;
            const block = d.subarray(start, Math.min(d.length, start + size));
            this._dataBlock(type, block);
            this.pos = start + size; break;
          }
          case 0x50: this._writeSn(d[p], false); this.pos = p + 1; break;
          case 0x30: this._writeSn(d[p], true); this.pos = p + 1; break; // 2個目のSN76489
          case 0x4F: this._writeGgStereo(d[p]); this.pos = p + 1; break;
          case 0x51: this._chipWrite('ym2413', d[p], d[p + 1], false); this.pos = p + 2; break;
          case 0xA1: this._chipWrite('ym2413', d[p], d[p + 1], true); this.pos = p + 2; break; // 2個目のYM2413
          // 0xA0/0xB3/0xB4/0xB9/0xD2: レジスタ(ポート)のbit7=1が2個目のチップ
          case 0xA0: this._chipWrite('ay8910', d[p] & 0x7F, d[p + 1], !!(d[p] & 0x80)); this.pos = p + 2; break;
          case 0xB3: this._chipWrite('gb', d[p] & 0x7F, d[p + 1], !!(d[p] & 0x80)); this.pos = p + 2; break;
          case 0xB4: this._chipWrite('nes', d[p] & 0x7F, d[p + 1], !!(d[p] & 0x80)); this.pos = p + 2; break;
          case 0xB9: this._chipWrite('huc6280', d[p] & 0x7F, d[p + 1], !!(d[p] & 0x80)); this.pos = p + 2; break;
          case 0xB2: this._chipWrite('pwm', (d[p] >> 4) & 0x0F, ((d[p] & 0x0F) << 8) | d[p + 1], false); this.pos = p + 2; break; // 32X PWM: reg=a, 12bit値
          case 0xB0: this._chipWrite('rf5c68', d[p] & 0x7F, d[p + 1], !!(d[p] & 0x80)); this.pos = p + 2; break;
          case 0xB1: this._chipWrite('rf5c164', d[p] & 0x7F, d[p + 1], !!(d[p] & 0x80)); this.pos = p + 2; break;
          case 0xC1: this._rfMemWrite('rf5c68', d[p] | (d[p + 1] << 8), d[p + 2]); this.pos = p + 3; break;  // RF5C68 メモリ書込み(選択中バンク窓)
          case 0xC2: this._rfMemWrite('rf5c164', d[p] | (d[p + 1] << 8), d[p + 2]); this.pos = p + 3; break; // RF5C164 メモリ書込み
          case 0xD2: this._sccWrite(d[p] & 0x7F, d[p + 1], d[p + 2], !!(d[p] & 0x80)); this.pos = p + 3; break;
          case 0x52: this._ymWrite(0, d[p], d[p + 1], false); this.pos = p + 2; break;
          case 0x53: this._ymWrite(1, d[p], d[p + 1], false); this.pos = p + 2; break;
          case 0xA2: this._ymWrite(0, d[p], d[p + 1], true); this.pos = p + 2; break; // 2個目のYM2612
          case 0xA3: this._ymWrite(1, d[p], d[p + 1], true); this.pos = p + 2; break;
          case 0x58: this._ym2610Write(0, d[p], d[p + 1]); this.pos = p + 2; break; // YM2610(Neo Geo) ポート0
          case 0x59: this._ym2610Write(1, d[p], d[p + 1]); this.pos = p + 2; break; // YM2610 ポート1
          case 0xE0: this.pcmPos = (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0; this.pos = p + 4; break;
          case 0x90: { // ストリーム設定: ss tt pp cc
            const s = this._stream(d[p]); s.chipType = d[p + 1] & 0x7F; s.second = !!(d[p + 1] & 0x80); s.port = d[p + 2]; s.cmd = d[p + 3];
            this.pos = p + 4; break;
          }
          case 0x91: { // データバンク: ss dd ll bb
            const s = this._stream(d[p]); s.bankType = d[p + 1]; s.stepSize = Math.max(1, d[p + 2]); s.stepBase = d[p + 3];
            this.pos = p + 4; break;
          }
          case 0x92: { // 周波数: ss ff ff ff ff
            const s = this._stream(d[p]); s.freq = (d[p + 1] | (d[p + 2] << 8) | (d[p + 3] << 16) | (d[p + 4] << 24)) >>> 0;
            this.pos = p + 5; break;
          }
          case 0x93: { // 開始: ss aa aa aa aa mm ll ll ll ll
            const s = this._stream(d[p]);
            const start = (d[p + 1] | (d[p + 2] << 8) | (d[p + 3] << 16) | (d[p + 4] << 24)) >>> 0;
            const mode = d[p + 5];
            const len = (d[p + 6] | (d[p + 7] << 8) | (d[p + 8] << 16) | (d[p + 9] << 24)) >>> 0;
            this._streamStart(s, start === 0xFFFFFFFF ? -1 : start, mode, len);
            this.pos = p + 10; break;
          }
          case 0x94: { const s = this.streams[d[p]]; if (s) s.active = false; this.pos = p + 1; break; } // 停止
          case 0x95: { // 高速開始: ss bb bb ff (ブロック番号、bit0=ループ, bit4=逆再生)
            const s = this._stream(d[p]); const blockId = d[p + 1] | (d[p + 2] << 8); const flags = d[p + 3];
            const bank = this.dataBanks[s.bankType];
            if (bank && bank.blocks[blockId]) {
              const b = bank.blocks[blockId];
              this._streamStart(s, b.start, 0x01 | (flags & 1 ? 0x80 : 0) | (flags & 0x10 ? 0x10 : 0), b.len);
            }
            this.pos = p + 4; break;
          }
          default: {
            if (op >= 0x70 && op <= 0x7F) { this.waitRemaining = (op & 0x0F) + 1; this.pos = p; break; }
            if (op >= 0x80 && op <= 0x8F) { // YM2612 DAC: PCMバンクから1バイトを A へ書き、nサンプル待つ
              const bank = this.dataBanks[0x00];
              if (bank && this.pcmPos < bank.data.length) this._ymWrite(0, 0x2A, bank.data[this.pcmPos], false);
              this.pcmPos++;
              this.waitRemaining = op & 0x0F; this.pos = p; break;
            }
            const len = operandLength(op);
            if (len < 0) { this.unknownOps++; this._endOfData(); return; } // 未定義: 同期不能なので終了
            this.pos = p + len; // 未実装チップ/未対応コマンドは読み飛ばす
            break;
          }
        }
      }
    }

    _endOfData() {
      const h = this.header;
      if (h.loopOffset && h.loopOffset > h.dataOffset && h.loopOffset < this.data.length) {
        // 待ちを1つも含まないループ(空ループ)は無限ループになるので、前回ループ時から
        // サンプル位置が進んでいなければ終了扱いにする
        if (this._lastLoopSample === this.samplePos) { this.ended = true; return; }
        this._lastLoopSample = this.samplePos;
        this.loopCount++;
        this.pos = h.loopOffset;
        return;
      }
      this.ended = true;
    }

    _dataBlock(type, block) {
      this.dataBlocks.push({ type, size: block.length });
      if (type < 0x40) { // 非圧縮ストリーム(0x00=YM2612 PCM 等): typeごとに連結してバンクにする
        const bank = this.dataBanks[type] || (this.dataBanks[type] = { data: new Uint8Array(0), blocks: [] });
        const merged = new Uint8Array(bank.data.length + block.length);
        merged.set(bank.data, 0); merged.set(block, bank.data.length);
        bank.blocks.push({ start: bank.data.length, len: block.length });
        bank.data = merged;
        return;
      }
      if (type === 0xC2) { // NES APU RAM書込み: 先頭2バイト=開始アドレス
        const nes = this.adapterById.nes;
        if (nes && block.length >= 2) nes.ramWrite(block[0] | (block[1] << 8), block.subarray(2));
      }
      if (type === 0xC0 || type === 0xC1) { // RF5C68(0xC0)/RF5C164(0xC1) 波形RAM書込み: 先頭2バイト=絶対アドレス
        const rf = this.adapterById[type === 0xC0 ? 'rf5c68' : 'rf5c164'];
        if (rf && block.length >= 2) rf.ramWrite(block[0] | (block[1] << 8), block.subarray(2));
      }
      if (type === 0x82 || type === 0x83) { // YM2610 ADPCM-A(0x82) / ADPCM-B(0x83) ROM: ROMサイズ(4)+開始アドレス(4)+データ
        const y = this.adapterById.ym2610;
        if (y && block.length >= 8) {
          const romSize = (block[0] | (block[1] << 8) | (block[2] << 16) | (block[3] << 24)) >>> 0;
          const start = (block[4] | (block[5] << 8) | (block[6] << 16) | (block[7] << 24)) >>> 0;
          y.loadRom(type === 0x83 ? 'b' : 'a', romSize, start, block.subarray(8));
        }
      }
      // その他(YM2612 PCM=0x00, 圧縮ブロック, 各種ROMダンプ)は未実装チップ向けなので保持しない
    }

    // second=true なら2個目のチップ(adapterById[id+'_2'])。onWriteのidも '_2' 付きで通知する
    // (キャプチャ側は1個目のみ抽出対象。2個目は再生と鍵盤表示のみ)。
    _chipWrite(id, aa, dd, second) {
      const key = second ? id + '_2' : id;
      const a = this.adapterById[key];
      if (!a) return;
      const r = a.write(aa, dd);
      if (this.onWrite) this.onWrite(key, aa, dd, r);
    }

    _sccWrite(pp, aa, dd, second) {
      const key = second ? 'k051649_2' : 'k051649';
      const a = this.adapterById[key];
      if (!a) return;
      const addr = a.write(pp, aa, dd);
      if (this.onWrite && addr >= 0) this.onWrite(key, pp, aa, dd, addr);
    }

    _ymWrite(port, aa, dd, second) {
      const key = second ? 'ym2612_2' : 'ym2612';
      const a = this.adapterById[key];
      if (!a) return;
      a.write(port, aa, dd);
      if (this.onWrite) this.onWrite(key, port, aa, dd);
    }

    _ym2610Write(port, aa, dd) {
      const a = this.adapterById.ym2610;
      if (!a) return;
      a.write(port, aa, dd);
      if (this.onWrite) this.onWrite('ym2610', port, aa, dd);
    }

    _stream(id) {
      return this.streams[id] || (this.streams[id] = { chipType: 0, second: false, port: 0, cmd: 0, bankType: 0, stepSize: 1, stepBase: 0, freq: 0, acc: 0, pos: 0, end: 0, loop: false, reverse: false, active: false });
    }
    // mode: bit7=ループ, bit4=逆再生, 下位2bit: 0=長さ無視(終端まで) 1=コマンド数 2=ミリ秒 3=終端まで
    _streamStart(s, start, mode, len) {
      const bank = this.dataBanks[s.bankType];
      if (!bank) { s.active = false; return; }
      if (start >= 0) s.pos = start;
      s.loop = !!(mode & 0x80); s.reverse = !!(mode & 0x10);
      s.start = s.pos;
      const lm = mode & 3;
      if (lm === 1) s.end = Math.min(bank.data.length, s.pos + len * s.stepSize);
      else if (lm === 2) s.end = Math.min(bank.data.length, s.pos + Math.round(s.freq * len / 1000) * s.stepSize);
      else s.end = bank.data.length;
      s.acc = 0; s.active = s.freq > 0 && s.pos < s.end;
    }
    // 1VGMサンプルぶんストリームを進める(0x90-0x95。現状の書込み先はYM2612(chipType 2)のみ実装)
    _stepStreams() {
      for (const id in this.streams) {
        const s = this.streams[id];
        if (!s.active) continue;
        s.acc += s.freq / 44100;
        if (s.acc < 1) continue;
        const bank = this.dataBanks[s.bankType];
        while (s.acc >= 1 && s.active) {
          s.acc -= 1;
          if (!bank || s.pos >= s.end || s.pos < 0) {
            if (s.loop && bank) { s.pos = s.start; } else { s.active = false; break; }
          }
          const v = bank.data[s.pos + s.stepBase];
          if (s.chipType === 0x02) this._ymWrite(s.port & 1, s.cmd, v, s.second);
          else if (s.chipType === 0x11) { // 32X PWM: ステップ2バイト(LE)の12bit値をレジスタ(port)へ
            const v16 = s.stepSize >= 2 ? (bank.data[s.pos + s.stepBase] | (bank.data[s.pos + s.stepBase + 1] << 8)) : v;
            this._chipWrite('pwm', s.port & 0x0F, v16 & 0xFFF, false);
          }
          // 他チップのストリーム(未実装チップ向け)は無視
          s.pos += s.stepSize;
        }
      }
    }

    _rfMemWrite(id, offset, dd) {
      const a = this.adapterById[id];
      if (a) a.memWrite(offset, dd);
    }

    _writeSn(dd, second) {
      const key = second ? 'sn76489_2' : 'sn76489';
      const a = this.adapterById[key];
      if (a) { a.write(dd); if (this.onWrite) this.onWrite(key, dd); }
    }
    _writeGgStereo(dd) {
      const a = this.adapterById.sn76489;
      if (a && a.writeStereo) a.writeStereo(dd);
    }

    /** VGMサンプルを1つ進める(待ちを1つ消化する)。 */
    _stepVgmSample() {
      if (this.waitRemaining === 0) this._runCommands();
      if (this.waitRemaining > 0) this.waitRemaining--;
      this._stepStreams();
      this.samplePos++;
    }

    /**
     * 曲頭から targetSample まで、チップのclock()を回さずコマンドだけを消化する
     * (シーク用。レジスタ状態は正しく復元されるが、エンベロープ等の時間経過状態は
     * 進んでいない。KSSのwriteLog再生シークと同じ割り切り)。
     */
    fastForward(targetSample) {
      while (this.samplePos < targetSample && !this.ended) {
        if (this.waitRemaining === 0) this._runCommands();
        const step = Math.min(this.waitRemaining, targetSample - this.samplePos);
        if (step <= 0) { if (this.ended) break; continue; }
        this.waitRemaining -= step;
        this.samplePos += step;
        // ストリームはサンプル単位でしか進められないが、シーク用途では最終位置だけ合えばよい
        for (let i = 0; i < step; i++) this._stepStreams();
      }
      this._flushWrites();
    }

    // clock()を回さずにコマンドだけ消化した後(fastForward / renderFrame regsOnly)、書込みを
    // キュー経由で適用するチップ(Nuked-OPN2版YM2612/YM2610)にキューを消化させる。
    // これが無いと、Nukedコアではキャプチャの鍵盤スナップショット/ロールが空になり、シーク後は
    // 曲頭からの全書込みがキューに溜まったまま再生が始まって暫く音が崩れる。
    _flushWrites() {
      for (const a of this.adapters) if (a.flushWrites) a.flushWrites();
    }

    /**
     * 1フレーム(VGM時間で1/60秒)分の音声サンプルを生成する。
     * @param {number} sampleRate - 出力サンプルレート
     * @param {boolean} [regsOnly] - trueなら音声合成もチップのclock()も省略(コマンド消化のみ)
     * @param {boolean} [stereo] - trueなら{left,right}を返す
     * @returns {Float32Array|{left:Float32Array,right:Float32Array}|null}
     */
    renderFrame(sampleRate, regsOnly, stereo) {
      const samplesThisFrame = Math.round(sampleRate / FRAME_RATE);
      if (regsOnly) {
        // 速度は無関係(キャプチャはVGM時間で進める)
        for (let i = 0; i < SAMPLES_PER_FRAME; i++) this._stepVgmSample();
        this._flushWrites(); // Nukedコアの書込みキュー適用(スナップショットを正しく読むため)
        return null;
      }
      const outL = new Float32Array(samplesThisFrame);
      const outR = stereo ? new Float32Array(samplesThisFrame) : null;
      const vgmPerOut = (VGM_RATE / sampleRate) * this.speedFactor;
      const acc = [0, 0];
      const adapters = this.adapters;
      for (let i = 0; i < samplesThisFrame; i++) {
        this.vgmAccum += vgmPerOut;
        while (this.vgmAccum >= 1) { this.vgmAccum -= 1; this._stepVgmSample(); }
        acc[0] = 0; acc[1] = 0;
        for (let k = 0; k < adapters.length; k++) {
          const a = adapters[k];
          if (a.clockHz > 0) {
            a.accum += a.clockHz / sampleRate;
            while (a.accum >= 1) { a.accum -= 1; a.clock(); }
          }
          a.mix(acc);
        }
        if (stereo) { outL[i] = acc[0]; outR[i] = acc[1]; }
        else outL[i] = (acc[0] + acc[1]) * 0.5;
      }
      return stereo ? { left: outL, right: outR } : outL;
    }

    applyMute(mute) { if (mute) for (const a of this.adapters) a.applyMute(mute); }
    applyVolume(vol) { if (vol) for (const a of this.adapters) a.applyVolume(vol); }
  }

  // ---------------------------------------------------------------------------
  // 先読みキャプチャ(ピアノロール/MML変換用)。チップのclock()は回さず(regsOnly)、
  // フレーム(1/60秒)ごとに各チップファミリの既存抽出器が読める形でデータを積む:
  //   nes: regSnapshots[f] = {addr:val}(累積), writeLog[f] = [{addr,value}]
  //   gb : snapshots[f] = gbsPlayer.js snapshotApu 形式
  //   hes: snapshots[f] = hesPlayer.js snapshotApu 形式
  //   kss: writeLog[f] = [{addr,value,io}] (AY=io 0xA0/0xA1, OPLL=io 0x7C/0x7D, SCC=mem 0x9800/0xB800台)
  // ---------------------------------------------------------------------------
  Emu.captureVgmSongAsync = async function (vgmBytes, opt, onProgress) {
    const player = new VgmPlayer(vgmBytes);
    const h = player.header;
    const durationSeconds = opt.durationSeconds || Math.max(1, h.durationSeconds || 30);
    const totalFrames = Math.max(1, Math.ceil(durationSeconds * FRAME_RATE));
    const has = (id) => !!player.adapterById[id];
    const data = {
      frameRate: FRAME_RATE, header: h, totalFrames,
      nes: has('nes') ? { regSnapshots: [], writeLog: [], fds: !!player.adapterById.nes.fds } : null,
      gb: has('gb') ? { snapshots: [] } : null,
      hes: has('huc6280') ? { snapshots: [] } : null,
      // YM2610の内蔵SSG(AY互換)は kss.writeLog へ AY8910書込みとして流し込む(KP1-3行/kss2mml流用)。
      // clock: kss2mml抽出器(AY/SCC)に渡す「Z80相当クロック」(=AY実クロック×2)。MSXの3.58MHz固定では
      // 別クロックのAY(Exed Exes 1.5MHz等)やYM2610内蔵SSG(チップクロック/4)のロール音程がずれる。
      // vgm2mml/converter.js の kssClock と同じ優先順位。
      kss: (has('ay8910') || has('k051649') || has('ym2413') || has('ym2610'))
        ? { writeLog: [], ay: has('ay8910') || has('ym2610'), scc: has('k051649'), opll: has('ym2413'), sccPlus: !!(player.adapterById.k051649 && player.adapterById.k051649.plus),
            clock: has('ay8910') ? player.adapterById.ay8910.clockHz : has('ym2610') ? player.adapterById.ym2610.clockHz / 2
                 : has('k051649') ? player.adapterById.k051649.clockHz : has('ym2413') ? player.adapterById.ym2413.clockHz : 3579545 }
        : null,
      sn: has('sn76489') ? { snapshots: [], clock: player.adapterById.sn76489.clockHz } : null,
      ym2612: has('ym2612') ? { snapshots: [] } : null,
      ym2610fm: has('ym2610') ? { snapshots: [] } : null,
      pwm: has('pwm') ? { snapshots: [] } : null,
      rf5c164: has('rf5c164') ? { snapshots: [] } : null,
      rf5c68: has('rf5c68') ? { snapshots: [] } : null
    };
    let nesFrameWrites = [];
    // YM2610 ADPCM のロール用発音区間推定の状態(上のループ内コメント参照)
    const adpcmState = { aSeq: new Array(6).fill(0), aEnd: new Array(6).fill(-1), bSeq: 0, bEnd: -1 };
    let kssFrameWrites = [];
    const nesRegs = {};
    if (data.kss && data.kss.scc && data.kss.sccPlus) {
      // kss2mml/expansion/scc.js のデコーダにSCC+配置(0xB800台)を認識させる前置き書込み
      kssFrameWrites.push({ addr: 0xBFFE, value: 0x20, io: false }, { addr: 0xB000, value: 0x80, io: false });
    }
    player.onWrite = (id, a, b, c, d) => {
      switch (id) {
        case 'nes': nesFrameWrites.push({ addr: c, value: b }); nesRegs[c] = b; break;
        case 'ay8910': kssFrameWrites.push({ addr: 0xA0, value: a & 0x0F, io: true }, { addr: 0xA1, value: b, io: true }); break;
        // YM2610: (port, addr, data)。port0 addr<0x0E が内蔵SSG(AY互換レジスタ0-13)
        case 'ym2610': if (a === 0 && b < 0x0E) kssFrameWrites.push({ addr: 0xA0, value: b & 0x0F, io: true }, { addr: 0xA1, value: c, io: true }); break;
        case 'ym2413': kssFrameWrites.push({ addr: 0x7C, value: a, io: true }, { addr: 0x7D, value: b, io: true }); break;
        case 'k051649': kssFrameWrites.push({ addr: d, value: c, io: false }); break;
      }
    };
    const CHUNK_FRAMES = 30;
    for (let f = 0; f < totalFrames; f++) {
      player.renderFrame(VGM_RATE, true);
      if (data.nes) {
        data.nes.writeLog.push(nesFrameWrites);
        // $4015 はVGMでも0xB4 0x15で書かれるが、書かれない曲もあるので鍵盤表示用に
        // 「全ch有効」を既定にしておく(NSFのliveSnap[0x4015]=0x0F補完と同じ)。
        if (nesRegs[0x4015] === undefined) nesRegs[0x4015] = 0x0F;
        data.nes.regSnapshots.push(Object.assign({}, nesRegs));
        nesFrameWrites = [];
      }
      if (data.gb) data.gb.snapshots.push(Emu.snapshotGbApuForCapture(player.adapterById.gb.apu));
      if (data.hes) data.hes.snapshots.push(Emu.snapshotHesApuForCapture(player.adapterById.huc6280.apu));
      if (data.kss) { data.kss.writeLog.push(kssFrameWrites); kssFrameWrites = []; }
      if (data.sn) {
        const s1 = Emu.snapshotSN76489(player.adapterById.sn76489.chip, data.sn.clock);
        const a2 = player.adapterById.sn76489_2;
        data.sn.snapshots.push(a2 ? s1.concat(Emu.snapshotSN76489(a2.chip, a2.clockHz)) : s1);
      }
      if (data.pwm) data.pwm.snapshots.push(Emu.snapshotPWM32X(player.adapterById.pwm.chip));
      if (data.rf5c164) data.rf5c164.snapshots.push(Emu.snapshotRF5C164(player.adapterById.rf5c164.chip));
      if (data.rf5c68) data.rf5c68.snapshots.push(Emu.snapshotRF5C164(player.adapterById.rf5c68.chip));
      if (data.ym2612) {
        // 先読みはチップのclock()を回さない(EGが進まない)ので、ロール用の発音判定/音量は
        // レジスタだけから決まる keyOn/tlVol に差し替える(ライブ表示はEG由来のactive/volを使う)
        const s = Emu.snapshotYM2612(player.adapterById.ym2612.chip);
        for (const c of s.channels) { c.active = c.keyOn && c.freq > 0; c.vol = c.tlVol; c.rawVol = Math.round(c.tlVol * 15); }
        data.ym2612.snapshots.push(s);
      }
      if (data.ym2610fm) {
        const s = Emu.snapshotYM2610(player.adapterById.ym2610.fm);
        for (const c of s.channels) { c.active = c.keyOn && c.freq > 0; c.vol = c.tlVol; c.rawVol = Math.round(c.tlVol * 15); }
        // ADPCM-A/B: clock()を回さないので playing は終端で落ちない。キーオン通番(seq)の変化を発音開始、
        // そこからサンプル長(lenSec)ぶんを発音区間として推定する(ADPCM-Bはリピート中=Infinity、
        // 実行ビットが落ちたら終了)
        const st = adpcmState;
        for (let i = 0; i < 6; i++) {
          const c = s.adpcmA[i];
          if (c.seq !== st.aSeq[i]) { st.aSeq[i] = c.seq; st.aEnd[i] = f + c.lenSec * FRAME_RATE; }
          c.active = c.vol > 0 && f < st.aEnd[i];
        }
        {
          const c = s.adpcmB;
          if (c.seq !== st.bSeq) { st.bSeq = c.seq; st.bEnd = f + c.lenSec * FRAME_RATE; }
          if (!c.executing) st.bEnd = -1;
          c.active = c.vol > 0 && f < st.bEnd;
        }
        data.ym2610fm.snapshots.push(s);
      }
      if (f % CHUNK_FRAMES === 0) {
        if (onProgress) onProgress(f, totalFrames, data);
        await new Promise(r => setTimeout(r, 0));
        if (opt.shouldCancel && opt.shouldCancel()) return data;
      }
    }
    if (onProgress) onProgress(totalFrames, totalFrames, data);
    // NES APUのDPCMサンプル本体はVGMのデータブロック(0x67 type=0xC2 "NES APU RAM write")で
    // エミュレータのメモリ空間へ流し込まれる(NSFのようにファイルの中にROMイメージがある
    // わけではない)。DMCは$C000-$FFFFしか読まないので、その16KBだけを最終状態で切り出して
    // 渡す(vgm2mml/converter.js → nsf2mml/converter.jsのoptions.dpcmRom。ブロックの
    // 読み込みは通常曲の先頭付近で1回きりなので最終スナップショットで足りる)
    if (data.nes && player.adapterById.nes.ramLoaded) {
      data.nes.dpcmRom = player.adapterById.nes.ram.slice(0xC000, 0x10000);
    }
    return data;
  };

  Emu.VgmPlayer = VgmPlayer;
  Emu.VGM_FRAME_RATE = FRAME_RATE;
  Emu.VGM_CHIP_GAIN = CHIP_GAIN;
})(window);
