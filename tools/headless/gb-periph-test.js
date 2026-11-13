#!/usr/bin/env node
/*
 * ゲームボーイの周辺(段階 8e)の確認: 時計の実時間、振動、HuC1(赤外線)、MBC7(傾き+EEPROM)、CGB の赤外線ポート、ポケットプリンタ、
 * HuC3(時計マイコン/ブザー)、MMM01、MBC6(フラッシュ)、ポケットカメラ、バーコードボーイ。
 * 市販ソフト無しで、カートリッジのレジスタと通信ポートを直接たたいて見る。  node tools/headless/gb-periph-test.js
 */
'use strict';
const { load } = require('./load');
const { MML } = load({ strict: true });
const { buildTestRom, buildPeriphRom } = require('./mk-gb-test-rom');
const E = MML.Emu;
let bad = 0; const ok = (c, m) => { console.log((c ? 'OK  ' : 'NG  ') + m); if (!c) bad++; };

// 種別だけ差し替えた空の ROM(ヘッダのチェックサムを付け直す)
function romOf(type, opt) {
  const rom = buildTestRom({ mbc: 'mbc5' });
  rom[0x147] = type; if (opt && opt.cgb) rom[0x143] = 0x80; if (opt && opt.ramCode !== undefined) rom[0x149] = opt.ramCode;
  let x = 0; for (let i = 0x134; i <= 0x14C; i++) x = (x - rom[i] - 1) & 0xFF; rom[0x14D] = x;
  return rom;
}

