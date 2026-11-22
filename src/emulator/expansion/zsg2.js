/*
 * ZOOM ZSG-2(48 声の PCM 音源)+ 後段の TMS57002(タイトー FX-1B / G-NET の ZOOM 音源基板)
 * MML.Emu.Zsg2Audio
 *
 * 動作は MAME src/devices/sound/zsg2.cpp と src/mame/sony/taito_zm.cpp(BSD-3-Clause、THIRD-PARTY-NOTICES.md)の写し。
 *   出力レート = クロック/768 の整数部(25MHz → 32552Hz。MAME が整数で割るのに合わせる)。clock() 1 回 = 1 サンプル
 *   レジスタは 16bit。番号 = 番地/2。0x000-0x2FF = 声ごと(16 本 × 48 声)、0x300-0x302 = キーオン、0x304-0x306 = キーオフ
 *   声ごと: 0/1 = 開始番地とページ、4 = 周波数、5/7 = ループ番地と直の右/左のゲイン、6 = 終端、
 *           8/9/C/D = フィルタ(初期値/今の値/目標/速さ)、A/B/E/F = 音量(初期値/今の値/目標/速さ)、D/F の上位 = コーラス/リバーブ送り
 *   波形は 4 バイト → 16bit 4 サンプルの独自圧縮(42222222 51111111 60000000 ssss3333)。番地は 4 バイト単位
 *   出力は 4 系統(リバーブ送り、コーラス送り、左、右)。DSP 付きなら送りは ×0.5、直は ×1.0 で TMS57002 の入力 0〜3 へ入り、
 *   DSP の出力 2・3 が左右。そこに全体音量(メイン CPU が書く 6bit ÷ 63)を掛ける
 *
 * VGM の ZSGX ブロック(src/vgm/vgmHeader.js)の書き込みは、レジスタ番号の 0x8000 以上を音源基板の他の部分に割り当てる:
 *   0x8000 = DSP へのデータ 1 バイト、0x8001 = DSP の制御線(bit0 PLOAD、bit1 CLOAD)、0x8002 / 0x8003 = 全体音量の左 / 右(0〜63)、
 *   0x8004 = DSP を無音で n サンプル進める(時間は進めない。曲の前の準備 = 係数の更新を DSP に食べさせるため)
 *   0x8005 = 2 つの声の中身を丸ごと入れ替える(上位 8bit と下位 8bit が声の番号)。ループの継ぎ目用: このドライバは声を順繰りに
 *            使い回すので、1 周の終わりでは同じ音が頭の時とは別の声で鳴っている。そのまま頭の書き込みへ戻ると、またいで伸びる音を
 *            誰も止めない。終わりで声を頭の時の番号へ並べ直してから戻る(tools/zsg2/zsg2-loop.js)
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 48;
  const REG_DSP_DATA = 0x8000, REG_DSP_CTRL = 0x8001, REG_GAIN_L = 0x8002, REG_GAIN_R = 0x8003, REG_DSP_RUN = 0x8004, REG_VOICE_SWAP = 0x8005;
  const GAIN_TAB = new Uint16Array(32);
  for (let i = 1; i < 32; i++) GAIN_TAB[i] = Math.pow(10, -(31 - i) / 20) * 65535;

  function getRamp(val) {
    let frac = (val << 12) << 16 >> 16;
    frac = (((frac >> 12) ^ 8) << (val >> 4)) << 16 >> 16;
    return frac >> 4;
  }
  function ramp(cur, target, delta) {
    let v = cur + delta;
    if (delta < 0 && v < target) v = target; else if (delta >= 0 && v > target) v = target;
    return v & 0xffff;
  }
  // 緩い音程判定(共通の detectCps とループ長の両方で取れなかった時の第 2 段)。
  // ZSG-2 の曲には合奏・合唱・重ね録りの波形が多く、1 周期ごとの形が揃わないので正規化自己相関の山が低い(0.4〜0.7)。
  // 共通の判定は山の高さ 0.85 以上を求めるので落ちる。ここでは山が低くても、波形の 6 か所で同じ周期が出ていれば採る:
  //   窓 3000 サンプル、周期 8〜512 サンプル、山の高さ 0.4 以上、6 か所のうち 4 か所以上が中央値の ±3% に入ること。
  //   周期の上限を 512 にしてあるのは、それより長い「周期」は音程ではなく、うねりや繰り返しの周期を拾った物だったため
  //   (実測: 周期 713 と 1333 の 2 種類が、鳴らすと 9〜35Hz の「音程」になり、変換で最低音に張り付いた音符になった)
  // 打楽器は場所ごとに周期がばらつくので通らない(16 曲 106 種類で確認。tools/zsg2/zsg2-sample-survey.js)。
  // 戻り { cps, conf } か null。conf は一致した割合(4/6 = 0.67 以上)
  function relaxedCps(pcm) {
    const len = pcm.length; if (len < 1024) return null;
    const W = Math.min(3000, Math.floor(len * 0.5)), maxLag = Math.min(512, W >> 1), FRAMES = 6;
    if (maxLag < 32) return null;
    const nsdf = new Float64Array(maxLag + 2), lags = [];
    for (let f = 0; f < FRAMES; f++) {
      const off = Math.floor((len - W) * (0.05 + 0.15 * f));
      for (let tau = 1; tau <= maxLag + 1; tau++) { let ac = 0, m = 0; for (let i = 0, n = W - tau; i < n; i++) { const a = pcm[off + i], b = pcm[off + i + tau]; ac += a * b; m += a * a + b * b; } nsdf[tau] = m > 0 ? 2 * ac / m : 0; }
      // 最初の零交差を過ぎてから山を拾い、いちばん高い山の 9 割以上ある最初の山を周期とする
      let t = 1; while (t <= maxLag && nsdf[t] > 0) t++;
      const peaks = []; let inPos = false, best = -1, bt = 0;
      for (; t <= maxLag; t++) { if (nsdf[t] > 0) { if (!inPos) { inPos = true; best = -1; } if (nsdf[t] > best) { best = nsdf[t]; bt = t; } } else if (inPos) { inPos = false; if (bt >= 8) peaks.push(bt); } }
      if (!peaks.length) continue;
      let g = 0; for (const p of peaks) if (nsdf[p] > g) g = nsdf[p];
      const p = peaks.find((q) => nsdf[q] >= g * 0.9);
      if (nsdf[p] < 0.4) continue;
      let lag = p; const y0 = nsdf[p - 1], y1 = nsdf[p], y2 = nsdf[p + 1], d = y0 - 2 * y1 + y2; if (d < 0) lag += 0.5 * (y0 - y2) / d;
      lags.push(lag);
    }
    if (lags.length < 4) return null;
    const sorted = lags.slice().sort((a, b) => a - b), med = sorted[sorted.length >> 1];
    const near = lags.filter((l) => Math.abs(l - med) / med <= 0.03);
    if (near.length < 4) return null;
    return { cps: near.length / near.reduce((a, b) => a + b, 0), conf: near.length / FRAMES };
  }
  function newChan() {
    return { v: new Uint16Array(16), active: false, status: 0, cur: 0, stepPtr: 0, step: 1, start: 0, end: 0, loop: 0, page: 0,
      vol: 0, volInit: 0, volTarget: 0, volDelta: 0, cut: 0, cutInit: 0, cutTarget: 0, cutDelta: 0, emph: 0, filt: 0, gain: new Uint8Array(4), s: new Int16Array(5),
      seq: 0, kStart: 0, kEnd: 0, kLoop: 0, kPage: 0, peak: 0 };   // seq 以降は表示用の控え(キーオンの通番、その時の波形の番地、キーオンからの最大音量)
  }
  const CH_NUM = ['active', 'status', 'cur', 'stepPtr', 'step', 'start', 'end', 'loop', 'page', 'vol', 'volInit', 'volTarget', 'volDelta', 'cut', 'cutInit', 'cutTarget', 'cutDelta', 'emph', 'filt', 'seq', 'kStart', 'kEnd', 'kLoop', 'kPage', 'peak'];

  class Zsg2Audio {
    /**
     * @param {number} [clock=25000000] - 音源に入るクロック(出力レート = floor(clock/768))
     * @param {number} [flags=1] - bit0 = 後段に TMS57002 がある
     */
    constructor(clock, flags) {
      this.clockHz = clock || 25000000;
      this.sampleRate = Math.floor(this.clockHz / 768);
      this.hasDsp = flags === undefined ? true : !!(flags & 1);
      this.rom = new Uint8Array(0);      // 波形(番地 0 始まり。飛び飛びに届くので、届いた所まで伸ばす)
      this.mute = new Array(NUM_CH).fill(false);
      this.vol = new Array(NUM_CH).fill(1);
      this.dspBypass = false;            // true で DSP を通さず直の左右だけ出す(聴き比べ用)
      this.captureOnly = false;          // true で音を作らない(先読みキャプチャ用。声の位置と音量だけ進める。DSP は実時間の 25% かかるので回さない)
      this._pitchCache = new Map();      // '開始:終了' → { cps, conf, … }(鍵盤表示の音程。波形が入れ替わったら捨てる)
      this.reset();
    }
    reset() {
      this.ch = []; for (let i = 0; i < NUM_CH; i++) this.ch.push(newChan());
      this.sampleCount = 0;
      this.dsp = this.hasDsp ? Emu.createTms57002() : null;
      this.gainL = 1; this.gainR = 1;
      this.mix = new Int32Array(4);
      this.outL = 0; this.outR = 0;
      this.nat = 0;
      this.q = []; this.qHead = 0;
    }
    queueWrite(delay, reg, value) {
      if (delay <= 0 && this.qHead >= this.q.length) { this.write(reg, value); return; }
      this.q.push(this.nat + Math.max(0, delay), reg, value);
    }
    /** 通し番号 n のサンプルの前に効く書き込みを積む(n = これまでに出したサンプル数がこの値になった時) */
    queueWriteAt(n, reg, value) {
      if (n <= this.nat && this.qHead >= this.q.length) { this.write(reg, value); return; }
      this.q.push(Math.max(n, this.nat), reg, value);
    }
    _drain() {
      const q = this.q;
      while (this.qHead < q.length && q[this.qHead] <= this.nat) { this.write(q[this.qHead + 1], q[this.qHead + 2]); this.qHead += 3; }
      if (this.qHead >= q.length) { q.length = 0; this.qHead = 0; }
    }
    flushWrites() { const q = this.q; for (let i = this.qHead; i < q.length; i += 3) this.write(q[i + 1], q[i + 2]); q.length = 0; this.qHead = 0; }
    /** 波形を置く。addr = 波形 ROM 内のバイト位置。飛び飛びに何度でも呼べる */
    loadRom(addr, data) {
      if (!data || !data.length) return;
      if (addr + data.length > this.rom.length) { const g = new Uint8Array(addr + data.length); g.set(this.rom); this.rom = g; }
      this.rom.set(data, addr);
      this._pitchCache.clear();
    }
    write(reg, value) {
      value &= 0xFFFF;
      if (reg < 0x300) { this._chanW(reg >> 4, reg & 0xf, value); return; }
      if (reg < 0x400) { this._controlW(reg - 0x300, value); return; }
      if (reg === REG_DSP_DATA) { if (this.dsp) this.dsp.dataW(value & 0xff); }
      else if (reg === REG_DSP_CTRL) { if (this.dsp) this.dsp.ctrl(value & 0xff); }
      else if (reg === REG_GAIN_L) this.gainL = (value & 0x3f) / 63;
      else if (reg === REG_GAIN_R) this.gainR = (value & 0x3f) / 63;
      else if (reg === REG_VOICE_SWAP) { const a = value >> 8, b = value & 0xff; if (a < NUM_CH && b < NUM_CH) { const t = this.ch[a]; this.ch[a] = this.ch[b]; this.ch[b] = t; } }
      else if (reg === REG_DSP_RUN) { if (this.dsp && !this.captureOnly) for (let i = 0; i < value; i++) this.dsp.sample(0, 0, 0, 0); }
    }
    _chanW(c, reg, data) {
      const e = this.ch[c];
      switch (reg) {
        case 0x0: e.start = (e.start & 0xff00) | (data >> 8 & 0xff); break;
        case 0x1: e.start = (e.start & 0x00ff) | (data << 8 & 0xff00); e.page = data << 8 & 0xff0000; break;
        case 0x3: e.status = data & 0x7fff; break;
        case 0x4: e.step = data + 1; break;
        case 0x5: e.loop = (e.loop & 0xff00) | (data & 0xff); e.gain[3] = data >> 8; break;
        case 0x6: e.end = data; break;
        case 0x7: e.loop = (e.loop & 0x00ff) | (data << 8 & 0xff00); e.gain[2] = data >> 8; break;
        case 0x8: e.cutInit = data; break;
        case 0x9: e.cut = data; break;
        case 0xa: e.volInit = data; break;
        case 0xb: e.vol = data; break;
        case 0xc: e.cutTarget = data; break;
        case 0xd: e.gain[1] = data >> 8; e.cutDelta = getRamp(data & 0xff); break;
        case 0xe: e.volTarget = data; break;
        case 0xf: e.gain[0] = data >> 8; e.volDelta = getRamp(data & 0xff); break;
      }
      e.v[reg] = data;
    }
    _controlW(reg, data) {
      if (reg <= 2) {
        for (let i = 0; i < 16; i++) if (data >> i & 1) {
          const c = reg << 4 | i; if (c >= NUM_CH) continue;
          const e = this.ch[c];
          e.active = true; e.cur = (e.start - 1) >>> 0; e.stepPtr = 0x10000;
          e.vol = 0; e.volDelta = 0x0400;                    // 初期音量は MAME でも無視している(クリック音が出るため)
          e.cut = e.cutInit; e.filt = 0;
          e.peak = 0; e.seq++; e.kStart = e.start; e.kEnd = e.end; e.kLoop = e.loop; e.kPage = e.page;
        }
      } else if (reg >= 4 && reg <= 6) {
        for (let i = 0; i < 16; i++) if (data >> i & 1) { const c = (reg & 3) << 4 | i; if (c < NUM_CH) { this.ch[c].vol = 0; this.ch[c].active = false; } }
      }
    }
    // 4 バイトの 1 ブロックを展開し、強調フィルタを通して e.s[1..4] に入れる
    _fill(e) {
      const o = ((e.page | e.cur) >>> 0) * 4, rom = this.rom, s = e.s;
      s[0] = s[4];
      let r0 = 0, r1 = 0, r2 = 0, r3 = 0;
      if (o + 3 < rom.length) {
        const b0 = rom[o], b1 = rom[o + 1], b2 = rom[o + 2], b3 = rom[o + 3];
        if (b0 | b1 | b2 | b3) {
          const sh = b0 >> 4;
          r0 = ((b1 & 0x7f) << 25 >> 16) >> sh; r1 = ((b2 & 0x7f) << 25 >> 16) >> sh; r2 = ((b3 & 0x7f) << 25 >> 16) >> sh;
          r3 = ((((b1 >> 1) & 0x40) | ((b2 >> 2) & 0x20) | ((b3 >> 3) & 0x10) | (b0 & 0xf)) << 25 >> 16) >> sh;
        }
      }
      let em = e.emph, v;
      em = (em + r0 - ((em + 0x20) >> 6)) | 0; v = em >> 1; s[1] = v < -32768 ? -32768 : v > 32767 ? 32767 : v;
      em = (em + r1 - ((em + 0x20) >> 6)) | 0; v = em >> 1; s[2] = v < -32768 ? -32768 : v > 32767 ? 32767 : v;
      em = (em + r2 - ((em + 0x20) >> 6)) | 0; v = em >> 1; s[3] = v < -32768 ? -32768 : v > 32767 ? 32767 : v;
      em = (em + r3 - ((em + 0x20) >> 6)) | 0; v = em >> 1; s[4] = v < -32768 ? -32768 : v > 32767 ? 32767 : v;
      e.emph = em;
    }
    clock() {
      if (this.qHead < this.q.length) this._drain();
      this.nat++;
      const mix = this.mix, odd = this.sampleCount & 1;
      let m0 = 0, m1 = 0, m2 = 0, m3 = 0;
      for (let c = 0; c < NUM_CH; c++) {
        const e = this.ch[c];
        if (!e.active) continue;
        e.stepPtr = (e.stepPtr + e.step) >>> 0;
        if (e.stepPtr & 0xffff0000) {
          e.cur = (e.cur + 1) >>> 0;
          if (e.cur >= e.end) {
            e.cur = e.loop;
            if (e.cur + 1 >= e.end) { e.vol = 0; e.active = false; continue; }
          }
          if (e.cur === e.start) e.emph = 0;
          e.stepPtr &= 0xffff;
          this._fill(e);
        }
        if (e.vol > e.peak) e.peak = e.vol;
        if (this.captureOnly) { if (odd) { e.vol = ramp(e.vol, e.volTarget, e.volDelta); e.cut = ramp(e.cut, e.cutTarget, e.cutDelta); } continue; }
        const sp = e.stepPtr >> 14 & 3;
        let s = e.s[sp];
        s += ((e.stepPtr << 2 & 0xffff) * ((e.s[sp + 1] - s) << 16 >> 16)) >> 16;
        e.filt = (e.filt + Math.imul(s - (e.filt >> 16), e.cut)) | 0;
        s = e.filt >> 16;
        if (!e.cut) e.filt >>= 1;
        s = Math.floor(s * e.vol / 65536);
        if (!this.mute[c]) {
          const g = e.gain, k = this.vol[c];
          if (k !== 1) s = Math.round(s * k);
          m0 += Math.floor((g[0] & 0x80 ? -s : s) * GAIN_TAB[g[0] & 0x1f] / 65536);
          m1 += Math.floor((g[1] & 0x80 ? -s : s) * GAIN_TAB[g[1] & 0x1f] / 65536);
          m2 += Math.floor((g[2] & 0x80 ? -s : s) * GAIN_TAB[g[2] & 0x1f] / 65536);
          m3 += Math.floor((g[3] & 0x80 ? -s : s) * GAIN_TAB[g[3] & 0x1f] / 65536);
        }
        if (odd) { e.vol = ramp(e.vol, e.volTarget, e.volDelta); e.cut = ramp(e.cut, e.cutTarget, e.cutDelta); }
      }
      this.sampleCount++;
      if (this.captureOnly) return;
      mix[0] = m0; mix[1] = m1; mix[2] = m2; mix[3] = m3;
      const f0 = Math.max(-1, Math.min(1, m0 / 32768)), f1 = Math.max(-1, Math.min(1, m1 / 32768)), f2 = Math.max(-1, Math.min(1, m2 / 32768)), f3 = Math.max(-1, Math.min(1, m3 / 32768));
      if (this.dsp) {
        const o = this.dsp.sample(f0 * 0.5, f1 * 0.5, f2, f3);
        if (this.dspBypass) { this.outL = f2 * this.gainL; this.outR = f3 * this.gainR; }
        else { this.outL = o[2] * this.gainL; this.outR = o[3] * this.gainR; }
      } else { this.outL = f2; this.outR = f3; }
    }
    mixSample() { return { left: this.outL, right: this.outR }; }

    // ── 鍵盤表示・ロール・変換が使う口(CPS3 / QSound と同じ形)──
    // 波形の番地は「4 バイトのブロックの通し番号」(ページ | 番地)。1 ブロック = 16bit 4 サンプル
    /** 再生レート(1 秒あたりの波形のサンプル数)。周波数レジスタ +1 が 0x10000 で 1 サンプルに 1 ブロック(= 4 サンプル)進む */
    playRate(v) { return this.ch[v].step / 65536 * 4 * this.sampleRate; }
    // ブロックの区間 → -1..1 の波形(最大 16384 ブロック = 65536 サンプル)。音源が鳴らす時と同じ強調フィルタを通す
    _decodeSample(start, end) {
      const nb = Math.max(0, Math.min(end, start + 16384) - start), pcm = new Float32Array(nb * 4);
      const e = { page: 0, cur: 0, emph: 0, s: new Int16Array(5) };
      for (let b = 0; b < nb; b++) { e.cur = start + b; this._fill(e); const o = b * 4; pcm[o] = e.s[1] / 32768; pcm[o + 1] = e.s[2] / 32768; pcm[o + 2] = e.s[3] / 32768; pcm[o + 3] = e.s[4] / 32768; }
      return pcm;
    }
    /** 波形の基本周期の解析(控えつき)。音程が取れない時はループ長から周期を出す(CPS3 / QSound と同じ) */
    samplePitch(kind, start, end, loop) {
      if (start === undefined || end === undefined || !(end > start) || !this.rom.length) return null;
      const key = start + ':' + end;
      let r = this._pitchCache.get(key);
      if (r) return r;
      const U = Emu.SamplePitchUtil;
      const pcm = this._decodeSample(start, end);
      let auto = U.detectCps(pcm), wavePcm = pcm, via = 'nsdf';
      if (auto.conf < 0.5 && loop && loop >= start && loop < end) {
        const loopLen = (end - loop) * 4;
        if (loopLen >= 16 && loopLen <= 16384) { const one = this._decodeSample(loop, end), r2 = U.loopCps(one); if (r2) { auto = r2; wavePcm = one; via = 'loop'; } }
      }
      // 第 2 段: 合奏や合唱のような、1 周期ごとの形は揃わないが周期は安定している波形(relaxedCps の説明)
      if (auto.conf < 0.5) { const r3 = relaxedCps(pcm); if (r3) { auto = r3; via = 'relaxed'; } }
      const a = Math.min(this.rom.length, start * 4), b = Math.min(this.rom.length, Math.min(end, start + 16384) * 4);
      r = { cps: auto.cps, conf: auto.conf, cpsAuto: auto.cps, confAuto: auto.conf, manual: false, hash: U.sampleHash(this.rom.subarray(a, b), 0, b - a), wave: null, lenBytes: pcm.length, via: auto.conf >= 0.5 ? via : '' };
      const t = U.getTuningMap()[r.hash];
      if (t !== undefined && t > 0) { r.cps = t; r.conf = 1; r.manual = true; }
      r.wave = U.makeSampleWave(wavePcm, r.conf >= 0.5 ? r.cps : 0);
      U.applyKindOverride(r);
      this._pitchCache.set(key, r);
      return r;
    }
    /** 打楽器/音階の手動上書き(kind: 'drum' | 'pitch' | null) */
    setSampleKind(sample, kind) {
      if (!sample) return null;
      const r = this.samplePitch(sample.kind, sample.start, sample.end);
      if (!r || !r.hash) return null;
      Emu.SamplePitchUtil.setKindOverride(r.hash, kind);
      const needsTuning = kind === 'pitch' && !(r.cps > 0);
      this._pitchCache.delete(sample.start + ':' + sample.end);
      return { kind: kind || null, needsTuning };
    }
    samplePcm(sample) { return sample ? this._decodeSample(sample.start, sample.end) : null; }
    /** 手動のピッチ補正 */
    setSampleTuning(kind, start, end, cps) {
      const r = this.samplePitch(kind, start, end);
      if (!r) return null;
      const U = Emu.SamplePitchUtil, map = U.getTuningMap();
      if (cps && cps > 0) { map[r.hash] = cps; r.cps = cps; r.conf = 1; r.manual = true; }
      else { delete map[r.hash]; r.cps = r.cpsAuto; r.conf = r.confAuto; r.manual = false; }
      U.saveTuningMap(map);
      r.wave = U.makeSampleWave(this._decodeSample(start, end), r.conf >= 0.5 ? r.cps : 0);
      return r;
    }

    getState() {
      const ch = this.ch.map((e) => ({ v: e.v.slice(), gain: e.gain.slice(), s: e.s.slice(), n: CH_NUM.map((k) => e[k]) }));
      return { ch, sampleCount: this.sampleCount, dsp: this.dsp ? this.dsp.getState() : null, gainL: this.gainL, gainR: this.gainR, outL: this.outL, outR: this.outR, nat: this.nat, q: this.q.slice(this.qHead) };
    }
    setState(st) {
      st.ch.forEach((c, i) => { const e = this.ch[i]; e.v.set(c.v); e.gain.set(c.gain); e.s.set(c.s); CH_NUM.forEach((k, j) => { e[k] = c.n[j]; }); });
      this.sampleCount = st.sampleCount; if (this.dsp && st.dsp) this.dsp.setState(st.dsp);
      this.gainL = st.gainL; this.gainR = st.gainR; this.outL = st.outL; this.outR = st.outR; this.nat = st.nat; this.q = st.q.slice(); this.qHead = 0;
    }
  }
  Zsg2Audio.NUM_CH = NUM_CH;
  Zsg2Audio.REG = { DSP_DATA: REG_DSP_DATA, DSP_CTRL: REG_DSP_CTRL, GAIN_L: REG_GAIN_L, GAIN_R: REG_GAIN_R, DSP_RUN: REG_DSP_RUN, VOICE_SWAP: REG_VOICE_SWAP };

  // 鍵盤表示用のスナップショット(CPS3 / QSound と同じ形の配列 48 要素)。
  //   音量 = 今の音量(16bit、ランプで動く)。左右 = 直の左右のゲイン(5bit、1 段 -1dB)を振幅に直した比
  //   発音中 = 声が動いていて、音量か目標音量が 0 でない(ドライバは音量を 0 へ落としてからキーオフする)
  //   波形 = キーオンの時点のブロック番地(ページ | 番地)。ループ無しの波形はループ番地 = 終端 - 1 で届く
  Emu.snapshotZsg2 = function (chip) {
    const out = [];
    for (let i = 0; i < NUM_CH; i++) {
      const e = chip.ch[i], seq = e.seq;
      const start = (e.kPage | e.kStart) >>> 0, end = (e.kPage | e.kEnd) >>> 0, loop = e.kLoop + 1 < e.kEnd, loopAt = (e.kPage | e.kLoop) >>> 0;
      const rate = chip.playRate(i);
      const p = seq ? chip.samplePitch('zsg2', start, end, loop ? loopAt : 0) : null;
      const len = p ? p.lenBytes : Math.max(0, end - start) * 4;
      const l = GAIN_TAB[e.gain[2] & 0x1f], r = GAIN_TAB[e.gain[3] & 0x1f], m = Math.max(l, r);
      // このドライバは音を止める時に音量を 0 へ落とさず、ごく小さい音量(最大時の -40〜-50dB)のまま声を鳴らし続ける(実測)。
      // レジスタの値だけで「発音中」とすると同時発音が平均 14 声になり、合成 ch も変換も散らばるので、キーオンからの最大音量を基準に見る:
      //   発音中 = 最大時の 3%(約 -30dB)以上、または音量が上がっている最中(立ち上がり。キーオン直後は音量 0 から始まる)
      //   余韻   = 最大時の 30%(約 -10dB)未満で、上がっていない。合成 ch が同じ音色の次のノートへレーンを譲る目印(multipcm.js PoolChannelRegrouper)
      const rising = e.volTarget > e.vol;
      out.push({ active: e.active && rate > 0 && (rising || (e.vol > 0 && e.vol >= e.peak * 0.03)), release: !rising && e.vol < e.peak * 0.3, vol: e.vol / 65535, volAim: Math.max(e.vol, e.volTarget) / 65535, rawVol: e.vol, rawVolMax: 0xFFFF,
        panL: m ? Math.round(l / m * 15) : 0, panR: m ? Math.round(r / m * 15) : 0,
        rate, seq, loop, lenSec: loop ? Infinity : (rate > 0 ? len / rate : 0),
        pitchHz: p ? p.cps * rate : 0, pitchConf: p ? p.conf : 0, pitchManual: !!(p && p.manual), sampleKind: p ? (p.kindManual || 'auto') : 'auto', sampleHash: p ? p.hash : null,
        waveData: p ? p.wave : null,
        sample: seq ? { kind: 'zsg2', start, end } : null });
    }
    return out;
  };

  Emu.Zsg2Audio = Zsg2Audio;
})(typeof window !== 'undefined' ? window : globalThis);
