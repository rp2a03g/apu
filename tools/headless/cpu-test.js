/*
 * CPU命令テスト CLI (6502 / Z80 / SM83 / SPC700)
 *
 *   node tools/headless/cpu-test.js 6502              代表命令だけ(既定)
 *   node tools/headless/cpu-test.js 6502 --all        全256命令
 *   node tools/headless/cpu-test.js z80 --group cb    プレフィックス群を指定
 *   node tools/headless/cpu-test.js sm83 --opcodes 00,cb 07
 *   node tools/headless/cpu-test.js all --per 100     4種まとめて
 *
 * 検証ロジックは tools/cpu-test-core.js(ブラウザ版 tools/*-test.html と共通)。
 * ここがやるのはベクタの取得・キャッシュ・進捗表示・終了コードだけ。
 *
 * テストベクタは SingleStepTests から取得し tools/headless/.vectors/ にキャッシュする。
 * 1命令あたり数MBあるので、--all は初回に数百MB落ちる(2回目以降はオフライン)。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { load, loadScript } = require('./load');

const CACHE_DIR = path.join(__dirname, '.vectors');

// 既定で回す代表命令。アドレッシングモードとフラグ更新を一通り踏む選び方にしてある。
// 網羅したいときは --all を使う(その代わり初回のダウンロードが重い)。
const DEFAULT_OPCODES = {
  '6502': ['69', '65', '75', '6d', '7d', '79', '61', '71', 'a9', 'bd', '4c', '6c', '20', '60', 'e8', 'c9', 'f0', '0a', '66', '28'],
  z80: ['00', '01', '09', '12', '27', '34', '3a', '76', '80', '90', 'a8', 'b0', 'c3', 'cd', 'c9', 'db', 'ed 42', 'ed b0', 'cb 06', 'dd 34'],
  sm83: ['00', '01', '09', '12', '27', '34', '3a', '76', '80', '90', 'a8', 'b0', 'c3', 'cd', 'c9', 'e8', 'f8', 'cb 06', 'cb 26', 'cb 46'],
  spc700: ['00', '04', '10', '1c', '28', '30', '3f', '48', '5d', '65', '78', '7a', '8f', '9c', 'af', 'ba', 'c4', 'cf', 'da', 'e4'],
};

async function fetchVector(spec, cpuName, file) {
  const cachePath = path.join(CACHE_DIR, cpuName, file.localPath);
  if (fs.existsSync(cachePath)) {
    return { json: JSON.parse(fs.readFileSync(cachePath, 'utf8')), cached: true };
  }
  const res = await fetch(spec.vectorBase + file.path);
  if (!res.ok) return { missing: true, status: res.status };
  const text = await res.text();
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, text);
  return { json: JSON.parse(text), cached: false, bytes: text.length };
}

async function testCpu(cpuName, opt) {
  const MML = globalThis.MML;
  const spec = MML.CpuTest.SPECS[cpuName];
  if (!spec) throw new Error(`未知のCPU: ${cpuName} (${Object.keys(MML.CpuTest.SPECS).join('/')})`);

  const runner = spec.createRunner();
  const per = opt.per || (spec.defaultPer === Infinity ? 10000 : spec.defaultPer);

  // 対象ファイルを決める
  let files = [];
  for (const g of spec.groups()) {
    if (opt.group && g.key !== opt.group) continue;
    files.push(...g.files);
  }
  if (opt.opcodes) {
    const want = new Set(opt.opcodes.map((s) => s.trim().toLowerCase()));
    files = files.filter((f) => want.has(f.name.toLowerCase()));
  } else if (!opt.all) {
    const want = new Set(DEFAULT_OPCODES[cpuName].map((s) => s.toLowerCase()));
    files = files.filter((f) => want.has(f.name.toLowerCase()));
  }
  // 未実装(非公式)命令はテスト対象外
  files = files.filter((f) => f.group !== 'main' || runner.isImplemented(f.op));

  if (!files.length) throw new Error('対象命令が0件');

  let okSum = 0, totalSum = 0, downloaded = 0, dlBytes = 0, missing = 0;
  const failed = {};

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let v;
    try {
      v = await fetchVector(spec, cpuName, f);
    } catch (e) {
      process.stderr.write('?');
      missing++;
      continue;
    }
    if (v.missing) { process.stderr.write('-'); missing++; continue; }
    if (!v.cached) { downloaded++; dlBytes += v.bytes; }

    const r = runner.runOne(v.json, per);
    okSum += r.pass; totalSum += r.total;
    if (r.pass === r.total) process.stderr.write('.');
    else { process.stderr.write('X'); failed[f.name] = r; }
    if ((i + 1) % 64 === 0) process.stderr.write(` ${i + 1}/${files.length}\n`);
  }
  process.stderr.write('\n');

  const failCount = Object.keys(failed).length;
  console.log(`\n[${cpuName}] ${spec.label}`);
  console.log(`  命令   : ${files.length}${missing ? ` (ベクタ無し ${missing})` : ''}`);
  console.log(`  ケース : ${okSum.toLocaleString()} / ${totalSum.toLocaleString()} pass`);
  console.log(`  DL     : ${downloaded} ファイル (${(dlBytes / 1048576).toFixed(1)} MB)${downloaded ? '' : ' ※全てキャッシュ'}`);
  console.log(`  結果   : ${failCount === 0 ? '✅ 全命令 PASS' : `❌ ${failCount} 命令で失敗`}`);

  for (const [name, r] of Object.entries(failed)) {
    console.log(`\n  --- ${name}: ${r.total - r.pass}/${r.total} 失敗 (cyc:${r.cycBad} state:${r.stateBad} ram:${r.ramBad}${r.imeBad ? ` ime:${r.imeBad}` : ''})`);
    for (const f of r.fails) {
      console.log(`      ${f.name}`);
      console.log(`        exp ${JSON.stringify(f.exp)}`);
      console.log(`        got ${JSON.stringify(f.got)}`);
    }
  }
  return failCount;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
  const target = argv.find((a) => !a.startsWith('-')) || 'all';

  // index.html の全スクリプト + テスト共通コアを読む
  load({ strict: true });
  loadScript('tools/cpu-test-core.js');

  const opt = {
    per: parseInt(flag('--per', '0'), 10) || 0,
    all: argv.includes('--all'),
    group: flag('--group', null),
    opcodes: flag('--opcodes', null) ? flag('--opcodes', '').split(',') : null,
  };

  const cpus = target === 'all' ? ['6502', 'z80', 'sm83', 'spc700'] : [target];
  let totalFail = 0;
  for (const c of cpus) totalFail += await testCpu(c, opt);

  console.log(`\n${totalFail === 0 ? '✅ 全て PASS' : `❌ 合計 ${totalFail} 命令で失敗`}`);
  process.exit(totalFail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(3); });
