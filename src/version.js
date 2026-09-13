/*
 * このアプリの版番号 (MML.VERSION)
 *
 * 形式は公開した日付 YYYY.MM.DD。同じ日に2回以上出すときだけ末尾に .2 .3 … を付ける。
 *
 * 公開の手順:
 *   1. この値をその日の日付に書き換えてコミットする
 *   2. git tag vYYYY.MM.DD を付けて push する(git push origin main vYYYY.MM.DD)
 *   3. GitHub でそのタグからリリースを作る(ZIPが自動で付くので file:// で使う人はそれを落とす)
 *
 * ★変換したMMLや書き出したNSFには入れない。入れると版を上げるたびに回帰テストの
 *   ベースライン(tools/headless/baseline-*.json)が全曲ぶん変わってしまう。
 * コア層(DOM非依存)。画面への表示は main.js が行う。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  MML.VERSION = '2026.09.13';
})(typeof window !== 'undefined' ? window : globalThis);
