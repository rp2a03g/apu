/*
 * Capcom QSound (DL-1425) 16ch PCM 音源 (VGM: chip 'qsound'。CPS1ダッシュ/CPS2。
 * Cadillacs and Dinosaurs / Street Fighter II' / Super SF2 / ヴァンパイア等)
 * MML.Emu.QSoundAudio
 *
 * 実体はDSP16A上のプログラムだが、本実装は旧MAME/VGMPlayのHLE(qsound.c)準拠の
 * 「8bit符号付きPCM×16ch+平方根パン」再現(エコー/フィルタ/SE用ADPCM 3chは未実装。
 * 音楽再生に使われるのは16ch PCMで、VGMPlayも長年このHLEを既定にしていた)。
 *   サンプルレート = clock/166(VGMヘッダ0xB4=4MHz → 24096Hz)
 *   レジスタ(VGMコマンド 0xC4 mm ll rr: 値=mmll 16bit、レジスタ=rr):
 *     0x00-0x7F: chレジスタ(ch=rr>>3, r=rr&7)
 *       r0=バンク(**ch+1に効く**=実機の変な仕様。(値&0x7F)<<16がROMオフセット)
 *       r1=開始(=現在アドレス直書き。ラッチ無し。**音量>0なら書込み=キーオン/リトリガ**)
 *       r2=ピッチ(値*16を16.16アカムへ加算=再生レート rate*値/4096 バイト/秒。
 *          **0は一時停止**=DSPは進行が止まるだけでキーオフではない) r3=不明(ドライバは
 *          開始と同値を書く=DSPのアドレス小数部か) r4=ループ長(終端からの距離。
 *          0=ワンショット) r5=終端(排他) r6=音量(0でキーオフ、非0書込みで未発音ならキーオン)
 *   ★キーオン規則は旧MAME HLEの「音量エッジのみ」から拡張済み: CPS2実ドライバは
 *     r2=0→r1→r3→r6→r2 の手順で音量エッジを作らず、ワンショット終端後はr1だけで再開する
 *     (Night Warriors実測。旧規則のままだと音が永久に消えるchが出る)。
 *     0x80-0x8F: chパン(値0x0110-0x0130、0x0120=中央。表=√則 pan_table[i]=256/√32*√i)
 *     0x93/0xBA-0xC9等: エコー/不明(無視)
 *   アドレスはバンク内16bitで**ラップ**する(バンクまたぎは無い)。終端でループ長>0なら
 *   address -= loop(ループ区間=[end-loop, end))、0ならキーオフ。
 * VGM: ROMはデータブロック0x8F(ROMサイズ+開始+データ)。デュアルは実機に存在しないので非対応。
 *
 * ★ピッチはC352と同じく Emu.SamplePitchUtil + ループ区間タイル・フォールバック
 * (短い一発+単一周期ループのシンセ波形方式に対応)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 16;

  // 平方根パン表(旧MAME): pan_table[0..32] = 256/√32 * √i
  const PAN_TBL = new Int32Array(33);
  for (let i = 0; i <= 32; i++) PAN_TBL[i] = Math.floor(256 / Math.sqrt(32) * Math.sqrt(i));

  // ループ区間の基本周期推定は Emu.SamplePitchUtil.loopCps へ共有化済み(ym2610.js。
  // このチップで実証した「ループ因数分解方式」。MultiPCM等の他ループ型PCMも使う)
  const qsoundLoopCps = (one) => Emu.SamplePitchUtil.loopCps(one);

  class QSoundAudio {
    /** @param {number} [clock=4000000] - クロック(サンプルレート=clock/166) */
    constructor(clock) {
      this.clockHz = clock || 4000000;
      this.cyclesPerSample = 166;
      this.sampleRate = this.clockHz / 166; // 4MHz → 24096Hz
      this.rom = null;
      this.mute = new Array(NUM_CH).fill(false);
      this.vol = new Array(NUM_CH).fill(1);
      this._pitchCache = new Map(); // 'start:end' → {cps, conf, …}
      this.reset();
    }
    reset() {
      this.ch = [];
      // key: 発音中 / bank: ROMオフセット / addr: 現在アドレス(16bit+ラップ) / frac: 16bit小数
      // seq: キーオン通番 / smpStart/End/Loop: ピッチ解析用の絶対アドレス(キーオン時ラッチ)
      for (let i = 0; i < NUM_CH; i++) this.ch.push({
        key: false, bank: 0, addr: 0, frac: 0, pitch: 0, loop: 0, end: 0, chVol: 0,
        lvol: PAN_TBL[16], rvol: PAN_TBL[16], pan: 0x120,
        seq: 0, smpStart: 0, smpEnd: 0, smpLoop: 0 });
      this.cyc = 0;
      this.lastL = 0; this.lastR = 0;
    }

    /** VGMデータブロック 0x8F(QSound ROM)。 */
    loadRom(romSize, start, data) {
      let rom = this.rom;
      const need = Math.max(romSize >>> 0, start + data.length);
      if (!rom || rom.length < need) { const n = new Uint8Array(need); if (rom) n.set(rom, 0); rom = this.rom = n; }
      rom.set(data, start);
      this._pitchCache.clear();
    }

    // キーオン時のサンプル同定(ピッチ解析用)
    _latchSample(c) {
      c.smpStart = c.bank + (c.addr & 0xFFFF);
      c.smpEnd = c.bank + c.end; // endは排他(address>=endで終端処理、endのバイトは鳴らない)
      // ループ区間=[end-loop, end)。範囲外/ワンショットは0
      c.smpLoop = (c.loop > 0 && c.loop <= c.end) ? c.bank + c.end - c.loop : 0;
      if (!(c.smpEnd > c.smpStart)) { c.smpEnd = c.smpStart; c.smpLoop = 0; }
    }

    /** レジスタ書込み(VGM 0xC4 値16bit → レジスタrr) */
    write(reg, val) {
      reg &= 0xFF; val &= 0xFFFF;
      if (reg < 0x80) {
        let i = reg >> 3;
        const r = reg & 7;
        const c0 = this.ch[i];
        switch (r) {
          case 0: // バンク(実機仕様: 次のチャンネルに効く)
            this.ch[(i + 1) & 0x0F].bank = (val & 0x7F) << 16;
            break;
          case 1: // 開始=現在アドレス直書き(DSPにキーフラグは無く、アドレス書込み=新音開始)。
            // ★旧MAME HLEの「音量0→非0エッジのみキーオン」だとCPS2ドライバの実手順
            // (r2=0→r1→r3→r6→r2、音量エッジ無し)や「ワンショット終端後にr1だけで再開」を
            // 取りこぼして音が永久に消える(Night Warriors PHOBOSステージch2で79回実測)。
            // 音量が生きていればアドレス書込みで常にキーオン(リトリガ)する。
            c0.addr = val;
            if (c0.chVol > 0) { c0.key = true; c0.frac = 0; c0.seq++; this._latchSample(c0); }
            break;
          case 2: // ピッチ。★0はキーオフではなく**一時停止**(DSPは進行が止まるだけ。
            // 0でkeyを殺すと、ピッチだけでビブラート/再開を書くドライバ(Night Warriors
            // DONOVANステージch7/8実測)がkey=falseのまま置き去りになり音が消える)
            c0.pitch = val;
            break;
          case 4: c0.loop = val; break;
          case 5: c0.end = val; break;
          case 6: // 音量(0でキーオフ、0→非0でキーオン)
            if (!val) c0.key = false;
            else if (!c0.key) {
              c0.key = true; c0.frac = 0;
              c0.seq++;
              this._latchSample(c0);
            }
            c0.chVol = val;
            break;
          // r3/r7: 不明/未使用
        }
        return;
      }
      if (reg < 0x90) { // パン(0x0110-0x0130、0x120=中央)
        const c = this.ch[reg - 0x80];
        let p = (val - 0x10) & 0x3F;
        if (p > 32) p = 32;
        c.rvol = PAN_TBL[p];
        c.lvol = PAN_TBL[32 - p];
        c.pan = val;
        return;
      }
      // 0x93(エコーfeedback)/0xBA-0xC9(エコー系)/その他: 未実装(無視)
    }

    // 再生レート(1秒あたりのROMバイト数)。ピッチ値0x1000=等速(チップレート)
    playRate(i) { return this.ch[i].pitch / 4096 * this.sampleRate; }

    _calcSample() {
      let l = 0, r = 0;
      const rom = this.rom;
      if (rom) {
        for (let i = 0; i < NUM_CH; i++) {
          const c = this.ch[i];
          if (!c.key || !c.pitch) continue; // pitch=0は一時停止(進行せず無音)
          // 16.16アカム(旧MAME: offset += pitch*16; address += offset>>16)
          c.frac += c.pitch << 4;
          c.addr += c.frac >> 16;
          c.frac &= 0xFFFF;
          if (c.addr >= c.end) {
            if (c.loop) {
              c.addr -= c.loop;
              if (c.addr >= c.end) c.addr = c.end - c.loop; // 飛び越え保険(VGMPlay準拠)
              c.addr &= 0xFFFF;
            } else { c.key = false; continue; }
          }
          if (this.mute[i]) continue;
          const s = (rom[c.bank + (c.addr & 0xFFFF)] << 24) >> 24; // 8bit符号付き
          // 旧MAME: out += sample * lvol(0-256) * vol(16bit) >> 14 → ±32767級へ正規化
          const g = c.chVol * this.vol[i];
          l += (s * c.lvol * g) / 16384;
          r += (s * c.rvol * g) / 16384;
        }
      }
      // 1chフルスケール(vol=0x2000, パン端=256) ≒ 127*256*8192>>14 = 16256。16ch合算を±1.0程度へ
      this.lastL = l / (32768 * 2);
      this.lastR = r / (32768 * 2);
    }

    clock() {
      if (++this.cyc < this.cyclesPerSample) return;
      this.cyc = 0;
      this._calcSample();
    }
    mixSample() { return { left: this.lastL, right: this.lastR }; }

    /** サンプル基本周期解析(キャッシュ)。c352と同じ設計+ループ区間タイル・フォールバック。
     *  QSoundは8bit符号付き固定なのでμ-law切替は無い。 */
    samplePitch(kind, start, end, loop) {
      if (start === undefined || end === undefined || !(end > start) || !this.rom) return null;
      const key = start + ':' + end;
      let r = this._pitchCache.get(key);
      if (r) return r;
      const U = Emu.SamplePitchUtil;
      const pcm = this._decodeSample(start, end);
      let auto = U.detectCps(pcm);
      let wavePcm = pcm;
      if (auto.conf < 0.5 && loop && loop >= start && loop < end) {
        // ループ因数分解方式: ハードウェアループは継ぎ目なく繋がる=**ループ長は基本周期の整数倍**。
        // k周期仮説(lag=L/k)ごとに巡回自己相関を測り、高相関の最大kを基本周期に採る。
        // ★汎用detectCpsのタイル再解析は探索上限(PITCH_MAX_LAG=800)があり、CPS2のベース
        // (Night Warriors実測: ループ2941バイト=3周期、周期981サンプル)を検出できない。
        // ループ長という既知の構造を使えば上限なしで正確に取れる。
        const loopLen = end - loop;
        if (loopLen >= 16 && loopLen <= 16384) {
          const one = this._decodeSample(loop, end);
          const r2 = qsoundLoopCps(one);
          if (r2) { auto = r2; wavePcm = one; }
        }
      }
      r = { cps: auto.cps, conf: auto.conf, cpsAuto: auto.cps, confAuto: auto.conf, manual: false,
        hash: U.sampleHash(this.rom, start, Math.min(end, start + pcm.length)), wave: null, lenBytes: pcm.length };
      const t = U.getTuningMap()[r.hash];
      if (t !== undefined && t > 0) { r.cps = t; r.conf = 1; r.manual = true; }
      r.wave = U.makeSampleWave(wavePcm, r.conf >= 0.5 ? r.cps : 0);
      // 打楽器/音階の手動上書きをconfへ反映(Emu.SamplePitchUtil。ロール/鍵盤/変換の
      // 4箇所がこの1点で追随する)。キャッシュへ入れる前に適用する
      Emu.SamplePitchUtil.applyKindOverride(r);
      this._pitchCache.set(key, r);
      return r;
    }
    _decodeSample(start, end) {
      const rom = this.rom;
      const MAX_BYTES = 64 * 1024;
      const e = Math.min(end, start + MAX_BYTES, rom.length);
      const n = Math.max(0, e - start);
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = ((rom[start + i] << 24) >> 24) / 128;
      return pcm;
    }

    /**
     * スナップショットの sample({kind,start,end}) → デコード済みPCM(Float32Array、-1..1)。
     * vgm2mmlのドラム→@DPCM変換が実サンプルを必要とするための公開口。
     * ROMはこのチップ(=キャプチャWorker側)にしか無く、関数はpostMessageを越えられないので、
     * キャプチャの最後にここを呼んで実データだけをメインスレッドへ渡す
     * (src/emulator/vgmPlayer.js の collectUsedSamples 参照)。
     */
    /**
     * 打楽器/音階の手動上書き。kind: 'drum' | 'pitch' | null(=自動へ戻す)。
     * ピッチ解析の信頼度(conf)による自動判定が外れた曲を、ユーザーが耳で直すための口。
     * 指定はサンプル内容のハッシュをキーに localStorage へ入る(setSampleTuningと同じ流儀。
     * ROMアドレスと違い、同じ音なら別のゲーム/リビジョンでも効く)。
     * ★confへの反映は Emu.SamplePitchUtil.applyKindOverride が samplePitch() の中で行うので、
     *   ロールのドラム区画・鍵盤のnote列・vgm2mmlのドラムパート・DPCM変換が自動的に追随する。
     */
    setSampleKind(sample, kind) {
      if (!sample) return null;
      const r = this.samplePitch(sample.kind, sample.start, sample.end);
      if (!r || !r.hash) return null;
      Emu.SamplePitchUtil.setKindOverride(r.hash, kind);
      // 「音階として扱う」を選んでも、周期がまったく検出できていない(cps=0)サンプルは
      // 使える音程が無い。呼び出し側へ知らせて基準音の手動補正を促す(黙って無視しない)
      const needsTuning = kind === 'pitch' && !(r.cps > 0);
      this._pitchCache.delete(sample.start + ':' + sample.end); // 次回参照で上書きを反映し直す
      return { kind: kind || null, needsTuning: needsTuning };
    }

    samplePcm(sample) {
      if (!sample) return null;
      return this._decodeSample(sample.start, sample.end);
    }

    /** 手動ピッチ補正(表示専用)。c352等と同じlocalStorage永続化。 */
    setSampleTuning(kind, start, end, cps) {
      const r = this.samplePitch(kind, start, end);
      if (!r) return null;
      const U = Emu.SamplePitchUtil;
      const map = U.getTuningMap();
      if (cps && cps > 0) { map[r.hash] = cps; r.cps = cps; r.conf = 1; r.manual = true; }
      else { delete map[r.hash]; r.cps = r.cpsAuto; r.conf = r.confAuto; r.manual = false; }
      U.saveTuningMap(map);
      r.wave = U.makeSampleWave(this._decodeSample(start, end), r.conf >= 0.5 ? r.cps : 0);
      return r;
    }
  }

  // 鍵盤表示用スナップショット(C352と同じ形の配列16要素)。
  // 音量はCadillacs実測で最大0x9D5(典型0x1D6-0x7C8)の16bit値。0x1000を表示フルスケールとする。
  Emu.snapshotQSound = function (chip) {
    const out = [];
    for (let i = 0; i < NUM_CH; i++) {
      const c = chip.ch[i];
      const rate = chip.playRate(i);
      const vol = Math.min(1, c.chVol / 0x1000);
      const p = c.seq ? chip.samplePitch('qsound', c.smpStart, c.smpEnd, c.smpLoop) : null;
      const lenBytes = p ? p.lenBytes : Math.max(0, c.smpEnd - c.smpStart);
      const loop = c.loop > 0;
      // ★表示規約(2026-09-17): 音量は**16bitの実レジスタをそのまま**、パンも実レジスタ
      //   (0x0110-0x0130、中央 0x0120)。桁が増えるので行の L/R 列は広げる(lrWide)。
      out.push({ active: c.key && vol > 0 && rate > 0, vol, rawVol: c.chVol, rawVolMax: 0x1000, lrWide: true,
        panReg: c.pan, panCenter: 0x120, panDir: 1, panHex: true,
        rate, seq: c.seq, loop, lenSec: loop ? Infinity : (rate > 0 ? lenBytes / rate : 0),
        pitchHz: p ? p.cps * rate : 0, pitchConf: p ? p.conf : 0, pitchManual: !!(p && p.manual), sampleKind: p ? (p.kindManual || 'auto') : 'auto', sampleHash: p ? p.hash : null,
        waveData: p ? p.wave : null,
        sample: c.seq ? { kind: 'qsound', start: c.smpStart, end: c.smpEnd } : null });
    }
    return out;
  };

  Emu.QSoundAudio = QSoundAudio;
})(window);
