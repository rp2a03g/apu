/*
 * チャンネル割当プレビュー(「割当先の音で聴く」) MML.Audio.AssignPreview
 *
 * 鍵盤表示のチャンネル割当(src/convert/channelPlan.js)で選んだ借用先のNSF音源で、
 * 再生中の元チャンネルを鳴らし直す。元エミュレータ(SPC/KSS/GBS/HES/VGM/NSF)は
 * そのまま走らせ(元chはミュート)、その横で NSF 側のチップ(2A03+拡張音源)を1組だけ
 * 動かして、毎フレーム「今の元chの音程・音量」をレジスタへ書く。
 *
 * ■ なぜ「プリセット波形の差し替え」ではなくチップエミュレータを鳴らすのか
 *   重いのはCPUエミュレーション(Z80/SPC700等)で、NSF側のチップ単体は軽い。MML再生
 *   (src/audio/stream-player.js MmlStreamPlayer)がまさに「CPU無しでチップへ書いて鳴らす」
 *   構造で全チップ同時でも問題なく動く。同じチップを鳴らせば三角波の4bit段・ノイズのLFSR・
 *   VRC7のFMエンベロープまで変換後(MML→再生)と同じ音になり、別実装の乖離が生まれない
 *   ([[roll-as-mml-debugger]] と同じ考え方)。
 *
 * ■ 入力
 *   setPlan(rows)      rows = [{ id, target, tone, kind, muted }] 鍵盤表示 getPreviewPlan() の形
 *   setProvider(fn)    fn(frameIdx) → 鍵盤表示 extractChannels() と同じ形の channels[]
 *                      (id/freq/vol(0-1)/active/noise/noiseIndex/wave/fmPatch を読む)
 *   onFrame(frameIdx)  各プレイヤーが元フレームを適用した直後に1回呼ぶ(メインスレッド)
 *   render()           出力1サンプルぶん(hostGain補正済み)。有効中は毎サンプル呼ぶ
 *
 * ■ 音量の写像は変換(src/convert/borrow.js volTableFor)と同じ規則:
 *   元の音量→減衰量[dB]→借用先の値。線形音源(GB/HES/SPC/2A03系)は振幅比、対数DAC
 *   (AY/SCC=1.5dB/段、SN76489=2dB/段)は段数、OPLL/OPL/FME-7は3dB/段。借用先は
 *   VRC7=レジスタの減衰値(0が最大。ここはレジスタへ直接書くので反転しない。MMLの v は v15 が最大)、
 *   FME-7=3dB/段、FDS/VRC6のこぎり=0-63、他=0-15。
 *
 * ■ 割り切り(変換の判断そのものは再現しない)
 *   ・@vエンベロープ表/量子化/デチューン/タイ判定は変換時の判断なので出ない
 *     (それは「変換→コンパイル→再生」で確認する)。
 *   ・E(DPCM)へ載せた行は元の音のまま(打楽器化は分離レンダリングが要るため)。スキップ行は無音。
 *   ・N163/FDSの「元の波形をコピー」は波形メモリ音源(SCC/GB波形/HuC6280)の現在波形を
 *     そのまま使う。SPCのBRRサンプルは1周期の切り出し(pcmToN163Wave)をせず既定波形にする。
 *   ・VRC7の自作音色(@0)は実機同様チップに1系統。重なった行は最寄りの内蔵音色へ落ちる
 *     (src/convert/vrc7Tone.js と同じ方針)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Audio = MML.Audio || {};

  const CPU_CLOCK_NTSC = 1789773;
  const NSF_GAIN = 1.56; // NsfReplayStreamPlayer/MmlStreamPlayer の gainNode 値(実測RMS校正済み)
  const N163_CHANNEL_COUNT = 8;
  // 「減衰した状態から+この量」跳ね上がったら再アタック(ADSR/ソフトエンベロープの減衰後に
  // 同音程で打ち直された音。VRC7のキーオン再発火に使う)。アタック中の上昇は peak を
  // 更新し続けるので decayed=false のまま=誤検出しない
  const REATTACK_RISE = 0.25;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function freqToNote(freq) { return 57 + 12 * Math.log2(freq / 440); } // 57=o4a(A4)
  function pitchRegs() { return (MML.Mml && MML.Mml.pitchRegs) || null; }
  function plan() { return (MML.Convert && MML.Convert.ChannelPlan) || null; }

  // OPLL音色オブジェクト({mod, car}) → レジスタ$00-$07の8バイト(src/ui/keyboard.js opllPatchBytesと同じ)
  function opllBytes(p) {
    const m = p.mod, c = p.car;
    if (!m || !c) return null;
    return [
      ((m.AM & 1) << 7) | ((m.PM & 1) << 6) | ((m.EG & 1) << 5) | ((m.KR & 1) << 4) | (m.ML & 15),
      ((c.AM & 1) << 7) | ((c.PM & 1) << 6) | ((c.EG & 1) << 5) | ((c.KR & 1) << 4) | (c.ML & 15),
      ((m.KL & 3) << 6) | (m.TL & 63),
      ((c.KL & 3) << 6) | ((c.WF & 1) << 4) | ((m.WF & 1) << 3) | (m.FB & 7),
      ((m.AR & 15) << 4) | (m.DR & 15),
      ((c.AR & 15) << 4) | (c.DR & 15),
      ((m.SL & 15) << 4) | (m.RR & 15),
      ((c.SL & 15) << 4) | (c.RR & 15),
    ];
  }
  // 旋律→ノイズの周期決めに使うFMキャリアの倍率(OPN: キャリアopのML最大、OPLL: キャリアML。無ければ1)
  const OPN_CARRIERS = [[3], [3], [3], [3], [1, 3], [1, 2, 3], [1, 2, 3], [0, 1, 2, 3]];
  function fmCarrierMul(ch) {
    const p = ch && ch.fmPatch;
    if (!p) return 1;
    if (p.type === 'opn' && p.ops) { let m = 0; for (const i of OPN_CARRIERS[p.AL & 7]) if (p.ops[i]) m = Math.max(m, p.ops[i].ML || 0); return m || 0.5; }
    if (p.type === 'opll' && p.car) return p.car.ML || 0.5;
    return 1;
  }
  function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // ── 元行の音量尺度(borrow.js attOf と同じ分類) ─────────────────────
  //   { linear: true } … 抽出値が線形振幅(vol=振幅比)
  //   { step }         … 対数DAC。vol=(段/15)、減衰 = (1-vol)*15*step [dB]
  //   { att }          … 減衰値そのもの(OPLL/OPL/VRC7: 鍵盤表示のvolは(15-n)/15 に反転済み)
  // ★音量則はチップの性質(src/convert/borrow.js CHIP_VOL_LAW が正典)。2026-09-11に実装と
  //   突き合わせて訂正: AY(KP)とSCC(KS)を一括で1.5dB/段としていたが、AYは3dB/段でSCCは線形。
  //   HES(PSG)は既定の線形へ落ちていたが実際は対数3dB/段。FME-7(FE)が元から3dBだったのと辻褄が合う
  function volSpecOf(id) {
    if (/^KP\d$/.test(id)) return { step: 3 };                           // AY/SSG(YM2149系)
    if (/^KS\d$/.test(id)) return { linear: true };                      // SCC: 波形×音量の掛け算
    if (/^PSG\d$/.test(id)) return { step: 3 };                          // HuC6280(抽出器が>>1で16段)
    if (/^SNN?\d?$/.test(id)) return { step: 2 };                        // SN76489
    if (/^(KF|OL)\d$/.test(id) || /^VR\d$/.test(id)) return { att: 3 };   // OPLL/OPL/VRC7
    if (/^FE\d$/.test(id)) return { step: 3 };                           // FME-7(YM2149)
    return { linear: true };
  }
  // 行ID → キャプチャのチップキー。変換と同じ「曲・チップ単位の音量正規化」のオフセットを
  // 引くために使う(setVolumeRefs で main.js から受け取る)。
  // ★これが無いと、ヘッドルームを持つPCM(K054539など約10dB)でプレビューだけ小さく鳴り、
  //   変換結果と食い違う。基準値は変換と同一の関数(Vgm2MmlExpansion.attRefOfSnapshots)で作る。
  const ROW_CHIP = [[/^GAd$/, 'ga20'], [/^K7d$/, 'k007232'], [/^K5d+$/, 'k054539'],
    [/^SPd+$/, 'segapcm'], [/^CNd+$/, 'c140'], [/^CSd+$/, 'c352'], [/^QSd+$/, 'qsound'],
    [/^OKd$/, 'okim6295'], [/^MPd+$/, 'multipcm'], [/^PXd+$/, 'psx']];
  function rowChipOf(id) { for (const [re, c] of ROW_CHIP) if (re.test(id)) return c; return null; }
  function attDbOf(spec, vol, refs) {
    if (vol <= 0) return 96;
    const ref = (refs && spec.chipKey && refs[spec.chipKey]) || 0;
    if (spec.linear) return Math.max(0, -20 * Math.log10(Math.min(1, vol)) - ref);
    if (spec.att) return Math.max(0, (1 - vol) * 15 * spec.att - ref);
    return Math.max(0, (1 - vol) * 15 * spec.step - ref);
  }
  // 減衰量[dB] → 借用先ファミリの音量レジスタ値(borrow.js VOL_FROM_DB / volTableFor と同じ)
  function targetVol(family, att) {
    if (family === 'vrc7') return clamp(Math.round(att / 3), 0, 15);
    if (family === 'fme7') return clamp(15 - Math.round(att / 3), 0, 15);
    // 借用先の音量レンジは変換と同じ表を見る(src/convert/borrow.js FAMILY_VOL_MAX)。
    // ★2026-09-11まで63を直書きしており、FDS(実効32)/VRC6のこぎり(実効42)で変換後と音量が違っていた
    const T = (MML.Convert.Borrow && MML.Convert.Borrow.FAMILY_VOL_MAX) || {};
    const max = T[family] == null ? 15 : T[family];
    if (att >= 60) return 0;
    return Math.max(1, Math.min(max, Math.round(max * Math.pow(10, -att / 20))));
  }

  // ── 波形(N163: 0-15 / FDS: 0-63) ──────────────────────────────────
  function presetWave(kind, len, max) {
    const out = new Array(len);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      let v;
      if (kind === 'pulse50') v = i < len / 2 ? 1 : 0;
      else if (kind === 'triangle') v = t < 0.5 ? t * 2 : 2 - t * 2;
      else if (kind === 'saw') v = t;
      else v = 0.5 + 0.5 * Math.sin(2 * Math.PI * t); // sin(既定)
      out[i] = Math.round(v * max);
    }
    return out;
  }
  // 元行の現在波形(鍵盤表示 ch.wave.data。長さ・値域はチップごとに違う)を len 点・0..max へ正規化
  function waveFromSource(data, len, max) {
    const n = data.length;
    if (!n) return null;
    let lo = Infinity, hi = -Infinity;
    for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const out = new Array(len);
    if (!(hi > lo)) { out.fill(Math.round(max / 2)); return out; }
    for (let i = 0; i < len; i++) {
      const v = data[Math.floor(i * n / len)];
      out[i] = Math.round((v - lo) / (hi - lo) * max);
    }
    return out;
  }

  class AssignPreview {
    constructor(sampleRate) {
      this.sampleRate = sampleRate || 44100;
      this.enabled = false;
      this.hostGain = NSF_GAIN;   // 乗せ先プレイヤーの gainNode 値。NSF再生と同じ音量に補正する
      this.provider = null;
      this.rows = [];
      this.apu = null;
      this.exp = {};
      this.expList = [];
      this._states = new Map();
      this._vrc7Custom = { bytes: null, owner: null };
      this._n163 = { num: 0, waveLen: 16 };
      this._fdsWaveSig = '';
      this.cycleAccum = 0; this.dcX = 0; this.dcY = 0;
      this._built = false;
    }

    setProvider(fn) { this.provider = fn; }

    // rows: [{ id, target, tone, kind, muted }]。スキップ/E(DPCM)は対象外(元の音のまま/無音は
    // 鍵盤表示側のミュートが担う)
    /**
     * 曲・チップ単位の音量正規化オフセット(dB)。変換(vgm2mml)と同じ基準を使うため、
     * main.js が Vgm2MmlExpansion.attRefOfSnapshots で作った値をそのまま渡す。
     * 渡さない/対象外のチップは 0(従来どおりの絶対値マッピング)。
     */
    setVolumeRefs(refs) { this._volRefs = refs || null; }

    setPlan(rows) {
      const P = plan();
      const next = [];
      for (const r of rows || []) {
        if (!P || !r.target || r.target === 'skip' || r.target === 'dpcm') continue;
        const tt = P.targetInfo(r.target);
        if (!tt || !tt.chip) continue;
        next.push({ id: r.id, target: r.target, tone: r.tone, kind: r.kind || 'any', muted: !!r.muted,
          chip: tt.chip, family: tt.family, index: tt.index, letter: tt.letter,
          volSpec: Object.assign(volSpecOf(r.id), { chipKey: rowChipOf(r.id) }) });
      }
      const sig = next.map(r => r.id + '=' + r.target + '/' + r.tone).join(',');
      if (this._built && sig === this._planSig) {
        // 行と音色が同じ(ミュートだけ変わった)ならチップは作り直さない
        for (let i = 0; i < next.length; i++) this.rows[i].muted = next[i].muted;
        return;
      }
      this.rows = next;
      this._planSig = sig;
      this._build();
    }

    reset() { this._build(); }

    // 必要なチップだけ作り直して初期化する(setPlan/曲切替/停止のたび)
    _build() {
      const Emu = MML.Emu;
      this._states.clear();
      this._vrc7Custom = { bytes: null, owner: null };
      this._fdsWaveSig = '';
      this.cycleAccum = 0; this.dcX = 0; this.dcY = 0;
      this.exp = {}; this.expList = [];
      this._built = false;
      if (!Emu || !Emu.APU2A03 || !pitchRegs()) return;
      this.apu = new Emu.APU2A03(null);
      this.apu.writeRegister(0x4015, 0x0F);
      this.apu.writeRegister(0x4001, 0x08); // スイープ誤ミュート防止の定石(compiler.js参照)
      this.apu.writeRegister(0x4005, 0x08);
      const chips = new Set(this.rows.map(r => r.chip));
      const mk = { vrc6: 'VRC6Audio', vrc7: 'VRC7Audio', fds: 'FDSAudio', mmc5: 'MMC5Audio', n163: 'N163Audio', fme7: 'FME7Audio' };
      for (const c of chips) {
        if (mk[c] && Emu[mk[c]]) { this.exp[c] = new Emu[mk[c]](); this.expList.push(this.exp[c]); }
      }
      if (this.exp.mmc5) this.exp.mmc5.writeRegister(0x5015, 0x03);
      if (this.exp.fme7) {
        // R7ミキサー: 使うchのトーンだけ有効(bit=0)、ノイズは全部無効
        let mixer = 0x3F;
        for (const r of this.rows) if (r.chip === 'fme7') mixer &= ~(1 << r.index);
        this.exp.fme7.writeRegister(0xC000, 7); this.exp.fme7.writeRegister(0xE000, mixer);
      }
      if (this.exp.fds) {
        this.exp.fds.writeRegister(0x4080, 0x80); // ゲイン0(直接指定)
        this.exp.fds.writeRegister(0x4084, 0x80); // 変調ゲイン0
        this.exp.fds.writeRegister(0x4087, 0x80); // 変調停止
        this.exp.fds.writeRegister(0x4083, 0x80); // 停止
      }
      if (this.exp.n163) {
        let num = 0;
        for (const r of this.rows) if (r.chip === 'n163') num = Math.max(num, r.index + 1);
        num = clamp(num, 1, N163_CHANNEL_COUNT);
        // 波形RAMは 128 - 8*num バイト。4ch以下なら変換(SCC等)と同じ32サンプル、それ以上は16
        this._n163 = { num, waveLen: num <= 4 ? 32 : 16 };
        this.exp.n163.writeRegister(0xF800, 0x7F | 0x80);
        this.exp.n163.writeRegister(0x4800, (num - 1) << 4);
      }
      this._built = true;
    }

    _state(id) {
      let st = this._states.get(id);
      if (!st) {
        st = { active: false, hi: -1, freqReg: -1, vol: -1, prevVol: 0, peak: 0, decayed: false,
               noiseIdx: -1, inst: -1, waveSig: '', fnum: -1, block: -1 };
        this._states.set(id, st);
      }
      return st;
    }

    // ── 毎フレーム ─────────────────────────────────────────────────
    onFrame(frameIdx) {
      if (!this._built || !this.provider || !this.rows.length) return;
      let channels = null;
      try { channels = this.provider(frameIdx); } catch (e) { console.error('[AssignPreview] provider failed:', e); return; }
      if (!channels) return;
      const byId = new Map();
      for (const c of channels) if (c && c.id) byId.set(c.id, c);
      for (const r of this.rows) this._applyRow(r, byId.get(r.id) || null);
    }

    _applyRow(r, ch) {
      const st = this._state(r.id);
      const isNoise = r.family === 'noise';
      let on = !r.muted && !!ch && !!ch.active && (ch.vol || 0) > 0;
      let freq = ch ? (ch.freq || 0) : 0;
      let noiseIdx = -1;
      if (on) {
        if (isNoise) {
          if (ch.noise && ch.noiseIndex !== undefined && ch.noiseIndex !== null) noiseIdx = clamp(Math.round(ch.noiseIndex), 0, 15);
          else if (freq > 0) noiseIdx = plan().noiseIndexFor(r.tone, freq, fmCarrierMul(ch)); // 変換(borrow.js pitchedToNoise)と同じ式
          else on = false;
        } else if (!(freq > 0) || ch.noise) {
          on = false;
        }
      }
      const vol01 = on ? Math.min(1, ch.vol) : 0;
      // 再アタック: 消えていた→鳴った、または減衰した状態からの跳ね上がり
      let keyOn = false;
      if (on) {
        if (!st.active) keyOn = true;
        else if (st.decayed && vol01 - st.prevVol >= REATTACK_RISE) keyOn = true;
        if (keyOn) { st.peak = vol01; st.decayed = false; }
        else { if (vol01 > st.peak) st.peak = vol01; if (vol01 <= st.peak * 0.75) st.decayed = true; }
        st.prevVol = vol01;
      } else {
        st.prevVol = 0; st.peak = 0; st.decayed = false;
      }

      const att = attDbOf(r.volSpec, vol01, this._volRefs);
      const vol = on ? targetVol(r.family, att) : 0;
      switch (r.family) {
        case 'pulse': this._pulse(r, st, ch, on, keyOn, freq, vol); break;
        case 'triangle': this._triangle(r, st, on, keyOn, freq); break;
        case 'noise': this._noise(r, st, ch, on, keyOn, noiseIdx, vol); break;
        case 'vrc6pulse': this._vrc6Pulse(r, st, on, keyOn, freq, vol); break;
        case 'vrc6saw': this._vrc6Saw(r, st, on, keyOn, freq, vol); break;
        case 'fme7': this._fme7(r, st, on, freq, vol); break;
        case 'fds': this._fds(r, st, ch, on, keyOn, freq, vol); break;
        case 'n163': this._n163Row(r, st, ch, on, freq, vol); break;
        case 'vrc7': this._vrc7(r, st, ch, on, keyOn, freq, vol); break;
        default: break;
      }
      st.active = on;
    }

    _w(chip, addr, value) {
      const c = chip ? this.exp[chip] : this.apu;
      if (c) c.writeRegister(addr, value & 0xFF);
    }
    _duty4(r) { const t = parseInt(r.tone, 10); return (isFinite(t) ? t : 2) & 3; }
    _duty8(r) { const t = parseInt(r.tone, 10); return (isFinite(t) ? t : 7) & 7; }

    // 2A03 パルス(A/B) / MMC5 パルス
    _pulse(r, st, ch, on, keyOn, freq, vol) {
      const R = pitchRegs();
      const chip = r.chip === 'mmc5' ? 'mmc5' : null;
      const base = chip ? (r.index === 0 ? 0x5000 : 0x5004) : (r.letter === 'A' ? 0x4000 : 0x4004);
      const duty = this._duty4(r);
      if (!on) {
        if (st.active) this._w(chip, base + 0, (duty << 6) | 0x30);
        return;
      }
      const period = R.pulsePeriod(freq);
      const hi = (period >> 8) & 7;
      if (period !== st.freqReg) { this._w(chip, base + 2, period & 0xFF); st.freqReg = period; }
      // 上位バイト書込みは位相リセットを伴うので、変わった時とアタック時だけ(compiler.jsと同じ)
      if (hi !== st.hi || keyOn) { this._w(chip, base + 3, hi); st.hi = hi; }
      if (vol !== st.vol || keyOn) { this._w(chip, base + 0, (duty << 6) | 0x30 | vol); st.vol = vol; }
    }

    _triangle(r, st, on, keyOn, freq) {
      const R = pitchRegs();
      if (!on) { if (st.active) this._w(null, 0x4008, 0x80); return; }
      const period = R.trianglePeriod(freq);
      const hi = (period >> 8) & 7;
      if (period !== st.freqReg) { this._w(null, 0x400A, period & 0xFF); st.freqReg = period; }
      if (hi !== st.hi || keyOn) { this._w(null, 0x400B, hi); st.hi = hi; }
      if (keyOn) this._w(null, 0x4008, 0xFF);
    }

    _noise(r, st, ch, on, keyOn, idx, vol) {
      if (!on) { if (st.active) this._w(null, 0x400C, 0x30); return; }
      const short = ch.noiseShort !== undefined ? !!ch.noiseShort : !!(ch.wave && ch.wave.short);
      const reg = (short ? 0x80 : 0) | (idx & 0x0F);
      if (reg !== st.noiseIdx || keyOn) { this._w(null, 0x400E, reg); this._w(null, 0x400F, 0x00); st.noiseIdx = reg; }
      if (vol !== st.vol || keyOn) { this._w(null, 0x400C, 0x30 | vol); st.vol = vol; }
    }

    _vrc6Pulse(r, st, on, keyOn, freq, vol) {
      const R = pitchRegs();
      const base = r.index === 0 ? 0x9000 : 0xA000;
      const duty = this._duty8(r) << 4;
      if (!on) { if (st.active) this._w('vrc6', base + 0, duty); return; }
      // VRC6 パルスの周期は12bit(compiler.js vrc6PulsePeriod。2A03 の pulsePeriod は11bitで A1 に貼り付く)
      const period = clamp((R.vrc6PulsePeriod || R.pulsePeriod)(freq), 0, 0xFFF);
      const hi = 0x80 | ((period >> 8) & 0x0F);
      if (period !== st.freqReg) { this._w('vrc6', base + 1, period & 0xFF); st.freqReg = period; }
      if (hi !== st.hi || keyOn) { this._w('vrc6', base + 2, hi); st.hi = hi; }
      if (vol !== st.vol || keyOn) { this._w('vrc6', base + 0, duty | vol); st.vol = vol; }
    }

    _vrc6Saw(r, st, on, keyOn, freq, vol) {
      const R = pitchRegs();
      if (!on) { if (st.active) this._w('vrc6', 0xB000, 0); return; }
      const period = R.sawPeriod(freq);
      const hi = 0x80 | ((period >> 8) & 0x0F);
      if (period !== st.freqReg) { this._w('vrc6', 0xB001, period & 0xFF); st.freqReg = period; }
      if (hi !== st.hi || keyOn) { this._w('vrc6', 0xB002, hi); st.hi = hi; }
      if (vol !== st.vol || keyOn) { this._w('vrc6', 0xB000, Math.min(63, vol)); st.vol = vol; }
    }

    _fme7(r, st, on, freq, vol) {
      const R = pitchRegs();
      const volReg = 8 + r.index;
      if (!on) { if (st.active) { this._w('fme7', 0xC000, volReg); this._w('fme7', 0xE000, 0); } return; }
      const period = R.fme7Period(freq);
      if (period !== st.freqReg) {
        this._w('fme7', 0xC000, r.index * 2); this._w('fme7', 0xE000, period & 0xFF);
        this._w('fme7', 0xC000, r.index * 2 + 1); this._w('fme7', 0xE000, (period >> 8) & 0x0F);
        st.freqReg = period;
      }
      if (vol !== st.vol) { this._w('fme7', 0xC000, volReg); this._w('fme7', 0xE000, vol); st.vol = vol; }
    }

    // 借用先の波形(N163=0-15 / FDS=0-63)。tone: 'copy'(既定) | 'pulse50' | 'sin' | 'triangle' | 'saw'
    _waveFor(r, ch, len, max) {
      const tone = r.tone || 'copy';
      if (tone !== 'copy') return presetWave(tone, len, max);
      const w = ch && ch.wave;
      if (w && w.t === 'wave' && w.data && w.data.length && r.kind !== 'brr') {
        const out = waveFromSource(w.data, len, max);
        if (out) return out;
      }
      // 波形メモリを持たない元(パルス/FM/BRR)の「コピー」: 変換側の既定と同じ矩形波(N163)/サイン(FDS)
      return max === 63 ? presetWave('sin', len, max) : presetWave('pulse50', len, max);
    }

    _fds(r, st, ch, on, keyOn, freq, vol) {
      const R = pitchRegs();
      if (!on) {
        if (st.active) this._w('fds', 0x4083, 0x80 | ((st.freqReg >> 8) & 0x0F));
        return;
      }
      const wave = this._waveFor(r, ch, 64, 63);
      const sig = wave.join(',');
      if (sig !== this._fdsWaveSig) {
        this._w('fds', 0x4089, 0x80);
        for (let i = 0; i < 64; i++) this._w('fds', 0x4040 + i, wave[i] & 0x3F);
        this._w('fds', 0x4089, 0x00);
        this._fdsWaveSig = sig;
      }
      const period = R.fdsFreqToPeriod(freq);
      const hi = (period >> 8) & 0x0F;
      if (period !== st.freqReg) { this._w('fds', 0x4082, period & 0xFF); st.freqReg = period; }
      if (hi !== st.hi || keyOn) { this._w('fds', 0x4083, hi); st.hi = hi; }
      if (vol !== st.vol || keyOn) { this._w('fds', 0x4080, 0x80 | Math.min(63, vol)); st.vol = vol; }
    }

    _n163Row(r, st, ch, on, freq, vol) {
      const R = pitchRegs();
      const { num, waveLen } = this._n163;
      if (r.index >= num) return;
      const internalIdx = (N163_CHANNEL_COUNT - num) + r.index;
      const regBase = 0x40 + internalIdx * 8;
      const isTop = (regBase + 7) === 0x7F;
      const volByte = v => (isTop ? ((num - 1) << 4) : 0) | (v & 0x0F);
      if (!on) {
        if (st.active) { this._w('n163', 0xF800, (regBase + 7) | 0x80); this._w('n163', 0x4800, volByte(0)); }
        return;
      }
      const byteOffset = r.index * (waveLen / 2);
      const wave = this._waveFor(r, ch, waveLen, 15);
      const sig = wave.join(',');
      const lengthByte = (256 - waveLen) & 0xFC;
      if (sig !== st.waveSig) {
        this._w('n163', 0xF800, byteOffset | 0x80);
        for (let i = 0; i < waveLen; i += 2) this._w('n163', 0x4800, (wave[i] & 0x0F) | ((wave[i + 1] & 0x0F) << 4));
        this._w('n163', 0xF800, (regBase + 6) | 0x80);
        this._w('n163', 0x4800, byteOffset * 2);
        st.waveSig = sig;
        st.freqReg = -1; // 波形長レジスタ(+4)も書き直す
      }
      const freqReg = R.n163FreqReg(freq, waveLen, num);
      if (freqReg !== st.freqReg) {
        this._w('n163', 0xF800, regBase + 0); this._w('n163', 0x4800, freqReg & 0xFF);
        this._w('n163', 0xF800, regBase + 2); this._w('n163', 0x4800, (freqReg >> 8) & 0xFF);
        this._w('n163', 0xF800, regBase + 4); this._w('n163', 0x4800, lengthByte | ((freqReg >> 16) & 0x03));
        st.freqReg = freqReg;
      }
      if (vol !== st.vol) { this._w('n163', 0xF800, (regBase + 7) | 0x80); this._w('n163', 0x4800, volByte(vol)); st.vol = vol; }
    }

    // VRC7の音色番号を決める。自作音色(@0)は1系統だけなので、先に確保した行が鳴っている間は
    // 他の行を最寄りの内蔵音色へ落とす(src/convert/vrc7Tone.js resolveConflicts と同じ方針)
    _vrc7Inst(r, ch) {
      const tone = r.tone;
      const n = parseInt(tone, 10);
      if (isFinite(n) && n >= 1 && n <= 15) return n;
      let bytes = null, inst = -1;
      const p = ch && ch.fmPatch;
      if (p && p.type === 'opll') {
        if (tone === 'auto' && p.inst > 0) inst = p.inst;
        else bytes = opllBytes(p);
      } else if (p && p.type === 'opn' && MML.VGM2MML && MML.VGM2MML.opnToOpllBytes) {
        bytes = MML.VGM2MML.opnToOpllBytes(p);
      }
      if (inst >= 0) return inst;
      if (!bytes) return 1;
      const cu = this._vrc7Custom;
      if (sameBytes(cu.bytes, bytes)) { cu.owner = cu.owner || r.id; return 0; }
      const ownerSt = cu.owner ? this._states.get(cu.owner) : null;
      if (!cu.owner || cu.owner === r.id || !ownerSt || !ownerSt.active) {
        for (let i = 0; i < 8; i++) { this._w('vrc7', 0x9010, i); this._w('vrc7', 0x9030, bytes[i]); }
        cu.bytes = bytes.slice(); cu.owner = r.id;
        return 0;
      }
      const V = MML.Convert && MML.Convert.Vrc7Tone;
      const near = V && V.nearestPreset ? V.nearestPreset(bytes) : 1;
      return clamp(near || 1, 1, 15);
    }

    _vrc7(r, st, ch, on, keyOn, freq, vol) {
      const R = pitchRegs();
      const c = r.index;
      if (!on) {
        if (st.active) { this._w('vrc7', 0x9010, 0x20 + c); this._w('vrc7', 0x9030, (st.block << 1) | ((st.fnum >> 8) & 1)); }
        return;
      }
      const { fnum, block } = R.vrc7FreqToFnumBlock(freq);
      if (keyOn) {
        const inst = this._vrc7Inst(r, ch);
        st.inst = inst;
        this._w('vrc7', 0x9010, 0x10 + c); this._w('vrc7', 0x9030, fnum & 0xFF);
        // キーオンはエッジトリガなので必ずオフを1回挟む(compiler.js segmentsToWriteLogVrc7と同じ)
        this._w('vrc7', 0x9010, 0x20 + c); this._w('vrc7', 0x9030, (block << 1) | ((fnum >> 8) & 1));
        this._w('vrc7', 0x9010, 0x20 + c); this._w('vrc7', 0x9030, 0x10 | (block << 1) | ((fnum >> 8) & 1));
        this._w('vrc7', 0x9010, 0x30 + c); this._w('vrc7', 0x9030, (inst << 4) | vol);
        st.fnum = fnum; st.block = block; st.vol = vol;
        return;
      }
      if (fnum !== st.fnum || block !== st.block) {
        this._w('vrc7', 0x9010, 0x10 + c); this._w('vrc7', 0x9030, fnum & 0xFF);
        this._w('vrc7', 0x9010, 0x20 + c); this._w('vrc7', 0x9030, 0x10 | (block << 1) | ((fnum >> 8) & 1));
        st.fnum = fnum; st.block = block;
      }
      if (vol !== st.vol) { this._w('vrc7', 0x9010, 0x30 + c); this._w('vrc7', 0x9030, ((st.inst < 0 ? 1 : st.inst) << 4) | vol); st.vol = vol; }
    }

    // ── 出力1サンプル(メインスレッドの onaudioprocess から毎サンプル呼ぶ) ──────────
    render() {
      if (!this._built) return 0;
      this.cycleAccum += CPU_CLOCK_NTSC / this.sampleRate;
      const list = this.expList;
      while (this.cycleAccum >= 1) {
        this.apu.clock();
        for (let i = 0; i < list.length; i++) list[i].clock();
        this.cycleAccum -= 1;
      }
      let raw = this.apu.mixSample();
      for (let i = 0; i < list.length; i++) raw += list[i].mixSample();
      const y = raw - this.dcX + 0.999 * this.dcY;
      this.dcX = raw; this.dcY = y;
      return y * (NSF_GAIN / (this.hostGain || NSF_GAIN));
    }
  }

  MML.Audio.AssignPreview = AssignPreview;
})(typeof window !== 'undefined' ? window : globalThis);
