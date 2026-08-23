/*
 * index.html の <script> を順番どおり Node に読み込むローダー
 *
 *   const { MML, errors } = require('./tools/headless/load').load();
 *   const cap = MML.Emu.captureSong(nsfBytes, { seconds: 30 });
 *
 * なぜ動くか: src/ は全ファイルが (function(global){...})(window) の
 * 素朴なIIFEで、単一グローバル MML にぶら下がるだけの構造。ESMでもCJSでも
 * ないので、順番に eval するだけでブラウザと同じ状態が再現できる。
 *
 * vm.runInThisContext を使う(vm.createContext ではない)のは意図的:
 * 別realmだと Uint8Array 等の instanceof がまたいだ瞬間に false になり、
 * バイト列を渡す我々の用途では地雷にしかならないため。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { installShim } = require('./shim');

const ROOT = path.resolve(__dirname, '..', '..');

/** index.html に書かれた src を出現順で返す(これが唯一の正典。手で並べない) */
function scriptSources(html) {
  const re = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

/**
 * @param {object} opt
 * @param {RegExp[]} [opt.skip]    読み込まないファイル(パスに対する正規表現)
 * @param {boolean}  [opt.verbose] 読み込んだファイルを1行ずつ出す
 * @param {boolean}  [opt.strict]  1本でも失敗したら例外にする
 */
function load(opt = {}) {
  const { skip = [], verbose = false, strict = false } = opt;
  const g = installShim();

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const srcs = scriptSources(html);

  const loaded = [];
  const skipped = [];
  const errors = [];

  for (const src of srcs) {
    if (skip.some((re) => re.test(src))) { skipped.push(src); continue; }
    const file = path.join(ROOT, src);
    let code;
    try {
      code = fs.readFileSync(file, 'utf8');
    } catch (e) {
      errors.push({ src, phase: 'read', message: e.message });
      continue;
    }
    try {
      vm.runInThisContext(code, { filename: file });
      loaded.push(src);
      if (verbose) console.error(`  ok   ${src}`);
    } catch (e) {
      errors.push({ src, phase: 'exec', message: e.message, stack: e.stack });
      if (verbose) console.error(`  FAIL ${src}: ${e.message}`);
    }
  }

  if (strict && errors.length) {
    const lines = errors.map((e) => `  ${e.src}: ${e.message}`).join('\n');
    throw new Error(`ヘッドレス読み込みで ${errors.length} 本が失敗:\n${lines}`);
  }

  return { MML: g.MML, global: g, loaded, skipped, errors, sources: srcs };
}

/** ファイルをバイト列で読む小道具(各テストスクリプトで使う) */
function readBytes(file) {
  return new Uint8Array(fs.readFileSync(file));
}

/** index.html に載っていないスクリプト(tools/ 配下等)を追加で読み込む */
function loadScript(relPath) {
  const file = path.isAbsolute(relPath) ? relPath : path.join(ROOT, relPath);
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
  return globalThis.MML;
}

module.exports = { load, loadScript, readBytes, scriptSources, ROOT };

// 直接実行したら読み込み状況のレポートを出す
if (require.main === module) {
  const r = load({ verbose: process.argv.includes('-v') });
  console.log(`scripts : ${r.sources.length}`);
  console.log(`loaded  : ${r.loaded.length}`);
  console.log(`errors  : ${r.errors.length}`);
  for (const e of r.errors) console.log(`  FAIL ${e.src}\n        ${e.message}`);
  const ns = Object.keys(r.MML || {}).sort();
  console.log(`MML.*   : ${ns.length} 個\n  ${ns.join(' ')}`);
}
