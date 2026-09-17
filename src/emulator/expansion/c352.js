/*
 * Namco C352 32ch PCM 音源 (VGM: chip 'c352'。ナムコ System 11/12/22/Super 22/
 * NB-1/NB-2/ND-1 等。Ridge Racer / Rave Racer / Air Combat 22 / The Outfoxies 等)
 * MML.Emu.C352Audio
 *
 * 8bit符号付き または 8bit μ-law(フラグbit3)のPCM×32ch、4出力(フロントL/R+リアL/R、
 * 本実装はフロント+リアを合算してステレオへ)。挙動は MAME c352.cpp(=superctrの実チップ
 * 解析。libvgm c352.cも同一)準拠:
 *   サンプルレート = clock/divider(dividerはVGMヘッダ0xD6の値×4、0なら288。
 *   System 22: 24.576MHz/288 → 85333Hz)
 *   レジスタは16bitワード、ボイスregs=voice*8+n:
 *     +0 音量フロント(上位=L/下位=R) / +1 音量リア(同) / +2 周波数(16bit。
 *     1出力サンプルごとにcounterへ加算、0x10000溢れで次のROMバイトへ=再生レート
 *     fs*freq/65536 バイト/秒) / +3 フラグ / +4 バンク / +5 開始 / +6 終了 / +7 ループ
 *   フラグ: bit15=BUSY, 14=KEYON, 13=KEYOFF, 11=LOOPHIST, 9/8/7=位相反転(RL/FL/FR。
 *     FRはリアRにも効く=実チップの実測挙動), 6=LDIR(ピンポン進行方向), 5=LINK,
 *     4=ノイズ(LFSR), 3=μ-law, 2=補間オフ, 1=ループ, 0=逆再生(1|2=ピンポンループ)
 *   キーオン/オフはレジスタ0x202への書込みで一括実行(KEYON/KEYOFFフラグの立っている
 *   ボイスへ適用。C140と違い+5書込み即時ではない)。
 *   アドレス: pos=(bank<<16)|start から±1ずつ進み、(pos&0xFFFF)==end で終端処理
 *   (ループ=下位16bitのみ差し替え、LINK+ループ=(start<<16)|loop へ飛ぶ長尺形式)。
 * VGM: コマンド 0xE1 aa bb dd ee(レジスタ=aabb、aaのbit7=デュアル2個目、データ=ddee)、
 * ROMはデータブロック0x92、分周はヘッダ0xD6(値×4)。
 *
 * ★C140/GA20/SegaPCMと同じく周波数レジスタで1サンプルを音階演奏するチップなので、
 * ピッチは Emu.SamplePitchUtil(ym2610.js共有)で得る。補間(FILTERフラグ無し時の線形
 * 補間)は実チップの実装済み機能なのでそのまま掛ける(C140のZOH判断とは別物)。
 * 出力レート85kHz級でZOHイメージも不可聴域のため出力LPFは持たない。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 32;

  // フラグ(MAME c352.cpp)
  const FLG_BUSY = 0x8000, FLG_KEYON = 0x4000, FLG_KEYOFF = 0x2000, FLG_LOOPHIST = 0x0800,
    FLG_PHASERL = 0x0200, FLG_PHASEFL = 0x0100, FLG_PHASEFR = 0x0080, FLG_LDIR = 0x0040,
    FLG_LINK = 0x0020, FLG_NOISE = 0x0010, FLG_MULAW = 0x0008, FLG_FILTER = 0x0004,
    FLG_LOOP = 0x0002, FLG_REVERSE = 0x0001;

  // μ-law展開表(MAME/libvgm準拠=実チップ解析。区分線形の折れ線、上位側は下位の反転)
  // ★この生成ループは MAME c352.cpp と同じ定式(BSD-3-Clause, Copyright R. Belmont, superctr)。THIRD-PARTY-NOTICES.md 参照
  const MULAW_TBL = new Int16Array(256);
  {
    let j = 0;
    for (let i = 0; i < 128; i++) {
      MULAW_TBL[i] = j << 5;
      if (i < 16) j += 1;
      else if (i < 24) j += 2;
      else if (i < 48) j += 4;
      else if (i < 100) j += 8;
      else j += 16;
    }
    for (let i = 128; i < 256; i++) MULAW_TBL[i] = (~MULAW_TBL[i - 128]) & 0xFFE0; // Int16Arrayが符号化
  }

  class C352Audio {
    /**
     * @param {number} [clock=24576000] - マスタークロック
     * @param {number} [divider=288] - 分周(VGMヘッダ0xD6の値×4。サンプルレート=clock/divider)
     */
    constructor(clock, divider) {
      this.clockHz = clock || 24576000;
      this.cyclesPerSample = divider || 288;
      this.baseRate = this.clockHz / this.cyclesPerSample; // System 22: 85333Hz
      this.sampleRate = this.baseRate; // playRate/スナップショットの周波数基準
      this.rom = null;
      this.mute = new Array(NUM_CH).fill(false);
      this.vol = new Array(NUM_CH).fill(1);
      this._pitchCache = new Map(); // 'start:end' → {cps, conf, …}
      this._muFlags = new Map();    // 'start:end' → μ-lawサンプルか(キーオン時に記録、解析のデコード切替用)
      this.reset();
    }
    reset() {
      this.ch = [];
      // seq: キーオン通番(先読みキャプチャ用)。smpStart/End: ピッチ解析用のROM上絶対アドレス
      for (let i = 0; i < NUM_CH; i++) this.ch.push({
        volF: 0, volR: 0, freq: 0, flags: 0, bank: 0, start: 0, end: 0, loop: 0,
        pos: 0, counter: 0, sample: 0, lastSample: 0, seq: 0, smpStart: 0, smpEnd: 0, smpLoop: 0, smpPingPong: false });
      this.random = 0x1234; // ノイズLFSR
      this.cyc = 0;
      this.lastL = 0; this.lastR = 0;
    }

    /** VGMデータブロック 0x92(C352 ROM)。 */
    loadRom(romSize, start, data) {
      let rom = this.rom;
      const need = Math.max(romSize >>> 0, start + data.length);
      if (!rom || rom.length < need) { const n = new Uint8Array(need); if (rom) n.set(rom, 0); rom = this.rom = n; }
      rom.set(data, start);
      this._pitchCache.clear();
    }

    /** レジスタ書込み(VGM 0xE1 aabb ddee、16bitワードアドレス/データ) */
    write(reg, val) {
      reg &= 0x3FF; val &= 0xFFFF;
      if (reg < 0x100) {
        const c = this.ch[reg >> 3];
        switch (reg & 7) {
          case 0: c.volF = val; break;
          case 1: c.volR = val; break;
          case 2: c.freq = val; break;
          case 3: c.flags = val; break;
          case 4: c.bank = val; break;
          case 5: c.start = val; break;
          case 6: c.end = val; break;
          case 7: c.loop = val; break;
        }
        return;
      }
      if (reg !== 0x202) return; // 0x200/0x201(コントロール)は音に影響しないので保持しない
      // キーオン/オフ一括実行
      for (let i = 0; i < NUM_CH; i++) {
        const c = this.ch[i];
        if (c.flags & FLG_KEYON) {
          c.pos = ((c.bank << 16) | c.start) >>> 0;
          c.sample = 0; c.lastSample = 0;
          c.counter = 0xFFFF; // 次のティックで必ず最初のバイトをフェッチ
          c.flags = (c.flags | FLG_BUSY) & ~(FLG_KEYON | FLG_LOOPHIST);
          c.seq++;
          // ピッチ解析用の絶対アドレス範囲。終端比較は pos の下位16bitだけなので、
          // 順再生で end < start のサンプルは**64Kバンク境界をまたいで次バンクで終わる**
          // (Outfoxies「City of Blue」のベース: start=EC24 end=47BC bank=C → 実体は
          // C_EC24..D_47BC。min/max正規化すると全く別領域を解析してしまい conf=0 になる)。
          // 逆再生(REVERSE単独)は start から下って end で停止 = 領域 [end, start]、
          // end > start なら前バンクへまたぐ。ピンポン(LOOP|REVERSE)はLDIR=0で前進開始
          // なので順再生と同じ扱い。
          const B = c.bank << 16;
          if ((c.flags & FLG_REVERSE) && !(c.flags & FLG_LOOP)) {
            c.smpStart = Math.max(0, B + c.end - (c.end > c.start ? 0x10000 : 0));
            c.smpEnd = B + c.start + 1; // startのバイトから読まれる(inclusive)
          } else {
            c.smpStart = B + c.start;
            c.smpEnd = B + c.end + (c.end < c.start ? 0x10000 : 0) + 1; // endのバイトも読まれる(inclusive)
          }
          // ループ位置(絶対)。MAMEの終端処理は pos = (pos & 0xFF0000) | loop なので、
          // バンクまたぎサンプルではループは「end到達時のバンク」に落ちる。
          // ピッチ解析のループタイル・フォールバック(samplePitch)用。
          if (c.flags & FLG_LOOP) {
            c.smpLoop = B + (c.end < c.start ? 0x10000 : 0) + c.loop;
            c.smpPingPong = !!(c.flags & FLG_REVERSE);
            if (!(c.smpLoop >= c.smpStart && c.smpLoop < c.smpEnd)) c.smpLoop = 0; // 範囲外(LINK等)は使わない
          } else { c.smpLoop = 0; c.smpPingPong = false; }
        } else if (c.flags & FLG_KEYOFF) {
          c.flags &= ~(FLG_BUSY | FLG_KEYOFF);
          c.counter = 0xFFFF;
        }
      }
    }

    // 再生レート(1秒あたりのROMバイト数)
    playRate(i) { return this.ch[i].freq / 65536 * this.sampleRate; }

    _fetch(c) {
      c.lastSample = c.sample;
      if (c.flags & FLG_NOISE) {
        this.random = ((this.random >> 1) ^ ((-(this.random & 1)) & 0xFFF6)) & 0xFFFF;
        c.sample = (this.random << 16) >> 16; // u16→s16
        return;
      }
      const v = this.rom ? (this.rom[c.pos >>> 0] || 0) : 0;
      c.sample = (c.flags & FLG_MULAW) ? MULAW_TBL[v] : (((v << 24) >> 24) << 8);
      const pos16 = c.pos & 0xFFFF;
      if ((c.flags & FLG_LOOP) && (c.flags & FLG_REVERSE)) {
        // ピンポンループ(end↔loop間を往復)
        if ((c.flags & FLG_LDIR) && pos16 === c.loop) c.flags &= ~FLG_LDIR;
        else if (!(c.flags & FLG_LDIR) && pos16 === c.end) c.flags |= FLG_LDIR;
        c.pos = (c.pos + ((c.flags & FLG_LDIR) ? -1 : 1)) >>> 0;
      } else if (pos16 === c.end) {
        if ((c.flags & FLG_LINK) && (c.flags & FLG_LOOP)) {
          c.pos = ((c.start << 16) | c.loop) >>> 0; // 長尺形式: 次の64Kバンクへリンク
          c.flags |= FLG_LOOPHIST;
        } else if (c.flags & FLG_LOOP) {
          c.pos = ((c.pos & 0xFF0000) | c.loop) >>> 0;
          c.flags |= FLG_LOOPHIST;
        } else {
          c.flags = (c.flags | FLG_KEYOFF) & ~FLG_BUSY;
          c.sample = 0;
        }
      } else {
        c.pos = (c.pos + ((c.flags & FLG_REVERSE) ? -1 : 1)) >>> 0;
      }
    }

    _calcSample() {
      let l = 0, r = 0;
      for (let i = 0; i < NUM_CH; i++) {
        const c = this.ch[i];
        if (!(c.flags & FLG_BUSY)) continue;
        const next = c.counter + c.freq;
        if (next & 0x10000) this._fetch(c);
        if ((next ^ c.counter) & 0x18000) c.lastSample = c.sample; // MAME: 桁上がり検出の補間基準更新
        c.counter = next & 0xFFFF;
        if (this.mute[i]) continue;
        // 補間(実チップ実装。FILTERフラグ=補間オフ)
        const s = (c.flags & FLG_FILTER) ? c.sample
          : c.lastSample + c.counter * (c.sample - c.lastSample) / 65536;
        const g = this.vol[i];
        const fl = (c.volF >> 8) & 0xFF, fr = c.volF & 0xFF;
        const rl = (c.volR >> 8) & 0xFF, rr = c.volR & 0xFF;
        const sFL = (c.flags & FLG_PHASEFL) ? -s : s;
        const sRL = (c.flags & FLG_PHASERL) ? -s : s;
        const sR = (c.flags & FLG_PHASEFR) ? -s : s; // FRフラグはフロントR/リアR両方に効く
        l += (sFL * fl + sRL * rl) * g;
        r += (sR * fr + sR * rr) * g;
      }
      // 1chフルスケール ≒ 32767*255(フロント+リア両方フルなら2倍)。32ch合算を±1.0程度へ
      // (C140と同じ正規化。実曲の合算過熱は再生段リミッタ任せ)
      this.lastL = l / (32768 * 255 * 2);
      this.lastR = r / (32768 * 255 * 2);
    }

    clock() {
      if (++this.cyc < this.cyclesPerSample) return;
      this.cyc = 0;
      this._calcSample();
    }
    mixSample() { return { left: this.lastL, right: this.lastR }; }

    /** サンプル(ROM上のstart..end-1)の基本周期解析(キャッシュ)。c140/ga20と同じ設計。
     *  μ-lawかどうかはキーオン時に _muFlags へ記録した値でデコードを切り替える。
     *  ★C352の音階サンプルには「短い一発+末尾の単一周期ループ」のシンセ波形方式が多い
     *  (Rave Racer「Exh Notes」ベース: 全長144バイト+18バイトループ)。この形は自己相関に
     *  必要な繰り返しが範囲内に無く detectCps が落ちるので、失敗時は**ループ区間をタイル状に
     *  繰り返したバッファ**で再解析する(ピンポンループは順+逆で1周期)。 */
    samplePitch(kind, start, end, loop, pingPong) {
      if (start === undefined || end === undefined || !(end > start) || !this.rom) return null;
      // キーはc140と同じ start:end(loopは初回解析の補助情報。手動キャリブレーション
      // (setSampleTuning=loop無し呼び出し)が同じキャッシュエントリを更新できるようにする)
      const key = start + ':' + end;
      let r = this._pitchCache.get(key);
      if (r) return r;
      const U = Emu.SamplePitchUtil;
      const mu = !!this._muFlags.get(start + ':' + end);
      const pcm = this._decodeSample(start, end, mu);
      let auto = U.detectCps(pcm);
      let wavePcm = pcm;
      if (auto.conf < 0.5 && loop && loop >= start && loop < end) {
        const loopLen = end - loop;
        if (loopLen >= 2 && loopLen <= 2048) {
          // ループ区間を4096サンプル以上になるまで繰り返す(ピンポンは往復で1周期)
          const one = this._decodeSample(loop, end, mu);
          const unit = pingPong ? 2 * one.length - 2 : one.length;
          const reps = Math.max(2, Math.ceil(4096 / unit));
          const tiled = new Float32Array(unit * reps);
          for (let rI = 0; rI < reps; rI++) {
            const base = rI * unit;
            tiled.set(one, base);
            if (pingPong) for (let i = 1; i < one.length - 1; i++) tiled[base + one.length - 1 + i] = one[one.length - 1 - i];
          }
          const a2 = U.detectCps(tiled);
          if (a2.conf >= 0.5) { auto = a2; wavePcm = tiled; }
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
    _decodeSample(start, end, mu) {
      const rom = this.rom;
      const MAX_BYTES = 64 * 1024;
      const e = Math.min(end, start + MAX_BYTES, rom.length);
      const n = Math.max(0, e - start);
      if (mu === undefined) mu = !!this._muFlags.get(start + ':' + end);
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = rom[start + i];
        pcm[i] = (mu ? MULAW_TBL[v] : (((v << 24) >> 24) << 8)) / 32768;
      }
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
      const mu = !!this._muFlags.get(sample.start + ':' + sample.end);
      return this._decodeSample(sample.start, sample.end, mu);
    }

    /** 手動ピッチ補正(表示専用)。c140/ga20/ym2610と同じlocalStorage永続化。 */
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

  // 鍵盤表示用スナップショット(C140と同じ形の配列32要素):
  // { active, vol(0-1)、rawVol(4出力の最大0-255)、panL/panR(0-15表示値)、rate、seq、
  //   loop、lenSec(ループ中はInfinity)、pitchHz、pitchConf、pitchManual、waveData、sample、noise }
  Emu.snapshotC352 = function (chip) {
    const out = [];
    for (let i = 0; i < NUM_CH; i++) {
      const c = chip.ch[i];
      const volL = Math.max((c.volF >> 8) & 0xFF, (c.volR >> 8) & 0xFF); // フロント/リアの大きい方
      const volR = Math.max(c.volF & 0xFF, c.volR & 0xFF);
      const vmax = Math.max(volL, volR);
      const rate = chip.playRate(i);
      const noise = !!(c.flags & FLG_NOISE);
      if (c.seq && !noise) chip._muFlags.set(c.smpStart + ':' + c.smpEnd, !!(c.flags & FLG_MULAW));
      const p = (c.seq && !noise) ? chip.samplePitch('c352', c.smpStart, c.smpEnd, c.smpLoop, c.smpPingPong) : null;
      const lenBytes = p ? p.lenBytes : Math.max(0, c.smpEnd - c.smpStart);
      const loop = !!(c.flags & FLG_LOOP); // ピンポン(REVLOOP)もbit1を含む
      // ★表示規約(2026-09-17): C140 と同じく音量列は '—'。L/R は**4出力の実レジスタ**
      //   (フロントL/R + リアL/R、各0-255)。表示側はフロントを主、リアを併記する。
      out.push({ active: !!(c.flags & FLG_BUSY) && vmax > 0 && rate > 0, vol: vmax / 255, rawVol: vmax, rawVolMax: 255, volNone: true,
        panL: (c.volF >> 8) & 0xFF, panR: c.volF & 0xFF,
        rearL: (c.volR >> 8) & 0xFF, rearR: c.volR & 0xFF,
        rate, seq: c.seq, loop, lenSec: loop ? Infinity : (rate > 0 ? lenBytes / rate : 0),
        pitchHz: p ? p.cps * rate : 0, pitchConf: p ? p.conf : 0, pitchManual: !!(p && p.manual), sampleKind: p ? (p.kindManual || 'auto') : 'auto', sampleHash: p ? p.hash : null,
        waveData: p ? p.wave : null,
        sample: (c.seq && !noise) ? { kind: 'c352', start: c.smpStart, end: c.smpEnd } : null,
        noise });
    }
    return out;
  };

  Emu.C352Audio = C352Audio;
})(window);
