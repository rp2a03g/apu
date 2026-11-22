/*
 * タイトーの Ensoniq 音源基板(ES5505+ES5510)の録音 → VGM(規格外ブロック ENSX。読む側は vgmHeader.js / vgmPlayer.js)。
 *
 *   MML.VGM.encodeEnsoniqRecording({ frames, wave, tags, autoLoop, trimSilence })
 *
 * VGM の規格には ES5505 の枠があるが、この基板は声ごとに波形のバンクを切り替える回路と ES5510 を持ち、どちらも規格のコマンドでは書けない。
 * 対応した再生ソフトも無いので、ZSG-2(ZSGX)や CPS3(CP3X)と同じく自前のブロックにまとめる。
 *
 * ブロック: 0x67 0x66 0xBC 長さ(4) 'E' 'N' 'S' 'X' 版(1) 種類(1) 中身…
 *   種類 0 ヘッダ : クロック u32(ES5505 に入るクロック。出力レート = クロック / 512)、フラグ u8(bit0 = ES5510 への書き込みを含む、bit1 = ループの長さつき)
 *                   bit1 が立っていれば続けて ループの頭 u32・1 周の長さ u32(音源のサンプル数)
 *   種類 1 波形   : 位置 u32(語の番地)+ 8bit のサンプル列(語の上位バイトになる。タイトーの基板の波形 ROM は 8bit)
 *   種類 2 書き込み: 6 バイト × n。時刻 u16(このブロックの位置からのサンプル数)、キー u16、値 u16。1 フレーム(735 サンプル)に 1 個
 *       キー: 0x000-0x00F = ES5505 のレジスタ(16bit)、0x100+ = 上位バイトだけ、0x200+ = 下位バイトだけ、0x400+声 = 波形のバンク、
 *             0x1000+レジスタ = ES5510、0x2000 = ESPHALT、0x2200 = 2 声の中身を入れ替える、0x2201 = その声を止める(どちらもループの継ぎ目用)
 *
 * 録音の 1 フレーム: { n0, n1, w: [キー, 値, n, …] }(n = 音源の通算サンプル番号)。キー 0xFFFF は「ここで指令を送った」の印(値 = 番号)。
 *
 * 決まりごと(ZSG-2 の時と同じ考え方。src/vgm/zsg2Record.js):
 *   - 時刻は「音源の何サンプル目の前に効くか」(n)で持ち、VGM の位置は s = ceil(n × 44100 / レート)。読む側は n = floor(s × レート / 44100)
 *   - ドライバは休まず全部の声を書き直す(毎秒 13 万件)。値が変わらない書き込みは落とす: 周波数・開始・終端・フィルタ係数・音量(ページ 0x00-0x1F の
 *     レジスタ 1〜9 を 16bit で書いた物)、ページの切り替え、バンク。制御(0)とアキュムレータ(A・B)、フィルタの状態(ページ 0x20-)は落とさない
 *   - ループ: キーオンの列の照合(VGM.loopFromKeyOns)と継ぎ目選び(VGM.loopSeam)。ループの頭では、落とす判定の表を空にし、その時のページを書き直す
 *   - VGM の長さは 1 周の終わりより 2 サンプル短くする(本体はループで戻る時に 1 サンプル余分に進む)
 *   - 波形は、キーオンされた区間(その時のアキュムレータと開始の小さい方 〜 終端)を 256 語単位で入れる
 */
