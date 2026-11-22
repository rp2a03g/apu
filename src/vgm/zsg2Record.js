/*
 * ZOOM 音源基板(ZSG-2+TMS57002)の書き込み列 → VGM(規格外ブロック ZSGX。読む側は vgmHeader.js / vgmPlayer.js)。
 *
 *   MML.VGM.zsg2ToWrites(events, start, seconds, keepAll, resetAtN)   時刻つきの書き込み → VGM に入れる書き込み列
 *   MML.VGM.zsg2PickLoop(writes, endN)                                 ループと継ぎ目を探す
 *   MML.VGM.encodeZsg2Recording({ wave, events, start, seconds, tags, autoLoop })   上の 2 つを通して VGM のバイト列にする
 *   MML.VGM.recordZoomSong({ program, wave, code, … })                 サウンド基板(src/emulator/zsg2/)を動かして 1 曲を VGM にする
 *
 * events = [{ t(秒), o(通し番号), reg, value }]。reg は ZSG-2 のレジスタ番号(0〜0x3FF)か、
 *   0x8000 = DSP へのデータ / 0x8001 = DSP の制御線 / 0x8002・0x8003 = 全体音量の左・右(0〜63)。
 * start = 曲の頭の時刻(サウンドコードを送った時)。それより前の書き込み(起動時の DSP のプログラム・係数・音源の初期設定)は時刻 0 にまとめる。
 *
 * 決まりごと(どれも実測で決めた物):
 *   - 時刻は「音源の何サンプル目の前に効くか」(n)で持ち、VGM の位置は s = ceil(n × 44100 / 32552)。読む側は n = floor(s × 32552 / 44100) で戻す
 *   - 値が変わらない ZSG-2 の書き込みは落とす(ドライバが毎回 48 声ぶん書き直す)。今の音量(B)・今のフィルタ(9)・キーオン/オフは落とさない。
 *     音量の速さ(F)はキーオンで音源側が書き換えるので、キーオンの後の最初の 1 回は同じ値でも残す
 *   - DSP の係数の更新は「DSP が 1 つ食べてから次」でないと別の番地に入る。曲の前の準備を時刻 0 にまとめる時は、
 *     元の列でサンプルの境目をまたいでいた所に 0x8004(DSP を無音で進める)を挟む
 *   - ループ: キーオンの列の照合で 1 周の長さを出す。声の番号は見ない(ドライバが 48 声を順繰りに使い回す)。
 *     1 周の終わりでは同じ音が別の声で鳴っているので、0x8005(2 声の中身を入れ替える)で頭の時の番号へ並べ直してから戻る
 *   - VGM の長さは 1 周の終わりより 2 サンプル短くする(本体はループで戻る時に 1 サンプル余分に進む。vgmPlayer.js makeZsg2Adapter)
 *   - 波形は、キーオンされた物を丸ごと入れる(読まれた所だけにすると、短く切った曲で音程判定と波形の同定が変わる)
 */
