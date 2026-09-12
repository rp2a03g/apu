/*
 * 一括変換スナップショット回帰テスト(NSF/SPC/KSS/GBS/HES/VGM)
 *
 *   node tools/headless/regress.js --corpus "C:/Users/user/Desktop/emu sound/nsf" --update
 *   node tools/headless/regress.js --corpus "C:/Users/user/Desktop/emu sound/nsf"
 *   node tools/headless/regress.js --corpus ... --dump out/   (本文も残して目視diff用)
 *   node tools/headless/regress.js --corpus ... --cmd NOTE_END=zero --dump out/
 *       (変換設定を変えて走らせる。ベースラインは既定設定の SHA なので差分は出て当然。
 *        --dump した本文を別設定の --dump と比べる用途: 「設定 A と B で出力が同じか」の実測)
 *
 * 変換結果そのものではなく SHA-256 を manifest に持つ(数百曲分の本文をgitに
 * 入れると重いため)。「どの曲が変わったか」は manifest で分かり、「どう変わったか」は
 * --dump した本文を diff すれば分かる、という二段構え。
 *
 * 変換が例外で落ちた曲も失敗として記録して先へ進む(1曲の破損で全体が止まらない)。
 * ベースラインで成功していた曲が落ちるようになった場合と、出力が変化した場合に exit 1。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { convertBytes, expandInput, ctx, parseCmdFlags } = require('./convert');
const { ROOT } = require('./load');

// Windows でも Node はスラッシュ区切りを受け付ける(バックスラッシュのエスケープ事故を避ける)
// 環境変数 MML_CORPUS_ROOT があればその下の nsf/ を既定にする(check-all.js と同じ変数)
const DEFAULT_CORPUS = (process.env.MML_CORPUS_ROOT || 'C:/Users/user/Desktop/emu sound') + '/nsf';
const SUPPORTED = /\.(nsfe?|spc|kss|gbs|hes|vgm|vgz|zip|7z)$/i;

function sha(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16); }

/** コーパス直下と配下のサブディレクトリを再帰的に走査する(vgm/32x のような入れ子対策) */
function listSongs(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listSongs(full));
    else if (SUPPORTED.test(ent.name)) out.push(full);
  }
  return out;
}

/**
 * 入力パス群をアーカイブ展開して曲単位に均す。
 * アーカイブ1個に数百曲入っていることがあるので、既定では先頭 maxEntries 曲だけ見る。
 */
async function collectSongs(files, maxEntries, corpus) {
  const songs = [];
  for (const file of files) {
    // キーはコーパス相対パス。basename だとサブフォルダに同名ファイルがあると
    // manifest 上で衝突し、片方が黙って消える(実際に .zophar フォルダで踏んだ)。
    const rel = path.relative(corpus, file).replace(/\\/g, '/');
    let items;
    try {
      items = await expandInput(file);
    } catch (e) {
      songs.push({ key: rel, openError: `${e.constructor.name}: ${e.message}` });
      continue;
    }
    for (const it of items.slice(0, maxEntries)) {
      songs.push(Object.assign({}, it, { key: it.key.includes('!') ? `${rel}!${it.name}` : rel }));
    }
  }
  return songs;
}

/**
 * 出来上がったMMLが実際にコンパイルできるかを見る。
 * ★SHA比較だけでは「変換は通るがコンパイルエラーで再生も書き出しもできないMML」を
 *   取りこぼす。実際、VRC7自作音色の同時使用チェック追加(2026-08-27)でメガドライブ等の
 *   VGMが全滅していたのに、この回帰は最後まで緑のままだった。コンパイルエラーは
 *   ベースラインとの差分に関係なく常に失敗として扱う。
 */
function compileError(mml) {
  try {
    const errs = ctx().Mml.compile(mml, {}).errors || [];
    return errs.length ? (errs[0].lineNo ? `[Line ${errs[0].lineNo}] ` : '') + errs[0].message : null;
  } catch (e) {
    return `${e.constructor.name}: ${e.message}`;
  }
}

