/*
 * 再生器の差分検査(耳を使わずに再生系の不具合を拾う)
 *
 *   node tools/headless/bughunt/playback-check.js                    (要 MML_CORPUS_ROOT)
 *   node tools/headless/bughunt/playback-check.js --format spc,nsf --per 3 --sec 6
 *   node tools/headless/bughunt/playback-check.js --json out.json    結果を機械可読で残す
 *
 * 考え方: このアプリの再生は「先読みキャプチャの書き込みログをチップへ流し直す再生器」で、
 * 正解は「CPU とチップをまるごと回した出力」(WAV 書き出しと同じ経路)としてコードの中にある。
 * 再生器を偽の AudioContext で直接回し、正解と数値で突き合わせる。さらに実際の利用で起きる
 * 意地悪な条件(取り込みが再生より遅い、一時停止、停止→再生、シーク、速度、ミュート)を掛け、
 * 「同じ音になるはずの2つの経路が同じか」を不変条件として採点する。
 *
 * 検査項目(形式ごと・曲ごと):
 *   ref      正解 vs 再生器(通常)             … 0.1秒窓のスペクトル類似度 平均≥0.95 かつ 最低≥0.7
 *   lag      取り込みが遅れても最終的な音は同じ   … 待ち(無音)を除いた出力が通常と一致(誤差<1%)
 *   stop     停止→再生 = 最初から              … サンプル単位で一致
 *   reload   load を2回 = 1回                  … サンプル単位で一致(状態の初期化漏れ)
 *   pause    一時停止中は位置が進まず、再開後は続きが一致
 *   seek     シーク後の音 = 通常再生のその位置以降 … 類似度 平均≥0.9(位相の割り切りは許す)、位置の報告が合う
 *   speed    速度 1/2 でも音程は同じ            … 遅い出力の窓 ↔ 正解の半分の時刻の窓 類似度≥0.9
 *   mute     全chミュートで無音、解除で復帰      … RMS<1e-3 / 解除後は通常と一致
 *   end      曲末で onEnded が1回だけ呼ばれ、位置が長さを超えない
 *
 * 判定できないもの: 正解の経路そのものが実機と違う不具合(それは NSFPlay/VGMPlay の基準 WAV との
 * 照合)、音量バランスや聴こえ方の好み。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { load, readBytes } = require('../load');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const ROOT = flag('--corpus-root', process.env.MML_CORPUS_ROOT || null);
const FORMATS = (flag('--format', 'nsf,spc,kss,gbs,hes,vgm,psf,mml')).split(',').filter(Boolean);
const PER = +flag('--per', '2');
const SEC = +flag('--sec', '6');
const JSON_OUT = flag('--json', null);
const VERBOSE = argv.includes('--verbose');
const SR = 44100;
const BUF = 1024;

// ---------------------------------------------------------------- スペクトル類似度(replay-check.js と同じ)
const N = 4096;
function fft(re, im) {
  for (let i = 1, j = 0; i < N; i++) { let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
const WIN = new Float32Array(N); for (let i = 0; i < N; i++) WIN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
const BINS = Math.floor(6000 / (SR / N));
function spec(x, at) {
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) re[i] = (x[at + i] || 0) * WIN[i];
  fft(re, im);
  const m = new Float32Array(BINS); let e = 0;
  for (let k = 0; k < BINS; k++) { m[k] = Math.hypot(re[k], im[k]); e += m[k] * m[k]; }
  return { m, e: Math.sqrt(e) };
}
const SIL = 2;
function cosSim(a, b) {
  if (a.e < SIL && b.e < SIL) return null;
  if (a.e < SIL || b.e < SIL) return 0;
  let s = 0; for (let k = 0; k < BINS; k++) s += a.m[k] * b.m[k];
  return s / (a.e * b.e);
}
// a の時刻 t の窓と b の時刻 t*ratio+offset の窓を比べる(ratio: 速度検査用)
function similarity(a, b, seconds, opt = {}) {
  const ratio = opt.ratio || 1, HOP = SR / 10;
  const frames = [];
  for (let t = 0; t + N <= Math.min(a.length, seconds * SR); t += HOP) frames.push({ t, s: spec(a, t) });
  const score = (lag) => {
    let s = 0, n = 0, min = 1, minAt = 0;
    for (const f of frames) {
      const c = cosSim(f.s, spec(b, Math.round(f.t * ratio) + lag));
      if (c === null) continue;
      s += c; n++; if (c < min) { min = c; minAt = f.t / SR; }
    }
    return { mean: n ? s / n : 1, min: n ? min : 1, minAt, n };
  };
  let best = null;
  const lags = opt.searchLag ? [-1500, -1000, -500, -200, -100, 0, 100, 200, 500, 1000, 1500] : [0];
  for (const lag of lags) { const r = score(lag); if (!best || r.mean > best.mean) { best = r; best.lag = lag; } }
  return best;
}
function relErr(a, b, n) {
  n = Math.min(n || Infinity, a.length, b.length);
  let d = 0, e = 0, first = -1;
  for (let i = 0; i < n; i++) { const x = a[i] - b[i]; d += x * x; e += a[i] * a[i]; if (first < 0 && Math.abs(x) > 1e-6) first = i; }
  return { err: Math.sqrt(d / (e || 1)), first: first < 0 ? null : first / SR, n };
}
function rms(a, from, to) {
  let s = 0, n = 0;
  for (let i = from || 0; i < Math.min(to || a.length, a.length); i++) { s += a[i] * a[i]; n++; }
  return n ? Math.sqrt(s / n) : 0;
}

// ---------------------------------------------------------------- 偽 AudioContext と再生の駆動
function fakeCtx() {
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 }, threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 1 }, attack: { value: 0 }, release: { value: 0 }, onaudioprocess: null });
  const ctx = { sampleRate: SR, currentTime: 0, state: 'running', destination: node(), createGain: node, createDynamicsCompressor: node, createScriptProcessor: node, resume() {} };
  return ctx;
}
// 実際のブラウザと同じく node.onaudioprocess を呼ぶ(isPlaying の判定・時刻の錨もその中にある)
function pump(p, nbuf) {
  const ch = p.node && p.node.numberOfOutputs === undefined ? 2 : 2;
  const L = new Float32Array(BUF), R = new Float32Array(BUF);
  const ev = { outputBuffer: { numberOfChannels: ch, getChannelData: (c) => (c === 0 ? L : R) }, playbackTime: 0 };
  const out = [];
  for (let k = 0; k < nbuf; k++) {
    L.fill(0); R.fill(0);
    ev.playbackTime = p.audioCtx.currentTime;
    const before = Math.round(p.getPosition() * SR);
    p.node.onaudioprocess(ev);
    p.audioCtx.currentTime += BUF / SR;
    const after = Math.round(p.getPosition() * SR);
    out.push({ L: L.slice(), R: R.slice(), advanced: after - before });
  }
  return out;
}
function mono(chunks, stripStall) {
  // stripStall: 位置が進んだ分だけ(=待ちで埋めた末尾の無音を捨てる)
  const parts = [];
  for (const c of chunks) {
    const n = stripStall ? Math.max(0, Math.min(BUF, c.advanced)) : BUF;
    const m = new Float32Array(n);
    for (let i = 0; i < n; i++) m[i] = (c.L[i] + c.R[i]) / 2;
    parts.push(m);
  }
  const total = parts.reduce((s, x) => s + x.length, 0);
  const out = new Float32Array(total); let pos = 0;
  for (const x of parts) { out.set(x, pos); pos += x.length; }
  return out;
}
const nbufFor = (sec) => Math.ceil(sec * SR / BUF);

// ---------------------------------------------------------------- 形式ごとの差し込み口
// adapter: {
//   list(root)           → [{ label, bytes, song, extra }]   検査対象の曲
//   reference(item, sec) → Float32Array(SR)                  正解(モノラル)
//   capture(item, sec)   → cap                                アプリ本体と同じ先読みキャプチャ
//   make(ctx)            → player
//   load(p, item, cap, lagged)                                lagged: 取り込みの遅れを再現する差し替え(省略可)
//   lag(cap)             → { cap, feed(done) }                done フレームまで取り込み済みにする(無ければ lag 検査は skip)
//   muteAll(p)           → mute 設定 / unmuteAll(p)
//   frames(cap)          → 総フレーム数
// }
function dc(MML, a) { return MML.Emu.dcBlock ? MML.Emu.dcBlock(a) : a; }
function firstFiles(dir, exts, n) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => exts.includes(path.extname(f).toLowerCase().slice(1))).sort().slice(0, n).map(f => path.join(dir, f));
}
async function archiveEntries(MML, bytes, exts) {
  const { entries } = await MML.Archive.parse(bytes);
  return MML.Archive.buildPlaylist(entries, exts, (m) => MML.Archive.readEntry(bytes, m));
}
function muteFromChips(chips) {
  // {name: chip} → {name: {key:true...}}(chip.mute が配列なら true の配列)
  const out = {};
  for (const [name, chip] of Object.entries(chips)) {
    if (!chip || !chip.mute) continue;
    out[name] = Array.isArray(chip.mute) ? chip.mute.map(() => true) : Object.fromEntries(Object.keys(chip.mute).map(k => [k, true]));
  }
  return out;
}
function unmuteFromChips(chips) {
  const m = muteFromChips(chips);
  for (const v of Object.values(m)) { if (Array.isArray(v)) v.fill(false); else for (const k in v) v[k] = false; }
  return m;
}

function adapters(MML) {
  const yieldFn = () => Promise.resolve();
  const A = {};

  A.nsf = {
    async list(root) {
      const out = [];
      for (const f of firstFiles(path.join(root, 'nsf'), ['nsf', 'nsfe'], PER)) {
        const bytes = MML.NSF.normalize(readBytes(f)).bytes; // NSFe は素の NSF へ
        const h = MML.NSF.parseHeader(bytes);
        out.push({ label: path.basename(f) + ' #' + (h.startSong || 1), bytes, song: (h.startSong || 1) - 1 });
      }
      return out;
    },
    reference: (it, sec) => MML.Emu.captureSong(it.bytes, { songIndex: it.song, durationSeconds: sec + 0.5, sampleRate: SR }).audio,
    capture: (it, sec) => MML.Emu.captureSongAsync(it.bytes, { songIndex: it.song, durationSeconds: sec + 0.5, sampleRate: SR, regsOnly: true, yieldFn }),
    make: (ctx) => new MML.Audio.NsfReplayStreamPlayer(ctx),
    frames: (cap) => cap.totalFrames,
    load(p, it, cap, lagged) {
      const c = lagged || cap;
      p.load(it.bytes, it.song, cap.totalFrames, { writeLog: c.writeLog, initWrites: cap.initWrites, initRegs: cap.initRegs, n163Snapshots: cap.n163Snapshots });
    },
    lag(cap) {
      const wl = new Array(cap.totalFrames);
      return { cap: { writeLog: wl }, feed(done) { for (let f = 0; f < done && f < cap.writeLog.length; f++) if (wl[f] === undefined) wl[f] = cap.writeLog[f]; } };
    },
    muteAll: (p) => p.applyMute({ apu: muteFromChips({ a: p.apu }).a, expansion: muteFromChips(p.bus.expansion) }),
    unmuteAll: (p) => p.applyMute({ apu: unmuteFromChips({ a: p.apu }).a, expansion: unmuteFromChips(p.bus.expansion) }),
  };

  A.kss = {
    async list(root) {
      const out = [];
      for (const f of firstFiles(path.join(root, 'kss'), ['kss', '7z', 'zip'], PER)) {
        let bytes = readBytes(f), label = path.basename(f);
        if (MML.Archive.detect(bytes)) {
          const list = await archiveEntries(MML, bytes, ['kss']);
          if (!list.length) continue;
          bytes = await MML.Archive.readEntry(bytes, list[0].entry);
          label += '!' + list[0].title;
        }
        const h = MML.KSS.parseHeader(bytes);
        if (!h.magicOk) continue;
        const song = h.hasSongRange ? h.firstSong : 0;
        out.push({ label: label + ' #' + song, bytes, song });
      }
      return out;
    },
    reference: async (it, sec) => dc(MML, (await MML.Emu.captureKssSongAsync(it.bytes, { songIndex: it.song, durationSeconds: sec + 0.5, sampleRate: SR, yieldFn })).audio),
    capture: (it, sec) => MML.Emu.captureKssSongAsync(it.bytes, { songIndex: it.song, durationSeconds: sec + 0.5, sampleRate: SR, regsOnly: true, yieldFn }),
    make: (ctx) => new MML.Audio.KssReplayStreamPlayer(ctx),
    frames: (cap) => cap.writeLog.length,
    load(p, it, cap, lagged) { p.load(it.bytes, it.song, cap.writeLog.length, { writeLog: (lagged || cap).writeLog }); },
    lag(cap) {
      const wl = new Array(cap.writeLog.length);
      return { cap: { writeLog: wl }, feed(done) { for (let f = 0; f < done && f < cap.writeLog.length; f++) if (wl[f] === undefined) wl[f] = cap.writeLog[f]; } };
    },
    muteAll: (p) => p.applyMute({ expansion: muteFromChips({ psg: p.psg, scc: p.scc, opll: p.opll, opl: p.opl }) }),
    unmuteAll: (p) => p.applyMute({ expansion: unmuteFromChips({ psg: p.psg, scc: p.scc, opll: p.opll, opl: p.opl }) }),
  };

  A.gbs = {
    async list(root) {
      return firstFiles(path.join(root, 'gbs'), ['gbs'], PER).map(f => {
        const bytes = readBytes(f); const h = MML.GBS.parseHeader(bytes);
        return { label: path.basename(f) + ' #' + (h.firstSong || 1), bytes, song: (h.firstSong || 1) - 1 };
      });
    },
    reference: async (it, sec) => dc(MML, (await MML.Emu.captureGbsSongAsync(it.bytes, { songIndex: it.song, durationSeconds: sec + 0.5, sampleRate: SR, yieldFn })).audio),
    capture: (it, sec) => MML.Emu.captureGbsSongAsync(it.bytes, { songIndex: it.song, durationSeconds: sec + 0.5, sampleRate: SR, regsOnly: true, yieldFn }),
    make: (ctx) => new MML.Audio.GbsReplayStreamPlayer(ctx),
    frames: (cap) => cap.snapshots.length,
    load(p, it, cap, lagged) { p.load(it.bytes, it.song, cap.snapshots.length, { snapshots: (lagged || cap).snapshots }); },
    lag(cap) {
      const sn = [];
      return { cap: { snapshots: sn }, feed(done) { while (sn.length < done && sn.length < cap.snapshots.length) sn.push(cap.snapshots[sn.length]); } };
    },
    muteAll: (p) => p.applyMute({ expansion: { gb: muteFromChips({ a: p.apu }).a } }),
    unmuteAll: (p) => p.applyMute({ expansion: { gb: unmuteFromChips({ a: p.apu }).a } }),
  };

  A.hes = {
    async list(root) {
      return firstFiles(path.join(root, 'hes'), ['hes'], PER).map(f => {
        const bytes = readBytes(f); const h = MML.HES.parseHeader(bytes);
        return { label: path.basename(f) + ' #' + (h.firstTrack || 0), bytes, song: h.firstTrack || 0 };
      });
    },
    reference: async (it, sec) => dc(MML, (await MML.Emu.captureHesSongAsync(it.bytes, { track: it.song, durationSeconds: sec + 0.5, sampleRate: SR, yieldFn })).audio),
    capture: (it, sec) => MML.Emu.captureHesSongAsync(it.bytes, { track: it.song, durationSeconds: sec + 0.5, sampleRate: SR, regsOnly: true, yieldFn }),
    make: (ctx) => new MML.Audio.HesReplayStreamPlayer(ctx),
    frames: (cap) => cap.snapshots.length,
    load(p, it, cap, lagged) { p.load(it.bytes, it.song, cap.snapshots.length, { snapshots: (lagged || cap).snapshots }); },
    lag(cap) {
      const sn = [];
      return { cap: { snapshots: sn }, feed(done) { while (sn.length < done && sn.length < cap.snapshots.length) sn.push(cap.snapshots[sn.length]); } };
    },
    muteAll: (p) => p.applyMute({ expansion: { hes: muteFromChips({ a: p.apu }).a } }),
    unmuteAll: (p) => p.applyMute({ expansion: { hes: unmuteFromChips({ a: p.apu }).a } }),
  };

  A.vgm = {
    async list(root) {
      // vgm/ 直下と1段下のフォルダから .vgm/.vgz/.zip を拾う
      const dir = path.join(root, 'vgm');
      if (!fs.existsSync(dir)) return [];
      const files = [];
      for (const e of fs.readdirSync(dir).sort()) {
        const p = path.join(dir, e);
        if (fs.statSync(p).isDirectory()) files.push(...firstFiles(p, ['vgm', 'vgz', 'zip'], 1));
        else if (['.vgm', '.vgz', '.zip'].includes(path.extname(e).toLowerCase())) files.push(p);
      }
      const out = [];
      for (const f of files.slice(0, PER)) {
        let bytes = readBytes(f), label = path.basename(f);
        if (MML.Archive.detect(bytes)) {
          const list = await archiveEntries(MML, bytes, ['vgm', 'vgz']);
          if (!list.length) continue;
          bytes = await MML.Archive.readEntry(bytes, list[0].entry);
          label += '!' + list[0].title;
        }
        bytes = await MML.Archive.gunzipIfNeeded(bytes);
        out.push({ label, bytes, song: 0 });
      }
      return out;
    },
    reference(it, sec) {
      const p = new MML.Emu.VgmPlayer(it.bytes);
      const want = Math.floor((sec + 0.5) * SR), audio = new Float32Array(want);
      let pos = 0;
      while (pos < want) {
        const buf = p.renderFrame(SR, false, true);
        if (!buf || !buf.left || !buf.left.length) break;
        for (let i = 0; i < buf.left.length && pos < want; i++) audio[pos++] = (buf.left[i] + buf.right[i]) / 2;
      }
      return dc(MML, audio.subarray(0, pos));
    },
    capture: () => ({}),
    make: (ctx) => new MML.Audio.VgmStreamPlayer(ctx),
    frames: (cap, sec) => Math.round((sec + 0.5) * 60),
    load(p, it, cap, lagged, sec) { p.load(it.bytes, Math.round((sec + 0.5) * 60)); },
    lag: null,
    muteAll(p) { p.applyMute(vgmMuteConfig(true)); },
    unmuteAll(p) { p.applyMute(vgmMuteConfig(false)); },
  };
  // VGM のミュート設定は keyboardDisplay.getMuteConfig() 形状(expansion[チップ名] = 配列 or {キー:bool})。
  // チップ名とキーの対応を全部持たずに済むよう、「どのキーを読まれても on」を返す Proxy にする
  // (Emu.applyMute は対象側のキーを読むだけなので足りる)。Object.assign で写す gb/hes と、
  // .slice() される配列(psg/sn76489/ym2203fm)だけは実体を置く。
  function vgmMuteConfig(on) {
    const any = () => new Proxy({}, { get: (_, k) => (typeof k === 'symbol' ? undefined : on) });
    const arr = new Array(64).fill(on);
    const obj = (keys) => Object.fromEntries(keys.map(k => [k, on]));
    const fixed = { gb: obj(['ch1', 'ch2', 'ch3', 'ch4']), hes: obj(['ch0', 'ch1', 'ch2', 'ch3', 'ch4', 'ch5']), psg: arr, sn76489: arr, ym2203fm: arr };
    const expansion = new Proxy(fixed, { get: (t, k) => (typeof k === 'symbol' ? undefined : (k in t ? t[k] : any())) });
    return { apu: obj(['pulse1', 'pulse2', 'triangle', 'noise', 'dmc']), expansion };
  }

  A.psf = {
    async list(root) {
      const out = [];
      for (const f of firstFiles(path.join(root, 'psf'), ['zip', '7z', 'psf', 'minipsf'], PER)) {
        const bytes = readBytes(f);
        let info = null, label = path.basename(f);
        try {
          if (MML.Archive.detect(bytes)) {
            const { entries } = await MML.Archive.parse(bytes);
            const songs = entries.filter(e => !e.isDir && /\.(psf|minipsf)$/i.test(e.name)).sort((a, b) => MML.Archive.naturalCompare(a.name, b.name));
            if (!songs.length) continue;
            const e = songs[0];
            info = await MML.PSF.load(await MML.Archive.readEntry(bytes, e), async (n) => {
              const x = entries.find(y => y.name.toLowerCase() === n.toLowerCase()) || entries.find(y => MML.Archive.baseName(y.name).toLowerCase() === MML.Archive.baseName(n).toLowerCase());
              return x ? MML.Archive.readEntry(bytes, x) : null;
            });
            label += '!' + MML.Archive.baseName(e.name);
          } else {
            info = await MML.PSF.load(bytes, async (n) => { const p = path.join(path.dirname(f), n); return fs.existsSync(p) ? readBytes(p) : null; });
          }
        } catch (e) { out.push({ label, error: e.message }); continue; }
        out.push({ label, info, song: 0 });
      }
      return out;
    },
    // 正解は SPU まで回した cap.audioL/R。同じ cap を再生器にも渡す(psf-replay-check.js と同じ考え方)
    async prepare(it, sec) {
      it.cap = await MML.Emu.capturePsfSongAsync(it.info, { durationSeconds: sec + 0.5, yieldFn: async () => {} });
    },
    reference(it) { const a = it.cap.audioL, b = it.cap.audioR, m = new Float32Array(a.length); for (let i = 0; i < a.length; i++) m[i] = (a[i] + b[i]) / 2; return m; },
    capture: (it) => it.cap,
    make: (ctx) => new MML.Audio.PsfReplayStreamPlayer(ctx),
    frames: (cap) => cap.frameLog.length,
    load(p, it, cap, lagged) { p.load(lagged || cap, cap.frameLog.length); },
    lag(cap) {
      const fl = [];
      const c = Object.assign({}, cap, { frameLog: fl });
      return { cap: c, feed(done) { while (fl.length < done && fl.length < cap.frameLog.length) fl.push(cap.frameLog[fl.length]); } };
    },
    muteAll: (p) => p.applyMute(new Array(24).fill(true)),
    unmuteAll: (p) => p.applyMute(new Array(24).fill(false)),
  };

  A.spc = {
    async list(root) {
      const out = [];
      for (const f of firstFiles(path.join(root, 'spc'), ['spc', 'rsn', 'zip', '7z', 'rar'], PER)) {
        let bytes = readBytes(f), label = path.basename(f);
        if (MML.Archive.detect(bytes)) {
          const list = await archiveEntries(MML, bytes, ['spc']);
          if (!list.length) continue;
          bytes = await MML.Archive.readEntry(bytes, list[0].entry);
          label += '!' + list[0].title;
        }
        out.push({ label, bytes, song: 0 });
      }
      return out;
    },
    reference: (it, sec) => new MML.Emu.SpcPlayer(it.bytes).renderSeconds(sec + 0.5, SR),
    capture: (it, sec) => MML.SPC2MML.captureAsync(it.bytes, sec + 0.5, null, null, { yieldFn }),
    make: (ctx) => new MML.Audio.SpcReplayStreamPlayer(ctx),
    frames: (cap) => cap.log.length,
    load(p, it, cap, lagged) {
      p.load(it.bytes, cap.log.length, (lagged || cap).log, 0);
      if (lagged) p.setCapturedFrames(0); else p.setCapturedFrames(null);
    },
    lag(cap) {
      const log = Array.from({ length: cap.log.length }, () => []);
      let player = null;
      return { cap: { log }, attach(p) { player = p; }, feed(done) { for (let f = 0; f < done && f < cap.log.length; f++) log[f] = cap.log[f]; if (player) player.setCapturedFrames(Math.min(done, cap.log.length)); } };
    },
    muteAll: (p) => p.applyMute(0xFF),
    unmuteAll: (p) => p.applyMute(0),
  };

  A.mml = {
    async list() {
      const out = [];
      const src = MML.Mml.sampleSource ? MML.Mml.sampleSource('ja') : null;
      if (src) out.push({ label: '組み込みサンプルMML', source: src, song: 0 });
      // 変換した曲も1つ(SPC→MML。変換の出力がそのまま再生器の入力になる)
      return out;
    },
    async prepare(it) { it.compiled = MML.Mml.compile(it.source, {}); },
    reference: (it, sec) => { const r = MML.Mml.render(it.source, { sampleRate: SR }); return r.audio.subarray(0, Math.min(r.audio.length, Math.floor((sec + 0.5) * SR))); },
    capture: (it) => it.compiled,
    make: (ctx) => new MML.Audio.MmlStreamPlayer(ctx),
    frames: (cap) => cap.totalFrames,
    load(p, it, cap) { p.load(cap); },
    lag: null,
    muteAll: (p) => p.applyMute({ apu: muteFromChips({ a: p.apu }).a, expansion: muteFromChips(p.expansionMap) }),
    unmuteAll: (p) => p.applyMute({ apu: unmuteFromChips({ a: p.apu }).a, expansion: unmuteFromChips(p.expansionMap) }),
  };
  return A;
}

// ---------------------------------------------------------------- 検査本体
async function checkSong(MML, fmt, ad, it, sec) {
  const results = [];
  const rec = (name, pass, detail, extra) => results.push(Object.assign({ name, pass, detail }, extra || {}));
  const fresh = (lagged) => {
    const p = ad.make(fakeCtx());
    ad.load(p, it, cap, lagged, sec);
    p.play();
    return p;
  };
  if (ad.prepare) await ad.prepare(it, sec);
  const cap = await ad.capture(it, sec);
  const totalFrames = ad.frames(cap, sec);
  const ref = await ad.reference(it, sec);
  const nb = nbufFor(sec);

  // 通常再生
  const pN = fresh();
  const normalChunks = [];
  let normalStalls = 0;
  for (let k = 0; k < nb && pN.isPlaying; k++) {
    const c = pump(pN, 1)[0];
    normalChunks.push(c);
    if (c.advanced < BUF && pN.isPlaying) normalStalls++; // 曲末で止まった分は数えない
  }
  while (normalChunks.length < nb) normalChunks.push({ L: new Float32Array(BUF), R: new Float32Array(BUF), advanced: BUF });
  const normal = mono(normalChunks, false);
  const endedEarly = !pN.isPlaying ? pN.getPosition() : null;
  if (normalStalls) rec('normal', false, `通常再生なのに ${normalStalls}/${nb} バッファで位置が進まなかった(取り込み済みなのに待っている)`);
  if (endedEarly !== null) rec('normal', null, `曲が ${endedEarly.toFixed(2)}s で終わった(データ末尾)。以降の検査はそこまでを比べる`);

  // ref: 正解 vs 再生器
  {
    const r = similarity(ref, normal, sec, { searchLag: true });
    rec('ref', r.mean >= 0.95 && r.min >= 0.7, `類似度 平均 ${r.mean.toFixed(3)} 最低 ${r.min.toFixed(3)}@${r.minAt.toFixed(1)}s (窓 ${r.n}, lag ${r.lag})`, { mean: r.mean, min: r.min });
  }

  // lag: 取り込みが遅れても最終的な音は同じ
  if (ad.lag) {
    const lg = ad.lag(cap);
    const p = ad.make(fakeCtx());
    ad.load(p, it, cap, lg.cap, sec);
    if (lg.attach) lg.attach(p);
    p.play();
    lg.feed(1);
    const chunks = [];
    let done = 1;
    const framesPerBuf = totalFrames / ((sec + 0.5) * SR / BUF);
    // 前半は再生の半分の速さでしか届かない → 後半で一気に追いつく
    for (let k = 0; k < nb * 3 && mono(chunks, true).length < normal.length; k++) {
      chunks.push(...pump(p, 1));
      if (k % 2 === 0 && done < totalFrames / 2) done += framesPerBuf;
      else if (done >= totalFrames / 2) done = totalFrames;
      lg.feed(Math.floor(done));
      if (k > nb * 3 - 2) break;
    }
    const got = mono(chunks, true);
    const stalls = chunks.filter(c => c.advanced < BUF).length;
    const r = relErr(normal, got, normal.length);
    const s = similarity(normal, got, sec);
    rec('lag', r.err < 0.01 && s.min >= 0.95, `待ち ${stalls} バッファ / 待ちを除いた出力の誤差 ${r.err.toFixed(4)}${r.first !== null ? ' 初差 ' + r.first.toFixed(2) + 's' : ''} / 類似度 最低 ${s.min.toFixed(3)}`, { err: r.err });
  } else rec('lag', null, '対象外(先読みなし)');

  // stop: 停止→再生 = 最初から
  {
    const p = fresh();
    pump(p, Math.floor(nb / 2));
    p.stop(); p.play();
    const again = mono(pump(p, nb), false);
    const r = relErr(normal, again);
    rec('stop', r.err < 1e-4, `停止→再生と最初からの誤差 ${r.err.toExponential(2)}${r.first !== null ? ' 初差 ' + r.first.toFixed(2) + 's' : ''}`, { err: r.err });
  }

  // reload: load を2回
  {
    const p = ad.make(fakeCtx());
    ad.load(p, it, cap, null, sec);
    pump(p, 3);
    ad.load(p, it, cap, null, sec);
    p.play();
    const again = mono(pump(p, nb), false);
    const r = relErr(normal, again);
    rec('reload', r.err < 1e-4, `2回 load と1回の誤差 ${r.err.toExponential(2)}${r.first !== null ? ' 初差 ' + r.first.toFixed(2) + 's' : ''}`, { err: r.err });
  }

  // pause: 一時停止中は位置が進まず、再開後は続きが一致
  {
    const p = fresh();
    const half = Math.floor(nb / 2);
    const a = pump(p, half);
    p.pause();
    const pos0 = p.getPosition();
    const during = pump(p, 5);
    const pos1 = p.getPosition();
    const silent = during.every(c => rms(c.L) < 1e-9);
    p.play();
    const b = pump(p, nb - half);
    const got = mono(a.concat(b), false);
    const r = relErr(normal, got);
    rec('pause', silent && Math.abs(pos1 - pos0) < 1e-6 && r.err < 1e-4, `停止中の無音 ${silent} / 位置 ${pos0.toFixed(3)}→${pos1.toFixed(3)} / 再開後の誤差 ${r.err.toExponential(2)}`, { err: r.err });
  }

  // seek
  {
    const p = fresh();
    pump(p, Math.floor(nb / 6));
    const target = Math.min(sec * 0.5, 2.5);
    p.seek(Math.round(target * SR));
    const posAfter = p.getPosition();
    const got = mono(pump(p, nbufFor(sec - target)), false);
    const from = Math.round(target * SR);
    const want = normal.subarray(from);
    const s = similarity(want, got, sec - target - 0.2, { searchLag: true });
    const posOk = Math.abs(posAfter - target) < 0.05;
    rec('seek', posOk && s.mean >= 0.9 && s.min >= 0.5, `${target}s へ: 位置の報告 ${posAfter.toFixed(3)} / 類似度 平均 ${s.mean.toFixed(3)} 最低 ${s.min.toFixed(3)}@+${s.minAt.toFixed(1)}s lag ${s.lag}`, { mean: s.mean, min: s.min });
  }

  // speed: 1/2 倍速でも音程は同じ
  {
    const p = fresh();
    p.setSpeed(0.5);
    const slow = mono(pump(p, nb), false);
    // slow の時刻 t は 正解の t/2
    const s = similarity(slow, ref, sec, { ratio: 0.5, searchLag: true });
    const dur = p.getDuration ? p.getDuration() : null;
    rec('speed', s.mean >= 0.9, `1/2倍速の窓 ↔ 正解の半分の時刻: 類似度 平均 ${s.mean.toFixed(3)} 最低 ${s.min.toFixed(3)} / getDuration=${dur === null ? '-' : dur.toFixed(1)}`, { mean: s.mean });
  }

  // mute: 全chミュートで無音、解除で復帰
  if (ad.muteAll) {
    const p = fresh();
    const third = Math.floor(nb / 3);
    const a = pump(p, third);
    ad.muteAll(p);
    const m = mono(pump(p, third), false);
    ad.unmuteAll(p);
    const b = mono(pump(p, nb - 2 * third), false);
    const level = rms(m, Math.floor(SR * 0.05)); // 頭の 50ms は DC 遮断の残りを許す
    const from = (2 * third) * BUF;
    const s = similarity(normal.subarray(from), b, sec - from / SR - 0.2);
    rec('mute', level < 1e-3 && s.mean >= 0.98, `ミュート中 RMS ${level.toExponential(2)} / 解除後の類似度 平均 ${s.mean.toFixed(3)} 最低 ${s.min.toFixed(3)}`, { level, mean: s.mean });
  }

  // end: 曲末
  {
    const p = fresh();
    let ended = 0; p.onEnded = () => ended++;
    const dur = p.getDuration ? p.getDuration() : totalFrames / 60;
    pump(p, nbufFor(dur + 1.5));
    const pos = p.getPosition();
    rec('end', ended === 1 && !p.isPlaying && pos <= dur + 0.1, `onEnded ${ended} 回 / isPlaying=${p.isPlaying} / 位置 ${pos.toFixed(2)} / 長さ ${dur.toFixed(2)}`);
  }
  return results;
}

async function main() {
  if (!ROOT && !FORMATS.every(f => f === 'mml')) { console.error('MML_CORPUS_ROOT か --corpus-root が必要(mml だけなら不要)'); process.exit(2); }
  const { MML } = load({ strict: true });
  const A = adapters(MML);
  const report = { generatedAt: new Date().toISOString(), sec: SEC, formats: {} };
  let ok = 0, ng = 0, skip = 0;
  for (const fmt of FORMATS) {
    const ad = A[fmt];
    if (!ad) { console.log(`skip ${fmt}: 未対応`); continue; }
    let items = [];
    try { items = await ad.list(ROOT); } catch (e) { console.log(`NG   ${fmt}: 曲一覧の取得に失敗 ${e.message}`); ng++; continue; }
    if (!items.length) { console.log(`skip ${fmt}: 曲が無い`); skip++; continue; }
    report.formats[fmt] = [];
    for (const it of items) {
      const t0 = Date.now();
      let res;
      if (it.error) res = [{ name: 'load', pass: false, detail: it.error }];
      else {
        try { res = await checkSong(MML, fmt, ad, it, SEC); }
        catch (e) { res = [{ name: 'exception', pass: false, detail: (e && e.stack || String(e)).split('\n').slice(0, 3).join(' | ') }]; }
      }
      const bad = res.filter(r => r.pass === false);
      console.log(`${bad.length ? 'NG  ' : 'OK  '} [${fmt}] ${it.label}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      for (const r of res) if (r.pass === false || VERBOSE) console.log(`      ${r.pass === null ? '--' : r.pass ? 'ok' : 'NG'} ${r.name.padEnd(7)} ${r.detail}`);
      report.formats[fmt].push({ label: it.label, results: res });
      if (bad.length) ng++; else ok++;
    }
  }
  console.log(`playback-check: OK ${ok} / NG ${ng} / skip ${skip}`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  process.exit(ng ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