(function (root) {
  'use strict';
  const MML = root.MML = root.MML || {}, VGM = MML.VGM = MML.VGM || {}, Emu = MML.Emu = MML.Emu || {};
  const CLOCK = 25000000, RATE = Math.floor(CLOCK / 768), VGM_RATE = 44100, FRAME = 735;
  const CHIP_FRAME = RATE / 60, TOL = Math.round(CHIP_FRAME * 1.5);
  const TYPE = 0xBB, MAGIC = [0x5A, 0x53, 0x47, 0x58], VERSION = 1, KIND_HEADER = 0, KIND_ROM = 1, KIND_WRITES = 2, FLAG_DSP = 1, FLAG_LOOP = 2;
  const REG = { DSP_DATA: 0x8000, DSP_CTRL: 0x8001, GAIN_L: 0x8002, GAIN_R: 0x8003, DSP_RUN: 0x8004, VOICE_SWAP: 0x8005 };
  const u16 = (n) => [n & 0xFF, (n >> 8) & 0xFF];
  const u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];

  // イベントは時刻 t(秒)の代わりに n(音源の通しのサンプル番号)を持っていてもよい(実時間で録った物。秒を経由すると丸めで 1 サンプルずれるため)。
  // その時は start も秒ではなくサンプル番号で渡す(opt.startN)
  VGM.zsg2ToWrites = function (ev, start, seconds, keepAll, resetAtN, opt) {
    const byN = !!(opt && opt.startN !== undefined);
    const n0 = byN ? opt.startN : Math.floor(start * RATE), out = [], last = new Map();
    let prevDspN = -1, runs = 0, dropped = 0, reset = false;
    for (const e of ev) {
      const nAbs = byN ? e.n : Math.floor(e.t * RATE), pre = byN ? e.n < n0 : e.t < start;
      const n = pre ? 0 : nAbs - n0, s = pre ? 0 : Math.ceil(n * VGM_RATE / RATE);
      if (!pre && s >= seconds * VGM_RATE) break;
      if (resetAtN !== undefined && !reset && !pre && n >= resetAtN) { last.clear(); reset = true; }
      if (e.reg >= 0x8000) {
        if (e.reg === REG.GAIN_L || e.reg === REG.GAIN_R) { if (last.get(e.reg) === e.value) continue; last.set(e.reg, e.value); }
        else {
          if (pre && prevDspN >= 0 && nAbs > prevDspN) { out.push({ s: 0, n: 0, reg: REG.DSP_RUN, value: Math.min(2, nAbs - prevDspN) }); runs++; }
          prevDspN = nAbs;
        }
        out.push({ s, n, reg: e.reg, value: e.value });
        continue;
      }
      if (!keepAll && e.reg < 0x300) {
        const r = e.reg & 0xf;
        if (r !== 0x9 && r !== 0xb) { if (last.get(e.reg) === e.value) { dropped++; continue; } last.set(e.reg, e.value); }
      } else if (!keepAll && e.reg >= 0x300 && e.reg <= 0x302 && e.value) {
        for (let i = 0; i < 16; i++) if (e.value >> i & 1) last.delete(((e.reg - 0x300) * 16 + i) * 16 + 0xf);
      }
      out.push({ s, n, reg: e.reg, value: e.value });
    }
    // 曲の前の準備の締め: 最後の係数を DSP に食べさせる
    let k = out.length; while (k > 0 && out[k - 1].s > 0) k--;
    let lastPre = -1; for (let i = 0; i < k; i++) if (out[i].reg === REG.DSP_DATA || out[i].reg === REG.DSP_CTRL) lastPre = i;
    if (lastPre >= 0 && ev.length && (byN ? ev[0].n < n0 : ev[0].t < start)) { out.splice(lastPre + 1, 0, { s: 0, n: 0, reg: REG.DSP_RUN, value: 2 }); runs++; }
    return { ws: out, runs, dropped };
  };

  // ── ループ ──
  function keyOns(ws) {
    const reg = new Uint16Array(0x300), ev = [], ids = new Map();
    for (const w of ws) {
      if (w.reg < 0x300) { reg[w.reg] = w.value; continue; }
      if (w.reg > 0x302 || !w.value) continue;
      for (let i = 0; i < 16; i++) if (w.value >> i & 1) {
        const v = (w.reg - 0x300) * 16 + i; if (v >= 48) continue;
        const k = reg[v * 16 + 1] + ':' + reg[v * 16] + ':' + reg[v * 16 + 6] + ':' + reg[v * 16 + 4];
        let id = ids.get(k); if (id === undefined) ids.set(k, id = ids.size);
        ev.push({ t: w.n, key: id, v });
      }
    }
    return ev;
  }
  // 1 周の長さとイントロの終わり。確かめられた区間が min(1 周, 25 秒) 以上(かつ 10 秒以上)無ければ採らない(半周で採ると曲の中の繰り返しを見誤る)
  VGM.zsg2FindLoop = function (ws, endN, opt) { return VGM.loopFromKeyOns(keyOns(ws), endN, RATE, opt); };
  // キーオンの列 ev = [{ t(音源のサンプル数), key(同じ音なら同じ値) }] から 1 周の長さとイントロの終わりを出す(音源を問わない。rate = 音源の出力レート)
  VGM.loopFromKeyOns = function (ev, endN, RATE, opt) {
    const CHIP_FRAME = RATE / 60, TOL = Math.round(CHIP_FRAME * 1.5);
    const minLoop = ((opt && opt.minLoopSec) || 8) * RATE;
    if (ev.length < 40) return null;
    const byKey = new Map();
    for (const e of ev) { let a = byKey.get(e.key); if (!a) byKey.set(e.key, a = []); a.push(e.t); }
    const BIN = Math.round(CHIP_FRAME), votes = new Map();
    for (const ts of byKey.values()) for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length && j < i + 400; j++) {
      const d = ts[j] - ts[i]; if (d < minLoop) continue; if (d > endN * 0.75) break;
      const b = Math.round(d / BIN); votes.set(b, (votes.get(b) || 0) + 1);
    }
    if (!votes.size) return null;
    const score = (b) => (votes.get(b) || 0) + (votes.get(b - 1) || 0) + (votes.get(b + 1) || 0);
    const cands = Array.from(votes.keys()).sort((a, b) => score(b) - score(a)).slice(0, 60);
    const find = (key, t) => { const list = byKey.get(key); let lo = 0, hi = list.length; while (lo < hi) { const m = (lo + hi) >> 1; if (list[m] < t - TOL) lo = m + 1; else hi = m; } return lo < list.length && list[lo] <= t + TOL ? list[lo] : -1; };
    let best = null;
    for (const b of cands) {
      let T = b * BIN;
      for (let pass = 0; pass < 2; pass++) {
        const diffs = [];
        for (const e of ev) { if (e.t + T > endN - TOL) break; const m = find(e.key, e.t + T); if (m >= 0) diffs.push(m - e.t); }
        if (diffs.length < 20) { T = 0; break; }
        diffs.sort((x, y) => x - y); T = diffs[diffs.length >> 1];
      }
      if (!T) continue;
      let lastMiss = -1, checked = 0, matched = 0;
      for (const e of ev) { if (e.t + T > endN - TOL) break; checked++; if (find(e.key, e.t + T) >= 0) matched++; else if (e.t > lastMiss) lastMiss = e.t; }
      const start = lastMiss < 0 ? 0 : lastMiss + 1, verified = endN - T - start;
      if (verified < Math.max(10 * RATE, Math.min(T, 25 * RATE))) continue;
      const cand = { start, length: T, checked, matched, verified };
      if (!best || cand.length < best.length * 0.75) best = cand;   // 倍の周期も必ず通るので、同じくらい確かなら短い周期
    }
    return best;
  };
  // 音源を回して(音は作らない)、各時刻に鳴っている声(波形と周波数、今の音量)を取る。times は昇順
  function soundingAt(ws, times) {
    const chip = new Emu.Zsg2Audio(CLOCK, 0); chip.captureOnly = true;
    const res = []; let e = 0, cur = 0;
    for (const t of times) {
      while (cur < t) { for (; e < ws.length && ws[e].n <= cur; e++) if (ws[e].reg < 0x400) chip.write(ws[e].reg, ws[e].value); chip.clock(); cur++; }
      const list = [];
      for (let v = 0; v < 48; v++) { const c = chip.ch[v]; if (c.active && (c.vol > 0 || c.volTarget > 0)) list.push({ v, key: c.page + ':' + c.start + ':' + c.end + ':' + c.step, vol: Math.max(c.vol, c.volTarget) }); }
      res.push(list);
    }
    return res;
  }
  // 継ぎ目: ループの頭から 20 秒以内で、その時点 s と 1 周後 s+T とで「鳴っている音の集まり」が揃う所。相手のいない音が無い事が最優先
  function findSeam(ws, loop, endN) {
    return VGM.loopSeam({ sounding: (times) => soundingAt(ws, times), ctl: ws.filter((w) => w.reg >= 0x300 && w.reg <= 0x306 && w.value).map((w) => w.n), loop, endN, rate: RATE, voices: 48 });
  }
  // 音源を問わない形。o = { sounding(times) → 各時刻に鳴っている声 [{ v, key, vol(0〜65535) }] の配列, ctl(キーオン/キーオフの時刻の昇順の列), loop, endN, rate, voices }
  VGM.loopSeam = function (o) {
    const loop = o.loop, endN = o.endN, RATE = o.rate, CHIP_FRAME = RATE / 60, TOL = Math.round(CHIP_FRAME * 1.5);
    const step = Math.round(CHIP_FRAME), cand = [];
    for (let s = loop.start; s <= Math.min(endN - loop.length - TOL * 2, loop.start + 20 * RATE); s += step) cand.push(s);
    if (!cand.length) return { start: loop.start, carried: -1, lost: -1 };
    // 1 回の通しで両方の時刻を取る(頭側 cand[i] と 1 周後 cand[i] + T)
    const times = cand.map((s, i) => ({ t: s, i, b: 0 })).concat(cand.map((s, i) => ({ t: s + loop.length, i, b: 1 }))).sort((x, y) => x.t - y.t);
    const got = o.sounding(times.map((x) => x.t)), A = [], B = [];
    times.forEach((x, k) => { (x.b ? B : A)[x.i] = got[k]; });
    // キーオン/キーオフのすぐそば(±1.5 フレーム)は避ける: 周ごとに時刻が 1 フレームほど揺れるので、片方だけが継ぎ目をまたぐ
    const ctl = o.ctl;
    const busy = (t) => { let lo = 0, hi = ctl.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ctl[m] < t - TOL) lo = m + 1; else hi = m; } return lo < ctl.length && ctl[lo] <= t + TOL; };
    let best = null;
    for (let i = 0; i < cand.length; i++) {
      const a = A[i], b = B[i];
      const cnt = new Map(); for (const x of a) cnt.set(x.key, (cnt.get(x.key) || 0) + 1);
      let lost = 0; for (const x of b) { const c = cnt.get(x.key) || 0; if (c > 0) cnt.set(x.key, c - 1); else lost++; }
      for (const c of cnt.values()) lost += c;
      const load = a.reduce((s, x) => s + x.vol, 0) / 65535 + b.reduce((s, x) => s + x.vol, 0) / 65535;
      const score = lost * 1000 + ((busy(cand[i]) || busy(cand[i] + loop.length)) ? 50 : 0) + a.length + load + (cand[i] - loop.start) / RATE;
      if (!best || score < best.score) best = { start: cand[i], carried: a.length, carriedEnd: b.length, lost, load, score, a, b };
    }
    // 後始末: 1 周の終わりに鳴っている音(b)を、頭で鳴っていた音(a)と同じキーどうしで組にする。
    //   swaps = 終わりの声の中身を頭の時の声の番号へ移す入れ替えの列、stop = 相手のいない終わり側の声(止める)
    const used = new Set(), pairs = [], stop = [];
    for (const y of best.b) { const x = best.a.find((q) => q.key === y.key && !used.has(q)); if (x) { used.add(x); pairs.push([x.v, y.v]); } else stop.push(y.v); }
    const content = Array.from({ length: o.voices }, (_, i) => i), slotOf = content.slice(), swaps = [];
    for (const [va, vb] of pairs) {
      const cur = slotOf[vb]; if (cur === va) continue;
      swaps.push([cur, va]);
      const o1 = content[cur], o2 = content[va]; content[cur] = o2; content[va] = o1; slotOf[o1] = va; slotOf[o2] = cur;
    }
    best.stop = stop; best.swaps = swaps; delete best.a; delete best.b;
    return best;
  };
  /** ループと継ぎ目。戻り { start, length, stop, swaps, seam, found } か null(n はどれも音源のサンプル数) */
  VGM.zsg2PickLoop = function (ws, endN, opt) {
    const found = VGM.zsg2FindLoop(ws, endN, opt);
    if (!found) return null;
    if (found.start + found.length + TOL * 4 > endN) return null;
    const seam = findSeam(ws, { start: found.start, length: found.length }, endN);
    if (seam.carried < 0) return null;
    return { start: seam.start, length: found.length, stop: seam.stop, swaps: seam.swaps, seam, found };
  };

  // ── 符号化 ──
  const loopTotalS = (loop) => Math.ceil((loop.start + loop.length) * VGM_RATE / RATE) - 2;
  function seamWrites(loop) {
    const s = loopTotalS(loop) - 1, n = Math.floor(s * RATE / VGM_RATE), out = [];
    const bits = [0, 0, 0]; for (const v of loop.stop || []) bits[v >> 4] |= 1 << (v & 15);
    bits.forEach((b, k) => { if (b) out.push({ s, n, reg: 0x304 + k, value: b }); });
    for (const [a, b] of loop.swaps || []) out.push({ s, n, reg: REG.VOICE_SWAP, value: a << 8 | b });
    return out;
  }
  function concat(parts) {
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  const block = (kind, payload) => concat([[0x67, 0x66, TYPE, ...u32(payload.length + 6), ...MAGIC, VERSION, kind], payload]);
  function gd3(tags) {
    const strs = [tags.title, '', tags.game, '', tags.system || 'Taito FX-1B', '', tags.author, '', '', tags.creator || 'Sound Emulation Foundry', ''];
    const body = []; for (const x of strs) { const s = String(x || ''); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); body.push(c & 0xff, c >> 8); } body.push(0, 0); }
    return concat([[0x47, 0x64, 0x33, 0x20, 0x00, 0x01, 0x00, 0x00, ...u32(body.length)], body]);
  }
  /** 書き込み列(zsg2ToWrites の ws)→ VGM。loop があれば イントロ+1 周で切ってループ位置を入れる */
  VGM.zsg2Encode = function (wave, ws, seconds, tags, loop) {
    const toS = (n) => Math.ceil(n * VGM_RATE / RATE);
    if (loop) { const totalS = loopTotalS(loop); ws = ws.filter((w) => w.s < totalS - 1).concat(seamWrites(loop)); seconds = totalS / VGM_RATE; }
    // 入れる波形: キーオンされた波形を丸ごと(256 バイト単位)
    const touched = new Uint8Array((wave.length >>> 8) + 1), reg = new Uint16Array(0x300);
    for (const w of ws) {
      if (w.reg < 0x300) { reg[w.reg] = w.value; continue; }
      if (w.reg > 0x302 || !w.value) continue;
      for (let i = 0; i < 16; i++) if (w.value >> i & 1) {
        const v = (w.reg - 0x300) * 16 + i; if (v >= 48) continue;
        const page = reg[v * 16 + 1] << 8 & 0xff0000, st = (reg[v * 16 + 1] << 8 & 0xff00) | (reg[v * 16] >> 8 & 0xff), en = reg[v * 16 + 6];
        const a = (page | st) >>> 0, b = (page | en) >>> 0;
        for (let p = (a * 4) >>> 8; p <= ((b * 4 + 3) >>> 8) && p < touched.length; p++) touched[p] = 1;
      }
    }
    const parts = [block(KIND_HEADER, loop ? [...u32(CLOCK), FLAG_DSP | FLAG_LOOP, ...u32(loop.start), ...u32(loop.length)] : [...u32(CLOCK), FLAG_DSP])];
    let size = parts[0].length, romBytes = 0;
    const add = (p) => { parts.push(p); size += p.length; };
    for (let p = 0; p < touched.length; p++) {
      if (!touched[p]) continue;
      let q = p; while (q + 1 < touched.length && touched[q + 1]) q++;
      const from = p << 8, to = Math.min(wave.length, (q + 1) << 8);
      if (to > from) { add(block(KIND_ROM, concat([u32(from), wave.subarray(from, to)]))); romBytes += to - from; }
      p = q;
    }
    const total = loop ? loopTotalS(loop) : Math.ceil(seconds * VGM_RATE), loopS = loop ? toS(loop.start) : -1;
    let i = 0, wait = 0, loopByte = -1;
    const flushWait = () => { while (wait > 0) { const d = Math.min(wait, 0xFFFF); add(d === FRAME ? [0x62] : [0x61, ...u16(d)]); wait -= d; } };
    // [sFrom, sTo) を 735 サンプルずつのブロックにして出す。ループの頭はブロックの境目に来るように、そこから数え直す
    const emit = (sFrom, sTo) => {
      for (let s0 = sFrom; s0 < sTo; s0 += FRAME) {
        const s1 = Math.min(sTo, s0 + FRAME), j = i;
        while (i < ws.length && ws[i].s < s1) i++;
        if (i > j) {
          flushWait();
          const b = new Uint8Array((i - j) * 6);
          for (let k = j; k < i; k++) { const o = (k - j) * 6, d = ws[k].s - s0; b[o] = d & 0xff; b[o + 1] = d >> 8; b[o + 2] = ws[k].reg & 0xff; b[o + 3] = ws[k].reg >> 8; b[o + 4] = ws[k].value & 0xff; b[o + 5] = ws[k].value >> 8 & 0xff; }
          add(block(KIND_WRITES, b));
        }
        wait += s1 - s0;
      }
    };
    if (loop && loopS > 0 && loopS < total) { emit(0, loopS); flushWait(); loopByte = size; emit(loopS, total); }
    else { if (loop) loopByte = size; emit(0, total); }
    flushWait();
    add([0x66]);
    const data = concat(parts), tag = gd3(tags || {});
    const hdr = new Uint8Array(0x100), dv = new DataView(hdr.buffer);
    hdr.set([0x56, 0x67, 0x6D, 0x20], 0);
    dv.setUint32(0x04, 0x100 + data.length + tag.length - 4, true); dv.setUint32(0x08, 0x171, true);
    dv.setUint32(0x14, 0x100 + data.length - 0x14, true); dv.setUint32(0x18, total, true); dv.setUint32(0x24, 60, true); dv.setUint32(0x34, 0x100 - 0x34, true);
    if (loop) { dv.setUint32(0x1C, 0x100 + loopByte - 0x1C, true); dv.setUint32(0x20, total - Math.max(0, loopS), true); }
    return { vgm: concat([hdr, data, tag]), writes: ws.length, romBytes, samples: total, loopSamples: loop ? total - Math.max(0, loopS) : 0 };
  };

  /**
   * 時刻つきの書き込み → VGM。
   * rec: { wave, events, start, seconds(曲の頭からの長さ), tags, autoLoop }
   * 戻り: { vgm, loop(見つかれば), writes, romBytes, samples, loopSamples }
   */
  VGM.encodeZsg2Recording = function (rec) {
    const endN = Math.floor(rec.seconds * RATE);
    let loop = null;
    if (rec.autoLoop) loop = VGM.zsg2PickLoop(VGM.zsg2ToWrites(rec.events, rec.start, rec.seconds, true).ws, endN);
    const w = VGM.zsg2ToWrites(rec.events, rec.start, rec.seconds, false, loop ? loop.start : undefined);
    const r = VGM.zsg2Encode(rec.wave, w.ws, rec.seconds, rec.tags, loop);
    r.loop = loop; r.dropped = w.dropped;
    return r;
  };

  /**
   * サウンド基板を動かして 1 曲を VGM にする(メイン CPU の代わりにサウンドコードを送る)。
   * opt: { program, wave, code, tags, bootSec, maxSec, gain, onProgress(済んだ秒, 見込みの秒), yieldEvery }
   *   指令は G-DARIUS のサウンドテストの実測どおり: 起動後に (01, 00, 00, 55)、続いて (01, コード, 01, 55)。全体音量は 0x30(同じく実測)。
   *   録る長さ: まず 100 秒。10 秒以上どの声にも書き込みが無ければ「終わる曲」としてそこで切る。
   *   鳴り続ける曲はループを探し、見つからなければ 200 → 400 → 640 秒と延ばす(1 周が 160 秒の曲は 600 秒ほど録らないと確かめられない)。
   * 戻り: Promise<{ vgm, loop, seconds, ended, recorded, stats }>
   */
  VGM.recordZoomSong = async function (opt) {
    const board = Emu.createZoomBoard({ program: opt.program, wave: opt.wave });
    const gain = opt.gain === undefined ? 0x30 : opt.gain, boot = opt.bootSec || 1.0, maxSec = opt.maxSec || 640;
    const events = [{ t: 0, o: -2, reg: REG.GAIN_L, value: gain }, { t: 0, o: -1, reg: REG.GAIN_R, value: gain }];
    const B = Emu.ZOOM_BOARD, boardRate = B.CPU_HZ / B.CYCLES_PER_SAMPLE;
    const tick = opt.onProgress || (() => {});
    const pause = () => new Promise((r) => setTimeout(r, 0));
    let lastYield = Date.now();
    const runSec = async (sec, goal) => {
      let left = Math.round(sec * boardRate);
      while (left > 0) {
        const n = Math.min(left, 16276); board.run(n); left -= n;      // 0.5 秒ずつ
        if (Date.now() - lastYield > (opt.yieldEvery || 50)) { tick(Math.max(0, board.time - start), goal); await pause(); lastYield = Date.now(); if (opt.cancelled && opt.cancelled()) throw new Error('cancelled'); }
      }
      for (const e of board.takeEvents()) events.push(e);
    };
    let start = Infinity;
    // opt.initAt / opt.songAt(秒): 指令を入れる時刻を指定する(MAME のログと同じ時刻にして照合する時用。サンプルの途中でも入れられる)
    const cmdAt = async (sec, b1, b2) => { await runSec(Math.floor(sec * boardRate) / boardRate - board.time, 100); board.runToCycle(Math.round(sec * B.CPU_HZ)); board.command(0x01, b1, b2, 0x55); return sec; };
    await cmdAt(opt.initAt || boot, 0x00, 0x00);
    start = await cmdAt(opt.songAt || (opt.initAt || boot) + 0.5, opt.code & 0xff, 0x01);
    const lastChipWrite = () => { for (let i = events.length - 1; i >= 0; i--) if (events[i].reg < 0x400) return events[i].t; return 0; };
    let recorded = 0, loop = null, ended = false, seconds = 0;
    for (const goal of [100, 200, 400, 640]) {
      if (goal > maxSec && recorded > 0) break;
      // 10 秒ずつ進めて、書き込みが 10 秒止まっていたら終わった曲
      while (recorded < goal) {
        await runSec(10, goal); recorded += 10;
        if (board.time - lastChipWrite() > 10) { ended = true; break; }
      }
      if (ended) { seconds = Math.max(1, lastChipWrite() - start + 2); break; }
      seconds = recorded;
      tick(recorded, goal); await pause();
      loop = VGM.zsg2PickLoop(VGM.zsg2ToWrites(events, start, seconds, true).ws, Math.floor(seconds * RATE));
      if (loop) break;
    }
    const w = VGM.zsg2ToWrites(events, start, seconds, false, loop ? loop.start : undefined);
    const r = VGM.zsg2Encode(opt.wave, w.ws, seconds, opt.tags, loop);
    const keyOnCount = events.reduce((a, e) => a + (e.reg >= 0x300 && e.reg <= 0x302 && e.value && e.t >= start ? 1 : 0), 0);
    return { vgm: r.vgm, loop, seconds: r.samples / VGM_RATE, ended, recorded, keyOns: keyOnCount, writes: r.writes, romBytes: r.romBytes,
      stats: { illegal: board.cpu.illegalCount, unmappedR: board.stats.unmappedR, unmappedW: board.stats.unmappedW } };
  };
  /**
   * 実時間で録った物(Emu.ZoomConsole の録音)→ VGM。
   * rec: { frames: [{ n0, n1, w: [レジスタ番号, 値, n, …] }], wave, tags, autoLoop, trimSilence }
   *   w の 0xFFFF は「ここでサウンドコードを送った」の印。録音の中の最初の印を曲の頭にする(無ければ録音の頭)。
   *   それより前の書き込み(DSP のプログラムと係数、録音を始めた時のレジスタ)は時刻 0 にまとめる。
   * 戻り: { vgm, samples(44100Hz), frames, loop: { startSec, lengthSec } | null, trimmed, code }
   */
  VGM.encodeZoomRecording = function (rec) {
    const frames = rec.frames || [], events = [];
    if (!frames.length) return null;
    let startN = -1, code = 0, lastChipN = -1;
    const recN0 = frames[0].n0, endAbs = frames[frames.length - 1].n1;
    for (const fr of frames) { const w = fr.w || [];
      for (let i = 0; i + 2 < w.length; i += 3) {
        if (w[i] === 0xFFFF) { if (startN < 0 && w[i + 2] >= recN0) { startN = w[i + 2]; code = w[i + 1]; } continue; }
        events.push({ n: w[i + 2], reg: w[i], value: w[i + 1] });
        if (w[i] < 0x400 && w[i + 2] > lastChipN) lastChipN = w[i + 2];
      } }
    if (startN < 0) startN = recN0;
    let endN = endAbs - startN, trimmed = false;
    // 終わった曲: 音源への書き込みが止まってから 2 秒で切る(止まってから 5 秒以上録っていた時だけ)
    if (rec.trimSilence !== false && lastChipN >= startN && endAbs - lastChipN > 5 * RATE) { endN = lastChipN - startN + 2 * RATE; trimmed = true; }
    if (endN < RATE / 10) endN = Math.max(endN, 1);
    const seconds = endN / RATE, o = { startN };
    let loop = null;
    if (rec.autoLoop !== false && !trimmed) loop = VGM.zsg2PickLoop(VGM.zsg2ToWrites(events, 0, seconds, true, undefined, o).ws, endN);
    const w = VGM.zsg2ToWrites(events, 0, seconds, false, loop ? loop.start : undefined, o);
    const r = VGM.zsg2Encode(rec.wave, w.ws, seconds, rec.tags, loop);
    return { vgm: r.vgm, samples: r.samples, frames: frames.length, trimmed, code,
      loop: loop ? { startSec: loop.start / RATE, lengthSec: loop.length / RATE, swaps: loop.swaps.length, stop: loop.stop.length } : null };
  };
  VGM.ZSG2_REC = { RATE, REG };
})(typeof globalThis !== 'undefined' ? globalThis : this);
