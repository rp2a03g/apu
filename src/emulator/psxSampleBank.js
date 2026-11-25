/*
 * PSF(PS1 SPU)のサンプル解析と、鍵盤/ロール/変換向けスナップショット
 * MML.Emu.PsxSampleBank / MML.Emu.snapshotPsx
 *
 * PSF は VGM の PCM チップ(C352/C140 等)と同じ「サンプル再生の音源」なので、
 * 鍵盤表示・ピアノロール・ドラムパッド・MML 変換は VGM の PCM チップ経路をそのまま使う。
 * そのために、キャプチャのフレームスナップショット(psfPlayer.js takeSnapshot の Int32Array)を
 * Emu.snapshotC352 と同じ形のオブジェクト配列(24要素)へ変換する。
 *   { active, vol(0-1), rawVol, rawVolMax, panL, panR(0-15), rate(原サンプル/秒), seq(キーオン通番),
 *     loop, lenSec, pitchHz, pitchConf, pitchManual, sampleKind, sampleHash, waveData,
 *     sample:{kind:'psx', start, end, id}, noise }
 *
 * サンプルの基本周期は Emu.SamplePitchUtil(ym2610.js)で解析し、手動キャリブレーション/
 * 打楽器・音階の上書き(localStorage、サンプル内容ハッシュがキー)も他チップと共有する。
 * ハッシュは SamplePitchUtil.sampleHash を SPU-ADPCM の生バイト列に掛けたもの
 * (ROM を持つチップが ROM の生バイトに掛けるのと同じ考え方)。
 *
 * ★既知の割り切り:
 *  - ピッチ変調(PMON)中のボイスは変調前のピッチレジスタで表示/変換する。
 *  - 同じ SPU RAM 番地へ別内容のサンプルが再転送された場合、sample.start/end(番地)が同じなので
 *    ドラムパッドのキー('psx:<start>')は同じになる(解析とハッシュは内容ごとに別)。
 *
 * DOM 非依存(INV-4)。キャプチャ Worker のロール構築でも使う。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_VOICES = 24;
  const SPU_RATE = 44100;

  class PsxSampleBank {
    /** @param {Array} samples cap.samples(Worker から伸びていく同じ配列でもよい) */
    constructor(samples) {
      this.samples = samples || [];
      this._pitchCache = new Map();   // id → 解析結果
    }

    /** start/end(番地)から一番新しいサンプル番号を引く(手動操作の口は番地しか持たないため) */
    _idOf(start, end) {
      for (let i = this.samples.length - 1; i >= 0; i--) {
        const s = this.samples[i];
        if (s && s.addr === start && s.addr + s.blocks * 16 === end) return i;
      }
      return -1;
    }

    _pcmFloat(s, from, to) {
      const src = s.pcm;
      const a = Math.max(0, from || 0), b = Math.min(src.length, to === undefined ? src.length : to);
      const out = new Float32Array(Math.max(0, b - a));
      for (let i = 0; i < out.length; i++) out[i] = src[a + i] / 32768;
      return out;
    }

    /**
     * サンプルの基本周期(cps=原サンプル1個あたりの周期数)。c352.js samplePitch と同じ設計:
     * 失敗時はループ区間をタイル状に並べて再解析する(短い単一周期ループのシンセ波形対策)。
     * 引数は他チップと同じ(kind, start, end)。id を直接渡してもよい(4番目)。
     */
    samplePitch(kind, start, end, id) {
      if (id === undefined || id < 0) id = this._idOf(start, end);
      const s = this.samples[id];
      if (!s || !s.pcm || !s.pcm.length) return null;
      let r = this._pitchCache.get(id);
      if (r) return r;
      const U = Emu.SamplePitchUtil;
      const pcm = this._pcmFloat(s);
      let auto = U.detectCps(pcm);
      let wavePcm = pcm;
      if (auto.conf < 0.5 && s.looped && s.loopStart != null && s.loopStart < s.pcm.length) {
        const one = this._pcmFloat(s, s.loopStart);
        if (one.length >= 2 && one.length <= 8192) {
          const reps = Math.max(2, Math.ceil(4096 / one.length));
          const tiled = new Float32Array(one.length * reps);
          for (let k = 0; k < reps; k++) tiled.set(one, k * one.length);
          const a2 = U.detectCps(tiled);
          if (a2.conf >= 0.5) { auto = a2; wavePcm = tiled; }
        }
      }
      const bytes = s.bytes || new Uint8Array(0);
      r = { cps: auto.cps, conf: auto.conf, cpsAuto: auto.cps, confAuto: auto.conf, manual: false,
        hash: U.sampleHash(bytes, 0, bytes.length), wave: null, lenBytes: s.pcm.length };
      const t = U.getTuningMap()[r.hash];
      if (t !== undefined && t > 0) { r.cps = t; r.conf = 1; r.manual = true; }
      r.wave = U.makeSampleWave(wavePcm, r.conf >= 0.5 ? r.cps : 0);
      U.applyKindOverride(r);
      this._pitchCache.set(id, r);
      return r;
    }

    /** スナップショットの sample → デコード済み PCM(Float32Array、-1..1)。DPCM 変換用 */
    samplePcm(sample) {
      if (!sample) return null;
      const id = sample.id !== undefined ? sample.id : this._idOf(sample.start, sample.end);
      const s = this.samples[id];
      return s ? this._pcmFloat(s) : null;
    }

    /** 打楽器/音階の手動上書き(c352.js setSampleKind と同じ契約) */
    setSampleKind(sample, kind) {
      if (!sample) return null;
      const id = sample.id !== undefined ? sample.id : this._idOf(sample.start, sample.end);
      const r = this.samplePitch(sample.kind, sample.start, sample.end, id);
      if (!r || !r.hash) return null;
      Emu.SamplePitchUtil.setKindOverride(r.hash, kind);
      const needsTuning = kind === 'pitch' && !(r.cps > 0);
      this._clearByHash(r.hash);
      return { kind: kind || null, needsTuning };
    }

    /** 手動ピッチ補正(c352.js setSampleTuning と同じ localStorage 永続化) */
    setSampleTuning(kind, start, end, cps) {
      const id = this._idOf(start, end);
      const r = this.samplePitch(kind, start, end, id);
      if (!r) return null;
      const U = Emu.SamplePitchUtil;
      const map = U.getTuningMap();
      if (cps && cps > 0) { map[r.hash] = cps; } else { delete map[r.hash]; }
      U.saveTuningMap(map);
      this._clearByHash(r.hash);
      return this.samplePitch(kind, start, end, id);
    }

    /** 同じ内容(ハッシュ)のサンプルの解析結果を全部捨てる(上書き設定を反映し直す) */
    _clearByHash(hash) {
      for (const [id, r] of this._pitchCache) if (r.hash === hash) this._pitchCache.delete(id);
    }
  }

  /**
   * psfPlayer.js takeSnapshot の Int32Array → snapshotC352 と同じ形の配列(24要素)
   * @param {Int32Array} snap
   * @param {PsxSampleBank} bank
   */
  Emu.snapshotPsx = function (snap, bank) {
    const S = Emu.PSF_SNAP;
    const F = S.VOICE_FIELDS;
    const out = new Array(NUM_VOICES);
    for (let i = 0; i < NUM_VOICES; i++) {
      const o = i * F;
      const phase = snap[o + S.PHASE];
      const level = snap[o + S.LEVEL];
      const pitch = Math.min(0x4000, snap[o + S.PITCH]);
      // ★L/R列は VOLL/VOLR の**生レジスタ(16bit符号付き、-0x8000..0x7FFF)**をそのまま出す
      //   (2026-09-17、ユーザー合意)。これはパンではなく「左右それぞれの音量」で、
      //   0=その側が無音・負=逆相。abs()して0-15へ潰すと逆相が見えなくなる。
      const volLReg = snap[o + S.VOLL], volRReg = snap[o + S.VOLR];
      const volL = Math.abs(volLReg) / 0x7FFF, volR = Math.abs(volRReg) / 0x7FFF;
      const env = level / 0x7FFF;
      const vol = Math.min(1, env * Math.max(volL, volR));
      const rate = SPU_RATE * pitch / 0x1000;
      const noise = !!(snap[o + S.FLAGS] & 1);
      const seq = snap[o + S.SERIAL];
      const id = snap[o + S.SAMPLE];
      const s = (id >= 0 && bank) ? bank.samples[id] : null;
      const p = (s && !noise && seq) ? bank.samplePitch('psx', s.addr, s.addr + s.blocks * 16, id) : null;
      const loop = !!(s && s.looped);
      // ドライバ内部のトラック番号(psfPlayer.js Emu.probePsfTracksAsync。見つからない曲/古いキャプチャは -1)
      const track = S.TRACK !== undefined ? snap[o + S.TRACK] : -1;
      out[i] = {
        // 実際に聞こえているボイスだけ(ドライバの初期化で音量0のまま鳴らし続けるダミーを除く。C352 の vmax>0 と同じ)
        active: phase !== 0 && vol > 0 && (noise || rate > 0),
        // キーオフ済みで余韻だけ鳴っている(ADSR のリリース段。合成chが同じ音色の次のノートへレーンを譲る目印)
        release: phase === 4,
        // 合成ch(Emu.PoolChannelRegrouper)がサンプルの代わりに束ねる鍵。トラックが分かればトラック単位
        track, laneKey: (track >= 0 && seq) ? 'trk:' + track : null,
        // vol は**変換が attDb へ戻す線形振幅**なので意味を変えない(borrow.js VOL_FROM_DB)。
        // 表示は別立て: 数値(rawVol)= ADSR の現在値そのもの、バー(volApparent)= その比。
        // L/R音量はL/R列に実値で出るので、バーには混ぜない(RF5C164 を ENV だけにしたのと同じ扱い)。
        vol, rawVol: level, rawVolMax: 0x7FFF, volApparent: env,
        panL: volLReg, panR: volRReg, lrWide: true,
        rate, seq, loop,
        lenSec: loop ? Infinity : (rate > 0 && s ? s.pcm.length / rate : 0),
        pitchHz: p ? p.cps * rate : 0, pitchConf: p ? p.conf : 0, pitchManual: !!(p && p.manual),
        sampleKind: p ? (p.kindManual || 'auto') : 'auto', sampleHash: p ? p.hash : null,
        waveData: p ? p.wave : null,
        sample: (s && !noise && seq) ? { kind: 'psx', start: s.addr, end: s.addr + s.blocks * 16, id } : null,
        noise,
        slot: i, // 物理ボイス番号(合成ch/トラックのレーンへ移しても残る。レーン単位ミュートが使う)
      };
    }
    return out;
  };

  // トラックモードのレーン作り(Emu.PsfTrackVoicer)と音色モード(Emu.PoolToneVoicer)は src/emulator/expansion/multipcm.js にある
  // (VGM のキャプチャ Worker にも要るので、合成ch Emu.PoolChannelRegrouper の隣へ置いた)

  Emu.PsxSampleBank = PsxSampleBank;
  Emu.PSX_NUM_VOICES = NUM_VOICES;
})(window);
