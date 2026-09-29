/*
 * ヘッドレス変換 API + CLI (NSF/SPC/KSS/GBS/HES/VGM 全対応、zip/7z/gzip 内も可)
 *
 *   node tools/headless/convert.js "song.nsf" --song 0 --sec 30 -o out.mml
 *   node tools/headless/convert.js "pack.zip" --entry 3 --sec 60
 *   node tools/headless/convert.js "pack.7z"  --list
 *   node tools/headless/convert.js "song.spc" --plan V0=pulse1,V1=pulse1,V2=triangle --merge V0+V1
 *   node tools/headless/convert.js "song.spc" --plan V0=pulse1,V0#1=n163_0 --copy V0#1/t=12/c=-5/d=30
 *     (--plan の '<行>#<n>' は複製行。--copy で 移調t(半音)/デチューンc(セント)/遅延d(フレーム))
 *     (--plan は行ID=借用先。--merge は同じ借用先の行を1パートにまとめる印。SPC/KSS/GBS/HES は鍵盤の行ID、VGM/PSF は変換器のソースID)
 *
 * ブラウザの main.js と同じ手順(parseHeader → fromXxx / captureSong+convert)を
 * DOM抜きでなぞる。NSF の captureSong(同期版)は captureSongAsync と _processFrame を
 * 共有しているため、UI経由の変換結果と一致する。
 *
 * --song は「そのフォーマットの変換APIが期待する値」をそのまま渡す:
 *   nsf/gbs/kss … 0始まりの曲インデックス
 *   hes         … トラック番号そのもの(HESの firstTrack は0/1始まりの規約が無く、
 *                  ゲームがINIT時のAレジスタとして直接解釈する任意の8bit値)
 *   spc/vgm     … 単曲なので無視
 * 省略時は defaultSong() がヘッダの宣言値(startingSong/firstSong/firstTrack)を使う。
 * ここを一律0にすると、firstTrack=1のHESで「存在しないトラック0」を変換してしまい、
 * 全休符のMMLが出来上がる(実際に6曲で踏んだ)。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { load, readBytes } = require('./load');

let _loaded = null;
function ctx() {
  if (!_loaded) _loaded = load({ strict: true });
  return _loaded.MML;
}

const SONG_EXTS = ['nsf', 'nsfe', 'spc', 'kss', 'gbs', 'hes', 'vgm', 'vgz', 'psf', 'minipsf'];
const ARCHIVE_EXTS = ['zip', '7z', 'rar', 'rsn'];

function extOf(name) { return path.extname(name).toLowerCase().replace('.', ''); }

/** 拡張子からフォーマットを推定する */
function detectFormat(name) {
  const ext = extOf(name);
  if (ext === 'nsf' || ext === 'nsfe') return 'nsf';
  if (ext === 'vgz') return 'vgm';
  if (ext === 'minipsf') return 'psf';
  if (SONG_EXTS.includes(ext)) return ext;
  throw new Error(`未知の拡張子: .${ext}`);
}

function isArchive(name) { return ARCHIVE_EXTS.includes(extOf(name)); }

/**
 * 入力パスを「変換可能な曲バイト列」の一覧に展開する。
 * 素のファイルなら1件、アーカイブなら中の対応拡張子ぶん(ブラウザの曲リストと同じ考え方)。
 *
 * ★バイト列は必ず read() 越しの遅延読み込みにすること。返り値にバイト列を持たせたり
 *   クロージャでアーカイブ全体を掴んだままにすると、コーパス全体を列挙した時点で
 *   全ファイルがメモリに居座る(VGMの589アーカイブで数百MBに膨らんだ)。
 *   read() のたびにディスクから読み直す方が、遅いが桁違いに省メモリで済む。
 * @returns {Promise<Array<{key:string, name:string, format:string, read:()=>Promise<Uint8Array>}>>}
 */
