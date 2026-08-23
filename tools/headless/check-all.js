/*
 * 全部まとめて回す(改修後の一括チェック用)
 *
 *   node tools/headless/check-all.js                        既定コーパスで全形式
 *   node tools/headless/check-all.js --corpus-root "D:/snd"  コーパスの親を変える
 *   node tools/headless/check-all.js --update                ベースライン更新
 *   node tools/headless/check-all.js --skip spc              時間のかかる形式を外す
 *   node tools/headless/check-all.js --no-cpu                CPU命令テストを省く
 *
 * 各コーパスを別プロセスで走らせる(1形式のメモリ肥大や異常終了が他へ波及しないため)。
 * 変化・失敗・CPUテスト失敗のいずれかがあれば exit 1。
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_ROOT = 'C:/Users/user/Desktop/emu sound';
const FORMATS = ['nsf', 'spc', 'kss', 'gbs', 'hes', 'vgm'];

function run(args) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
  const root = flag('--corpus-root', DEFAULT_ROOT);
  const update = argv.includes('--update');
  const seconds = flag('--sec', '15');
  const skip = (flag('--skip', '') || '').split(',').filter(Boolean);
  const rows = [];
  let bad = 0;

  for (const f of FORMATS) {
    if (skip.includes(f)) { rows.push([f, 'skip', '', '', '']); continue; }
    process.stderr.write(`\n=== ${f} ===\n`);
    const args = [path.join(__dirname, 'regress.js'), '--corpus', `${root}/${f}`, '--sec', seconds];
    if (update) args.push('--update');
    const { code, out } = run(args);
    process.stderr.write(out.split('\n').filter((l) => !/^[.X~ ]*$/.test(l)).join('\n') + '\n');

    const num = (re) => { const m = out.match(re); return m ? m[1] : '?'; };
    const changed = (out.match(/出力が変化した曲: (\d+)/) || [])[1] || '0';
    rows.push([f, num(/対象   : (\d+)/), num(/成功   : (\d+)/), num(/失敗   : (\d+)/), update ? '-' : changed]);
    if (code !== 0 && code !== 2) bad++;
  }

  if (!argv.includes('--no-cpu')) {
    process.stderr.write('\n=== cpu ===\n');
    const { code, out } = run([path.join(__dirname, 'cpu-test.js'), 'all', '--per', '200']);
    process.stderr.write(out.split('\n').filter((l) => !/^[.X? -]*$/.test(l)).join('\n') + '\n');
    rows.push(['cpu', '-', '-', code === 0 ? '0' : 'NG', '-']);
    if (code !== 0) bad++;
  }

  if (!argv.includes('--no-help')) {
    process.stderr.write('\n=== help ===\n');
    const { code, out } = run([path.join(__dirname, 'help-lint.js')]);
    process.stderr.write(out.trim() + '\n');
    const items = (out.match(/項目 (\d+)/) || [])[1] || '?';
    const errs = (out.match(/エラー (\d+)/) || [])[1] || '?';
    const missing = (out.match(/未掲載 (\d+)/) || [])[1] || '?';
    rows.push(['help', items, '-', errs, missing + ' 未掲載']);
    if (code !== 0) bad++;
  }

  console.log('\n' + '='.repeat(52));
  console.log('形式    対象    成功    失敗    変化');
  for (const r of rows) {
    console.log(`${String(r[0]).padEnd(7)} ${String(r[1]).padStart(5)} ${String(r[2]).padStart(7)} ${String(r[3]).padStart(7)} ${String(r[4]).padStart(7)}`);
  }
  console.log('='.repeat(52));
  console.log(bad === 0 ? '✅ 変化・新規失敗なし' : `❌ ${bad} 項目に変化または失敗`);
  process.exit(bad === 0 ? 0 : 1);
}

main();
