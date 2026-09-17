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
 *   YM2612(OPN2、MD FM)=expansion/ym2612Nuked.js(Nuked-OPN2移植。データブロック0x00のPCM、
 *   0xE0シーク、0x8n DAC書込+待ち、DACストリーム制御0x90-0x95もここで扱う)、
 *   YM2610(OPNB、Neo Geo)=expansion/ym2610.js(FM=レジスタ配置がYM2612と同一なのでYM2612コアの
 *   ラッパー、ADPCM-A/B=ymfm移植。ROMはデータブロック0x82/0x83)+AY8910Audio(SSG流用)、
 *   YM2151(OPM、アーケード/X68000)=expansion/ym2151.js(コマンド0x54、デュアル2個目=0xA4)、
 *   YM2203(OPN、PC-88/PC-98/アーケード)=expansion/ym2203.js(FM=YM2612コアのラッパー3ch+
 *   内蔵SSG=AY8910Audio。コマンド0x55、デュアル2個目=0xA5。プリスケーラ0x2D-0x2Fはチップ側)、
 *   YM2608(OPNA、PC-88 SB2/PC-98)=expansion/ym2608.js(FM 6ch=YM2612コアのラッパー+SSG+
 *   内蔵リズム+ADPCM-B。コマンド0x56/0x57、デュアル2個目=0xA6/0xA7。DELTA-Tはデータブロック0x81、
 *   リズムROMはEmu.setYm2608RhythmRom=opt.ym2608RhythmRom経由)、
 *   GA20(Irem M92/M107 PCM)=expansion/ga20.js(コマンド0xBF、ROMはデータブロック0x93)、
 *   SegaPCM(OutRun/After Burner等)=expansion/segapcm.js(コマンド0xC0、ROMはデータブロック0x80)、
 *   C352(ナムコ System 11/12/22等)=expansion/c352.js(コマンド0xE1、ROMはデータブロック0x92)、
 *   OKIM6258(X68000 ADPCM)=expansion/okim6258.js(コマンド0xB7、データはDACストリーム0x17経由)、
 *   QSound(カプコンCPS1ダッシュ/CPS2)=expansion/qsound.js(コマンド0xC4、ROMはデータブロック0x8F)、
 *   OKIM6295(東亜プラン/ライジング等)=expansion/okim6295.js(コマンド0xB8、ROMはデータブロック0x8B)、
 *   MultiPCM(セガModel 1/2/Multi 32)=expansion/multipcm.js(コマンド0xB5、バンク0xC3、ROMは0x89)、
 *   K007232(コナミ・アーケードPCM)=expansion/k007232.js(コマンド0x41、ROMはデータブロック0x94)、
 *   MSM5205/6585(PC Engine CD ADPCM等)=expansion/msm5205.js(コマンド0x32、ROM無し)
 * ヘッダのクロックが非ゼロでも未実装のチップは、コマンド長規則で読み飛ばすだけ
 * (ROADMAP.md VGM節: 全チップ実装は不要)。ただし **vgmHeader.js の VGM.CHIPS には必ず載せる**
 * — 表に無いチップは usedChips に入らず「未対応・読み飛ばし」の表示すら出ず、
 * 「音が欠けているのに理由が分からない」状態になる(K007232 で実際に起きた)。
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
 *  - YM2151: ヘッダ値(3579545/4000000)そのまま(内部/64で1サンプル=55930/62500Hz)。
 *  - YM2203: ヘッダ値そのままで chip.clock()(チップ内部でプリスケーラに応じてFMコアを2/4/6回、
 *    SSGを1/2/4回進める。既定1/6でFMサンプル=clock/72、SSG実クロック=clock/2)。
 *  - YM2608: ヘッダ値そのままで chip.clock()(同上。既定1/6でFMサンプル=clock/144、
 *    SSG実クロック=clock/4。PC-88 SB2: 7987200Hz → FM 55.5kHz / SSG 1.9968MHz)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const VGM_RATE = 44100;
  const FRAME_RATE = 60;
  const DAC_HITS_MAX = 200000; // ストリーミングDAC打点の記録上限(_dacHitStart)
  // 先読みキャプチャのスナップショットは表示専用の合成波形を作らない(2026-09-04)。
  // ロール構築と変換が読むのは freq/vol/active/patch だけで、毎フレーム128点の配列を
  // 全chぶん抱えると保持量が跳ね上がる(実測でスナップショット1フレームの14%)。
  const SNAP_CAPTURE = { skipWave: true };
  // シーク用チェックポイントの間隔と上限(VGMサンプル=44100Hz基準)。
  // 5秒間隔なら1回あたり約3KB×(曲長/5秒)で、5分の曲でも200KB程度
  const CHECKPOINT_INTERVAL = 5 * 44100;
  const CHECKPOINT_MAX = 512; // 42分ぶん。異常に長いログでも青天井にしない
  const SAMPLES_PER_FRAME = VGM_RATE / FRAME_RATE; // 735

  // 各フォーマットのストリームプレイヤーが使っている実測校正済みgain
  // (src/audio/*-stream-player.js 参照)。VGMは複数チップの合算なので、チップごとに
  // 由来フォーマットのgainを掛けてから足し、出力段のgainは1.0にする。
  // ym2610(FM+ADPCM、チップ内ミックス比はymfm準拠)/ym2610ssg: Neo Geoの曲はYM2612(MD)よりTLを詰めて
  // 鳴らすものが多く、YM2612と同じ2.0だとFMだけでMD FMの2〜4倍になる。FM+ADPCM込みの全体RMSが
  // 他形式(MD全体0.13、SPC基準)に近づくよう1.0(実測: Metal Slug 0.17〜0.21、Last Resort 0.10〜0.12、
  // Neo Turf Masters 0.29〜0.42=元々ホットな曲、ピークはリミッタ任せ)。SSGはFMに対して MAME neogeo
  // ドライバのルーティング比(SSG 0.28 : FM 0.98)を目安に0.8(暫定。実機録音との比較は未実施)。
  // ym2203/ym2203ssg: FMはYM2612系コア(TLに余裕を持たせた書き方の曲が多い)なので2.0、
  // SSGはYM2610で採ったFM:SSG=1.0:0.8の比をFM2.0へスケールして1.6(暫定。実機照合は未実施)。
  // opl(YM3812/YM3526/Y8950共通): 出力尺度はYM2151と同じ(±8192合算/(8192*6))だが、OPL曲は
  // 2opで音量を稼ぐ書き方が多く2.0では過熱(実測: Bubble Bobble RMS-10dB/ピーク1.56クリップ)。
  // 1.4でRMS-13〜-15dB級(MD/SPC基準近傍。Bubble Bobble/Xevious Fardraut/Haunted Castle実測)。
  // c352: 1.0→0.5(2026-09-14)。VGMPlay 0.52 のリファレンスWAVと比べると、波形の一致は1秒窓の相関0.96〜0.97で
  // 正しいのに音量が全区間でちょうど2倍だった(Rave Racer 3曲)。1.0ではナムコSystem 22/NB系の全曲がリミッタ前で
  // ピーク1.0超(1.0〜2.1)・RMS -9.5〜-17dBFS と他のナムコ作品(C140のワルキューレ -18〜-20dBFS)より6〜8dB大きく、
  // 大きい所をリミッタが押しつぶしていた。0.5でVGMPlayと同じ比率になり、ピークは0.49〜1.06に収まる
  const CHIP_GAIN = { nes: 1.56, gb: 1.35, huc6280: 1.65, ay8910: 1.99, k051649: 1.99, ym2413: 1.99, sn76489: 2.0, ym2612: 2.0, pwm: 0.9, rf5c164: 1.6, rf5c68: 1.6, ym2610: 1.0, ym2610ssg: 0.8, ym2151: 2.0, ym2203: 2.0, ym2203ssg: 1.6, ym2608: 2.0, ym2608ssg: 1.6, opl: 1.4, ga20: 3.0, segapcm: 2.0, c140: 1.0, c352: 0.5, okim6258: 0.6, qsound: 5.0, okim6295: 1.0, multipcm: 1.0, k007232: 1.6, msm5205: 1.45, k054539: 2.4 };

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

  // YM2612コアは Nuked-OPN2 移植版(実機準拠)のみ。YM2610(expansion/ym2610.js)のFM段も
  // 同じコアをラダー無しの ym3438 モードで使う。
  function makeYm2612Adapter(info) {
    const chip = new Emu.YM2612Nuked(info.clock);
    return {
      id: 'ym2612', clockHz: info.clock, accum: 0, chip, gain: CHIP_GAIN.ym2612,
      // 0x52 aa dd(port0=ch1-3) / 0x53(port1=ch4-6)。DAC(0x2A)もここを通る
      write(port, aa, dd) { chip.writeReg(port, aa, dd); },
      clock() { chip.clock(); },
      mix(out) { const s = chip.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain; },
      // 書込みはキュー経由でclock()内に適用されるので、clock()を回さない経路(先読み/シーク)は
      // これで適用させる(VgmPlayer._flushWrites)
      flushWrites(collapse) { if (chip.flushWrites) chip.flushWrites(collapse); },
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
      id: 'ym2610', clockHz: info.clock, accum: 0, fm, ssg, gain: CHIP_GAIN.ym2610, ssgGain: CHIP_GAIN.ym2610ssg,
      _ssgToggle: 0,
      write(port, aa, dd) {
        if (port === 0 && aa < 0x0E) { ssg.writeInternal(aa & 0x0F, dd); return; }
        fm.writeReg(port, aa, dd);
      },
      loadRom(kind, romSize, start, data) { fm.loadRom(kind, romSize, start, data); },
      clock() { fm.clock(); if ((this._ssgToggle ^= 1) === 0) ssg.clock(); },
      flushWrites(collapse) { fm.flushWrites(collapse); },
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

  // YM2151(OPM): FM 8ch単チップ(expansion/ym2151.js)。VGMコマンドは 0x54 aa dd
  // (レジスタ空間256バイトの1ポート)、デュアルチップ2個目は 0xA4。
  function makeYm2151Adapter(info) {
    const chip = new Emu.YM2151Audio(info.clock);
    return {
      id: 'ym2151', clockHz: info.clock, accum: 0, chip, gain: CHIP_GAIN.ym2151,
      write(aa, dd) { chip.writeReg(aa, dd); },
      clock() { chip.clock(); },
      mix(out) { const s = chip.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain; },
      applyMute(m) { const e = m.expansion || m; if (e.ym2151) Emu.applyMute(chip.mute, e.ym2151); },
      applyVolume(v) { const e = v.expansion || v; if (e.ym2151) Emu.applyVolume(chip.vol, e.ym2151); }
    };
  }

  // YM2203(OPN): FM 3ch+内蔵SSG(expansion/ym2203.js。SSG=AY8910Audioをチップが内蔵し、
  // clock()もチップ側がプリスケーラに応じてFM/SSG両方を進める)。VGMコマンドは 0x55 aa dd、
  // デュアル2個目は 0xA5。SSGレジスタ(0x00-0x0F)の振り分けはチップのwriteReg()が行う。
  // 鍵盤: FMはOP1-3行(chip 'ym2203fm'、デュアルはOP4-6)、SSGはKSS PSG表示のKP1-3(KP4-6)行を流用。
  function makeYm2203Adapter(info) {
    const fm = new Emu.YM2203Audio(info.clock);
    return {
      id: 'ym2203', clockHz: info.clock, accum: 0, fm, gain: CHIP_GAIN.ym2203, ssgGain: CHIP_GAIN.ym2203ssg,
      write(aa, dd) { fm.writeReg(aa, dd); },
      clock() { fm.clock(); },
      flushWrites(collapse) { fm.flushWrites(collapse); },
      mix(out) {
        const s = fm.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain;
        const sg = fm.ssg.mixSample() * this.ssgGain; out[0] += sg; out[1] += sg;
      },
      // 2個目のチップ(this.second)は鍵盤のOP4-6/KP4-6行=配列index 3-5 を自分のch0-2として読む
      applyMute(m) {
        const e = m.expansion || m;
        if (e.ym2203fm) { Emu.applyMute(fm.mute, this.second ? e.ym2203fm.slice(3) : e.ym2203fm); fm.syncMuteVol(); }
        if (e.psg) Emu.applyMute(fm.ssg.mute, this.second ? e.psg.slice(3) : e.psg);
      },
      applyVolume(v) {
        const e = v.expansion || v;
        if (e.ym2203fm) { Emu.applyVolume(fm.vol, this.second ? e.ym2203fm.slice(3) : e.ym2203fm); fm.syncMuteVol(); }
        if (e.psg) Emu.applyVolume(fm.ssg.vol, this.second ? e.psg.slice(3) : e.psg);
      },
      // 拡張ヘッダのチップ音量/全体音量(reset()が掛ける)はFM/SSG両方に効かせる
      scaleGain(f) { this.gain *= f; this.ssgGain *= f; }
    };
  }

  // YM2608(OPNA): FM 6ch+内蔵SSG+内蔵リズム6ch+ADPCM-B(expansion/ym2608.js。SSG=AY8910Audioを
  // チップが内蔵し、clock()もチップ側がプリスケーラに応じて進める)。VGMコマンドは
  // 0x56(ポート0)/0x57(ポート1)、デュアル2個目は0xA6/0xA7。DELTA-Tメモリはデータブロック0x81。
  // 鍵盤: FMはOA1-6行(chip 'ym2608fm')、リズム/ADPCM-BはOABD等/OAB行(chip 'ym2608adpcm'、
  // 0-5=リズム, 6=B)、SSGはKSS PSG表示のKP1-3行を流用。
  function makeYm2608Adapter(info) {
    const fm = new Emu.YM2608Audio(info.clock);
    return {
      id: 'ym2608', clockHz: info.clock, accum: 0, fm, gain: CHIP_GAIN.ym2608, ssgGain: CHIP_GAIN.ym2608ssg,
      write(port, aa, dd) { fm.writeReg(port, aa, dd); },
      loadRom(romSize, start, data) { fm.loadRom('b', romSize, start, data); },
      clock() { fm.clock(); },
      flushWrites(collapse) { fm.flushWrites(collapse); },
      mix(out) {
        const s = fm.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain;
        const sg = fm.ssg.mixSample() * this.ssgGain; out[0] += sg; out[1] += sg;
      },
      applyMute(m) {
        const e = m.expansion || m;
        if (e.ym2608fm) { Emu.applyMute(fm.mute, e.ym2608fm); fm.syncMuteVol(); }
        if (e.ym2608adpcm) Emu.applyMute(fm.muteAdpcm, e.ym2608adpcm);
        if (e.psg) Emu.applyMute(fm.ssg.mute, e.psg);
      },
      applyVolume(v) {
        const e = v.expansion || v;
        if (e.ym2608fm) { Emu.applyVolume(fm.vol, e.ym2608fm); fm.syncMuteVol(); }
        if (e.ym2608adpcm) Emu.applyVolume(fm.volAdpcm, e.ym2608adpcm);
        if (e.psg) Emu.applyVolume(fm.ssg.vol, e.psg);
      },
      // 拡張ヘッダのチップ音量/全体音量(reset()が掛ける)はFM/SSG両方に効かせる
      scaleGain(f) { this.gain *= f; this.ssgGain *= f; }
    };
  }

  // OPL系(YM3812=OPL2 / YM3526=OPL / Y8950=MSX-AUDIO): 2op FM×9ch+リズム(expansion/opl.js)。
  // コマンドは 0x5A/0x5B/0x5C aa dd、デュアル2個目=0xAA/0xAB/0xAC。Y8950のDELTA-Tメモリは
  // データブロック0x88。鍵盤はOL1-9行+リズム行(chip 'opl'、ミュート添字はEmu.OPL_MUTE)。
  // 3チップは同一コアのtype違いなので、鍵盤/ミュート/変換の語彙('opl')を共有する
  // (実VGMでOPL系同士が同居する構成は無い)。
  function makeOplAdapter(id) {
    return function (info) {
      const chip = new Emu.OPLAudio(info.clock, { type: id });
      return {
        id, clockHz: info.clock, accum: 0, chip, gain: CHIP_GAIN.opl,
        write(aa, dd) { chip.writeReg(aa, dd); },
        loadRom(romSize, start, data) { chip.loadRom(romSize, start, data); }, // Y8950のみ実体あり
        clock() { chip.clock(); },
        mix(out) { const s = chip.mixSample() * this.gain; out[0] += s; out[1] += s; },
        applyMute(m) { const e = m.expansion || m; if (e.opl) Emu.applyMute(chip.mute, e.opl); },
        applyVolume(v) { const e = v.expansion || v; if (e.opl) Emu.applyVolume(chip.vol, e.opl); }
      };
    };
  }

  // GA20(Irem M92/M107 PCM): 4ch 8bit PCM(expansion/ga20.js)。コマンドは 0xBF aa dd
  // (aaのbit7=デュアル2個目)、ROMはデータブロック0x93。
  function makeGa20Adapter(info) {
    const chip = new Emu.GA20Audio(info.clock);
    return {
      id: 'ga20', clockHz: info.clock, accum: 0, chip, gain: CHIP_GAIN.ga20,
      write(aa, dd) { chip.write(aa, dd); },
      loadRom(romSize, start, data) { chip.loadRom(romSize, start, data); },
      clock() { chip.clock(); },
      mix(out) { const s = chip.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain; },
      applyMute(m) { const e = m.expansion || m; if (e.ga20) Emu.applyMute(chip.mute, e.ga20); },
      applyVolume(v) { const e = v.expansion || v; if (e.ga20) Emu.applyVolume(chip.vol, e.ga20); }
    };
  }

  // K007232(コナミPCM): 2ch 7bitステレオPCM(expansion/k007232.js)。コマンドは 0x41 aa dd
  // (aaのbit7=デュアル2個目、aa=0x1F は読み出しトリガ)、ROMはデータブロック0x94。
  function makeK007232Adapter(info) {
    const chip = new Emu.K007232Audio(info.clock);
    return {
      id: 'k007232', clockHz: info.clock, accum: 0, chip, gain: CHIP_GAIN.k007232,
      write(aa, dd) { chip.write(aa, dd); },
      read(dd) { chip.read(dd); },
      loadRom(romSize, start, data) { chip.loadRom(romSize, start, data); },
      clock() { chip.clock(); },
      mix(out) { const s = chip.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain; },
      applyMute(m) { const e = m.expansion || m; if (e.k007232) Emu.applyMute(chip.mute, e.k007232); },
      applyVolume(v) { const e = v.expansion || v; if (e.k007232) Emu.applyVolume(chip.vol, e.k007232); }
    };
  }

  // MSM5205/MSM6585(PC Engine CD ADPCM 等): 1ch ストリーミングADPCM(expansion/msm5205.js)。
  // コマンドは 0x32 dd(上位ニブル=レジスタ、下位=値、bit7=デュアル2個目)。ROMは持たない。
  // プリスケーラ/ビット幅はヘッダ0xD7、MSM6585判定は0xF0のbit31(vgmHeader.js が解釈済み)。
  function makeMsm5205Adapter(info) {
    const chip = new Emu.MSM5205Audio(info.clock, info.msmFlags || 0, info.msm6585);
    return {
      id: 'msm5205', clockHz: info.clock, accum: 0, chip, gain: CHIP_GAIN.msm5205,
      write(reg, val) { chip.write(reg, val); },
      clock() { chip.clock(); },
      mix(out) { const s = chip.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain; },
      applyMute(m) { const e = m.expansion || m; if (e.msm5205) Emu.applyMute(chip.mute, e.msm5205); },
      applyVolume(v) { const e = v.expansion || v; if (e.msm5205) Emu.applyVolume(chip.vol, e.msm5205); }
    };
  }

  // K054539 のゲイン 2.4 は実測で決めた(90曲×15秒の掃引)。VGMPlay比は1.21で基準帯(1.6〜2.0)より
  // 低いが、この素材はクレストファクタが高く、基準どおりに上げるとクリップする:
  //   3.40 → クリップ2683・最大1.495 / 2.72 → 87・1.217 / **2.40 → 8・1.101** / 2.04 → 0・0.985
  // 8サンプル(90曲1350秒中)はリミッタが透過的に処理できる範囲なので、音量を優先して2.4を採った。
  // K054539(コナミPCM): 8ch ステレオPCM(expansion/k054539.js)。コマンドは 0xD3 pp aa dd
  // (offset=(pp<<8)|aa、ppのbit7=デュアル2個目)、ROMはデータブロック0x8C。フラグはヘッダ0x95。
  function makeK054539Adapter(info) {
    const chip = new Emu.K054539Audio(info.clock, info.k054Flags || 0);
    return {
      id: 'k054539', clockHz: info.clock, accum: 0, chip, gain: CHIP_GAIN.k054539,
      write(offset, dd) { chip.write(offset, dd); },
      loadRom(romSize, start, data) { chip.loadRom(romSize, start, data); },
      clock() { chip.clock(); },
      mix(out) { const s = chip.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain; },
      // 2個目のチップ(this.second)は鍵盤の K59-K516 行=配列 index 8-15 を自分の ch0-7 として読む
      applyMute(m) { const e = m.expansion || m; if (e.k054539) Emu.applyMute(chip.mute, this.second ? e.k054539.slice(8) : e.k054539); },
      applyVolume(v) { const e = v.expansion || v; if (e.k054539) Emu.applyVolume(chip.vol, this.second ? e.k054539.slice(8) : e.k054539); }
    };
  }

  // SegaPCM(315-5218): 16ch ステレオPCM(expansion/segapcm.js)。コマンドは 0xC0 bbaa dd
  // (offset=aabb、bit15=デュアル2個目)、ROMはデータブロック0x80。バンク構成はヘッダ0x3C(info.intf)。
  function makeSegaPcmAdapter(info) {
    const chip = new Emu.SegaPCMAudio(info.clock, info.intf || 0);
    return {
      id: 'segapcm', clockHz: info.clock, accum: 0, chip, gain: CHIP_GAIN.segapcm,
      write(off, dd) { chip.write(off, dd); },
      loadRom(romSize, start, data) { chip.loadRom(romSize, start, data); },
      clock() { chip.clock(); },
      mix(out) { const s = chip.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain; },
      applyMute(m) { const e = m.expansion || m; if (e.segapcm) Emu.applyMute(chip.mute, e.segapcm); },
      applyVolume(v) { const e = v.expansion || v; if (e.segapcm) Emu.applyVolume(chip.vol, e.segapcm); }
    };
  }

  // C140(Namco System 2/21): 24ch ステレオPCM(expansion/c140.js)。コマンドは 0xD4 pp aa dd
  // (レジスタ=ppaa、ppのbit7=デュアル2個目)、ROMはデータブロック0x8D。タイプはヘッダ0x96。
  function makeC140Adapter(info) {
    const chip = new Emu.C140Audio(info.clock, info.c140Type || 0);
    return {
      id: 'c140', clockHz: info.clock, accum: 0, chip, gain: CHIP_GAIN.c140,
      write(reg, dd) { chip.write(reg, dd); },
      loadRom(romSize, start, data) { chip.loadRom(romSize, start, data); },
      clock() { chip.clock(); },
      mix(out) { const s = chip.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain; },
      applyMute(m) { const e = m.expansion || m; if (e.c140) Emu.applyMute(chip.mute, e.c140); },
      applyVolume(v) { const e = v.expansion || v; if (e.c140) Emu.applyVolume(chip.vol, e.c140); }
    };
  }

  // C352(Namco System 11/12/22/NB-1/2/ND-1): 32ch PCM(expansion/c352.js)。コマンドは
  // 0xE1 aa bb dd ee(レジスタ=aabb 16bitワード、aaのbit7=デュアル2個目、データ=ddee)、
  // ROMはデータブロック0x92。サンプルレート=クロック/分周(ヘッダ0xD6の値×4、0=288)。
  function makeC352Adapter(info) {
    const chip = new Emu.C352Audio(info.clock, info.c352Div || 288);
    return {
      id: 'c352', clockHz: info.clock, accum: 0, chip, gain: CHIP_GAIN.c352,
      write(reg, dd) { chip.write(reg, dd); },
      loadRom(romSize, start, data) { chip.loadRom(romSize, start, data); },
      clock() { chip.clock(); },
      mix(out) { const s = chip.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain; },
      applyMute(m) { const e = m.expansion || m; if (e.c352) Emu.applyMute(chip.mute, e.c352); },
      applyVolume(v) { const e = v.expansion || v; if (e.c352) Emu.applyVolume(chip.vol, e.c352); }
    };
  }

  // QSound(カプコンCPS1ダッシュ/CPS2): 16ch PCM(expansion/qsound.js)。コマンドは
  // 0xC4 mm ll rr(値=mmll、レジスタ=rr)、ROMはデータブロック0x8F。デュアルは実機に無い。
  function makeQsoundAdapter(info) {
    const chip = new Emu.QSoundAudio(info.clock);
    return {
      id: 'qsound', clockHz: info.clock, accum: 0, chip, gain: CHIP_GAIN.qsound,
      write(reg, dd) { chip.write(reg, dd); },
      loadRom(romSize, start, data) { chip.loadRom(romSize, start, data); },
      clock() { chip.clock(); },
      mix(out) { const s = chip.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain; },
      applyMute(m) { const e = m.expansion || m; if (e.qsound) Emu.applyMute(chip.mute, e.qsound); },
      applyVolume(v) { const e = v.expansion || v; if (e.qsound) Emu.applyVolume(chip.vol, e.qsound); }
    };
  }

  // MultiPCM(セガModel 1/2/Multi 32の28ch PCM): expansion/multipcm.js。コマンドは
  // 0xB5 aa dd(aa=ポート0-2、bit7=デュアル2個目)、バンクは0xC3 cc bbaa(専用case)、
  // ROMはデータブロック0x89。
  function makeMultiPcmAdapter(info) {
    // クロックはヘッダ値をそのまま使う(サンプルレート=clock/180。分周の根拠は
    // multipcm.jsコンストラクタのコメント参照。一時期「Multi32はヘッダ×4/3」補正を
    // 入れたが、実盤FLACのクロマ照合で「分周180+ヘッダそのまま」が正と確定し撤去)。
    const chip = new Emu.MultiPCMAudio(info.clock);
    return {
      id: 'multipcm', clockHz: info.clock, accum: 0, chip, gain: CHIP_GAIN.multipcm,
      write(port, dd) { chip.write(port, dd); },
      loadRom(romSize, start, data) { chip.loadRom(romSize, start, data); },
      clock() { chip.clock(); },
      mix(out) { const s = chip.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain; },
      applyMute(m) { const e = m.expansion || m; if (e.multipcm) Emu.applyMute(chip.mute, e.multipcm); },
      applyVolume(v) { const e = v.expansion || v; if (e.multipcm) Emu.applyVolume(chip.vol, e.multipcm); }
    };
  }

  // OKIM6295(東亜プラン/ライジング等の4ch ADPCM): expansion/okim6295.js。コマンドは
  // 0xB8 aa dd(aaのbit7=デュアル2個目、aa=仮想レジスタ: 0=コマンド/0x0F=バンク/
  // 0x0E,0x10-0x13=NMK112)。ROMはデータブロック0x8B、pin7(分周132/165)はクロックbit31。
  function makeOkim6295Adapter(info) {
    const chip = new Emu.OKIM6295Audio(info.clock, !!info.pin7);
    return {
      id: 'okim6295', clockHz: info.clock, accum: 0, chip, gain: CHIP_GAIN.okim6295,
      write(reg, dd) { chip.write(reg, dd); },
      loadRom(romSize, start, data) { chip.loadRom(romSize, start, data); },
      clock() { chip.clock(); },
      mix(out) { const s = chip.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain; },
      applyMute(m) { const e = m.expansion || m; if (e.okim6295) Emu.applyMute(chip.mute, e.okim6295); },
      applyVolume(v) { const e = v.expansion || v; if (e.okim6295) Emu.applyVolume(chip.vol, e.okim6295); }
    };
  }

  // OKIM6258(Sharp X68000 ADPCM): 1ch ストリーミングADPCM(expansion/okim6258.js)。
  // コマンドは 0xB7 aa dd(aaのbit7=デュアル2個目)。ROMは持たず、データは
  // DACストリーム制御(0x90-0x95、chipType 0x17)がデータバンク(type 0x04)から
  // データレジスタ(offset 1)へ配送する。初期分周はヘッダ0x94のflags。
  function makeOkim6258Adapter(info) {
    const chip = new Emu.OKIM6258Audio(info.clock, info.okiFlags || 0);
    return {
      id: 'okim6258', clockHz: info.clock, accum: 0, chip, gain: CHIP_GAIN.okim6258,
      write(reg, dd) { chip.write(reg, dd); },
      clock() { chip.clock(); },
      mix(out) { const s = chip.mixSample(); out[0] += s.left * this.gain; out[1] += s.right * this.gain; },
      applyMute(m) { const e = m.expansion || m; if (e.okim6258) Emu.applyMute(chip.mute, e.okim6258); },
      applyVolume(v) { const e = v.expansion || v; if (e.okim6258) Emu.applyVolume(chip.vol, e.okim6258); }
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
    rf5c68: makeRfAdapter('rf5c68'), rf5c164: makeRfAdapter('rf5c164'), ym2610: makeYm2610Adapter,
    ym2151: makeYm2151Adapter, ym2203: makeYm2203Adapter, ym2608: makeYm2608Adapter,
    ym3812: makeOplAdapter('ym3812'), ym3526: makeOplAdapter('ym3526'), y8950: makeOplAdapter('y8950'),
    ga20: makeGa20Adapter, segapcm: makeSegaPcmAdapter, c140: makeC140Adapter,
    c352: makeC352Adapter, okim6258: makeOkim6258Adapter, qsound: makeQsoundAdapter,
    okim6295: makeOkim6295Adapter, multipcm: makeMultiPcmAdapter,
    k007232: makeK007232Adapter, msm5205: makeMsm5205Adapter, k054539: makeK054539Adapter
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
        // ナムコSystem 2/21(YM2151+C140): 実基板録音CD(ワルキューレの伝説メインテーマ)との
        // ラウドネス推移フィットで、FM:PCM比は既定ゲイン比のFM約1.7倍が最適だった
        // (現状比1.4〜2.0がほぼ同値、最小1.77。FMのファンファーレがPCMに埋もれる報告)。
        // C140側を下げると曲全体が他形式比-5dBに沈むため、YM2151側をこの構成時のみ増強する。
        if (info.id === 'ym2151' && h.chips.c140) a.gain *= 1.7;
        // アイレムM92/M107(YM2151+GA20): FM:PCM比自体はCD照合(UCC/ファイヤーバレル4曲の
        // ゲインフィット±0.5dB以内)で既定ゲイン比が正と確認済みだが、合算ミックスが過熱し
        // 再生段リミッタ(-3dB/20:1)がファイヤーバレルで64〜67%の時間介入・アタック最大6.8dB
        // 刈り=「PCMの抜けが弱い」の実体だった(2026-08-28)。比率を保ったまま両チップ×0.5で
        // 介入0%・RMS-13〜-15dB(MD/SPC基準近傍)に収める。
        if ((info.id === 'ym2151' || info.id === 'ga20') && h.chips.ym2151 && h.chips.ga20) a.gain *= 0.5;
        // 東亜プラン2/ライジング(YM2151+OKIM6295): FM:ADPCM比は既定ゲイン比でRMSほぼ1:1
        // (Battle Garegga実測 0.197:0.198)だが合算が過熱(RMS0.28/ピーク1.41)するため、
        // アイレムM92と同じ「比率を保ったまま両チップ縮小」で×0.7(RMS-14dB級/ピーク~1.0)。
        if ((info.id === 'ym2151' || info.id === 'okim6295') && h.chips.ym2151 && h.chips.okim6295) a.gain *= 0.7;
        // デュアルYM2203(Avengers等のアーケード): 2個で単純加算するとMD基準のgain2.0が実質4.0に
        // なり過熱する(実測: Avengers Boss RMS-8.1dB/ピーク2.4=クリップ)。FM:SSG比を保ったまま
        // 両チップ×0.5して単チップ相当の合算レベルに収める(RMS-14dB級)。
        if (info.id === 'ym2203' && info.dual) a.scaleGain(0.5);
        // デュアルK054539(サラマンダー2): VGMPlay は GetChipVolume で「2個使いなら各チップ÷個数」
        // にしている。これを入れないと2個ぶんが素通しで合算2倍になる(実測: 単チップの曲は
        // VGMPlay比0.80前後なのにサラマンダー2だけ1.63=ちょうど2倍)。
        if (info.id === 'k054539' && info.dual) a.gain *= 0.5;
        // コナミ・アーケード(OPL系+SCC。ライブラリ内では Haunted Castle だけがこの同居):
        // このパックは**K007232を足す前から全曲的に0dBFSを超えていた**(23曲20秒の合計で
        // クリップ9211サンプル・最大ピーク1.49)。アイレムM92と同じ「比率を保ったまま全体を
        // 縮小」で×0.7にすると合計639・最大1.41まで下がり、**全曲が変更前より良くなる**
        // (K007232単独の効果音4曲はこの同居に当たらないので等倍のまま。ピーク0.35〜0.52)。
        // 素材のクレストファクタが高く(VGMPlayリファレンスでも7前後)、RMSは-17dB級と
        // 基準帯(-13〜-15dB)より低めになるが、リミッタを常時叩くよりはこちらを採る。
        // ★「同じパック内でVGMPlay比が一定にならない」(10曲目1.90/8曲目3.81)の正体は
        //   **VGMPlayの自動正規化 `NormalizeOverallVolume`**(libvgm player/vgmplayer.cpp)。
        //   VGMPlayは各チップの音量に重み `_PB_VOL_AMNT` を掛けた総和 absVol を出し、
        //   absVol <= 0x180 なら全チップ×2、**absVol > 0x300 なら全チップ÷2** を繰り返す。
        //     10曲目: YM3812 154×2 + SCC 204×1 + K007232 256×1 = 768 = 0x300 → ちょうど閾値内で等倍
        //     8曲目 : YM3812 179×2 + SCC 204×1 + K007232 256×1 = 818 = 0x332 → 超過して÷2
        //   ヘッダ0x7C(音量修正)はこの総和に入らない(front-endのマスタ音量)ので、
        //   0x7Cを0〜64で掃引しても両者ぴったり 2^(n/32) で一致する(実測確認済み)。
        //   ★当プロジェクトはこの正規化を持たない。入れると **ライブラリ14597曲中11794曲(81%)の
        //   音量が2倍/4倍動く**(×2が7588曲・×4が3812曲・×0.5が394曲)。CHIP_GAIN は
        //   この正規化が無い前提で実測較正してある(C140/アイレムのCD照合等)ので、
        //   足すと二重補正になる。採用するならCHIP_GAIN全面再較正とセットで、要判断。
        if ((h.chips.ym3812 || h.chips.ym3526 || h.chips.y8950) && h.chips.k051649) {
          if (a.scaleGain) a.scaleGain(0.7); else a.gain *= 0.7;
        }
        // PC Engine CD(HuC6280+MSM5205): ADPCMは素材自体がフルスケール近くまで振れていて
        // (VGMPlayリファレンスも peak 0.909 / クレストファクタ7.2)、当プロジェクトの基準音量
        // (VGMPlay比 約1.5倍)をそのまま掛けると確実にクリップする(実測 peak 1.336・780サンプル)。
        // 同じく比率を保ったまま×0.7(peak 0.935 / クリップ0 / RMS -17.2dB)。
        if (h.chips.msm5205) { if (a.scaleGain) a.scaleGain(0.7); else a.gain *= 0.7; }
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
          if (info.id === 'ym2151' && h.chips.c140) b.gain *= 1.7;
          if ((info.id === 'ym2151' || info.id === 'ga20') && h.chips.ym2151 && h.chips.ga20) b.gain *= 0.5;
          if ((info.id === 'ym2151' || info.id === 'okim6295') && h.chips.ym2151 && h.chips.okim6295) b.gain *= 0.7;
          if (info.id === 'ym2203') b.scaleGain(0.5);
          if (info.id === 'k054539') b.gain *= 0.5;
          if ((h.chips.ym3812 || h.chips.ym3526 || h.chips.y8950) && h.chips.k051649) {
            if (b.scaleGain) b.scaleGain(0.7); else b.gain *= 0.7;
          }
          if (h.chips.msm5205) { if (b.scaleGain) b.scaleGain(0.7); else b.gain *= 0.7; }
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
      // ── ストリーミングDACの「1発」をログから取る(2026-09-04) ──────────────
      // YM2612のDACや32X PWM/OKIM6258はレジスタ上ただのバイト列で、鳴っている音から
      // 打点を推測しても同じ太鼓が別物に割れてしまう。VGMは「どこから流し始めたか」を
      // 0xE0シーク/0x93・0x95のstartアドレスで持っているので、**それをサンプル同定に使う**
      // (C140などが sample.start を持つのと同じ意味論)。
      //   dacHits: [{ chip, start, bytes, startSample, endSample }]
      //   ・0xE0 が現在位置と違うところへ飛んだら「打ち直し」。同じ位置への再シークは
      //     ロガーの都合なので継続扱い(OutRunners実測: 打ち直し4375回に対し継続1回)
      //   ・バイト内容が一定の区間はDACの無音レベル(0x80)を書いているだけなので後段で捨てる
      this.dacHits = [];
      this._dacCur = null;
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
            const second = !!(size & 0x80000000); // bit31 = デュアルチップ2個目のROM/RAM
            size &= 0x7FFFFFFF;
            const start = p + 6;
            const block = d.subarray(start, Math.min(d.length, start + size));
            this._dataBlock(type, block, second);
            this.pos = start + size; break;
          }
          case 0x50: this._writeSn(d[p], false); this.pos = p + 1; break;
          case 0x30: this._writeSn(d[p], true); this.pos = p + 1; break; // 2個目のSN76489
          case 0x4F: this._writeGgStereo(d[p]); this.pos = p + 1; break;
          case 0x51: this._chipWrite('ym2413', d[p], d[p + 1], false); this.pos = p + 2; break;
          case 0xA1: this._chipWrite('ym2413', d[p], d[p + 1], true); this.pos = p + 2; break; // 2個目のYM2413
          case 0x54: this._chipWrite('ym2151', d[p], d[p + 1], false); this.pos = p + 2; break; // YM2151(OPM)
          case 0xA4: this._chipWrite('ym2151', d[p], d[p + 1], true); this.pos = p + 2; break; // 2個目のYM2151
          case 0x55: this._chipWrite('ym2203', d[p], d[p + 1], false); this.pos = p + 2; break; // YM2203(OPN)
          case 0xA5: this._chipWrite('ym2203', d[p], d[p + 1], true); this.pos = p + 2; break; // 2個目のYM2203
          case 0x5A: this._chipWrite('ym3812', d[p], d[p + 1], false); this.pos = p + 2; break; // YM3812(OPL2)
          case 0xAA: this._chipWrite('ym3812', d[p], d[p + 1], true); this.pos = p + 2; break;
          case 0x5B: this._chipWrite('ym3526', d[p], d[p + 1], false); this.pos = p + 2; break; // YM3526(OPL)
          case 0xAB: this._chipWrite('ym3526', d[p], d[p + 1], true); this.pos = p + 2; break;
          case 0x5C: this._chipWrite('y8950', d[p], d[p + 1], false); this.pos = p + 2; break; // Y8950(MSX-AUDIO)
          case 0xAC: this._chipWrite('y8950', d[p], d[p + 1], true); this.pos = p + 2; break;
          case 0x56: this._ym2608Write(0, d[p], d[p + 1], false); this.pos = p + 2; break; // YM2608(OPNA) ポート0
          case 0x57: this._ym2608Write(1, d[p], d[p + 1], false); this.pos = p + 2; break; // YM2608 ポート1
          case 0xA6: this._ym2608Write(0, d[p], d[p + 1], true); this.pos = p + 2; break; // 2個目のYM2608
          case 0xA7: this._ym2608Write(1, d[p], d[p + 1], true); this.pos = p + 2; break;
          // 0xA0/0xB3/0xB4/0xB9/0xD2: レジスタ(ポート)のbit7=1が2個目のチップ
          case 0xA0: this._chipWrite('ay8910', d[p] & 0x7F, d[p + 1], !!(d[p] & 0x80)); this.pos = p + 2; break;
          case 0xB3: this._chipWrite('gb', d[p] & 0x7F, d[p + 1], !!(d[p] & 0x80)); this.pos = p + 2; break;
          case 0xB4: this._chipWrite('nes', d[p] & 0x7F, d[p + 1], !!(d[p] & 0x80)); this.pos = p + 2; break;
          case 0xB9: this._chipWrite('huc6280', d[p] & 0x7F, d[p + 1], !!(d[p] & 0x80)); this.pos = p + 2; break;
          case 0xB2: this._chipWrite('pwm', (d[p] >> 4) & 0x0F, ((d[p] & 0x0F) << 8) | d[p + 1], false); this.pos = p + 2; break; // 32X PWM: reg=a, 12bit値
          case 0xBF: this._chipWrite('ga20', d[p] & 0x7F, d[p + 1], !!(d[p] & 0x80)); this.pos = p + 2; break; // GA20(Irem)
          // K007232(コナミPCM): 0x41 aa dd。aa=0x1F は「チップ読み出しの実行」で dd が読み出し
          // オフセット(5/11でキーオン)。Haunted Castle のドライバはこの経路でしか発音しない
          case 0x41: this._k007232Write(d[p] & 0x7F, d[p + 1], !!(d[p] & 0x80)); this.pos = p + 2; break;
          // K054539(コナミ8ch PCM): 0xD3 pp aa dd。オフセットは16bit、ppのbit7=デュアル2個目
          case 0xD3: this._chipWrite('k054539', ((d[p] & 0x7F) << 8) | d[p + 1], d[p + 2], !!(d[p] & 0x80)); this.pos = p + 3; break;
          // MSM5205/MSM6585(PC Engine CD ADPCM 等): 0x32 dd。上位ニブル=レジスタ、下位=値
          case 0x32: this._chipWrite('msm5205', (d[p] >> 4) & 0x07, d[p] & 0x0F, !!(d[p] & 0x80)); this.pos = p + 1; break;
          case 0xB7: this._chipWrite('okim6258', d[p] & 0x7F, d[p + 1], !!(d[p] & 0x80)); this.pos = p + 2; break; // OKIM6258(X68000 ADPCM)
          case 0xB8: this._chipWrite('okim6295', d[p] & 0x7F, d[p + 1], !!(d[p] & 0x80)); this.pos = p + 2; break; // OKIM6295(4ch ADPCM)
          case 0xB5: this._chipWrite('multipcm', d[p] & 0x7F, d[p + 1], !!(d[p] & 0x80)); this.pos = p + 2; break; // MultiPCM(ポート0-2)
          case 0xC3: { // MultiPCMセガバンキング: cc bb aa(値=aabb、ccのbit0/1=L/Rバンク、bit7=2個目)
            const mp = this.adapterById[(d[p] & 0x80) ? 'multipcm_2' : 'multipcm'];
            if (mp) mp.chip.bankWrite(d[p] & 0x7F, d[p + 1] | (d[p + 2] << 8));
            this.pos = p + 3; break;
          }
          case 0xB0: this._chipWrite('rf5c68', d[p] & 0x7F, d[p + 1], !!(d[p] & 0x80)); this.pos = p + 2; break;
          case 0xB1: this._chipWrite('rf5c164', d[p] & 0x7F, d[p + 1], !!(d[p] & 0x80)); this.pos = p + 2; break;
          case 0xC4: this._chipWrite('qsound', d[p + 2], (d[p] << 8) | d[p + 1], false); this.pos = p + 3; break; // QSound: mm ll rr(値=mmll、レジスタ=rr)
          case 0xC0: { // SegaPCM: bbaa dd(offset=aabb、bit15=デュアル2個目)
            const off = d[p] | (d[p + 1] << 8);
            this._chipWrite('segapcm', off & 0x7FFF, d[p + 2], !!(off & 0x8000));
            this.pos = p + 3; break;
          }
          case 0xC1: this._rfMemWrite('rf5c68', d[p] | (d[p + 1] << 8), d[p + 2]); this.pos = p + 3; break;  // RF5C68 メモリ書込み(選択中バンク窓)
          case 0xC2: this._rfMemWrite('rf5c164', d[p] | (d[p + 1] << 8), d[p + 2]); this.pos = p + 3; break; // RF5C164 メモリ書込み
          case 0xD2: this._sccWrite(d[p] & 0x7F, d[p + 1], d[p + 2], !!(d[p] & 0x80)); this.pos = p + 3; break;
          case 0xD4: this._chipWrite('c140', ((d[p] & 0x7F) << 8) | d[p + 1], d[p + 2], !!(d[p] & 0x80)); this.pos = p + 3; break; // C140(Namco)
          case 0xE1: this._chipWrite('c352', ((d[p] & 0x7F) << 8) | d[p + 1], (d[p + 2] << 8) | d[p + 3], !!(d[p] & 0x80)); this.pos = p + 4; break; // C352(Namco、16bitデータ)
          case 0x52: this._ymWrite(0, d[p], d[p + 1], false); this.pos = p + 2; break;
          case 0x53: this._ymWrite(1, d[p], d[p + 1], false); this.pos = p + 2; break;
          case 0xA2: this._ymWrite(0, d[p], d[p + 1], true); this.pos = p + 2; break; // 2個目のYM2612
          case 0xA3: this._ymWrite(1, d[p], d[p + 1], true); this.pos = p + 2; break;
          case 0x58: this._ym2610Write(0, d[p], d[p + 1]); this.pos = p + 2; break; // YM2610(Neo Geo) ポート0
          case 0x59: this._ym2610Write(1, d[p], d[p + 1]); this.pos = p + 2; break; // YM2610 ポート1
          case 0xE0: {
            const t = (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0;
            if (t !== this.pcmPos) this._dacHitStart('ym2612', 0x00, t); // 位置が飛んだ=打ち直し
            this.pcmPos = t; this.pos = p + 4; break;
          }
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
              if (this._dacCur) { this._dacCur.bytes++; this._dacCur.endSample = this.samplePos; }
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

    // ROMサイズ(4)+開始アドレス(4)+データ、の共通形式で1チップに紐づくROMブロック(型→チップid)
    static get ROM_BLOCK_CHIP() {
      return { 0x80: 'segapcm', 0x89: 'multipcm', 0x8B: 'okim6295', 0x8D: 'c140', 0x8F: 'qsound', 0x92: 'c352', 0x93: 'ga20', 0x94: 'k007232', 0x8C: 'k054539' };
    }
    // second: データブロックサイズのbit31=デュアルチップ2個目のROM/RAM(Batriderの
    // デュアルOKIM6295等。以前は捨てて全部1個目へロードし、2個目のROMが1個目を上書きしていた)
    _dataBlock(type, block, second) {
      this.dataBlocks.push({ type, size: block.length });
      const ad = (id) => this.adapterById[second ? id + '_2' : id];
      if (type < 0x40) { // 非圧縮ストリーム(0x00=YM2612 PCM 等): typeごとに連結してバンクにする
        const bank = this.dataBanks[type] || (this.dataBanks[type] = { data: new Uint8Array(0), blocks: [] });
        const merged = new Uint8Array(bank.data.length + block.length);
        merged.set(bank.data, 0); merged.set(block, bank.data.length);
        bank.blocks.push({ start: bank.data.length, len: block.length });
        bank.data = merged;
        return;
      }
      if (type === 0xC2) { // NES APU RAM書込み: 先頭2バイト=開始アドレス
        const nes = ad('nes');
        if (nes && block.length >= 2) nes.ramWrite(block[0] | (block[1] << 8), block.subarray(2));
      }
      if (type === 0xC0 || type === 0xC1) { // RF5C68(0xC0)/RF5C164(0xC1) 波形RAM書込み: 先頭2バイト=絶対アドレス
        const rf = ad(type === 0xC0 ? 'rf5c68' : 'rf5c164');
        if (rf && block.length >= 2) rf.ramWrite(block[0] | (block[1] << 8), block.subarray(2));
      }
      if (type === 0x81 || type === 0x88) { // DELTA-Tメモリ: 0x81=YM2608 / 0x88=Y8950(共通形式)
        const y = ad(type === 0x81 ? 'ym2608' : 'y8950');
        if (y && block.length >= 8) {
          const romSize = (block[0] | (block[1] << 8) | (block[2] << 16) | (block[3] << 24)) >>> 0;
          const start = (block[4] | (block[5] << 8) | (block[6] << 16) | (block[7] << 24)) >>> 0;
          y.loadRom(romSize, start, block.subarray(8));
        }
      }
      if (type === 0x82 || type === 0x83) { // YM2610 ADPCM-A(0x82) / ADPCM-B(0x83) ROM: 共通形式(kind付き)
        const y = ad('ym2610');
        if (y && block.length >= 8) {
          const romSize = (block[0] | (block[1] << 8) | (block[2] << 16) | (block[3] << 24)) >>> 0;
          const start = (block[4] | (block[5] << 8) | (block[6] << 16) | (block[7] << 24)) >>> 0;
          y.loadRom(type === 0x83 ? 'b' : 'a', romSize, start, block.subarray(8));
        }
      }
      const romChip = VgmPlayer.ROM_BLOCK_CHIP[type];
      if (romChip) {
        const a = ad(romChip);
        if (a && block.length >= 8) {
          const romSize = (block[0] | (block[1] << 8) | (block[2] << 16) | (block[3] << 24)) >>> 0;
          const start = (block[4] | (block[5] << 8) | (block[6] << 16) | (block[7] << 24)) >>> 0;
          a.loadRom(romSize, start, block.subarray(8));
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

    // K007232: オフセット0x1F は読み出しトリガ(dd=読み出すオフセット)。それ以外は通常の書込み。
    // onWrite には「実際にチップへ渡ったオフセット」を通知する(キャプチャがキーオンを拾えるように)。
    _k007232Write(ofs, dd, second) {
      const key = second ? 'k007232_2' : 'k007232';
      const a = this.adapterById[key];
      if (!a) return;
      if (ofs === 0x1F) a.read(dd); else a.write(ofs, dd);
      if (this.onWrite) this.onWrite(key, ofs, dd);
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

    _ym2608Write(port, aa, dd, second) {
      const key = second ? 'ym2608_2' : 'ym2608';
      const a = this.adapterById[key];
      if (!a) return;
      a.write(port, aa, dd);
      if (this.onWrite) this.onWrite(key, port, aa, dd);
    }

    _stream(id) {
      return this.streams[id] || (this.streams[id] = { chipType: 0, second: false, port: 0, cmd: 0, bankType: 0, stepSize: 1, stepBase: 0, freq: 0, acc: 0, pos: 0, end: 0, loop: false, reverse: false, active: false });
    }

    /**
     * ストリーミングDACの打点を開始する(直前の打点は確定して積む)。
     * chip: 'ym2612'(0x8n経路) / 'pwm' / 'okim6258'(DACストリーム経路)
     * bankType: どのデータバンクから流しているか(PCMの取り出しに使う)
     */
    _dacHitStart(chip, bankType, start) {
      // 打点が異常に増える曲(壊れたログ)で無制限に伸びないよう歯止めを置く。
      // ★shift()で古いのを捨てるとO(n)が毎回走って主スレッドが焼き付く
      //   ([[write-queue-needs-unclocked-path-guard]]と同じ罠)。上限に当たったら記録を止める
      if (this.dacHits.length >= DAC_HITS_MAX) { this._dacCur = null; return; }
      if (this._dacCur) this.dacHits.push(this._dacCur);
      this._dacCur = { chip, bankType, start, bytes: 0, startSample: this.samplePos, endSample: this.samplePos };
    }
    /** 取得済みのDAC打点(進行中の1件も含む)。データバンクは取り出し側が dataBanks から引く */
    getDacHits() {
      return this._dacCur ? this.dacHits.concat([this._dacCur]) : this.dacHits.slice();
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
      // DACストリームは開始アドレスがそのままサンプル同定になる(0x8n経路の0xE0と同じ意味)。
      // 書込み先チップごとに打点を積む(YM2612 DAC / 32X PWM / OKIM6258)
      if (s.active) {
        const chip = s.chipType === 0x02 ? 'ym2612' : s.chipType === 0x11 ? 'pwm' : s.chipType === 0x17 ? 'okim6258' : null;
        if (chip) {
          this._dacHitStart(chip, s.bankType, s.start);
          // ストリームは長さが分かっているので、その場でバイト数を確定させておく
          // (実際の消化は _stepStreams。途中で 0x94 停止されたら短くなるが、パッドの
          //  同定は開始アドレスで行うので影響しない)
          this._dacCur.bytes = Math.max(0, Math.floor((s.end - s.start) / Math.max(1, s.stepSize)));
          this._dacCur.rate = s.freq;
          this._dacCur.stepSize = s.stepSize;
          // OKIM6258はROMを持たないので、鍵盤行の波形アイコン用に「いま流しているサンプル」を
          // チップへ教える(expansion/okim6258.js setStreamSample)。音の生成には関与しない
          if (chip === 'okim6258') {
            const a = this.adapterById[s.second ? 'okim6258_2' : 'okim6258'];
            if (a && a.chip && a.chip.setStreamSample) a.chip.setStreamSample(bank.data, s.start, this._dacCur.bytes);
          }
        }
      }
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
          else if (s.chipType === 0x17) this._chipWrite('okim6258', s.cmd & 0x7F, v, s.second); // X68000 ADPCM: データレジスタ(通常cmd=0x01)へ1バイト
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
    // ── シーク用チェックポイント(2026-09-04) ──────────────────────────────────
    // シークは曲頭からコマンドを流し直すので、長い曲ほど重い(実測: 2分の曲の末尾で
    // 543ms、ドラッグすると積み上がって固まる)。一定間隔で状態を控えておき、
    // 直近のところから再開すれば「間隔ぶん」で済む。
    // ★対応できるのは全チップが getState/setState を持つ曲だけ。1つでも欠けたら
    //   誤った状態で鳴らすより従来どおり頭から流す(canCheckpoint)。
    // 1回あたり実測2.7〜3.4KB(サンプルROM等の不変データは含めない)なので、
    // 5秒間隔・5分の曲でも200KB程度。
    get canCheckpoint() {
      if (this._ckOk === undefined) {
        this._ckOk = this.adapters.every((a) => {
          const chip = a.chip || a.fm || a.apu || null;
          return !chip || (typeof chip.getState === 'function' && typeof chip.setState === 'function');
        });
      }
      return this._ckOk;
    }
    _saveCheckpoint() {
      const chips = [];
      for (const a of this.adapters) {
        const chip = a.chip || a.fm || a.apu || null;
        chips.push(chip ? chip.getState() : null);
      }
      const streams = {};
      for (const id in this.streams) streams[id] = Object.assign({}, this.streams[id]);
      return { samplePos: this.samplePos, pos: this.pos, waitRemaining: this.waitRemaining,
               pcmPos: this.pcmPos, loopCount: this.loopCount, streams, chips,
               dacHitsLen: this.dacHits.length };
    }
    _restoreCheckpoint(cp) {
      for (let i = 0; i < this.adapters.length; i++) {
        const a = this.adapters[i], chip = a.chip || a.fm || a.apu || null;
        if (chip && cp.chips[i]) chip.setState(cp.chips[i]);
      }
      this.samplePos = cp.samplePos; this.pos = cp.pos; this.waitRemaining = cp.waitRemaining;
      this.pcmPos = cp.pcmPos; this.loopCount = cp.loopCount;
      this.streams = {};
      for (const id in cp.streams) this.streams[id] = Object.assign({}, cp.streams[id]);
      // 打点は「そこまでに拾った分」へ戻す(シークで重複して積まないように)
      this.dacHits.length = Math.min(this.dacHits.length, cp.dacHitsLen);
      this._dacCur = null;
      this.ended = false;
    }
    /**
     * 進行中に一定間隔で状態を控える(fastForward/renderFrame から呼ぶ)。
     * @param {boolean} [flushFirst] 早送り経路だけ true。早送りは clock() を回さないので
     *   書込みキューが伸び続け、そのまま控えるとキュー全体のコピーが毎回走って重くなる
     *   (実測: 60秒地点のシークが 7ms → 348ms)。控える前に流して空にしておく。
     *   ★キャプチャ経路(renderFrame)では絶対に流さないこと。あそこでの flushWrites は
     *     末尾で1サンプルぶん clock() を回すため、EGが余分に進んで抽出結果が変わる。
     */
    _noteCheckpoint(flushFirst) {
      if (!this.canCheckpoint) return;
      const cps = this._checkpoints || (this._checkpoints = []);
      const last = cps.length ? cps[cps.length - 1].samplePos : -Infinity;
      if (this.samplePos - last < CHECKPOINT_INTERVAL) return;
      if (cps.length >= CHECKPOINT_MAX) return;
      if (flushFirst) this._flushWrites(true);
      cps.push(this._saveCheckpoint());
    }
    /**
     * 控えたチェックポイントを他のプレイヤーへ渡せる形にする(2026-09-04)。
     * 先読みキャプチャは曲全体をコマンド解釈しながら歩くので、そこで作った控えを
     * 実再生側のプレイヤーへ渡せば「まだ通っていない位置」への初回シークも速くなる。
     * ★データバンク(0x67で読み込むPCM/ADPCMの元データ)も一緒に渡すこと。
     *   チェックポイント復元はコマンド位置を飛ばすので、曲頭のデータブロックを
     *   読んでいないプレイヤーではDACのバンクが空のまま鳴らすことになる。
     *   バンクは曲中で足されるだけ(既存の内容は変わらない)なので、最終状態を渡して安全。
     */
    serializeSeekData() {
      if (!this.canCheckpoint || !this._checkpoints || !this._checkpoints.length) return null;
      const banks = {};
      for (const type of Object.keys(this.dataBanks)) {
        const b = this.dataBanks[type];
        banks[type] = { data: b.data, blocks: b.blocks };
      }
      return { checkpoints: this._checkpoints, banks };
    }
    /** serializeSeekData() の結果を取り込む(実再生側のプレイヤーで呼ぶ) */
    adoptSeekData(sd) {
      if (!sd || !sd.checkpoints || !this.canCheckpoint) return;
      for (const type of Object.keys(sd.banks || {})) {
        const cur = this.dataBanks[type];
        // まだ読んでいない/短いバンクだけ差し替える(自分で読んだ分を壊さない)
        if (!cur || !cur.data || cur.data.length < sd.banks[type].data.length) {
          this.dataBanks[type] = { data: sd.banks[type].data, blocks: sd.banks[type].blocks };
        }
      }
      const cps = this._checkpoints || (this._checkpoints = []);
      const have = new Set(cps.map((c) => c.samplePos));
      for (const cp of sd.checkpoints) if (!have.has(cp.samplePos)) cps.push(cp);
      cps.sort((a, b) => a.samplePos - b.samplePos);
    }

    /**
     * 目標位置へシークする。控えてあるチェックポイントのうち手前で一番近いものから
     * 再開し、足りない分だけコマンドを流す。チェックポイントが無ければ従来どおり頭から。
     */
    seekTo(targetSample) {
      const cps = this._checkpoints || [];
      let best = null;
      for (const cp of cps) { if (cp.samplePos <= targetSample && (!best || cp.samplePos > best.samplePos)) best = cp; }
      if (best && this.canCheckpoint) this._restoreCheckpoint(best);
      else { const keep = this._checkpoints; this.reset(); this._checkpoints = keep; }
      this.fastForward(targetSample);
    }

    fastForward(targetSample) {
      while (this.samplePos < targetSample && !this.ended) {
        this._noteCheckpoint(true); // 早送りは控える前にキューを流す(_noteCheckpoint参照)
        if (this.waitRemaining === 0) this._runCommands();
        const step = Math.min(this.waitRemaining, targetSample - this.samplePos);
        if (step <= 0) { if (this.ended) break; continue; }
        this.waitRemaining -= step;
        this.samplePos += step;
        // ストリームはサンプル単位でしか進められないが、シーク用途では最終位置だけ合えばよい
        for (let i = 0; i < step; i++) this._stepStreams();
      }
      this._flushWrites(true); // シークは時間経過を再現していないので畳んでよい
    }

    // clock()を回さずにコマンドだけ消化した後(fastForward / renderFrame regsOnly)、書込みを
    // キュー経由で適用するチップ(Nuked-OPN2版YM2612/YM2610)にキューを消化させる。
    // これが無いと、Nukedコアではキャプチャの鍵盤スナップショット/ロールが空になり、シーク後は
    // 曲頭からの全書込みがキューに溜まったまま再生が始まって暫く音が崩れる。
    // collapse: シーク(fastForward)からの呼び出しだけ true。溜まりきったキューを
    // レジスタごとの最終値へ畳んでよい合図(ym2612Nuked.flushWrites 参照)。
    // キャプチャの毎フレーム経路では畳まない(そこでのclock()はエンベロープを実際に進めており、
    // 鍵盤スナップショットの発音判定がそれに依存している)
    _flushWrites(collapse) {
      for (const a of this.adapters) if (a.flushWrites) a.flushWrites(collapse);
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
      // 再生しながらチェックポイントを控える(一度通ったところへのシークが速くなる)。
      // 先読みキャプチャ(regsOnly)でも控える: 曲全体を歩くので、その控えを実再生側へ
      // 渡せば未到達位置への初回シークも速くなる(serializeSeekData/adoptSeekData)。
      // ★getState()はチップを一切進めないので、控えても抽出結果は変わらない
      this._noteCheckpoint();
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
    // YM2608内蔵リズムROM: Worker実行時はlocalStorageが無いのでopt経由で受け取る
    // (main.jsがlocalStorageから復元してoptへ入れる。無ければリズムのみ無音)
    if (opt.ym2608RhythmRom && Emu.setYm2608RhythmRom) Emu.setYm2608RhythmRom(opt.ym2608RhythmRom);
    const player = new VgmPlayer(vgmBytes);
    const h = player.header;
    const durationSeconds = opt.durationSeconds || Math.max(1, h.durationSeconds || 30);
    const totalFrames = Math.max(1, Math.ceil(durationSeconds * FRAME_RATE));
    const has = (id) => !!player.adapterById[id];
    const data = {
      frameRate: FRAME_RATE, header: h, totalFrames,
      nes: has('nes') ? { regSnapshots: [], writeLog: [], fds: !!player.adapterById.nes.fds } : null,
      gb: has('gb') ? { snapshots: [] } : null,
      // hes: ctlTrace/pitchTrace は hesPlayer.js の controlTrace/pitchTrace と同じ内容だが、
      // Worker差分プロトコル(capture-worker-multi-impl.js diffPayload: 1段ネスト配列まで)に
      // 乗るよう ch別二重配列ではなく {ch,...} 付きの平坦な1本にして積む。vgm2mml/converter.js
      // が ch別に振り分けてから HES2MML.convertCapture へ渡す。用途はソフト音量エンベロープ/
      // ピッチ列の位相エイリアシング対策(hes2mml/expansion/wave.js buildVolTimeline参照)。
      // VGMは書込みごとにサンプル精度の時刻を持つので、HES同様にノート相対時刻で
      // リサンプルできる(これが無いと wave.js は従来のフレーム格子スナップショット列に
      // フォールバックし、駆動レートがフレームレートと合わない曲で@vが1フレーム違いの
      // 変種として量産される)。
      hes: has('huc6280') ? { snapshots: [], ctlTrace: [], pitchTrace: [] } : null,
      // YM2610の内蔵SSG(AY互換)は kss.writeLog へ AY8910書込みとして流し込む(KP1-3行/kss2mml流用)。
      // clock: kss2mml抽出器(AY/SCC)に渡す「Z80相当クロック」(=AY実クロック×2)。MSXの3.58MHz固定では
      // 別クロックのAY(Exed Exes 1.5MHz等)やYM2610内蔵SSG(チップクロック/4)のロール音程がずれる。
      // vgm2mml/converter.js の kssClock と同じ優先順位。
      kss: (has('ay8910') || has('k051649') || has('ym2413') || has('ym2610') || has('ym2203') || has('ym2608') || has('ym3812') || has('ym3526') || has('y8950'))
        ? { writeLog: [], ay: has('ay8910') || has('ym2610') || has('ym2203') || has('ym2608'), scc: has('k051649'), opll: has('ym2413'), sccPlus: !!(player.adapterById.k051649 && player.adapterById.k051649.plus),
            // OPL(YM3812/YM3526/Y8950): 書込みは io 0xC0/0xC1 として同じwriteLogへ流す
            // (KSSのMSX-AUDIOと同じ形。抽出器 Kss2MmlExpansion.opl をKSS/VGMで共有するため)
            opl: has('ym3812') || has('ym3526') || has('y8950'),
            oplClock: has('ym3812') ? player.adapterById.ym3812.clockHz : has('ym3526') ? player.adapterById.ym3526.clockHz
                    : has('y8950') ? player.adapterById.y8950.clockHz : 3579545,
            clock: has('ay8910') ? player.adapterById.ay8910.clockHz : has('ym2610') ? player.adapterById.ym2610.clockHz / 2
                 : has('ym2203') ? player.adapterById.ym2203.fm.ssgTickHz
                 : has('ym2608') ? player.adapterById.ym2608.fm.ssgTickHz
                 : has('k051649') ? player.adapterById.k051649.clockHz : has('ym2413') ? player.adapterById.ym2413.clockHz : 3579545 }
        : null,
      // 2個目のPSG(デュアルAY8910、YM2203/YM2608/YM2610の2個目の内蔵SSG): KSS形式のwriteLogはPSG1個ぶんの
      // ポート(0xA0/0xA1)しか持てないので、2個目は別のwriteLog(kss2)へ同じ形で流す。ロールは KP4-6 行、
      // 変換は ay2:0-2 として同じ抽出器(Kss2MmlExpansion.ay)を使う(2026-09-06)
      kss2: (has('ay8910_2') || has('ym2610_2') || has('ym2203_2') || has('ym2608_2'))
        ? { writeLog: [], ay: true,
            clock: has('ay8910_2') ? player.adapterById.ay8910_2.clockHz : has('ym2610_2') ? player.adapterById.ym2610_2.clockHz / 2
                 : has('ym2203_2') ? player.adapterById.ym2203_2.fm.ssgTickHz
                 : player.adapterById.ym2608_2.fm.ssgTickHz }
        : null,
      sn: has('sn76489') ? { snapshots: [], clock: player.adapterById.sn76489.clockHz } : null,
      ym2612: has('ym2612') ? { snapshots: [] } : null,
      ym2610fm: has('ym2610') ? { snapshots: [] } : null,
      ym2151: has('ym2151') ? { snapshots: [] } : null,
      ym2203fm: has('ym2203') ? { snapshots: [] } : null,
      ym2608fm: has('ym2608') ? { snapshots: [] } : null,
      ga20: has('ga20') ? { snapshots: [] } : null,
      k007232: has('k007232') ? { snapshots: [] } : null,
      k054539: has('k054539') ? { snapshots: [] } : null,
      msm5205: has('msm5205') ? { snapshots: [] } : null,
      // snapshots=物理スロット、logical=割当逆算(ソフトウェアチャンネル合成、
      // Emu.PoolChannelRegrouper)。ペア交互/巡回割当のドライバ対策で両方を常時保持する
      segapcm: has('segapcm') ? { snapshots: [], logical: [] } : null,
      c140: has('c140') ? { snapshots: [], logical: [] } : null,
      c352: has('c352') ? { snapshots: [], logical: [] } : null,
      okim6258: has('okim6258') ? { snapshots: [] } : null,
      qsound: has('qsound') ? { snapshots: [], logical: [] } : null,
      okim6295: has('okim6295') ? { snapshots: [] } : null,
      // multipcm: snapshots=物理スロット(実機のまま)、logical=割当逆算(ソフトウェア
      // チャンネル合成)。チャンネルプール式ドライバ対策で両方を常時保持し、
      // 鍵盤/ロール/変換が表示モードに応じて選ぶ(Emu.PoolChannelRegrouper参照)
      multipcm: has('multipcm') ? { snapshots: [], logical: [] } : null,
      pwm: has('pwm') ? { snapshots: [] } : null,
      rf5c164: has('rf5c164') ? { snapshots: [] } : null,
      rf5c68: has('rf5c68') ? { snapshots: [] } : null
    };
    let nesFrameWrites = [];
    // YM2610 ADPCM のロール用発音区間推定の状態(上のループ内コメント参照)
    const adpcmState = { aSeq: new Array(6).fill(0), aEnd: new Array(6).fill(-1), bSeq: 0, bEnd: -1 };
    // YM2608 リズム/ADPCM-B も同じ推定(スナップショット形状がYM2610と同一)
    const adpcm2608State = { aSeq: new Array(6).fill(0), aEnd: new Array(6).fill(-1), bSeq: 0, bEnd: -1 };
    // GA20 も同じ推定(clock()を回さないと0x00終端で止まらないため、キーオン通番+サンプル長で区間を切る)
    const ga20State = { seq: new Array(4).fill(0), end: new Array(4).fill(-1) };
    // K007232 も同じ推定(終端はROMのbit7マーカーなので、キーオン通番+サンプル長で区間を切る)
    const k007232State = { seq: new Array(2).fill(0), end: new Array(2).fill(-1) };
    // K054539 も同じ推定(終端はROMのマーカーなので、キーオン通番+サンプル長で区間を切る)
    const k054539State = { seq: new Array(16).fill(0), end: new Array(16).fill(-1) };
    // SegaPCM: ワンショットは同じ推定。ループ再生(lenSec=Infinity)は明示停止(reg86書込み)まで鳴る
    const spcmState = { seq: new Array(16).fill(0), end: new Array(16).fill(-1) };
    // C140: 同じ推定(キーオン/オフは明示レジスタなのでエッジは正確。ワンショット終端だけ窓で切る)
    const c140State = { seq: new Array(24).fill(0), end: new Array(24).fill(-1) };
    // C352: 同上(キーオン/オフは0x202トリガで明示。ワンショット終端だけ窓で切る)
    const c352State = { seq: new Array(32).fill(0), end: new Array(32).fill(-1) };
    // QSound: 同上(キーオン/オフは音量/ピッチレジスタで明示。ワンショット終端だけ窓で切る)
    const qsState = { seq: new Array(16).fill(0), end: new Array(16).fill(-1) };
    // OKIM6295: 同上(全ワンショット。停止コマンドは明示、終端だけ窓で切る)
    const okiState = { seq: new Array(4).fill(0), end: new Array(4).fill(-1) };
    // MultiPCM: キーオン/オフは明示(r4)だが、キーオフ無しのワンショット(ドラム)はEGの
    // ディケイで無音化する方式なので、キーオン時のEG可聴時間見積り(lenSec)で窓を切る
    const mpcmState = { seq: new Array(28).fill(0), end: new Array(28).fill(-1) };
    const mpcmRegrouper = data.multipcm ? new Emu.PoolChannelRegrouper(28) : null;
    const spcmRegrouper = data.segapcm ? new Emu.PoolChannelRegrouper(16) : null;
    const c140Regrouper = data.c140 ? new Emu.PoolChannelRegrouper(24) : null;
    const c352Regrouper = data.c352 ? new Emu.PoolChannelRegrouper(32) : null;
    const qsRegrouper = data.qsound ? new Emu.PoolChannelRegrouper(16) : null;
    let kssFrameWrites = [];
    let kss2FrameWrites = []; // 2個目のPSG(data.kss2)
    const nesRegs = {};
    // HuC6280書込みトレース(上の data.hes コメント参照)。t は分数フレーム時刻
    // (hesPlayer.js の currentFrame + frameSamplePos/frameSampleCount と同じ意味)。
    let curFrame = 0;
    // KSS形式 writeLog の各書込みに分数フレーム時刻を詰める(kssPackWrite の frac。kss2mml の AY/SCC 抽出器が
    // 位相エイリアシング対策のリサンプルに使う。hesTraceWrite の t と同じ定義)
    const kpk = (a, v, io) => Emu.kssPackWrite(a, v, io, Math.min(1, Math.max(0, (player.samplePos - curFrame * SAMPLES_PER_FRAME) / SAMPLES_PER_FRAME)));
    let hesSeq = 0;
    const hesApu = data.hes ? player.adapterById.huc6280.apu : null;
    const hesTraceWrite = (aa) => {
      const t = curFrame + Math.min(1, Math.max(0, (player.samplePos - curFrame * SAMPLES_PER_FRAME) / SAMPLES_PER_FRAME));
      const ctl = (ch) => {
        const c = hesApu.ch[ch];
        data.hes.ctlTrace.push({ ch, frame: curFrame, t, seq: hesSeq++, on: c.on, dda: c.dda, vol: c.volume, bal: c.balance, gbal: hesApu.balance });
      };
      switch (aa) {
        case 0x01: for (let ch = 0; ch < Emu.APUHuC6280_CH_COUNT; ch++) ctl(ch); break; // 全体バランス=全chの実効音量が変わる
        case 0x04: case 0x05: if (hesApu.selected < Emu.APUHuC6280_CH_COUNT) ctl(hesApu.selected); break;
        case 0x02: case 0x03:
          if (hesApu.selected < Emu.APUHuC6280_CH_COUNT)
            data.hes.pitchTrace.push({ ch: hesApu.selected, t, freq: hesApu.ch[hesApu.selected].freq });
          break;
      }
    };
    if (data.kss && data.kss.scc && data.kss.sccPlus) {
      // kss2mml/expansion/scc.js のデコーダにSCC+配置(0xB800台)を認識させる前置き書込み
      kssFrameWrites.push(kpk(0xBFFE, 0x20, 0), kpk(0xB000, 0x80, 0));
    }
    // 32X PWM のサンプル書込みをそのまま記録する(2026-09-10、段階3)。PWMは32X側で合成済みの
    // 1本のストリーム(0xB2直書きが主で、開始アドレスのような同定情報が無い)なので、DACストリームの
    // 打点ログ(dacHits)では捕まえられない。ここでは L/R を1サンプルにまとめた12bit値を
    // cycle で±1へ正規化した Int16 として全部持ち(After Burner Complete: 97万書込み≈1MB)、
    // フレームごとの累積本数(frameEnd)と一緒に data.pwmStream として渡す。main.js
    // vgmPwmStreamDrumFor が無音の切れ目でクリップに分け、長いものは DrumHits の分割へ流す
    const pwmRec = data.pwm ? { buf: new Int16Array(1 << 16), n: 0, pendingL: null, frameEnd: [] } : null;
    const pwmPush = (v) => {
      if (pwmRec.n >= pwmRec.buf.length) { const nb = new Int16Array(pwmRec.buf.length * 2); nb.set(pwmRec.buf); pwmRec.buf = nb; }
      pwmRec.buf[pwmRec.n++] = v;
    };
    const pwmRecWrite = (reg, data12) => {
      const chip = player.adapterById.pwm && player.adapterById.pwm.chip;
      const cyc = chip && chip.cycle > 0 ? chip.cycle : 4095;
      const v = Math.max(-32767, Math.min(32767, Math.round((Math.min(data12, cyc) - cyc / 2) / (cyc / 2) * 32767)));
      switch (reg & 0x0F) {
        case 0x02: if (pwmRec.pendingL != null) pwmPush(pwmRec.pendingL); pwmRec.pendingL = v; break; // L(次のRと対にする)
        case 0x03: if (pwmRec.pendingL != null) { pwmPush((pwmRec.pendingL + v) >> 1); pwmRec.pendingL = null; } else pwmPush(v); break;
        case 0x04: if (pwmRec.pendingL != null) { pwmPush(pwmRec.pendingL); pwmRec.pendingL = null; } pwmPush(v); break; // モノ
        default: break;
      }
    };
    // MSM5205(PC Engine CD ADPCM等)のストリーム記録(2026-09-16)。PWMと同じ「同定情報が
    // 無い1本のストリーム」なので、同じ形(samples + frameEnd)で持って main.js の
    // クリップ分割へ流す。ただしPWMと違い**流れてくるのは生の値ではなく4bit ADPCM**なので、
    // ここで msm5205.js と同じ差分表・同じ減衰付き更新で復号しながら積む
    // (キャプチャは clock() を回さないのでチップ側の signal は進まない。regsOnly でも
    //  書込みだけで再現できるのがストリーミングADPCMの利点)。
    // ★ニブルが来ないフレーム(ドライバが供給を止めている区間)は無音として明示的に0を積む。
    //   そうしないとサンプル列が時間的に詰まってしまい、無音の切れ目でクリップに分けられない。
    const msmRec = data.msm5205 ? { buf: new Int16Array(1 << 16), n: 0, frameEnd: [], signal: 0, step: 0, reset: 0,
                                    inFrame: 0, perFrame: 0 } : null;
    const msmPush = (v) => {
      if (msmRec.n >= msmRec.buf.length) { const nb = new Int16Array(msmRec.buf.length * 2); nb.set(msmRec.buf); msmRec.buf = nb; }
      msmRec.buf[msmRec.n++] = v;
    };
    const msmRecWrite = (reg, val) => {
      const chip = player.adapterById.msm5205 && player.adapterById.msm5205.chip;
      switch (reg & 0x07) {
        case 0: { // リセット: 立ち上がり/立ち下がりで内部状態をクリア(msm5205.js と同じ)
          if (msmRec.reset ^ val) { msmRec.signal = 0; msmRec.step = 0; }
          msmRec.reset = val;
          break;
        }
        case 1: { // データ(1ニブル)。復号して1サンプル積む
          if (msmRec.reset) break;
          let d4 = val & 0x0F;
          if (chip && chip.bitWidth === 3) d4 = (d4 << 1) & 0x0F;
          const diff = Emu.MSM5205_DIFF ? Emu.MSM5205_DIFF[msmRec.step * 16 + d4] : 0;
          msmRec.signal = ((diff << 8) + (msmRec.signal * 245)) >> 8;
          if (msmRec.signal > 2047) msmRec.signal = 2047; else if (msmRec.signal < -2048) msmRec.signal = -2048;
          msmRec.step += Emu.MSM5205_INDEX_SHIFT[d4 & 7];
          if (msmRec.step > 48) msmRec.step = 48; else if (msmRec.step < 0) msmRec.step = 0;
          msmPush(Math.max(-32767, Math.min(32767, msmRec.signal * 16)));
          msmRec.inFrame++;
          break;
        }
        default: break;
      }
    };
    player.onWrite = (id, a, b, c, d) => {
      switch (id) {
        case 'nes': nesFrameWrites.push({ addr: c, value: b }); nesRegs[c] = b; break;
        case 'pwm': if (pwmRec) pwmRecWrite(a, b); break; // (reg, 12bit値)
        case 'msm5205': if (msmRec) msmRecWrite(a, b); break; // (reg, 4bit値)
        case 'ay8910': kssFrameWrites.push(kpk(0xA0, a & 0x0F, 1), kpk(0xA1, b, 1)); break;
        // 2個目のチップ('_2')の内蔵SSG/AYは kss2 へ(1個目と同じ形)
        case 'ay8910_2': kss2FrameWrites.push(kpk(0xA0, a & 0x0F, 1), kpk(0xA1, b, 1)); break;
        case 'ym2610_2': if (a === 0 && b < 0x0E) kss2FrameWrites.push(kpk(0xA0, b & 0x0F, 1), kpk(0xA1, c, 1)); break;
        case 'ym2203_2': if (a < 0x0E) kss2FrameWrites.push(kpk(0xA0, a & 0x0F, 1), kpk(0xA1, b, 1)); break;
        case 'ym2608_2': if (a === 0 && b < 0x0E) kss2FrameWrites.push(kpk(0xA0, b & 0x0F, 1), kpk(0xA1, c, 1)); break;
        // YM2610: (port, addr, data)。port0 addr<0x0E が内蔵SSG(AY互換レジスタ0-13)
        case 'ym2610': if (a === 0 && b < 0x0E) kssFrameWrites.push(kpk(0xA0, b & 0x0F, 1), kpk(0xA1, c, 1)); break;
        // YM2203: (addr, data)。addr<0x0E が内蔵SSG(AY互換レジスタ0-13)
        case 'ym2203': if (a < 0x0E) kssFrameWrites.push(kpk(0xA0, a & 0x0F, 1), kpk(0xA1, b, 1)); break;
        // YM2608: (port, addr, data)。port0 addr<0x0E が内蔵SSG(AY互換レジスタ0-13)
        case 'ym2608': if (a === 0 && b < 0x0E) kssFrameWrites.push(kpk(0xA0, b & 0x0F, 1), kpk(0xA1, c, 1)); break;
        case 'ym2413': kssFrameWrites.push(kpk(0x7C, a, 1), kpk(0x7D, b, 1)); break;
        // OPL系: MSX-AUDIOのポート(0xC0=アドレス/0xC1=データ)としてKSSと同じ形でログする
        case 'ym3812': case 'ym3526': case 'y8950':
          kssFrameWrites.push(kpk(0xC0, a, 1), kpk(0xC1, b, 1)); break;
        case 'k051649': kssFrameWrites.push(kpk(d, c, 0)); break;
        case 'huc6280': hesTraceWrite(a); break; // (reg, value)。書込み適用後に呼ばれるのでAPUの状態をそのまま記録
      }
    };
    // ★2026-08-20 スライスを「フレーム数固定」から「時間予算固定」へ変更(NSFの
    // capture.js captureSongAsyncと同じ方式・同じ理由)。Worker実行時は
    // opt.yieldFn/sliceBudgetMsで上書きされる。
    const sliceBudgetMs = opt.sliceBudgetMs > 0 ? opt.sliceBudgetMs : 5;
    const yieldFn = opt.yieldFn || (() => new Promise(r => setTimeout(r, 0)));
    let sliceStart = performance.now();
    for (let f = 0; f < totalFrames; f++) {
      curFrame = f;
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
      if (data.kss) { data.kss.writeLog.push(Int32Array.from(kssFrameWrites)); kssFrameWrites = []; }
      if (data.kss2) { data.kss2.writeLog.push(Int32Array.from(kss2FrameWrites)); kss2FrameWrites = []; }
      if (data.sn) {
        const s1 = Emu.snapshotSN76489(player.adapterById.sn76489.chip, data.sn.clock);
        const a2 = player.adapterById.sn76489_2;
        data.sn.snapshots.push(a2 ? s1.concat(Emu.snapshotSN76489(a2.chip, a2.clockHz)) : s1);
      }
      if (data.pwm) data.pwm.snapshots.push(Emu.snapshotPWM32X(player.adapterById.pwm.chip));
      if (pwmRec) pwmRec.frameEnd.push(pwmRec.n);
      if (msmRec) {
        // ニブルが来なかったフレームは「そのフレーム分の無音」を積む(上のコメント参照)。
        // 長さは直近の供給レート(1フレームあたりのニブル数)の移動平均。初回は8kHz/60Hz相当。
        if (msmRec.inFrame > 0) msmRec.perFrame = msmRec.perFrame ? (msmRec.perFrame * 7 + msmRec.inFrame) / 8 : msmRec.inFrame;
        else { const pad = Math.max(1, Math.round(msmRec.perFrame || 133)); for (let k = 0; k < pad; k++) msmPush(0); }
        msmRec.inFrame = 0;
        msmRec.frameEnd.push(msmRec.n);
      }
      if (data.rf5c164) data.rf5c164.snapshots.push(Emu.snapshotRF5C164(player.adapterById.rf5c164.chip));
      if (data.rf5c68) data.rf5c68.snapshots.push(Emu.snapshotRF5C164(player.adapterById.rf5c68.chip));
      if (data.ym2612) {
        // 先読みはチップのclock()を回さない(EGが進まない)ので、ロール用の発音判定/音量は
        // レジスタだけから決まる keyOn/tlVol に差し替える(ライブ表示はEG由来のactive/volを使う)
        const s = Emu.snapshotYM2612(player.adapterById.ym2612.chip, SNAP_CAPTURE);
        for (const c of s.channels) { c.active = c.keyOn && c.freq > 0; c.vol = c.tlVol; c.rawVol = Math.round(c.tlVol * 15); }
        data.ym2612.snapshots.push(s);
      }
      if (data.ga20) {
        const s = Emu.snapshotGA20(player.adapterById.ga20.chip);
        const st = ga20State;
        for (let i = 0; i < 4; i++) {
          const c = s[i];
          if (c.seq !== st.seq[i]) { st.seq[i] = c.seq; st.end[i] = f + c.lenSec * FRAME_RATE; }
          // 明示停止(reg6=0)は書込みで play が落ちるので c.active に反映済み。終端は推定窓で切る
          c.active = c.active && f < st.end[i];
        }
        data.ga20.snapshots.push(s);
      }
      if (data.k007232) {
        const s = Emu.snapshotK007232(player.adapterById.k007232.chip);
        const st = k007232State;
        for (let i = 0; i < 2; i++) {
          const c = s[i];
          if (c.seq !== st.seq[i]) { st.seq[i] = c.seq; st.end[i] = f + c.lenSec * FRAME_RATE; }
          // ループ有効(0x0D)のサンプルは終端で止まらないが、ドライバが次のキーオンで
          // 上書きするまで鳴り続けるのが実挙動なので、ワンショットと同じ窓で切る
          c.active = c.active && f < st.end[i];
        }
        data.k007232.snapshots.push(s);
      }
      if (data.msm5205) data.msm5205.snapshots.push(Emu.snapshotMSM5205(player.adapterById.msm5205.chip));
      if (data.k054539) {
        const a2 = player.adapterById.k054539_2;
        // デュアル(サラマンダー2)は2個目を連結して16要素にする。ロール/鍵盤/変換は幅で自動追随する。
        // 2個目の kind を分ける規則は snapshotK054539Dual に置いてある(ライブ側と共有)
        const s = Emu.snapshotK054539Dual(player.adapterById.k054539.chip, a2 ? a2.chip : null);
        const st = k054539State;
        for (let i = 0; i < s.length; i++) {
          const c = s[i];
          if (c.seq !== st.seq[i]) { st.seq[i] = c.seq; st.end[i] = f + c.lenSec * FRAME_RATE; }
          // キーオフは 0x215 で明示されるので c.active に反映済み。ワンショットの終端だけ窓で切る
          c.active = c.active && f < st.end[i];
        }
        data.k054539.snapshots.push(s);
      }
      if (data.segapcm) {
        const s = Emu.snapshotSegaPCM(player.adapterById.segapcm.chip);
        const st = spcmState;
        for (let i = 0; i < 16; i++) {
          const c = s[i];
          if (c.seq !== st.seq[i]) { st.seq[i] = c.seq; st.end[i] = c.lenSec === Infinity ? Infinity : f + c.lenSec * FRAME_RATE; }
          c.active = c.active && f < st.end[i];
        }
        data.segapcm.snapshots.push(s);
        data.segapcm.logical.push(spcmRegrouper.step(s));
      }
      if (data.c140) {
        const s = Emu.snapshotC140(player.adapterById.c140.chip);
        const st = c140State;
        for (let i = 0; i < 24; i++) {
          const c = s[i];
          if (c.seq !== st.seq[i]) { st.seq[i] = c.seq; st.end[i] = c.lenSec === Infinity ? Infinity : f + c.lenSec * FRAME_RATE; }
          c.active = c.active && f < st.end[i];
        }
        data.c140.snapshots.push(s);
        data.c140.logical.push(c140Regrouper.step(s));
      }
      if (data.c352) {
        const s = Emu.snapshotC352(player.adapterById.c352.chip);
        const st = c352State;
        for (let i = 0; i < 32; i++) {
          const c = s[i];
          if (c.seq !== st.seq[i]) { st.seq[i] = c.seq; st.end[i] = c.lenSec === Infinity ? Infinity : f + c.lenSec * FRAME_RATE; }
          c.active = c.active && f < st.end[i];
        }
        data.c352.snapshots.push(s);
        data.c352.logical.push(c352Regrouper.step(s));
      }
      if (data.qsound) {
        const s = Emu.snapshotQSound(player.adapterById.qsound.chip);
        const st = qsState;
        for (let i = 0; i < 16; i++) {
          const c = s[i];
          if (c.seq !== st.seq[i]) { st.seq[i] = c.seq; st.end[i] = c.lenSec === Infinity ? Infinity : f + c.lenSec * FRAME_RATE; }
          c.active = c.active && f < st.end[i];
        }
        data.qsound.snapshots.push(s);
        data.qsound.logical.push(qsRegrouper.step(s));
      }
      if (data.multipcm) {
        const s = Emu.snapshotMultiPCM(player.adapterById.multipcm.chip);
        const st = mpcmState;
        for (let i = 0; i < 28; i++) {
          const c = s[i];
          if (c.seq !== st.seq[i]) { st.seq[i] = c.seq; st.end[i] = c.lenSec === Infinity ? Infinity : f + c.lenSec * FRAME_RATE; }
          c.active = c.active && f < st.end[i];
        }
        data.multipcm.snapshots.push(s);
        data.multipcm.logical.push(mpcmRegrouper.step(s));
      }
      if (data.okim6295) {
        const s = Emu.snapshotOKIM6295(player.adapterById.okim6295.chip);
        const st = okiState;
        for (let i = 0; i < 4; i++) {
          const c = s[i];
          if (c.seq !== st.seq[i]) { st.seq[i] = c.seq; st.end[i] = f + c.lenSec * FRAME_RATE; }
          c.active = c.active && f < st.end[i];
        }
        data.okim6295.snapshots.push(s);
      }
      // OKIM6258: 再生/停止が制御レジスタ書込みで明示されるので推定不要(activeは正確)。
      // 音程情報は無い(ストリーミングADPCM)のでロールはDMC式の疑似ノート表示のみ。
      if (data.okim6258) data.okim6258.snapshots.push(Emu.snapshotOKIM6258(player.adapterById.okim6258.chip));
      if (data.ym2151) {
        // YM2612と同じ: 先読みはEGが進まないので発音判定/音量はレジスタ由来(keyOn/tlVol)へ差し替える
        const s = Emu.snapshotYM2151(player.adapterById.ym2151.chip, SNAP_CAPTURE);
        for (const c of s.channels) { c.active = c.keyOn && c.freq > 0; c.vol = c.tlVol; c.rawVol = Math.round(c.tlVol * 15); }
        data.ym2151.snapshots.push(s);
      }
      if (data.ym2203fm) {
        // YM2612と同じ: 先読みはEGが進まないので発音判定/音量はレジスタ由来(keyOn/tlVol)へ差し替える
        const s = Emu.snapshotYM2203(player.adapterById.ym2203.fm, SNAP_CAPTURE);
        // デュアルチップ(Avengers等): ライブ表示(main.js getYm2203Fm)と同じく ym2203_2 のFM3chを後ろに足す
        // (OP4-6行)。★ここに無いとロールと変換だけ2個目が空になる(鍵盤の行はライブで出るので気付きにくい)
        const a2 = player.adapterById.ym2203_2;
        if (a2) {
          s.channels = s.channels.concat(Emu.snapshotYM2203(a2.fm, SNAP_CAPTURE).channels);
          if (data.kss2) data.kss2.clock = a2.fm.ssgTickHz; // 2個目のプリスケーラも追随
        }
        for (const c of s.channels) { c.active = c.keyOn && c.freq > 0; c.vol = c.tlVol; c.rawVol = Math.round(c.tlVol * 15); }
        data.ym2203fm.snapshots.push(s);
        // プリスケーラでSSG実クロックが変わる(Avengersは1/3=SSG実クロック2倍)ため、
        // ロール/変換が読むkss.clockを毎フレーム追随させる(通常は曲頭の1回で確定する)
        if (data.kss && !player.adapterById.ay8910 && !player.adapterById.ym2610) {
          data.kss.clock = player.adapterById.ym2203.fm.ssgTickHz;
        }
      }
      if (data.ym2608fm) {
        // YM2610と同じ: FMはkeyOn/tlVolへ差し替え、リズム/ADPCM-Bはキーオン通番+サンプル長で
        // 発音区間を推定(clock()を回さないため)
        const s = Emu.snapshotYM2608(player.adapterById.ym2608.fm, SNAP_CAPTURE);
        for (const c of s.channels) { c.active = c.keyOn && c.freq > 0; c.vol = c.tlVol; c.rawVol = Math.round(c.tlVol * 15); }
        const st8 = adpcm2608State;
        for (let i = 0; i < 6; i++) {
          const c = s.adpcmA[i];
          if (c.seq !== st8.aSeq[i]) { st8.aSeq[i] = c.seq; st8.aEnd[i] = f + c.lenSec * FRAME_RATE; }
          c.active = c.vol > 0 && f < st8.aEnd[i];
        }
        {
          const c = s.adpcmB;
          if (c.seq !== st8.bSeq) { st8.bSeq = c.seq; st8.bEnd = f + c.lenSec * FRAME_RATE; }
          if (!c.executing) st8.bEnd = -1;
          c.active = c.vol > 0 && f < st8.bEnd;
        }
        data.ym2608fm.snapshots.push(s);
        // プリスケーラでSSG実クロックが変わりうるため、ロール/変換が読むclockを追随させる
        if (data.kss && !player.adapterById.ay8910 && !player.adapterById.ym2610 && !player.adapterById.ym2203) {
          data.kss.clock = player.adapterById.ym2608.fm.ssgTickHz;
        }
      }
      if (data.ym2610fm) {
        const s = Emu.snapshotYM2610(player.adapterById.ym2610.fm, SNAP_CAPTURE);
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
      if (f === 0 || performance.now() - sliceStart >= sliceBudgetMs) {
        if (onProgress) onProgress(f, totalFrames, data);
        await yieldFn();
        if (opt.shouldCancel && opt.shouldCancel()) return data;
        sliceStart = performance.now();
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
    collectUsedSamples(data, player);
    collectDacHits(data, player, FRAME_RATE);
    // 32X PWM のサンプル列(上の pwmRec)。dacpcm と同じ理由でオブジェクトに1段包む
    if (pwmRec && pwmRec.n > 0) {
      if (pwmRec.pendingL != null) pwmPush(pwmRec.pendingL);
      data.pwmStream = { log: { samples: pwmRec.buf.slice(0, pwmRec.n), frameEnd: Uint32Array.from(pwmRec.frameEnd),
                                rate: pwmRec.n / Math.max(1, totalFrames) * FRAME_RATE } };
    }
    // MSM5205 のサンプル列(上の msmRec)。PWMと同じ形なので main.js 側は同じ分割器を使う
    if (msmRec && msmRec.n > 0) {
      data.msm5205Stream = { log: { samples: msmRec.buf.slice(0, msmRec.n), frameEnd: Uint32Array.from(msmRec.frameEnd),
                                    rate: msmRec.n / Math.max(1, totalFrames) * FRAME_RATE } };
    }
    // シーク用チェックポイント(未到達位置への初回シークを速くする)。dacpcmと同じ理由で
    // オブジェクトに1段包む(キャプチャ完了後に足すプロパティは finalMeta でしか届かず、
    // 配列のまま置くと丸ごと落ちる。capture-worker-multi-impl.js diffPayload)
    const seek = player.serializeSeekData();
    if (seek) data.vgmSeek = { all: seek };
    return data;
  };

  // ── ストリーミングDACの打点(ログ由来)を取り出す(2026-09-04) ──────────────
  // YM2612のDAC/32X PWM/OKIM6258は「鳴っている音」から打点を推測すると、同じ太鼓が
  // 切り出し長・音量・直前の状態の違いで別物に割れてしまう(OutRunners実測: 51打点=35種)。
  // VGMログは「どこから流し始めたか」を持っているので、その開始アドレスをそのまま
  // サンプル同定に使う(C140などの sample.start と同じ意味論)。実測では
  // 「02 - Mega Driver」の実ドラムは8種類・各5〜23回で、レートも約5kHzで一定。
  const DAC_IDLE_RANGE = 8;   // バイトの振れ幅がこれ以下なら無音(DACレベル書き込みだけ)
  const DAC_MIN_BYTES = 48;   // これ未満は打点として短すぎる(可聴でない繋ぎ)
  function collectDacHits(data, player, frameRate) {
    const hits = player.getDacHits ? player.getDacHits() : [];
    if (!hits.length) return;
    const banks = {};
    const out = [];
    for (const h of hits) {
      if (!(h.bytes >= DAC_MIN_BYTES)) continue;
      const bank = player.dataBanks[h.bankType];
      if (!bank || !bank.data) continue;
      const end = Math.min(bank.data.length, h.start + h.bytes);
      if (end - h.start < DAC_MIN_BYTES) continue;
      // 無音判定: その区間のバイトがほぼ一定なら、DACを黙らせているだけ(bank[0..]=0x80 等)
      let mn = 255, mx = 0;
      for (let i = h.start; i < end; i++) { const v = bank.data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      if (mx - mn <= DAC_IDLE_RANGE) continue;
      // 再生レート: ストリーム経路は freq が正、0x8n経路は「バイト数÷経過VGMサンプル」で実測する
      const dur = Math.max(1, h.endSample - h.startSample);
      const rate = h.rate > 0 ? h.rate : (h.bytes / dur * 44100);
      if (!(rate > 0)) continue;
      out.push({ chip: h.chip, bankType: h.bankType, start: h.start, bytes: end - h.start,
                 stepSize: h.stepSize || 1, rate,
                 startFrame: Math.round(h.startSample / 44100 * frameRate),
                 endFrame: Math.max(1, Math.round((h.startSample + dur) / 44100 * frameRate)) });
      if (!banks[h.bankType]) banks[h.bankType] = bank.data;
    }
    // ★Worker経路の都合でオブジェクトに1段包む: 進行中の差分送信は「配列=増分/オブジェクト=丸ごと」
    //   だが、キャプチャ完了後に足したものは finalMeta(非配列プロパティ)でしか届かない
    //   (src/audio/capture-worker-multi-impl.js diffPayload)。打点リストは完了後に作るので、
    //   配列のまま置くと丸ごと落ちる。collectUsedSamples の samples が object なのと同じ理屈。
    if (out.length) data.dacpcm = { log: { hits: out, banks } };
  }

  // ── 使われたサンプルの実PCMを取り出す(dpcmRomと同じ「最後に一度だけ」の考え方) ──
  // サンプルROMはチップ側にしか無く、キャプチャはWorkerで走るうえ関数はpostMessageを
  // 越えられないので、キャプチャの最後に「実際にキーオンされたサンプルだけ」をデコードして
  // 実データとして持たせる。vgm2mmlのドラム→@DPCM変換(打点の合成)がこれを使う。
  // 実測: 1曲あたり5〜13種・ROM生バイトで14〜252KB程度しか使われないので全部持ってよい。
  const USED_SAMPLE_MAX_TOTAL = 16 * 1024 * 1024; // デコード後の合計サンプル数の上限(安全弁)
  function collectUsedSamples(data, player) {
    // [dataのキー, スナップショットからチャンネル配列を取り出す関数, adapterId]
    const SRC = [
      ['ga20', (s) => s, 'ga20'], ['k007232', (s) => s, 'k007232'], ['k054539', (s) => s, 'k054539'],
      ['segapcm', (s) => s, 'segapcm'],
      ['c140', (s) => s, 'c140'], ['c352', (s) => s, 'c352'],
      ['qsound', (s) => s, 'qsound'], ['okim6295', (s) => s, 'okim6295'],
      ['multipcm', (s) => s, 'multipcm'],
      // ★YM2610/YM2608のアダプタはチップを .chip ではなく .fm で持つ(SSGと2個持ちのため)
      ['ym2610fm', (s) => (s && s.adpcmA ? s.adpcmA.concat(s.adpcmB ? [s.adpcmB] : []) : null), 'ym2610', (a) => a.fm],
      ['ym2608fm', (s) => (s && s.adpcmA ? s.adpcmA.concat(s.adpcmB ? [s.adpcmB] : []) : null), 'ym2608', (a) => a.fm],
    ];
    let total = 0;
    for (const [key, chansOf, adapterId, chipOf] of SRC) {
      const entry = data[key];
      const adapter = player.adapterById[adapterId];
      const chip = adapter && (chipOf ? chipOf(adapter) : adapter.chip);
      if (!entry || !entry.snapshots || !chip || !chip.samplePcm) continue;
      const adapter2 = player.adapterById[adapterId + '_2'];
      const chip2 = adapter2 && (chipOf ? chipOf(adapter2) : adapter2.chip);
      const seen = new Map(); // 'kind:start:end' → sample
      for (const fr of entry.snapshots) {
        const chans = chansOf(fr);
        if (!chans) continue;
        for (const c of chans) {
          if (!c || !c.sample) continue;
          // デュアルチップの2個目は kind が 'k054539#2' なのでキーは自然に分かれる(上記)
          const k = c.sample.kind + ':' + c.sample.start + ':' + c.sample.end;
          if (!seen.has(k)) seen.set(k, c.sample);
        }
      }
      if (!seen.size) continue;
      const out = {};
      for (const [k, sample] of seen) {
        if (total >= USED_SAMPLE_MAX_TOTAL) break;
        let pcm = null;
        const src = (sample.chip2 && chip2) ? chip2 : chip;
        try { pcm = src.samplePcm(sample); } catch (e) { pcm = null; }
        if (!pcm || !pcm.length) continue;
        total += pcm.length;
        out[k] = pcm;
      }
      entry.samples = out;
    }
  }

  Emu.VgmPlayer = VgmPlayer;
  Emu.VGM_FRAME_RATE = FRAME_RATE;
  Emu.VGM_CHIP_GAIN = CHIP_GAIN;
})(window);