async function expandInput(file) {
  const MML = ctx();
  const base = path.basename(file);

  if (!isArchive(base)) {
    // PSF の _lib(.psflib)は同じフォルダの兄弟ファイルから引く
    const dir = path.dirname(file);
    const resolveLib = async (name) => {
      const p = path.join(dir, name);
      return fs.existsSync(p) ? readBytes(p) : null;
    };
    return [{ key: base, name: base, format: detectFormat(base), read: async () => readBytes(file), resolveLib }];
  }

  const raw = readBytes(file);
  const { entries } = await MML.Archive.parse(raw);
  const out = [];
  for (const e of entries) {
    if (e.isDir || !SONG_EXTS.includes(extOf(e.name))) continue;
    out.push({
      key: `${base}!${e.name}`,
      name: e.name,
      format: detectFormat(e.name),
      read: async () => MML.Archive.readEntry(readBytes(file), e),
      // PSF の _lib はアーカイブ内の兄弟エントリから引く(ブラウザの makeArchiveSiblingResolver と同じ照合順)
      resolveLib: async (libName) => {
        const want = libName.replace(/\\/g, '/').toLowerCase();
        const dir = e.name.lastIndexOf('/') >= 0 ? e.name.slice(0, e.name.lastIndexOf('/') + 1).toLowerCase() : '';
        const files = entries.filter(x => !x.isDir);
        const hit = files.find(x => x.name.toLowerCase() === dir + want)
          || files.find(x => x.name.toLowerCase() === want)
          || files.find(x => MML.Archive.baseName(x.name).toLowerCase() === MML.Archive.baseName(want));
        return hit ? MML.Archive.readEntry(readBytes(file), hit) : null;
      },
    });
  }
  return out;  // ここで raw の参照が切れる(entries はオフセット情報だけを持つ)
}

/** ヘッダを読んで曲数などのメタ情報を返す(変換はしない) */
async function probe(bytes, format) {
  const MML = ctx();
  if (format === 'vgm') bytes = await MML.Archive.gunzipIfNeeded(bytes);
  // NSFe は素のNSFバイト列へ正規化してから同じ経路へ(ブラウザの loadNsfFile と同じ)
  if (format === 'nsf' && MML.NSF.isNsfe(bytes)) bytes = MML.NSF.normalize(bytes).bytes;
  const header = {
    nsf: () => MML.NSF.normalize(bytes).header,
    spc: () => MML.SPC.parseHeader(bytes),
    kss: () => MML.KSS.parseHeader(bytes),
    gbs: () => MML.GBS.parseHeader(bytes),
    hes: () => MML.HES.parseHeader(bytes),
    vgm: () => MML.VGM.parseHeader(bytes),
    psf: () => { const p = MML.PSF.parse(bytes); return Object.assign({ title: p.tags.title || '', gameName: p.tags.game || '' }, { tags: p.tags }); },
  }[format]();
  const songs = header.totalSongs || header.songCount || header.numSongs || 1;
  return { bytes, header, songs };
}

/** --plan(行ID→借用先)/--merge(行ID→true)を各変換器の options に。どちらも無ければ空(既定経路のまま) */
function planOpts(opt) {
  const o = {};
  if (opt.plan) o.channelMap = opt.plan;
  if (opt.merge) o.merge = opt.merge;
  const copies = copiesOf(opt);
  if (copies) o.copies = copies;
  return o;
}
/** --plan の '<元ch>#<n>' キーと --copy の加工から複製の表 { copyId: { of, transpose, detune, delay } } を作る */
function copiesOf(opt) {
  const o = {};
  for (const id of Object.keys(opt.plan || {})) {
    const m = /^(.+)#(\d+)$/.exec(id);
    if (m) o[id] = Object.assign({ of: m[1], transpose: 0, detune: 0, delay: 0 }, (opt.copy || {})[id] || {});
  }
  return Object.keys(o).length ? o : null;
}
/** SPC は channelMap が8要素の配列(既定 V0-3→A-D、V4-7 skip)。--plan/--merge が無ければ undefined(既定経路) */
function spcChannelMap(plan, merge, copy) {
  if (!plan && !merge) return undefined;
  const DEF = ['pulse1', 'pulse2', 'triangle', 'noise', 'skip', 'skip', 'skip', 'skip'];
  const map = DEF.map((t, ch) => { const id = 'V' + ch; return { type: (plan && plan[id]) || t, merge: !!(merge && merge[id]) }; });
  // 複製('V0#1' 等)は 8 以降(main.js と同じ形)
  const copies = copiesOf({ plan, copy }) || {};
  for (const id of Object.keys(copies)) {
    const m = /^V(\d)$/.exec(copies[id].of);
    if (m) map.push({ type: plan[id], merge: !!(merge && merge[id]), copyOf: +m[1], copyId: id, transpose: copies[id].transpose, detune: copies[id].detune, delay: copies[id].delay });
  }
  return map;
}
/** "V0#1/t=12/c=-5/d=30" → { 'V0#1': { transpose: 12, detune: -5, delay: 30 } }(区切りは / 。VGM のソースID 'opm:0' が : を含むため) */
function parseCopyFlag(s) {
  if (!s) return null;
  const o = {};
  for (const item of s.split(',')) {
    const parts = item.trim().split('/');
    const id = parts.shift();
    if (!id) continue;
    const c = {};
    for (const p of parts) { const m = /^([tcd])=(-?\d+)$/.exec(p); if (m) c[{ t: 'transpose', c: 'detune', d: 'delay' }[m[1]]] = +m[2]; }
    o[id] = c;
  }
  return Object.keys(o).length ? o : null;
}
/** "V0=pulse1,V1=pulse1" → { V0: 'pulse1', V1: 'pulse1' } */
function parsePlanFlag(s) {
  if (!s) return null;
  const o = {};
  for (const kv of s.split(',')) { const m = /^([^=]+)=(.+)$/.exec(kv.trim()); if (m) o[m[1]] = m[2]; }
  return Object.keys(o).length ? o : null;
}
/** "V0+V1,V2+V3" → { V0: true, V1: true, V2: true, V3: true } */
function parseMergeFlag(s) {
  if (!s) return null;
  const o = {};
  for (const g of s.split(',')) for (const id of g.split('+')) if (id.trim()) o[id.trim()] = true;
  return Object.keys(o).length ? o : null;
}