(function (root) {
  'use strict';
  const MML = root.MML = root.MML || {}, VGM = MML.VGM = MML.VGM || {}, Emu = MML.Emu = MML.Emu || {};
  const CLOCK = 30476180 / 2, RATE = CLOCK / 512, VGM_RATE = 44100, FRAME = 735;
  const TYPE = 0xBC, MAGIC = [0x45, 0x4E, 0x53, 0x58], VERSION = 1, KIND_HEADER = 0, KIND_ROM8 = 1, KIND_WRITES = 2, FLAG_ESP = 1, FLAG_LOOP = 2;
  const KEY_SWAP = 0x2200, KEY_STOP = 0x2201, KEY_MARK = 0xFFFF;
  const u16 = (n) => [n & 0xFF, (n >> 8) & 0xFF];
  const u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];
  const toS = (n) => Math.ceil(n * VGM_RATE / RATE);

  // 書き込みを順になぞって、ページと声ごとのレジスタを追う(落とす判定、キーオン、波形の範囲に使う)
  function tracker() {
    return { page: 0, reg: new Uint16Array(32 * 16), ctl: new Uint16Array(32).fill(3), bank: new Uint16Array(32),
      // 戻り: 0 = 何でもない、1 = キーオン(声 = this.voice)
      apply(key, value) {
        this.voice = -1;
        const r = key & 15, lane = key >> 8;
        if (key >= 0x400 && key < 0x420) { this.bank[key & 31] = value & 0xff; return 0; }
        if (key >= 0x300) return 0;
        const mask = lane === 0 ? 0xffff : lane === 1 ? 0xff00 : 0x00ff;
        if (r === 15) { if (mask & 0xff) this.page = value & 0x7f; return 0; }
        if (this.page >= 0x20 || r > 11) return 0;
        const v = this.page & 31, i = v * 16 + r;
        if (r === 0) {
          const was = this.ctl[v]; let c = was;
          if (mask & 0xff) c = (c & ~0xff) | (value & 0xff); if (mask & 0xff00) c = (c & 0xff) | (value & 0x0f00);
          this.ctl[v] = c;
          if ((was & 3) && !(c & 3)) { this.voice = v; return 1; }
          return 0;
        }
        this.reg[i] = (this.reg[i] & ~mask) | (value & mask);
        return 0;
      } };
  }

  /** 録音の書き込み [{ n, key, value }] → VGM に入れる書き込み列 [{ s, n, reg(キー), value }]。startN より前は時刻 0 にまとめる */
  VGM.ensToWrites = function (ev, startN, endN, keepAll, resetAtN) {
    // 落としてよい書き込み(どれも「書いても音源の中身が変わらない」と言える物だけ。前後でビット一致するのを tools/f3/en-console-check.js で確かめる):
    //   - 声の設定(ページ 0x00-0x1F のレジスタ 1〜9): 音源が使うビットだけを比べて、前と同じなら落とす(音量は上位 8bit、フィルタ係数は上位 12bit、
    //     周波数は bit0 以外、開始・終端の下位は上位 11bit だけが効く)。ドライバは音量を 16bit で細かく動かすが、音源に届くのは 8bit ぶん
    //   - ページの切り替え: 書き込みのたびには残さず、残す書き込みの直前で今のページと違う時だけ入れる
    //   - 制御(レジスタ 0): 止めている声へ、同じ値(止めたまま)を書き直す物
    //   - フィルタの状態(ページ 0x20-0x3F のレジスタ 1〜6): 止めている声へ、同じ値を書き直す物(声が動いたら、同じかどうかは分からないので残す)
    //   - バンク: 前と同じ値
    const out = [], tr = tracker(), last = new Map();
    const eff = (r, v) => (r === 1 ? v & 0xfffe : (r === 2 || r === 4) ? v & 0x1fff : (r === 3 || r === 5) ? v & 0xffe0 : (r === 6 || r === 7) ? v & 0xfff0 : v & 0xff00);
    let dropped = 0, reset = false, outPage = -1;
    for (const e of ev) {
      const pre = e.n < startN, n = pre ? 0 : e.n - startN, s = pre ? 0 : toS(n);
      if (!pre && n >= endN) break;
      if (e.key >= 0x2100 && e.key < 0x2200) continue;                 // 音量 IC: 使わない
      if (resetAtN !== undefined && !reset && !pre && n >= resetAtN) { last.clear(); reset = true; outPage = -1; }   // ループの頭: 表を空にし、ページも書き直させる
      const key = e.key, r = key & 15, isReg = key < 0x300, isPage = isReg && r === 15;
      if (keepAll) { tr.apply(key, e.value); out.push({ s, n, reg: key, value: e.value }); continue; }
      if (isPage) { tr.apply(key, e.value); dropped++; continue; }
      let drop = false;
      const page = tr.page, v = page & 31;
      if (isReg && page < 0x20) {
        if (r >= 1 && r <= 9) {
          const id = v * 16 + r;
          if (key < 0x10) { const x = eff(r, e.value); if (last.get(id) === x) drop = true; else last.set(id, x); } else last.delete(id);   // バイトで書いた: 次は必ず残す
        } else if (r === 0) {
          const id = 'c' + v;
          if (key < 0x10) {
            const x = e.value & 0x0fff;
            if ((x & 3) && last.get(id) === x) drop = true; else last.set(id, x);
            if (!(x & 3)) for (let k = 1; k <= 6; k++) last.delete('f' + (v * 16 + k));          // 動き出した: フィルタの状態は変わっていく
          } else { last.delete(id); for (let k = 1; k <= 6; k++) last.delete('f' + (v * 16 + k)); }
        }
      } else if (isReg && page < 0x40) {
        if (r >= 1 && r <= 6) {
          const id = 'f' + (v * 16 + r);
          if (key < 0x10 && (tr.ctl[v] & 3) && last.get(id) === e.value) drop = true; else if (key < 0x10 && (tr.ctl[v] & 3)) last.set(id, e.value); else last.delete(id);
        } else if (r === 0) { last.delete('c' + v); for (let k = 1; k <= 6; k++) last.delete('f' + (v * 16 + k)); }
      } else if (key >= 0x400 && key < 0x420) { const id = 'b' + (key & 31); if (last.get(id) === (e.value & 0xff)) drop = true; else last.set(id, e.value & 0xff); }
      tr.apply(key, e.value);
      if (drop) { dropped++; continue; }
      if (isReg && outPage !== page) { out.push({ s, n, reg: 0x0f, value: page }); outPage = page; }
      out.push({ s, n, reg: key, value: e.value });
    }
    return { ws: out, dropped };
  };

  // キーオンの列(ループ探し用)。キー = バンク+周波数+開始+終端
  function keyOns(ws) {
    const tr = tracker(), ev = [], ids = new Map(), ctl = [];
    for (const w of ws) {
      const hit = tr.apply(w.reg, w.value);
      if ((w.reg & 0xff0f) === 0 || (w.reg & 0xf0ff) === 0) { /* 制御レジスタ */ }
      if (hit) {
        const v = tr.voice, b = v * 16, k = tr.bank[v] + ':' + tr.reg[b + 1] + ':' + tr.reg[b + 2] + ':' + tr.reg[b + 3] + ':' + tr.reg[b + 4] + ':' + tr.reg[b + 5];
        let id = ids.get(k); if (id === undefined) ids.set(k, id = ids.size);
        ev.push({ t: w.n, key: id, v });
      }
      if ((w.reg & 15) === 0 && w.reg < 0x300 && tr.page < 0x20) ctl.push(w.n);
    }
    return { ev, ctl };
  }
  // 音源を回して(音は作らない)、各時刻に鳴っている声を取る
  function soundingAt(ws, times) {
    const chip = new Emu.Es5505Audio(CLOCK, new Int16Array(0)); chip.captureOnly = true;
    const res = []; let e = 0, cur = 0;
    for (const t of times) {
      while (cur < t) { for (; e < ws.length && ws[e].n <= cur; e++) if (ws[e].reg < 0x1000) chip.writeKey(ws[e].reg, ws[e].value); chip.clock(); cur++; }
      const list = [];
      for (let v = 0; v < 32; v++) { const c = chip.v[v]; if (!(c.control & 3) && (c.lvol | c.rvol)) list.push({ v, key: c.bank + ':' + c.start + ':' + c.end + ':' + c.freq, vol: Math.max(c.lvol, c.rvol) << 8 }); }
      res.push(list);
    }
    return res;
  }
  /** ループと継ぎ目。戻り { start, length, stop, swaps, seam, found } か null(どれも音源のサンプル数) */
  VGM.ensPickLoop = function (ws, endN, opt) {
    const k = keyOns(ws), rate = Math.round(RATE);
    const found = VGM.loopFromKeyOns(k.ev, endN, rate, opt);
    if (!found) return null;
    const TOL = Math.round(rate / 60 * 1.5);
    if (found.start + found.length + TOL * 4 > endN) return null;
    const seam = VGM.loopSeam({ sounding: (times) => soundingAt(ws, times), ctl: k.ctl, loop: { start: found.start, length: found.length }, endN, rate, voices: 32 });
    if (!seam || seam.carried < 0) return null;
    return { start: seam.start, length: found.length, stop: seam.stop, swaps: seam.swaps, seam, found };
  };

  const loopTotalS = (loop) => toS(loop.start + loop.length) - 2;
  function seamWrites(loop) {
    const s = loopTotalS(loop) - 1, n = Math.floor(s * RATE / VGM_RATE), out = [];
    for (const v of loop.stop || []) out.push({ s, n, reg: KEY_STOP, value: v });
    for (const [a, b] of loop.swaps || []) out.push({ s, n, reg: KEY_SWAP, value: a << 8 | b });
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
    const strs = [tags.title, '', tags.game, '', tags.system || 'Taito F3 System', '', tags.author, '', '', tags.creator || 'Sound Emulation Foundry', ''];
    const body = []; for (const x of strs) { const s = String(x || ''); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); body.push(c & 0xff, c >> 8); } body.push(0, 0); }
    return concat([[0x47, 0x64, 0x33, 0x20, 0x00, 0x01, 0x00, 0x00, ...u32(body.length)], body]);
  }
  /** 書き込み列 → VGM。wave = Int16Array(語の番地。上位バイトだけを入れる) */
  VGM.ensEncode = function (wave, ws, seconds, tags, loop) {
    if (loop) { const totalS = loopTotalS(loop); ws = ws.filter((w) => w.s < totalS - 1).concat(seamWrites(loop)); seconds = totalS / VGM_RATE; }
    // 入れる波形: キーオンされた区間(256 語単位)
    const touched = new Uint8Array((wave.length >>> 8) + 1), tr = tracker();
    let hasEsp = false;
    for (const w of ws) {
      if (w.reg >= 0x1000 && w.reg < 0x1100) hasEsp = true;
      if (!tr.apply(w.reg, w.value)) continue;
      const v = tr.voice, b = v * 16, bank = (tr.bank[v] * 0x100000) % wave.length;   // バンクの値は上位に余計なビットが乗っている事がある(基板は波形 ROM の大きさで折り返す)
      const st = ((tr.reg[b + 2] & 0x1fff) << 7 | tr.reg[b + 3] >> 9) >>> 0, en = ((tr.reg[b + 4] & 0x1fff) << 7 | tr.reg[b + 5] >> 9) >>> 0, ac = ((tr.reg[b + 10] & 0x1fff) << 7 | tr.reg[b + 11] >> 9) >>> 0;
      const from = (bank + Math.min(st, ac)) >>> 0, to = (bank + Math.max(en, st) + 2) >>> 0;
      for (let p = from >>> 8; p <= (to >>> 8) && p < touched.length; p++) touched[p] = 1;
    }
    const parts = [block(KIND_HEADER, loop ? [...u32(Math.round(CLOCK)), (hasEsp ? FLAG_ESP : 0) | FLAG_LOOP, ...u32(loop.start), ...u32(loop.length)] : [...u32(Math.round(CLOCK)), hasEsp ? FLAG_ESP : 0])];
    let size = parts[0].length, romBytes = 0;
    const add = (p) => { parts.push(p); size += p.length; };
    for (let p = 0; p < touched.length; p++) {
      if (!touched[p]) continue;
      let q = p; while (q + 1 < touched.length && touched[q + 1]) q++;
      const from = p << 8, to = Math.min(wave.length, (q + 1) << 8);
      if (to > from) { const b = new Uint8Array(to - from); for (let i = from; i < to; i++) b[i - from] = wave[i] >> 8 & 0xff; add(block(KIND_ROM8, concat([u32(from), b]))); romBytes += to - from; }
      p = q;
    }
    const total = loop ? loopTotalS(loop) : Math.ceil(seconds * VGM_RATE), loopS = loop ? toS(loop.start) : -1;
    let i = 0, wait = 0, loopByte = -1;
    const flushWait = () => { while (wait > 0) { const d = Math.min(wait, 0xFFFF); add(d === FRAME ? [0x62] : [0x61, ...u16(d)]); wait -= d; } };
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
   * 実時間で録った物(Emu.EnsoniqConsole の録音)→ VGM。
   * 戻り: { vgm, samples(44100Hz), frames, loop: { startSec, lengthSec } | null, trimmed, code, dropped }
   */
  VGM.encodeEnsoniqRecording = function (rec) {
    const frames = rec.frames || [], events = [];
    if (!frames.length) return null;
    let startN = -1, code = 0, lastOn = -1;
    const recN0 = frames[0].n0, endAbs = frames[frames.length - 1].n1, tr = tracker();
    for (const fr of frames) { const w = fr.w || [];
      for (let i = 0; i + 2 < w.length; i += 3) {
        if (w[i] === KEY_MARK) { if (startN < 0 && w[i + 2] >= recN0) { startN = w[i + 2]; code = w[i + 1]; } continue; }
        events.push({ n: w[i + 2], key: w[i], value: w[i + 1] });
        if (tr.apply(w[i], w[i + 1])) lastOn = w[i + 2];
      } }
    if (startN < 0) startN = recN0;
    let endN = endAbs - startN, trimmed = false;
    // 終わった曲: このドライバは鳴っていなくても書き続けるので、書き込みではなく「最後のキーオン」から 6 秒で切る(その後 8 秒以上録っていた時だけ)
    if (rec.trimSilence !== false && lastOn >= startN && endAbs - lastOn > 8 * RATE) { endN = Math.round(lastOn - startN + 6 * RATE); trimmed = true; }
    endN = Math.max(endN, 1);
    let loop = null;
    if (rec.autoLoop !== false && !trimmed) loop = VGM.ensPickLoop(VGM.ensToWrites(events, startN, endN, true).ws, endN);
    const w = VGM.ensToWrites(events, startN, endN, false, loop ? loop.start : undefined);
    const r = VGM.ensEncode(rec.wave, w.ws, endN / RATE, rec.tags, loop);
    return { vgm: r.vgm, samples: r.samples, frames: frames.length, trimmed, code, dropped: w.dropped, writes: r.writes, romBytes: r.romBytes,
      loop: loop ? { startSec: loop.start / RATE, lengthSec: loop.length / RATE, swaps: loop.swaps.length, stop: loop.stop.length } : null };
  };
  VGM.ENS_REC = { RATE, CLOCK };
})(typeof globalThis !== 'undefined' ? globalThis : this);