async function runOne(item, seconds, cmd) {
  if (item.openError) return { ok: false, error: item.openError };
  try {
    const bytes = item.read ? await item.read() : item.bytes;
    const r = await convertBytes(bytes, item.format, { seconds, cmd });
    const compErr = compileError(r.mml);
    return {
      ok: true,
      ...(compErr ? { compileError: compErr } : {}),
      format: r.format,
      bpm: r.bpm,
      expansions: (r.expansions || []).slice().sort(),
      chips: (r.chips || []).slice().sort(),
      lines: r.mml.split('\n').length,
      chars: r.mml.length,
      files: r.files.length,
      sha: sha(r.mml),
      ms: r.tCapture + r.tConvert,
      mml: r.mml,
    };
  } catch (e) {
    return { ok: false, error: `${e.constructor.name}: ${e.message}` };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
  const update = argv.includes('--update');
  const dumpDir = flag('--dump', null);
  const corpus = flag('--corpus', DEFAULT_CORPUS);
  const seconds = parseInt(flag('--sec', '15'), 10);
  const cmd = parseCmdFlags(flag('--preset', null), flag('--cmd', null)); // 省略時 undefined=既定設定
  const only = flag("--only", null);
  const verbose = argv.includes("--verbose");
  const name = flag('--name', path.basename(corpus));
  const maxEntries = flag('--entries', '1') === 'all' ? Infinity : parseInt(flag('--entries', '1'), 10);
  const manifestPath = path.join(__dirname, `baseline-${name}.json`);

  let paths = listSongs(corpus);
  if (only) paths = paths.filter((f) => path.basename(f).toLowerCase().includes(only.toLowerCase()));
  if (!paths.length) { console.error(`対象ファイルなし: ${corpus}`); process.exit(2); }
  const files = await collectSongs(paths, maxEntries, corpus);
  if (dumpDir) fs.mkdirSync(dumpDir, { recursive: true });

  const baseline = (!update && fs.existsSync(manifestPath))
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).entries : null;

  const entries = {};
  const failed = [];
  const changed = [];
  const uncompilable = [];
  const t0 = Date.now();

  for (let i = 0; i < files.length; i++) {
    const item = files[i];
    const key = item.key;
    // --verbose は「どの曲で固まっているか」を見るためのもの。変換前に名前を出す
    if (verbose) process.stderr.write(`[${i + 1}/${files.length}] ${key} ... `);
    const tOne = Date.now();
    const r = await runOne(item, seconds, cmd);
    if (verbose) process.stderr.write(`${Date.now() - tOne}ms ${r.ok ? '' : r.error}\n`);
    if (dumpDir && r.ok) fs.writeFileSync(path.join(dumpDir, key.replace(/[\\/:*?"<>|!]/g, '_') + '.mml'), r.mml);
    const { mml, ...rec } = r;
    entries[key] = rec;

    let mark = '.';
    if (r.ok && r.compileError) { uncompilable.push({ key, error: r.compileError }); mark = 'C'; }
    if (!r.ok) { failed.push({ key, error: r.error }); mark = 'X'; }
    else if (baseline && baseline[key] && baseline[key].sha !== r.sha) {
      changed.push({ key, from: baseline[key], to: rec }); mark = '~';
    }
    process.stderr.write(mark);
    if ((i + 1) % 60 === 0) process.stderr.write(` ${i + 1}/${files.length}\n`);
  }
  process.stderr.write('\n');

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const okCount = Object.values(entries).filter((e) => e.ok).length;
  console.log(`\n対象   : ${files.length} 曲 (各 ${seconds} 秒, ヘッダ既定の曲番号)`);
  console.log(`成功   : ${okCount}`);
  console.log(`失敗   : ${failed.length}`);
  console.log(`コンパイル不可: ${uncompilable.length}`);
  console.log(`所要   : ${elapsed} 秒`);

  if (failed.length) {
    console.log('\n--- 変換に失敗した曲 ---');
    for (const f of failed) console.log(`  ${f.key}\n      ${f.error}`);
  }

  if (uncompilable.length) {
    console.log('\n--- 変換はできたがMMLがコンパイルできない曲(再生も書き出しも不可) ---');
    for (const f of uncompilable.slice(0, 20)) console.log(`  ${f.key}\n      ${f.error}`);
    if (uncompilable.length > 20) console.log(`  …他 ${uncompilable.length - 20} 曲`);
  }

  if (update) {
    fs.writeFileSync(manifestPath, JSON.stringify({ corpus, seconds, created: new Date().toISOString(), entries }, null, 1));
    console.log(`\nベースラインを書き出しました: ${path.relative(ROOT, manifestPath)}`);
    // コンパイル不可はベースラインの差分と無関係に常にバグなので --update でも失敗にする
    // (「今の出力」を正としてしまうと、鳴らないMMLがそのまま正解として焼き付いてしまう)
    if (uncompilable.length) process.exit(1);
    return;
  }

  if (!baseline) { console.log(`\nベースライン未作成(${path.basename(manifestPath)})。--update で作成してください。`); process.exit(2); }

  if (changed.length) {
    console.log(`\n--- 出力が変化した曲: ${changed.length} ---`);
    for (const c of changed) {
      const d = [];
      if (c.from.bpm !== c.to.bpm) d.push(`bpm ${c.from.bpm}→${c.to.bpm}`);
      if (c.from.lines !== c.to.lines) d.push(`行 ${c.from.lines}→${c.to.lines}`);
      if (c.from.chars !== c.to.chars) d.push(`字 ${c.from.chars}→${c.to.chars}`);
      if (String(c.from.expansions) !== String(c.to.expansions)) d.push(`拡張 [${c.from.expansions}]→[${c.to.expansions}]`);
      if (String(c.from.chips) !== String(c.to.chips)) d.push(`chip [${c.from.chips}]→[${c.to.chips}]`);
      console.log(`  ${c.key}  ${d.join(' / ') || '本文のみ変化'}`);
    }
  } else {
    console.log('\n出力の変化なし。');
  }

  const newFailures = failed.filter((f) => baseline[f.key] && baseline[f.key].ok);
  if (newFailures.length || changed.length || uncompilable.length) process.exit(1);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(3); });