/** ヘッダが宣言する既定の曲番号(--song 省略時に使う) */
function defaultSong(format, header) {
  if (format === 'nsf') return Math.max(0, (header.startingSong || 1) - 1);
  if (format === 'hes') return header.firstTrack || 0;   // 0始まりとは限らない生のトラック番号
  if (format === 'kss') return header.firstSong || 0;
  return 0;  // gbs は firstSong 起点の0始まりインデックス、spc/vgm は単曲
}

/**
 * バイト列を MML へ変換する
 * @param {Uint8Array} rawBytes
 * @param {string} format
 * @param {object} opt {song(省略時はヘッダ既定), seconds, bpm, sampleRate,
 *                      cmd(変換設定 src/convert/options.js。省略時はプリセット「全コマンド」=従来通り)}
 */
async function convertBytes(rawBytes, format, opt = {}) {
  const MML = ctx();
  const { seconds = 30, bpm = null, sampleRate = 48000, cmd = undefined } = opt;
  const { bytes, header, songs } = await probe(rawBytes, format);
  const song = opt.song != null ? opt.song : defaultSong(format, header);

  const t0 = Date.now();
  let r;
  let tCapture = 0;

  if (format === 'nsf') {
    // NSF だけは capture と convert が分かれている(ピアノロール等が中間結果を使うため)
    const cap = MML.Emu.captureSong(bytes, {
      songIndex: song, durationSeconds: seconds, sampleRate, mute: {},
    });
    tCapture = Date.now() - t0;
    r = MML.NSF2MML.convert(
      cap.writeLog, bytes, header, song, cap.initRegs, cap.initWrites,
      { bpm, cmd, n163Snapshots: cap.n163Snapshots });
    r.capture = cap;
  } else if (format === 'spc') {
    r = MML.SPC2MML.fromSpc(bytes, seconds, { bpm, cmd, channelMap: spcChannelMap(opt.plan, opt.merge, opt.copy) });
  } else if (format === 'kss') {
    r = await MML.KSS2MML.fromKss(bytes, song, seconds, Object.assign({ bpm, cmd }, planOpts(opt)));
  } else if (format === 'gbs') {
    r = await MML.GBS2MML.fromGbs(bytes, song, seconds, Object.assign({ bpm, cmd }, planOpts(opt)));
  } else if (format === 'hes') {
    r = await MML.HES2MML.fromHes(bytes, song, seconds, Object.assign({ bpm, cmd }, planOpts(opt)));
  } else if (format === 'vgm') {
    // channelMap を渡さないと defaultPlan + 全ch抽出になる(UI未操作時と同じ挙動)
    r = await MML.VGM2MML.fromVgm(bytes, seconds, Object.assign({ bpm, cmd }, planOpts(opt)));
  } else if (format === 'psf') {
    // _lib は opt.resolveLib(expandInput が付ける)で解決。yield 無しで一気に回す
    const info = await MML.PSF.load(bytes, opt.resolveLib || null);
    r = await MML.PSF2MML.fromPsf(info, seconds, { bpm, cmd, yieldFn: async () => {} });
  } else {
    throw new Error(`未対応フォーマット: ${format}`);
  }

  const total = Date.now() - t0;
  return Object.assign({}, r, {
    format, song, songs, header,
    // フォーマットごとに expansion / expansions と揺れているので正規化する
    expansions: r.expansions || (r.expansion ? [r.expansion] : []),
    files: r.dpcmFiles || r.dmcFiles || [],
    tCapture, tConvert: total - tCapture,
  });
}

/**
 * --preset / --cmd から変換設定(options.cmd)を組み立てる。
 * --preset plain|faithful を土台に、--cmd "D=0,EP=0,SHAPE_REST=1" で個別上書き。
 * どちらも無ければ undefined(=プリセット「全コマンド」、従来通り)。
 */
