/*
 * 不具合探しをまとめて回して、報告(Markdown)を書く
 *
 *   node tools/headless/bughunt/run-all.js                         (要 MML_CORPUS_ROOT)
 *   node tools/headless/bughunt/run-all.js --out report.md --per 3 --sec 8
 *   node tools/headless/bughunt/run-all.js --skip playback         片方だけ
 *
 * playback-check.js(再生器の差分検査)と io-check.js(入出力・変換の通し検査)を別プロセスで走らせ、
 * それぞれの JSON をまとめて1本の報告にする。報告は「直す」ためのものなので、NG だけでなく
 * 境界値(閾値ぎりぎり)も残す。曲名が入るので報告ファイルはリポジトリに入れない(_tmp_test/ 既定)。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const REPO = path.resolve(__dirname, '..', '..', '..');
const OUT = flag('--out', path.join(REPO, '_tmp_test', 'bughunt-report.md'));
const SKIP = (flag('--skip', '')).split(',').filter(Boolean);
const PER = flag('--per', '2'), SEC = flag('--sec', '6');
const CORPUS = flag('--corpus-root', process.env.MML_CORPUS_ROOT || null);
const tmp = path.join(REPO, '_tmp_test');
fs.mkdirSync(tmp, { recursive: true });

function run(name, args) {
  const t0 = Date.now();
  process.stderr.write(`== ${name}\n`);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 256 << 20, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, CORPUS ? { MML_CORPUS_ROOT: CORPUS } : {}) });
  fs.writeFileSync(path.join(tmp, `bughunt-${name}.log`), (r.stdout || '') + (r.stderr || ''));
  return { code: r.status, sec: (Date.now() - t0) / 1000 };
}

const sections = [];
if (!SKIP.includes('playback')) {
  const json = path.join(tmp, 'bughunt-playback.json');
  const r = run('playback', [path.join(__dirname, 'playback-check.js'), '--per', PER, '--sec', SEC, '--verbose', '--json', json].concat(CORPUS ? ['--corpus-root', CORPUS] : []));
  const data = fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : null;
  sections.push({ name: '再生器の差分検査(playback-check)', kind: 'playback', data, r });
}
if (!SKIP.includes('io')) {
  const json = path.join(tmp, 'bughunt-io.json');
  const r = run('io', [path.join(__dirname, 'io-check.js'), '--sec', String(Math.max(8, +SEC)), '--json', json].concat(CORPUS ? ['--corpus-root', CORPUS] : []));
  const data = fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : null;
  sections.push({ name: '入出力・変換の通し検査(io-check)', kind: 'io', data, r });
}

// ---- 報告
const L = [];
L.push(`# 不具合探しの報告 (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`);
L.push('');
L.push('耳を使わずに拾える範囲の自動検査。「NG」は閾値を外れたもの、「注意」は閾値内だがぎりぎりのもの。');
L.push('正解の経路そのものが実機と違う不具合と、聴こえ方の好みは対象外。');
L.push('');
let totalNg = 0;
for (const s of sections) {
  L.push(`## ${s.name}  (${s.r.sec.toFixed(0)}s, exit ${s.r.code})`);
  L.push('');
  if (!s.data) { L.push('結果の JSON が無い(途中で落ちた)。ログ: `_tmp_test/bughunt-' + s.kind + '.log`'); L.push(''); continue; }
  if (s.kind === 'playback') {
    const rows = [];
    for (const [fmt, songs] of Object.entries(s.data.formats)) {
      for (const song of songs) {
        for (const r of song.results) {
          if (r.pass === true) {
            // ぎりぎり: 類似度 0.95 未満 / 誤差 1e-3 超
            const edge = (r.mean !== undefined && r.mean < 0.97) || (r.err !== undefined && r.err > 1e-3) || (r.min !== undefined && r.min < 0.8);
            if (!edge) continue;
            rows.push([fmt, song.label, r.name, '注意', r.detail]);
          } else if (r.pass === false) { rows.push([fmt, song.label, r.name, 'NG', r.detail]); totalNg++; }
          else rows.push([fmt, song.label, r.name, '情報', r.detail]);
        }
      }
    }
    const ok = Object.values(s.data.formats).flat().filter(x => x.results.every(r => r.pass !== false)).length;
    const all = Object.values(s.data.formats).flat().length;
    L.push(`曲 ${all} 本中、全項目通過 ${ok} 本。検査は ref/lag/stop/reload/pause/seek/speed/mute/end(意味は playback-check.js 冒頭)。`);
    L.push('');
    if (rows.length) {
      L.push('| 形式 | 曲 | 検査 | 判定 | 内容 |'); L.push('|---|---|---|---|---|');
      for (const r of rows) L.push(`| ${r.join(' | ').replace(/\|/g, '\\|')} |`);
    } else L.push('指摘なし。');
    L.push('');
  } else {
    const byArea = {};
    for (const f of s.data.findings) (byArea[f.area] = byArea[f.area] || []).push(f);
    for (const [area, fs_] of Object.entries(byArea)) {
      const ng = fs_.filter(f => f.pass === false);
      totalNg += ng.length;
      L.push(`### ${area}  (${fs_.filter(f => f.pass === true).length} 通過 / ${ng.length} NG)`);
      L.push('');
      for (const f of fs_) {
        if (f.pass === true && !/注意|境界|ぎりぎり/.test(f.detail)) continue;
        L.push(`- ${f.pass === false ? '**NG**' : f.pass === null ? '情報' : 'ok'} ${f.item}: ${f.detail}`);
      }
      if (!ng.length) L.push('- 指摘なし。');
      L.push('');
    }
  }
}
L.push('---');
L.push(`NG 合計 ${totalNg} 件。ログと JSON は \`_tmp_test/bughunt-*.log\` / \`_tmp_test/bughunt-*.json\`。`);
fs.writeFileSync(OUT, L.join('\n'));
console.log(`report: ${OUT} (NG ${totalNg})`);
process.exit(totalNg ? 1 : 0);
