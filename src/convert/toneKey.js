/*
 * 音色の同定キー — MML.Convert.ToneKey (2026-09-09、音色別指定「音色一覧」の土台)
 *
 * 「変換元チャンネルの中で使われている音色(楽器)1つ」を、形式に依らない文字列キーで同定する。
 * 設定(src/convert/toneSettings.js)はこのキーで持つので、同じ音色が別チャンネルに出ても・
 * 同じゲームの別トラックでも同じ設定が効く(DPCMパッドの「サンプル内容ハッシュ」と同じ考え方。
 * src/convert/drumSamples.js 冒頭参照)。
 *
 * キーの形(先頭の種別で見分ける):
 *   'brr:<hash>'    SPCのBRRサンプル(MML.SPC2MML.brrHash と同じ値)
 *   'pcm:<hash>'    VGMのサンプルPCM(Emu.SamplePitchUtil.sampleHash)
 *   'opn:<hash>'    OPN/OPM系4op FM音色(キャリアのTLは音量なので除いて同定)
 *   'opll:<n>'      OPLL/VRC7の内蔵音色 @1-@15
 *   'opllc:<hash>'  OPLL/VRC7 自作音色(レジスタ$00-$07の8バイト)。OPL(2op)の音色はOPLL形式へ
 *                   変換済みのバイト列で同定する(抽出器 kss2mml/expansion/opl.js が変換する)
 *   'wave:<hash>'   波形メモリ(SCC/GB波形/HuC6280/N163/FDS)。32点・0..15へ正規化してから同定
 *   'duty:<n>'      デューティ矩形波(2A03/MMC5/GB=0-3、VRC6=0-7)
 *   'sq:<chip>'     デューティ固定の矩形波(AY/SN76489)。チップに1音色
 *   'tri' / 'saw' / 'noise' / 'sample'  音色の区別を持たない行
 *
 * ★同じ音色を「抽出器のイベント」(ofEvent)と「鍵盤/ロールのライブ状態」(ofLive)の両方から
 *   同じキーに落とせることが要件。ロールのノートに載せたキーで音色一覧を組み、変換側は
 *   イベントから引いた同じキーで設定を適用する。片方だけ変えるとキーが食い違って設定が効かなくなる。
 *
 * Worker(ロール構築 src/audio/roll-builders.js)でも動かすのでDOM/localStorageは触らない。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  const WAVE_LEN = 32;

  // FNV-1a 32bit(整数列)。sampleHash と同じ系のハッシュだが入力が整数配列なので別実装
  function fnv(values, seed) {
    let h = seed === undefined ? 0x811c9dc5 : seed;
    for (let i = 0; i < values.length; i++) {
      const v = values[i] | 0;
      h ^= v & 0xff; h = Math.imul(h, 0x01000193);
      h ^= (v >>> 8) & 0xff; h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  /** 任意長・任意値域の1周期波形 → 32点・0..15 の正規化波形(同定と表示に使う) */
  function normalizeWave(data) {
    if (!data || !data.length) return null;
    const n = data.length;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { const v = +data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const out = new Array(WAVE_LEN);
    if (!(hi > lo)) { out.fill(8); return out; }
    for (let i = 0; i < WAVE_LEN; i++) {
      const v = +data[Math.floor(i * n / WAVE_LEN)];
      out[i] = Math.max(0, Math.min(15, Math.round((v - lo) / (hi - lo) * 15)));
    }
    return out;
  }
  function waveKey(data) {
    const w = normalizeWave(data);
    return w ? 'wave:' + fnv(w) : null;
  }

  // ── OPN/OPM 4op ───────────────────────────────────────────────────
  // 各アルゴリズムのキャリア(出力に直結するop、論理op番号0-3)。キャリアのTLは音量なので同定から外す
  const OPN_CARRIERS = [[3], [3], [3], [3], [1, 3], [1, 2, 3], [1, 2, 3], [0, 1, 2, 3]];
  const OP_FIELDS = ['DT', 'ML', 'TL', 'KS', 'AR', 'DR', 'SR', 'SL', 'RR', 'AM', 'SE', 'DT2'];
  function opnKey(p) {
    if (!p || !p.ops || !p.ops.length) return null;
    const alg = (p.AL || 0) & 7;
    const carriers = OPN_CARRIERS[alg];
    const vals = [alg, (p.FB || 0) & 7];
    for (let i = 0; i < p.ops.length; i++) {
      const o = p.ops[i] || {};
      for (const f of OP_FIELDS) {
        let v = o[f];
        if (v === undefined) v = 0;
        if (f === 'TL' && carriers.indexOf(i) >= 0) v = 0;
        vals.push(v);
      }
    }
    return 'opn:' + fnv(vals);
  }

  // ── OPLL/VRC7 ─────────────────────────────────────────────────────
  // {mod, car} 形式の音色 → レジスタ$00-$07の8バイト(src/ui/keyboard.js opllPatchBytes と同じ並び)
  function opllBytesOf(p) {
    const m = p && p.mod, c = p && p.car;
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
  function opllCustomKey(bytes) {
    if (!bytes || bytes.length < 8) return null;
    return 'opllc:' + fnv(Array.from(bytes).slice(0, 8));
  }
  function opllKey(inst, bytes) {
    const n = inst | 0;
    if (n > 0 && n <= 15) return 'opll:' + n;
    return opllCustomKey(bytes);
  }

  // ── 抽出器イベント → キー ─────────────────────────────────────────
  // ctx: { chip, kind, brrSamples? }(borrow.js の source s をそのまま渡せる)
  // 抽出器がイベントに載せる同定情報:
  //   ev.srcn(SPC) / ev.sampleHash(VGM PCM) / ev.opnPatch(OPN系) / ev.srcTone(OPLL/OPL 8バイト) /
  //   ev.instrument(OPLLの内蔵音色番号・GB/2A03デューティ) / ev.srcWave(波形メモリの生波形)
  function ofEvent(ev, ctx) {
    if (!ev || ev.note === null) return null;
    const chip = ctx && ctx.chip;
    if (ev.srcn !== undefined && ctx && ctx.brrSamples) {
      const h = MML.SPC2MML && MML.SPC2MML.brrHash ? MML.SPC2MML.brrHash(ctx.brrSamples[ev.srcn]) : null;
      return h ? 'brr:' + h : 'brr:srcn' + ev.srcn;
    }
    if (ev.sampleHash) return 'pcm:' + ev.sampleHash;
    if (ev.opnPatch) return opnKey(ev.opnPatch);
    if (chip === 'ym2413' || chip === 'opl' || chip === 'vrc7') {
      if (ev.srcTone) return opllCustomKey(ev.srcTone);
      if (ev.instrument > 0) return 'opll:' + (ev.instrument & 15);
      return null;
    }
    if (ev.srcWave) return waveKey(ev.srcWave);
    if (chip === 'ay8910' || chip === 'sn76489') return 'sq:' + chip;
    if (chip === 'gb' && ctx.kind === 'square') return ev.instrument !== undefined ? 'duty:' + (ev.instrument & 3) : 'duty:2';
    return null;
  }

  // ── 鍵盤/ロールのライブ状態(extractChannels の1行) → キー ─────────────────
  // 同定に使うのは: ch.fmPatch(OPN/OPM/OPLL) / ch.sampleHash(サンプルPCM) / ch.wave(波形) / ch.duty
  const patchKeyCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function ofLive(ch) {
    if (!ch) return null;
    if (ch.srcn !== undefined && ch.brrHash) return 'brr:' + ch.brrHash;
    if (ch.sampleHash) return 'pcm:' + ch.sampleHash;
    const p = ch.fmPatch;
    if (p) {
      if (patchKeyCache && typeof p === 'object') {
        const c = patchKeyCache.get(p);
        if (c !== undefined) return c;
      }
      let k = null;
      if (p.type === 'opll') k = opllKey(p.inst, opllBytesOf(p));
      else if (p.ops) k = opnKey(p);
      if (patchKeyCache && typeof p === 'object') patchKeyCache.set(p, k);
      return k;
    }
    const w = ch.wave;
    if (ch.noise) return 'noise';
    if (!w) return null;
    if (w.t === 'wave' && w.data && w.data.length) return waveKey(w.data);
    if (w.t === 'pulse') {
      if (ch.duty !== undefined && ch.duty !== null) return 'duty:' + ch.duty;
      if (/^(KP|SN)\d/.test(ch.id || '')) return 'sq:' + (/^SN/.test(ch.id) ? 'sn76489' : 'ay8910');
      return null;
    }
    if (w.t === 'tri') return 'tri';
    if (w.t === 'saw') return 'saw';
    if (w.t === 'sample') return 'sample';
    return null;
  }

  // ── 表示・試聴用の付随情報(キーだけでは音が作れないので、初出時に一緒に控える) ────
  //   { kind:'brr'|'pcm'|'opn'|'opll'|'wave'|'duty'|'sq'|'other', label, wave?(32点0..15), patch?, bytes?, inst?, duty? }
  function infoOfLive(ch, key) {
    if (!key) return null;
    const kind = key.split(':')[0];
    const info = { kind: kind === 'opllc' ? 'opll' : kind, label: '' };
    const p = ch.fmPatch;
    if (info.kind === 'opll' && p) {
      info.inst = p.inst | 0;
      info.bytes = opllBytesOf(p);
      info.label = info.inst > 0 ? '@' + info.inst : 'OP';
    } else if (info.kind === 'opn' && p) {
      info.patch = p;
      info.label = 'FM' + (p.AL !== undefined ? ' AL' + p.AL : '');
    } else if (info.kind === 'wave' && ch.wave && ch.wave.data) {
      info.wave = normalizeWave(ch.wave.data);
      info.label = 'wave';
    } else if (info.kind === 'duty') {
      info.duty = ch.duty | 0;
      info.label = 'duty ' + info.duty;
    } else if (info.kind === 'sq') {
      info.label = 'square';
    } else if (info.kind === 'pcm') {
      info.sample = ch.adpcmSample || null;
      info.label = 'PCM';
    }
    return info;
  }
  function infoOfEvent(ev, ctx, key) {
    if (!key) return null;
    const kind = key.split(':')[0];
    const info = { kind: kind === 'opllc' ? 'opll' : kind, label: '' };
    if (info.kind === 'opll') {
      if (ev.srcTone) { info.bytes = Array.from(ev.srcTone).slice(0, 8); info.inst = 0; info.label = 'OP'; }
      else { info.inst = ev.instrument | 0; info.label = '@' + info.inst; }
    } else if (info.kind === 'opn') {
      info.patch = ev.opnPatch; info.label = 'FM AL' + (ev.opnPatch.AL | 0);
    } else if (info.kind === 'wave') {
      info.wave = normalizeWave(ev.srcWave); info.label = 'wave';
    } else if (info.kind === 'duty') {
      info.duty = ev.instrument | 0; info.label = 'duty ' + info.duty;
    } else if (info.kind === 'sq') {
      info.label = 'square';
    } else if (info.kind === 'brr') {
      info.srcn = ev.srcn; info.label = 'srcn' + ev.srcn;
    } else if (info.kind === 'pcm') {
      info.label = 'PCM';
    }
    return info;
  }

  /** 設定を持てるキーか(音色の区別が無い 'tri'/'saw'/'noise'/'sample' は対象外) */
  function isAssignable(key) {
    return !!key && /^(brr|pcm|opn|opll|opllc|wave|duty|sq):/.test(key);
  }

  MML.Convert.ToneKey = {
    WAVE_LEN, fnv, normalizeWave, waveKey, opnKey, opllBytesOf, opllKey, opllCustomKey,
    ofEvent, ofLive, infoOfLive, infoOfEvent, isAssignable,
  };
})(typeof window !== 'undefined' ? window : globalThis);