function parseCmdFlags(preset, cmdStr) {
  if (!preset && !cmdStr) return undefined;
  const MML = ctx();
  const base = preset ? MML.Convert.CMD_PRESETS[preset] : null;
  if (preset && !base) throw new Error(`未知のプリセット: ${preset}`);
  const out = Object.assign({}, base || {});
  for (const kv of (cmdStr || '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    const raw = v === undefined ? '1' : v.trim();
    // 真偽値っぽい語はboolean、それ以外は文字列/数値のまま(DMC_RATE=14, DRUM_POLY=mono, PITCH_SA=off 等の
    // 列挙値設定に対応。'off' は PITCH_SA の値でもあるので、キーが列挙値設定のときは文字列で渡す)
    const enumKey = ['DMC_RATE', 'PITCH_SA', 'RATE_MIX', 'DRUM_POLY', 'N163_WAVE', 'N163_CH', 'TUNING', 'TUNING_MIN', 'NOTE_END', 'GATE_TOL', 'LEN_SNAP', 'PART_ORDER', 'BARS_PER_LINE', 'CHANNEL_ORDER', 'SN_PERIODIC', 'SHARE_LINES', 'SHARE_SPLIT_MAX', 'SHARE_MIN_BARS'].indexOf(k.trim()) >= 0;
    if (enumKey) out[k.trim()] = isNaN(Number(raw)) ? raw : Number(raw);
    else out[k.trim()] = !(raw === '0' || raw === 'false' || raw === 'off');
  }
  return out;
}

/** パス指定で1曲変換する(アーカイブなら opt.entry 番目) */
async function convertFile(file, opt = {}) {
  const items = await expandInput(file);
  if (!items.length) throw new Error(`変換対象が見つからない: ${file}`);
  const item = items[opt.entry || 0];
  if (!item) throw new Error(`エントリ番号が範囲外: ${opt.entry} (0..${items.length - 1})`);
  const bytes = item.read ? await item.read() : item.bytes;
  const r = await convertBytes(bytes, item.format, Object.assign({ resolveLib: item.resolveLib }, opt));
  return Object.assign(r, { file, key: item.key, entries: items.length });
}

module.exports = { convertFile, convertBytes, expandInput, probe, defaultSong, detectFormat, isArchive, SONG_EXTS, ctx, parseCmdFlags, parsePlanFlag, parseMergeFlag, parseCopyFlag };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('-'));
  const flag = (name, def) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
  };
  if (!file) {
    console.error('usage: node tools/headless/convert.js <file> [--song N] [--entry N] [--sec S] [-o out.mml] [--list] [--preset plain|faithful] [--cmd D=0,EP=0,NOTE_END=zero,...] [--plan V0=pulse1,V1=pulse1] [--merge V0+V1] [--copy V0#1/t=12/c=-5/d=30]');
    process.exit(2);
  }

  (async () => {
    if (argv.includes('--list')) {
      const items = await expandInput(file);
      items.forEach((it, i) => console.log(`${String(i).padStart(3)}  ${it.format.padEnd(4)}  ${it.name}`));
      console.error(`\n${items.length} エントリ`);
      return;
    }
    const r = await convertFile(file, {
      song: flag('--song', null) != null ? parseInt(flag('--song', '0'), 10) : null,
      entry: parseInt(flag('--entry', '0'), 10),
      seconds: parseInt(flag('--sec', '30'), 10),
      cmd: parseCmdFlags(flag('--preset', null), flag('--cmd', null)),
      plan: parsePlanFlag(flag('--plan', null)),
      merge: parseMergeFlag(flag('--merge', null)),
      copy: parseCopyFlag(flag('--copy', null)),
    });
    const out = flag('-o', null);
    const title = r.header.songName || r.header.title || r.header.gameName || '(no title)';
    console.error(`format   : ${r.format}`);
    console.error(`entry    : ${r.key}`);
    console.error(`title    : ${title}`);
    console.error(`songs    : ${r.songs}  (converted index ${r.song})`);
    console.error(`chips    : ${(r.chips || []).join(',') || '-'}`);
    console.error(`expansion: ${r.expansions.join(',') || 'none'}`);
    console.error(`bpm      : ${r.bpm}`);
    console.error(`mml      : ${r.mml.split('\n').length} 行 / ${r.mml.length} 文字`);
    console.error(`files    : ${r.files.length} 個`);
    console.error(`time     : capture ${r.tCapture}ms + convert ${r.tConvert}ms`);
    if (out) { fs.writeFileSync(out, r.mml); console.error(`wrote    : ${out}`); }
    else console.log(r.mml);
  })().catch((e) => {
    console.error(`変換失敗: ${e.stack || e.message}`);
    process.exit(1);
  });
}