// ── 時計(MBC3): エミュレータ内の時間で進む/セーブをまたいだ実時間 ──
{
  let now = 1.7e12; E.GbCart.now = () => now;
  const c = new E.GbCart(romOf(0x10));
  c.write(0x0000, 0x0A);
  const rd = (reg) => { c.write(0x6000, 0); c.write(0x6000, 1); c.write(0x4000, 8 + reg); return c.readRam(0xA000); };
  c.tickRtc(4194304 * 61, 4194304);
  ok(rd(0) === 1 && rd(1) === 1, `時計: 61 秒ぶん進めて 1 分 1 秒(${rd(1)}:${rd(0)})`);
  const sav = c.getBattery();
  now += (2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000; // 2 日 3 時間 4 分 5 秒、電源を切っていた
  const c2 = new E.GbCart(romOf(0x10)); c2.setBattery(sav); c2.write(0x0000, 0x0A);
  const rd2 = (reg) => { c2.write(0x6000, 0); c2.write(0x6000, 1); c2.write(0x4000, 8 + reg); return c2.readRam(0xA000); };
  ok(rd2(3) === 2 && rd2(2) === 3 && rd2(1) === 5 && rd2(0) === 6, `時計: セーブを読み直すと切っていた間の分が進む(${rd2(3)} 日 ${rd2(2)}:${rd2(1)}:${rd2(0)})`);
  c2.write(0x4000, 0x0C); c2.writeRam(0xA000, 0x40); // 停止ビット
  const sav2 = c2.getBattery(); now += 3600e3;
  const c3 = new E.GbCart(romOf(0x10)); c3.setBattery(sav2); c3.write(0x0000, 0x0A); c3.write(0x6000, 0); c3.write(0x6000, 1); c3.write(0x4000, 0x0A);
  ok(c3.readRam(0xA000) === 3, '時計: 停止ビットが立っていれば進まない');
  E.GbCart.now = () => Date.now();
}

// ── 振動(MBC5) ──
{
  const gb = new E.GbConsole(romOf(0x1E));
  gb.cart.write(0x4000, 0x08); const on = gb.rumble; gb.cart.write(0x4000, 0x00);
  ok(on && !gb.rumble && gb.cart.ramBank === 0, '振動: RAM バンクレジスタの bit3 でモータが回る(バンクには混ざらない)');
}

// ── HuC1 ──
{
  const gb = new E.GbConsole(romOf(0xFF, { ramCode: 3 }));
  const c = gb.cart;
  c.writeRam(0xA123, 0x5A); c.write(0x4000, 1); c.writeRam(0xA123, 0x77); c.write(0x4000, 0);
  ok(c.readRam(0xA123) === 0x5A, 'HuC1: RAM は許可の書き込み無しで使え、バンクも切り替わる');
  c.write(0x0000, 0x0E);
  const dark = c.readRam(0xA000); gb.setLight(true); const lit = c.readRam(0xA000); c.writeRam(0xA000, 1);
  ok(dark === 0xC0 && lit === 0xC1 && c.irOut && gb.irWanted, `HuC1: $0E で赤外線レジスタ(光なし $${dark.toString(16)} / 光あり $${lit.toString(16)})`);
  c.write(0x0000, 0x0A);
  ok(c.readRam(0xA123) === 0x5A && !gb.irWanted, 'HuC1: $0E 以外で RAM に戻る');
  c.write(0x2000, 0x02);
  ok(c.read(0x4000) === 0xB2, 'HuC1: ROM バンク');
}

// ── MBC7: 傾きと EEPROM ──
{
  const gb = new E.GbConsole(romOf(0x22));
  const c = gb.cart;
  ok(c.readRam(0xA020) === 0xFF, 'MBC7: 許可前は $FF');
  c.write(0x0000, 0x0A); c.write(0x4000, 0x40);
  const rd16 = (lo) => c.readRam(0xA000 + lo) | (c.readRam(0xA010 + lo) << 8);
  ok(rd16(0x20) === 0x8000, 'MBC7: 取り込む前は $8000');
  gb.setTilt(1, -0.5);
  c.writeRam(0xA010, 0xAA);
  ok(rd16(0x20) === 0x8000, 'MBC7: $55 で消さずに $AA だけでは取り込まない');
  c.writeRam(0xA000, 0x55); c.writeRam(0xA010, 0xAA);
  ok(rd16(0x20) === 0x81D0 - 0x70 && rd16(0x40) === 0x81D0 + 0x38, `MBC7: 右に 1G、上に 0.5G → X=$${rd16(0x20).toString(16)} Y=$${rd16(0x40).toString(16)}`);
  // EEPROM: 線を 1 本ずつ動かす
  const E8 = 0xA080;
  const bit = (b) => { c.writeRam(E8, 0x80 | (b ? 2 : 0)); c.writeRam(E8, 0xC0 | (b ? 2 : 0)); };
  const begin = () => { c.writeRam(E8, 0x00); c.writeRam(E8, 0x80); };
  const cmd = (bits) => { begin(); bit(1); for (const ch of bits) bit(ch === '1'); };
  const bin = (v, n) => v.toString(2).padStart(n, '0');
  cmd('01' + bin(5, 8) + bin(0xBEEF, 16)); c.writeRam(E8, 0);             // EWEN 無しの WRITE は効かない
  cmd('10' + bin(5, 8)); let v = 0; for (let i = 0; i < 16; i++) { bit(0); v = (v << 1) | (c.readRam(E8) & 1); } c.writeRam(E8, 0);
  ok(v === 0xFFFF || v === 0x0000, `EEPROM: 書き込み許可の前の WRITE は無視(読むと $${v.toString(16)})`);
  cmd('0011000000'); c.writeRam(E8, 0);                                    // EWEN
  cmd('01' + bin(5, 8) + bin(0xBEEF, 16)); const rdy = c.readRam(E8) & 1; c.writeRam(E8, 0);
  cmd('10' + bin(5, 8)); v = 0; for (let i = 0; i < 16; i++) { bit(0); v = (v << 1) | (c.readRam(E8) & 1); } c.writeRam(E8, 0);
  ok(v === 0xBEEF && rdy === 1 && c.dirty, `EEPROM: EWEN → WRITE → READ で読み戻せる($${v.toString(16)})`);
  const sav = gb.getBattery();
  const gb2 = new E.GbConsole(romOf(0x22)); gb2.setBattery(sav);
  ok(sav.length === 256 && gb2.cart.ram[10] === 0xBE && gb2.cart.ram[11] === 0xEF, 'EEPROM: セーブ(256 バイト)に入り、読み直せる');
  cmd('11' + bin(5, 8)); c.writeRam(E8, 0);                                // ERASE
  cmd('10' + bin(5, 8)); v = 0; for (let i = 0; i < 16; i++) { bit(0); v = (v << 1) | (c.readRam(E8) & 1); } c.writeRam(E8, 0);
  ok(v === 0xFFFF, 'EEPROM: ERASE で $FFFF');
}

// ── CGB の赤外線ポート ──
{
  const gb = new E.GbConsole(romOf(0x1B, { cgb: true }), { model: 'auto' });
  gb.write(0xFF56, 0xC0);
  const dark = gb._busRead(0xFF56); gb.setLight(true); const lit = gb._busRead(0xFF56);
  gb.write(0xFF56, 0x00); const off = gb._busRead(0xFF56);
  ok(gb.cgb && (dark & 2) === 2 && (lit & 2) === 0 && (off & 2) === 2, `CGB 赤外線: 読み取り有効で光があれば bit1=0(暗 $${dark.toString(16)} / 明 $${lit.toString(16)} / 無効 $${off.toString(16)})`);
}

// ── ポケットプリンタ ──
{
  const gb = new E.GbConsole(romOf(0x1B));
  const x = (b) => gb.serialDevice(b);
  const packet = (cmd, data, compress) => {
    data = data || [];
    const head = [cmd, compress ? 1 : 0, data.length & 0xFF, data.length >> 8];
    let sum = 0; for (const b of head) sum += b; for (const b of data) sum += b;
    for (const b of [0x88, 0x33, ...head, ...data, sum & 0xFF, (sum >> 8) & 0xFF]) x(b);
    return [x(0), x(0)];
  };
  ok(packet(0x0F)[0] === 0x81, 'プリンタ: 状態の問い合わせに $81 で答える(つながっている)');
  packet(0x01);
  // 2 段ぶん(40 タイル): 1 段目は真っ黒(色 3)、2 段目は色 1。2 段目は圧縮で送る
  const d1 = new Array(0x140).fill(0xFF);
  const st1 = packet(0x04, d1);
  // 2 段目($FF,$00 の組 = 色 1 を 320 バイト)は圧縮で: リテラル 64 バイト × 4 と、同じ内容になる繰り返し($FF×2 は使えないので $FF,$00 を 1 組ずつリテラル)を混ぜる
  const comp = [];
  for (let i = 0; i < 4; i++) { comp.push(63); for (let k = 0; k < 32; k++) comp.push(0xFF, 0x00); }
  for (let k = 0; k < 32; k++) comp.push(0x00, 0xFF, 0x00, 0x00); // 1 バイトのリテラル 2 つ(値+1 バイト)
  const rle = new E.GbPrinter(); rle.data.set([0x80 | 3, 0xAB, 1, 1, 2]); rle.len = 5; rle.cmd = 4; rle.compress = 1; rle._run(true);
  ok(rle.tiles.join() === [0xAB, 0xAB, 0xAB, 0xAB, 0xAB, 1, 2].join(), "プリンタ: 圧縮の展開(繰り返し=下位 7bit+2 回、リテラル=値+1 バイト)");
  packet(0x04, comp, true);
  const stData = packet(0x0F)[1];
  packet(0x04, []);
  packet(0x02, [1, 0x13, 0xE4, 0x40]);
  const stPrint = packet(0x0F)[1];
  let stDone = stPrint; for (let i = 0; i < 6; i++) stDone = packet(0x0F)[1];
  const pages = gb.takePrints();
  const p = pages && pages[0];
  ok(st1[0] === 0x81 && (stData & 0x08) && (stPrint & 0x02) && !(stDone & 0x02), `プリンタ: 状態が データあり → 印刷中 → 完了 と動く($${stData.toString(16)} → $${stPrint.toString(16)} → $${stDone.toString(16)})`);
  ok(p && p.width === 160 && p.height === 16 && p.pixels[0] === 3 && p.pixels[159] === 3 && p.pixels[8 * 160] === 1 && p.pixels[15 * 160 + 159] === 1, `プリンタ: 160×${p && p.height} の絵(1 段目=黒、2 段目=圧縮で送った薄い色)`);
  // 余白 0 の印刷は次とつながる
  packet(0x01); packet(0x04, d1); packet(0x04, []); packet(0x02, [1, 0x00, 0xE4, 0x40]);
  const none = gb.takePrints();
  packet(0x04, d1); packet(0x04, []); packet(0x02, [1, 0x03, 0xE4, 0x40]);
  const joined = gb.takePrints();
  ok(!none && joined && joined[0].height === 16, 'プリンタ: 後ろの余白 0 の印刷は次の印刷とつないで 1 枚にする');
  const bad1 = (() => { for (const b of [0x88, 0x33, 0x0F, 0, 0, 0, 0x99, 0x00]) x(b); x(0); return x(0); })();
  ok((bad1 & 1) === 1, 'プリンタ: チェックサム違いは状態の bit0');
}

// ── ROM から通しで: 赤外線の読み取り有効、振動、通信ポート経由の印刷 ──
{
  const gb = new E.GbConsole(buildPeriphRom(), { model: 'auto' });
  for (let f = 0; f < 120; f++) gb.runFrame();
  const pages = gb.takePrints();
  ok(gb.cgb && gb.irWanted && gb.rumble, '通し ROM: CGB として起動し、赤外線の読み取りと振動モータが有効');
  ok(pages && pages.length === 1 && pages[0].height === 16 && pages[0].pixels.every((v) => v === 3), `通し ROM: 通信ポート経由で 160×${pages && pages[0] && pages[0].height} の真っ黒な絵が 1 枚刷れる`);
  ok(gb.barcodeWanted && gb.scanBarcode('4901234567894'), '通し ROM: 印刷の後の握手でバーコードの読み取り待ちになる');
  for (let f = 0; f < 30; f++) gb.runFrame();
  let txt = ''; for (let i = 1; i <= 13; i++) txt += String.fromCharCode(gb.wram[0x100 + i]);
  ok(gb.wram[0x100] === 2 && txt === '4901234567894' && gb.wram[0x100 + 14] === 3 && gb.wram[0x100 + 29] === 3, `通し ROM: ゲーム側が外部クロックで 30 バイト受け取る(${txt})`);
}

// ───────── 段階 8e その 2: HuC3 / MMM01 / MBC6 / ポケットカメラ / バーコードボーイ / ブザーの録音 ─────────

// ── HuC3: 時計マイコンの命令、ブザー、赤外線 ──
{
  let now = 1.7e12; E.GbCart.now = () => now;
  const gb = new E.GbConsole(romOf(0xFE, { ramCode: 3 }));
  const c = gb.cart;
  const cmd = (op, arg) => { gb.write(0x0000, 0x0B); gb.write(0xA000, (op << 4) | arg); gb.write(0x0000, 0x0D); gb.write(0xA000, 0xFE); gb.write(0x0000, 0x0C); return c.readRam(0xA000) & 0x0F; };
  const setAddr = (a) => { cmd(4, a & 15); cmd(5, a >> 4); };
  gb.write(0x0000, 0x0D);
  ok((c.readRam(0xA000) & 1) === 1 && cmd(6, 2) === 1, 'HuC3: セマフォは受け付け可、状態の問い合わせは 1');
  setAddr(0); for (const n of [3, 2, 1, 5, 0, 0]) cmd(3, n); cmd(6, 1);       // 291 分、5 日を時刻へ
  c.tickRtc(4194304 * 61, 4194304);
  cmd(6, 0); setAddr(0);
  const rd = []; for (let i = 0; i < 6; i++) rd.push(cmd(1, 0));
  ok(rd.join() === '4,2,1,5,0,0', `HuC3: 時刻を書いて 61 秒進めると 292 分($124)、5 日(読めた並び ${rd.join(' ')})`);
  const sav = gb.getBattery(); now += (86400 + 120) * 1000;
  const gb2 = new E.GbConsole(romOf(0xFE, { ramCode: 3 })); gb2.setBattery(sav);
  const m2 = gb2.cart.h3.mem;
  ok((m2[0x10] | (m2[0x11] << 4) | (m2[0x12] << 8)) === 294 && m2[0x13] === 6, 'HuC3: セーブを読み直すと切っていた間(1 日と 2 分)の分が進む');
  gb.write(0x0000, 0x0A); gb.write(0xA010, 0x77); gb.write(0x0000, 0x00);
  ok(c.readRam(0xA010) === 0x77, 'HuC3: $0A で RAM に書け、$00 でも読める');
  gb.write(0x0000, 0x0E); gb.setLight(true);
  ok((c.readRam(0xA000) & 1) === 1 && gb.irWanted === false, 'HuC3: $0E で赤外線(光ありで bit0=1)');
  // ブザー: 音の番号 2、有効、拡張命令 $E を 2 回 → 鳴る。録音に載り VGM の規格外ブロックになる
  gb.setSampleRate(44100); gb.startRecording();
  setAddr(0x26); cmd(3, 2); cmd(3, 1);
  cmd(6, 0xE); const before = gb.bzLeft; cmd(6, 0xE);
  const a = gb.runFrame(); let peak = 0; for (let i = 0; i < a.length; i++) peak = Math.max(peak, Math.abs(a[i]));
  const frames = gb.stopRecording();
  const ev = frames.flat().filter((w) => w.buzz !== undefined);
  ok(before === 0 && gb.bzLeft > 0 && peak > 0.03 && ev.length === 1 && ev[0].buzz === 2, `HuC3 ブザー: 拡張命令 $E の 2 回目で鳴り(peak ${peak.toFixed(3)})、録音に音の番号 2 が載る`);
  const r = MML.VGM.encodeGbRecording({ frames });
  let found = false; for (let i = 0x100; i < r.vgm.length - 12; i++) if (r.vgm[i] === 0x67 && r.vgm[i + 1] === 0x66 && r.vgm[i + 2] === MML.VGM.GBXX.TYPE && r.vgm[i + 7] === 0x47 && r.vgm[i + 12] === MML.VGM.GBXX.KIND_BUZZER && r.vgm[i + 13] === 2) found = true;
  let played = true; try { const vp = new E.VgmPlayer(r.vgm); for (let k = 0; k < 5; k++) vp.renderFrame(44100, false, true); } catch (e) { played = false; }
  ok(r.buzzes === 1 && found && played, 'HuC3 ブザー: VGM に規格外ブロック GBXX(種類 2)で入り、本ツールの VGM 再生はそれを読み飛ばして動く');
  E.GbCart.now = () => Date.now();
}

// ── MMM01 ──
{
  const mk = (menuFirst) => {
    const rom = new Uint8Array(0x40000).fill(0xFF);
    for (let b = 0; b < 16; b++) rom[b * 0x4000] = b;                        // 各 16K バンクの先頭に番号
    const hdr = (at, type) => { rom[at + 0x104] = 0xCE; rom[at + 0x105] = 0xED; for (let i = 0x106; i < 0x134; i++) rom[at + i] = i & 0xFF; rom[at + 0x147] = type; rom[at + 0x148] = 3; rom[at + 0x149] = 2; let x = 0; for (let i = 0x134; i <= 0x14C; i++) x = (x - rom[at + i] - 1) & 0xFF; rom[at + 0x14D] = x; };
    if (menuFirst) { hdr(0, 0x0D); hdr(0x8000, 0x01); } else { hdr(0, 0x01); hdr(0x38000, 0x0D); }
    return rom;
  };
  const c = new E.GbCart(mk(false));
  ok(c.mbc === 'mmm01' && c.read(0x0000) === 14 && c.read(0x4000) === 15, 'MMM01: 起動時は最後の 32K(メニュー)が見える');
  c.write(0x2000, 0x04); c.write(0x6000, 0x38); c.write(0x0000, 0x40); // バンク 4 から 4 バンクぶんのゲームを選んでマップ
  ok(c.read(0x0000) === 4 && c.read(0x4000) === 5, `MMM01: マップ後は選んだゲームの先頭(${c.read(0)})と、その中のバンク 1(${c.read(0x4000)})`);
  c.write(0x2000, 0x02); const b2 = c.read(0x4000); c.write(0x2000, 0x1F); const b3 = c.read(0x4000); c.write(0x2000, 0x60);
  ok(b2 === 6 && b3 === 7 && c.read(0x0000) === 4 && c.read(0x4000) === 5, 'MMM01: ゲームからはマスクの外のビットだけ動く(上位は書けない、バンク 0 は 1 に読み替え)');
  const c2 = new E.GbCart(mk(true));
  ok(c2.mbc === 'mmm01' && c2.read(0x0000) === 0 && c2.read(0x4000) === 1 && c2.rom[0] === 2, 'MMM01: メニューが先頭にある吸い出しは最後へ回して扱う');
  ok(new E.GbCart(buildTestRom({ mbc: 'mbc1' })).mbc === 'mbc1', 'MMM01: 普通の MBC1 を取り違えない');
}

// ── MBC6: 8K バンク 2 窓、4K RAM 2 窓、フラッシュ ──
{
  const c = new E.GbCart(romOf(0x20));
  ok(c.mbc === 'mbc6' && c.ram.length === 0x8000 && c.read(0x4000) === 0xB1 && c.read(0x6000) === c.rom[0x6000], 'MBC6: 起動時の窓 A=バンク 2、B=バンク 3(8K 単位)');
  c.write(0x2000, 4); c.write(0x3000, 6);
  ok(c.read(0x4000) === 0xB2 && c.read(0x6000) === 0xB3, 'MBC6: 窓 A/B を別々に切り替え');
  c.write(0x0000, 0x0A); c.write(0x0400, 1); c.writeRam(0xA000, 0x11); c.write(0x0400, 0); c.writeRam(0xA000, 0x22); c.write(0x0800, 1);
  ok(c.readRam(0xA000) === 0x22 && c.readRam(0xB000) === 0x11, 'MBC6: RAM も 4K 単位で 2 窓(B から A のバンクが見える)');
  // フラッシュ: 窓 A に出して ID を読む
  c.write(0x0C00, 1); c.write(0x2800, 8);
  const unlock = () => { c.write(0x2000, 2); c.write(0x5555, 0xAA); c.write(0x2000, 1); c.write(0x4AAA, 0x55); c.write(0x2000, 2); };
  unlock(); c.write(0x5555, 0x90);
  const id = [c.read(0x4000), c.read(0x4001)]; c.write(0x4000, 0xF0);
  ok(id[0] === 0xC2 && id[1] === 0x81 && c.read(0x4000) === 0xFF, `MBC6 フラッシュ: ID $${id[0].toString(16)} $${id[1].toString(16)}、消去済みは $FF`);
  // セクタ 1(バンク 16〜)へ 128 バイト書く
  unlock(); c.write(0x5555, 0xA0); c.write(0x2000, 16);
  for (let i = 0; i < 128; i++) c.write(0x4000 + i, i);
  c.write(0x407F, 0x7F);
  const st = c.read(0x4000); c.write(0x4000, 0xF0);
  ok(st === 0x80 && c.read(0x4005) === 5 && c.read(0x407F) === 0x7F && c.dirty, 'MBC6 フラッシュ: 128 バイト書いて最後の番地にもう一度で確定、状態 $80');
  // セクタ 0 は書き込み許可が無いと書けない
  unlock(); c.write(0x5555, 0xA0); c.write(0x2000, 0); c.write(0x4000, 0x00); c.write(0x4000, 0x00); c.write(0x4000, 0xF0);
  ok(c.read(0x4000) === 0xFF, 'MBC6 フラッシュ: セクタ 0 は $1000 の許可が無いと書けない');
  const sav = c.getBattery();
  const c2 = new E.GbCart(romOf(0x20)); c2.setBattery(sav); c2.write(0x0C00, 1); c2.write(0x2800, 8); c2.write(0x2000, 16);
  ok(sav.length === 0x8000 + 0x100000 + 257 && c2.read(0x4005) === 5, 'MBC6: セーブに RAM とフラッシュが入り、読み直せる');
  unlock(); c.write(0x5555, 0x80); unlock(); c.write(0x2000, 16); c.write(0x4000, 0x30); c.write(0x4000, 0xF0);
  ok(c.read(0x4005) === 0xFF, 'MBC6 フラッシュ: セクタ消去');
}

// ── ポケットカメラ ──
{
  const gb = new E.GbConsole(romOf(0xFC));
  const c = gb.cart;
  const img = new Uint8Array(128 * 112); for (let y = 0; y < 112; y++) for (let x = 64; x < 128; x++) img[y * 128 + x] = 255; // 左半分は暗、右半分は明
  gb.setCameraImage(img);
  c.write(0x0000, 0x0A); c.write(0x4000, 0x10);
  c.writeRam(0xA001, 0x04); c.writeRam(0xA002, 0x10); c.writeRam(0xA003, 0x00);      // ゲイン 1.0、露光 $1000(等倍)
  for (let i = 0; i < 16; i++) { c.writeRam(0xA006 + i * 3, 64); c.writeRam(0xA007 + i * 3, 128); c.writeRam(0xA008 + i * 3, 192); }
  c.writeRam(0xA000, 0x01);
  const busy = c.readRam(0xA000) & 1; c.write(0x4000, 0x00); const hidden = c.readRam(0xA100); c.write(0x4000, 0x10);
  for (let i = 0; i < 8 && (c.readRam(0xA000) & 1); i++) c.tickRtc(70224, 4194304);
  const done = (c.readRam(0xA000) & 1) === 0;
  c.write(0x4000, 0x00);
  const left = [c.readRam(0xA100), c.readRam(0xA101)], right = [c.readRam(0xA100 + 15 * 16), c.readRam(0xA101 + 15 * 16)];
  ok(busy === 1 && hidden === 0 && done && gb.cameraWanted, 'カメラ: 撮影中は bit0=1 で RAM は読めず、露光時間ぶん待つと終わる');
  ok(left.join() === '255,255' && right.join() === '0,0', `カメラ: 絵が 2bpp のタイルで RAM に入る(暗い側 ${left.join(' ')} = 一番濃い、明るい側 ${right.join(' ')} = 白)`);
  // 中間の明るさはディザの閾値で 4 階調に分かれる
  img.fill(100); c.write(0x4000, 0x10); c.writeRam(0xA000, 0x01); for (let i = 0; i < 8; i++) c.tickRtc(70224, 4194304); c.write(0x4000, 0x00);
  ok(c.readRam(0xA100) === 0x00 && c.readRam(0xA101) === 0xFF, 'カメラ: 明るさ 100 は閾値 64/128/192 で 2 番目に濃い階調');
}

// ── バーコードボーイ(とプリンタの同居)──
{
  const gb = new E.GbConsole(romOf(0x1B));
  const reply = [0x10, 0x07, 0x10, 0x07].map((b) => gb.serialDevice(b));
  ok(reply.join() === '255,255,16,7' && gb.barcodeWanted, 'バーコードボーイ: 握手 $10 $07 $10 $07 に $FF $FF $10 $07 を返し、読み取り待ちになる');
  ok(E.GbBarcodeBoy.checkEan13('4901234567894') && !E.GbBarcodeBoy.checkEan13('4901234567890'), 'バーコード: 検査数字の確認');
  ok(gb.scanBarcode('4901234567894') && !gb.barcodeWanted, 'バーコードボーイ: 13 桁を受け付ける');
  const got = [];
  for (let n = 0; n < 30; n++) { gb.write(0xFF02, 0x80); gb.if &= ~8; let guard = 0; while (!(gb.if & 8) && guard++ < 20000) gb.tick(); got.push(gb.sb); }
  const want = [2, ...'4901234567894'].map((x) => (typeof x === 'string' ? x.charCodeAt(0) : x)).concat([3]);
  ok(got.join() === want.concat(want).join(), 'バーコードボーイ: ゲームが外部クロックで待つと、$02+13 桁+$03 を 2 回、機器の側から送る');
  ok(!gb.scanBarcode('4901234567894'), 'バーコードボーイ: 送り終えたら握手からやり直し');
  for (const b of [0x88, 0x33, 0x0F, 0, 0, 0, 0x0F, 0x00]) gb.serialDevice(b);
  ok(gb.serialDevice(0) === 0x81, 'バーコードボーイと同じ口でも、プリンタの問い合わせには $81 で答える');
}

process.exit(bad ? 1 : 0);
