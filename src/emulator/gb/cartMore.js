/*
 * ゲームボーイの追加の基板: HuC3 / MMM01 / MBC6 / ポケットカメラ / TAMA5
 * (gb/cart.js の GbCart.EXTRA に登録する。cart.js の後に読む)
 *
 * どれも市販ソフトで確かめられていない(手元に無い)。仕様の出どころと、分かっていない所は各節に書く。
 * 参考: Pan Docs(HuC-3 / MMM01 / MBC6 / Game Boy Camera)、SameBoy(Expat License)の Core/mbc.c・memory.c・camera.c(読んで動作を確かめた。写してはいない)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};
  const GbCart = Emu.GbCart;
  if (!GbCart) return;
  const EXTRA = GbCart.EXTRA, TYPES = GbCart.TYPES;
  const f64 = (bytes, o) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(o, true);
  const putF64 = (bytes, o, v) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat64(o, v, true);

  // ───────────────────────── HuC3(時計+赤外線+ブザー)─────────────────────────
  // $0000 台の下位 4bit で $A000 台の中身を選ぶ: 0=RAM(読むだけ)、A=RAM、B=時計マイコンへの命令(上位=命令、下位=引数)、
  // C=命令と結果の読み出し、D=セマフォ(bit0=1 で受け付け可。bit0=0 を書くと B の命令を実行)、E=赤外線。
  // マイコンは 256 ニブルの記憶を持つ: $10-12=1 日の中の分(0〜1439)、$13-15=日数、$26=音の番号(下位 2bit)、$27=1 でブザー有効。
  // 命令: 1=読んで番地+1、3=書いて番地+1、4/5=番地の下位/上位、6=拡張(0=今の時刻を $00-06 へ、1=$00-06 を時刻へ、2=状態(1 を返す)、
  //   $E=2 回続けるとブザーを鳴らす)。
  // ★ブザーの音の高さと長さは資料が無い。鳴らした事実と音の番号だけを確かに記録し、音そのものは本体側の仮の値で鳴らす
  TYPES[0xFE] = { mbc: 'huc3', ram: 1, battery: 1, ir: 1, buzzer: 1 };
  EXTRA.huc3 = {
    init(c) { c.h3 = { mode: 0, cmd: 0, arg: 0, result: 0, addr: 0, mem: new Uint8Array(256), sub: 0, sec: 0, tone: 0 }; },
    reset(c) { const h = c.h3; h.mode = 0; h.cmd = 0; h.arg = 0; h.result = 0; h.addr = 0; h.tone = 0; },
    map(c) { c.lo = 0; c.hi = (c.romBank % c.romBanks) << 14; c.ramOff = c.ram.length > 0x2000 ? (c.ramBank << 13) % c.ram.length : 0; },
    write(c, addr, v) {
      if (addr < 0x2000) c.h3.mode = v & 0x0F;
      else if (addr < 0x4000) c.romBank = v & 0x7F;
      else if (addr < 0x6000) c.ramBank = v & 3;
    },
    readRam(c, addr) {
      const h = c.h3;
      switch (h.mode) {
        case 0x0: case 0xA: return c.ram.length ? c.ram[(c.ramOff + (addr & 0x1FFF)) % c.ram.length] : 0xFF;
        case 0xC: return 0x80 | (h.cmd << 4) | h.result;
        case 0xD: return 0x81; // いつでも受け付け可
        case 0xE: return 0xC0 | (c.irIn ? 1 : 0);
      }
      return 0xFF;
    },
    writeRam(c, addr, v) {
      const h = c.h3, m = h.mem;
      switch (h.mode) {
        case 0xA: if (c.ram.length) { c.ram[(c.ramOff + (addr & 0x1FFF)) % c.ram.length] = v; c.dirty = true; } break;
        case 0xB: h.cmd = (v >> 4) & 7; h.arg = v & 0x0F; break;
        case 0xE: c.irOut = (v & 1) !== 0; break;
        case 0xD:
          if (v & 1) break;
          switch (h.cmd) {
            case 1: h.result = m[h.addr]; h.addr = (h.addr + 1) & 0xFF; break;
            case 3: m[h.addr] = h.arg; h.addr = (h.addr + 1) & 0xFF; c.dirty = true; break;
            case 4: h.addr = (h.addr & 0xF0) | h.arg; break;
            case 5: h.addr = (h.addr & 0x0F) | (h.arg << 4); break;
            case 6:
              if (h.arg === 0) { for (let i = 0; i < 6; i++) m[i] = m[0x10 + i]; m[6] = 0; }
              else if (h.arg === 1) { for (let i = 0; i < 6; i++) m[0x10 + i] = m[i]; h.sec = 0; c.dirty = true; }
              else if (h.arg === 2) h.result = 1;
              else if (h.arg === 0xE) { if (++h.tone >= 2) { h.tone = 0; if (m[0x27] === 1) c.buzzQueue.push(m[0x26] & 3); } }
              if (h.arg !== 0xE) h.tone = 0;
              break;
          }
          break;
      }
    },
    // 時計: 1 分ごとに $10-12 を進め、1440 で日数 $13-15 へ
    addMinutes(c, n) {
      const m = c.h3.mem;
      let min = m[0x10] | (m[0x11] << 4) | (m[0x12] << 8), day = m[0x13] | (m[0x14] << 4) | (m[0x15] << 8);
      min += n; day = (day + Math.floor(min / 1440)) & 0xFFF; min %= 1440;
      m[0x10] = min & 15; m[0x11] = (min >> 4) & 15; m[0x12] = (min >> 8) & 15;
      m[0x13] = day & 15; m[0x14] = (day >> 4) & 15; m[0x15] = (day >> 8) & 15;
    },
    tick(c, t, clockHz) {
      const h = c.h3;
      h.sub += t;
      while (h.sub >= clockHz) { h.sub -= clockHz; if (++h.sec >= 60) { h.sec = 0; EXTRA.huc3.addMinutes(c, 1); c.dirty = true; } }
    },
    // セーブ: RAM、マイコンの記憶 256、秒、控えた時の実時刻(倍精度 8 バイト)
    getBattery(c) {
      const out = new Uint8Array(c.ram.length + 256 + 8 + 8);
      out.set(c.ram); out.set(c.h3.mem, c.ram.length); out[c.ram.length + 256] = c.h3.sec;
      putF64(out, c.ram.length + 264, GbCart.now());
      return out;
    },
    setBattery(c, bytes) {
      if (bytes.length < c.ram.length) return false;
      c.ram.set(bytes.subarray(0, c.ram.length));
      const o = c.ram.length;
      if (bytes.length >= o + 272) {
        c.h3.mem.set(bytes.subarray(o, o + 256)); c.h3.sec = bytes[o + 256] % 60;
        const saved = f64(bytes, o + 264);
        if (saved > 0 && isFinite(saved)) { const s = Math.floor((GbCart.now() - saved) / 1000) + c.h3.sec; if (s > 0) { EXTRA.huc3.addMinutes(c, Math.floor(s / 60)); c.h3.sec = s % 60; } }
      }
      return true;
    },
  };

  // ───────────────────────── MMM01(多本入り)─────────────────────────
  // 電源投入時は「未マップ」: ROM の最後の 32K(メニュー)が $0000-$7FFF に出る。メニューが選んだゲームの位置と大きさをレジスタの
  // 上位ビットに書き、$0000 台の bit6 で「マップ」すると、以後は選ばれたゲームに対して MBC1 として振る舞う(上位ビットは書けなくなる)。
  //   $0000: bit0-3 RAM 許可、bit4-5 RAM バンクの固定マスク、bit6 マップ
  //   $2000: bit0-4 ROM バンク下位(マスクされたビットは書けない)、bit5-6 ROM バンク中位
  //   $4000: bit0-1 RAM バンク下位、bit2-3 RAM バンク上位、bit4-5 ROM バンク上位、bit6 モード切替の禁止
  //   $6000: bit0 MBC1 のモード、bit2-5 ROM バンク下位の固定マスク(bit1-4 に当たる)、bit6 多重化(市販品では未使用)
  // 吸い出しには「メニューが先頭」の物と「最後」の物がある。先頭の種別が MMM01 なら最初の 32K を最後へ回す(SameBoy と同じ扱い)
  for (const [t, o] of [[0x0B, {}], [0x0C, { ram: 1 }], [0x0D, { ram: 1, battery: 1 }]]) TYPES[t] = Object.assign({ mbc: 'mmm01' }, o);
  const isMmm01Type = (t) => t >= 0x0B && t <= 0x0D;
  EXTRA.mmm01 = {
    detect(rom) {
      const n = rom.length;
      if (n <= 0x8000) return null;
      if (isMmm01Type(rom[0x147])) { // メニューが先頭 → 最後へ回す
        const out = new Uint8Array(n); out.set(rom.subarray(0x8000)); out.set(rom.subarray(0, 0x8000), n - 0x8000);
        return { rom: out, headerAt: n - 0x8000 };
      }
      const m = n - 0x8000;
      let logo = true; for (let i = 0x104; i < 0x134; i++) if (rom[i] !== rom[m + i]) { logo = false; break; }
      if (logo && rom[0x104] === 0xCE && isMmm01Type(rom[m + 0x147])) return { rom, headerAt: m };
      return null;
    },
    reset(c) { c.mm = { mapped: false, ramMask: 0, romLow: 0, romMid: 0, romMask: 0, ramLow: 0, ramHigh: 0, romHigh: 0, modeLock: false, mode: 0, mux: false }; },
    map(c) {
      const m = c.mm, n = c.romBanks;
      if (!m.mapped) { c.lo = (n - 2) << 14; c.hi = (n - 1) << 14; c.ramOff = 0; return; }
      let rom0, romB, ramB;
      if (m.mux) {
        rom0 = (m.romLow & m.romMask) | ((m.mode ? m.ramLow : m.ramLow & m.ramMask) << 5) | (m.romHigh << 7);
        romB = m.romLow | (m.ramLow << 5) | (m.romHigh << 7);
        ramB = m.romMid | (m.ramHigh << 2);
      } else {
        rom0 = (m.romLow & m.romMask) | (m.romMid << 5) | (m.romHigh << 7);
        romB = m.romLow | (m.romMid << 5) | (m.romHigh << 7);
        ramB = (m.mode ? m.ramLow : m.ramLow & m.ramMask) | (m.ramHigh << 2);
      }
      if ((m.romLow & ~m.romMask & 0x1F) === 0) romB |= 1; // ゲーム内のバンク 0 は 1 に読み替え(MBC1 と同じ)
      c.lo = (rom0 % n) << 14; c.hi = (romB % n) << 14;
      c.ramOff = c.ram.length ? (ramB << 13) % c.ram.length : 0;
    },
    write(c, addr, v) {
      const m = c.mm;
      if (addr < 0x2000) {
        c.ramEnable = (v & 0x0F) === 0x0A;
        if (!m.mapped) { m.ramMask = (v >> 4) & 3; if (v & 0x40) m.mapped = true; }
      } else if (addr < 0x4000) {
        if (!m.mapped) m.romMid = (v >> 5) & 3;
        m.romLow = (m.romLow & m.romMask) | (v & 0x1F & ~m.romMask);
      } else if (addr < 0x6000) {
        m.ramLow = (m.ramLow & m.ramMask) | (v & 3 & ~m.ramMask);
        if (!m.mapped) { m.ramHigh = (v >> 2) & 3; m.romHigh = (v >> 4) & 3; m.modeLock = (v & 0x40) !== 0; }
      } else {
        if (!m.modeLock) m.mode = v & 1;
        if (!m.mapped) { m.romMask = ((v >> 2) & 0x0F) << 1; m.mux = (v & 0x40) !== 0; }
      }
    },
  };

  // ───────────────────────── MBC6(フラッシュメモリつき)─────────────────────────
  // ROM は 8K 単位で 2 窓($4000 台=A、$6000 台=B)、RAM は 4K 単位で 2 窓($A000 台=A、$B000 台=B)。
  // 窓ごとに ROM とフラッシュ(1MB+隠し領域 256 バイト)を切り替えられる。フラッシュは JEDEC 式の命令列
  // ($5555 に $AA、$2AAA に $55、$5555 に命令)。番地はフラッシュ内の番地 = バンク×$2000+窓内の位置。
  //   $80…$30=セクタ(128K)消去、$80…$10=全消去、$90=ID(C2 81)、$A0=書き込み(128 バイト単位。最後の番地にもう一度書くと確定)、
  //   $60…$04/$E0=隠し領域の消去/書き込み、$60…$40/$20=セクタ 0 の保護解除/保護、$77…$77=隠し領域を読む、$F0=読み出しへ戻る
  // 書き込み/消去の後は状態バイト($80=完了)が読める。セクタ 0 と隠し領域は $1000 の書き込み許可が要る
  TYPES[0x20] = { mbc: 'mbc6', ram: 1, battery: 1 };
  const FLASH = 0x100000;
  EXTRA.mbc6 = {
    ramSize: 0x8000,
    init(c) { c.m6 = { flash: new Uint8Array(FLASH).fill(0xFF), hidden: new Uint8Array(256).fill(0xFF), protect0: false }; },
    reset(c) { Object.assign(c.m6, { romA: 2, romB: 3, flashA: false, flashB: false, ramA: 0, ramB: 0, flashOn: false, wp: false, seq: 0, mode: 'read', pre: 0, last: -1, status: 0x80 }); },
    map() {},
    read(c, addr) {
      if (addr < 0x4000) return c.rom[addr];
      const m = c.m6, isB = addr >= 0x6000, bank = isB ? m.romB : m.romA, off = addr & 0x1FFF;
      if (isB ? m.flashB : m.flashA) {
        if (!m.flashOn) return 0xFF;
        const fa = ((bank << 13) | off) & (FLASH - 1);
        if (m.mode === 'status') return m.status;
        if (m.mode === 'id') return (off & 1) ? 0x81 : 0xC2;
        if (m.mode === 'hidden') return m.hidden[fa & 0xFF];
        return m.flash[fa];
      }
      return c.rom[((bank << 13) | off) % c.rom.length];
    },
    write(c, addr, v) {
      const m = c.m6;
      if (addr < 0x0400) c.ramEnable = (v & 0x0F) === 0x0A;
      else if (addr < 0x0800) m.ramA = v & 7;
      else if (addr < 0x0C00) m.ramB = v & 7;
      else if (addr < 0x1000) m.flashOn = (v & 1) !== 0;
      else if (addr === 0x1000) m.wp = (v & 1) !== 0;
      else if (addr < 0x2000) { /* 使われていない */ }
      else if (addr < 0x2800) m.romA = v & 0x7F;
      else if (addr < 0x3000) m.flashA = v === 0x08;
      else if (addr < 0x3800) m.romB = v & 0x7F;
      else if (addr < 0x4000) m.flashB = v === 0x08;
      else EXTRA.mbc6.flashWrite(c, addr, v);
    },
    flashWrite(c, addr, v) {
      const m = c.m6, isB = addr >= 0x6000;
      if (!(isB ? m.flashB : m.flashA) || !m.flashOn) return;
      const fa = (((isB ? m.romB : m.romA) << 13) | (addr & 0x1FFF)) & (FLASH - 1);
      const canSector0 = m.wp && !m.protect0;
      if (m.mode === 'program' || m.mode === 'programHidden') {
        if (v === 0xF0 && m.last < 0) { m.mode = 'read'; return; }
        if (fa === m.last) { m.mode = 'status'; m.status = 0x80; m.last = -1; c.dirty = true; return; } // 最後の番地にもう一度 = 確定
        if (m.mode === 'programHidden') { if (m.wp) m.hidden[fa & 0xFF] &= v; }
        else if (fa >= 0x20000 || canSector0) m.flash[fa] &= v; // 書き込みは 1→0 だけ
        m.last = fa;
        return;
      }
      if (v === 0xF0) { m.mode = 'read'; m.seq = 0; m.pre = 0; return; }
      if (m.seq === 0) { if (fa === 0x5555 && v === 0xAA) m.seq = 1; return; }
      if (m.seq === 1) { m.seq = (fa === 0x2AAA && v === 0x55) ? 2 : 0; return; }
      m.seq = 0; // 3 つ目 = 命令
      const pre = m.pre; m.pre = 0;
      if (pre === 0x80) {
        if (v === 0x30) { const s = fa >> 17; if (s || canSector0) m.flash.fill(0xFF, s << 17, (s + 1) << 17); }
        else if (v === 0x10) m.flash.fill(0xFF, canSector0 ? 0 : 0x20000);
        else return;
        m.mode = 'status'; m.status = 0x80; c.dirty = true; return;
      }
      if (pre === 0x60) {
        if (v === 0x04) { if (m.wp) m.hidden.fill(0xFF); }
        else if (v === 0xE0) { m.mode = 'programHidden'; m.last = -1; return; }
        else if (v === 0x40) { if (m.wp) m.protect0 = false; }
        else if (v === 0x20) { if (m.wp) m.protect0 = true; }
        else return;
        m.mode = 'status'; m.status = 0x80 | (m.protect0 ? 2 : 0); c.dirty = true; return;
      }
      if (pre === 0x77) { if (v === 0x77) m.mode = 'hidden'; return; }
      if (v === 0x80 || v === 0x60 || v === 0x77) m.pre = v;
      else if (v === 0x90) m.mode = 'id';
      else if (v === 0xA0) { m.mode = 'program'; m.last = -1; }
    },
    readRam(c, addr) { if (!c.ramEnable) return 0xFF; const m = c.m6; return c.ram[(((addr < 0xB000 ? m.ramA : m.ramB) << 12) | (addr & 0xFFF)) % c.ram.length]; },
    writeRam(c, addr, v) { if (!c.ramEnable) return; const m = c.m6; c.ram[(((addr < 0xB000 ? m.ramA : m.ramB) << 12) | (addr & 0xFFF)) % c.ram.length] = v; c.dirty = true; },
    // セーブ: RAM 32K、フラッシュ 1MB、隠し領域 256、保護の印 1
    getBattery(c) { const m = c.m6, out = new Uint8Array(c.ram.length + FLASH + 257); out.set(c.ram); out.set(m.flash, c.ram.length); out.set(m.hidden, c.ram.length + FLASH); out[out.length - 1] = m.protect0 ? 1 : 0; return out; },
    setBattery(c, bytes) {
      if (bytes.length < c.ram.length) return false;
      c.ram.set(bytes.subarray(0, c.ram.length));
      if (bytes.length >= c.ram.length + FLASH + 257) { const m = c.m6, o = c.ram.length; m.flash.set(bytes.subarray(o, o + FLASH)); m.hidden.set(bytes.subarray(o + FLASH, o + FLASH + 256)); m.protect0 = bytes[o + FLASH + 256] === 1; }
      return true;
    },
  };

  // ───────────────────────── ポケットカメラ ─────────────────────────
  // バンクは MBC5 と同じ。RAM バンクに $10 以上を選ぶと $A000 台がカメラのレジスタになる:
  //   $A000 bit0=撮影開始/撮影中、$A001 下位 5bit=ゲイン・上位 3bit=輪郭強調の種類、$A002-3=露光時間、$A004 bit4-6=輪郭強調の強さ、
  //   $A006-$A035=ディザの閾値(4×4 画素 × 3 段)
  // 撮影が終わると、128×112 の絵が 2bpp のタイル(16×14 個)で RAM バンク 0 の $A100-$AEFF に入る。撮影中は RAM が読めない(0)。
  // 画素の作り方は SameBoy と同じ考え方: 明るさ × ゲイン × 露光/$1000 → 輪郭強調 → 位置ごとの 3 つの閾値で 4 階調。
  // 元の絵は camImage(128×112、0〜255。本体が Web カメラから入れる)。無ければ斜めの濃淡の試験模様
  TYPES[0xFC] = { mbc: 'camera', ram: 1, battery: 1, camera: 1 };
  const CAM_W = 128, CAM_H = 112;
  const GAIN = [0.8809390, 0.9149149, 0.9457498, 0.9739758, 1.0000000, 1.0241412, 1.0466537, 1.0677433, 1.0875793, 1.1240310, 1.1568911, 1.1868043, 1.2142561, 1.2396208, 1.2743837, 1.3157323,
    1.3525190, 1.3856512, 1.4157897, 1.4434309, 1.4689574, 1.4926697, 1.5148087, 1.5355703, 1.5551159, 1.5735801, 1.5910762, 1.6077008, 1.6235366, 1.6386550, 1.6531183, 1.6669808];
  const EDGE = [0.5, 0.75, 1, 1.25, 2, 3, 4, 5];
  EXTRA.camera = {
    ramSize: 0x20000,
    init(c) { c.cam = { regs: new Uint8Array(0x36), mapped: false, left: 0, shots: 0 }; c.camImage = null; },
    reset(c) { c.cam.regs.fill(0); c.cam.mapped = false; c.cam.left = 0; c.romBank = 1; },
    map(c) { c.lo = 0; c.hi = (c.romBank % c.romBanks) << 14; c.ramOff = ((c.ramBank & 0x0F) << 13) % c.ram.length; },
    write(c, addr, v) {
      if (addr < 0x2000) c.ramEnable = (v & 0x0F) === 0x0A;
      else if (addr < 0x4000) c.romBank = v & 0x3F;
      else if (addr < 0x6000) { c.ramBank = v & 0x1F; c.cam.mapped = (v & 0x10) !== 0; }
    },
    readRam(c, addr) {
      const cam = c.cam;
      if (cam.mapped) return (addr & 0x7F) === 0 ? cam.regs[0] & 7 : 0x00; // レジスタは $A000 だけ読める
      if (cam.regs[0] & 1) return 0x00;                                    // 撮影中は RAM が読めない
      return c.ram[c.ramOff + (addr & 0x1FFF)];
    },
    writeRam(c, addr, v) {
      const cam = c.cam;
      if (cam.mapped) {
        const r = addr & 0x7F;
        if (r >= 0x36) return;
        if (r === 0) {
          v &= 7;
          if ((v & 1) && !(cam.regs[0] & 1)) { // 撮影開始。掛かる時間は露光時間で決まる(実機の値)
            const exposure = (cam.regs[2] << 8) | cam.regs[3];
            cam.left = 129792 + ((cam.regs[1] & 0x80) ? 0 : 2048) + exposure * 64;
            cam.shots++;
          }
          if (!(v & 1) && (cam.regs[0] & 1)) v |= 1; // 途中でやめる操作は無視
        }
        cam.regs[r] = v;
        return;
      }
      if (!c.ramEnable || (cam.regs[0] & 1)) return;
      c.ram[c.ramOff + (addr & 0x1FFF)] = v; c.dirty = true;
    },
    tick(c, t) {
      const cam = c.cam;
      if (!(cam.regs[0] & 1)) return;
      cam.left -= t;
      if (cam.left <= 0) { EXTRA.camera.develop(c); cam.regs[0] &= ~1; }
    },
    // 元の絵をレジスタどおりに 4 階調へ落として RAM に入れる
    develop(c) {
      const r = c.cam.regs, img = c.camImage;
      const gain = GAIN[r[1] & 0x1F], exposure = ((r[2] << 8) | r[3]) / 0x1000;
      const lum = new Float32Array(CAM_W * CAM_H);
      for (let y = 0; y < CAM_H; y++) for (let x = 0; x < CAM_W; x++) {
        const src = img && img.length >= CAM_W * CAM_H ? img[y * CAM_W + x] : ((x + y) * 255 / (CAM_W + CAM_H)) | 0;
        lum[y * CAM_W + x] = src * gain * exposure;
      }
      const edgeOn = (r[1] & 0xE0) === 0xE0, ratio = EDGE[(r[4] >> 4) & 7];
      const at = (x, y) => lum[Math.max(0, Math.min(CAM_H - 1, y)) * CAM_W + Math.max(0, Math.min(CAM_W - 1, x))];
      const out = c.ram; // バンク 0 の $0100 から
      for (let ty = 0; ty < 14; ty++) for (let tx = 0; tx < 16; tx++) for (let py = 0; py < 8; py++) {
        let lo = 0, hi = 0;
        const y = ty * 8 + py;
        for (let px = 0; px < 8; px++) {
          const x = tx * 8 + px;
          let v = at(x, y);
          if (edgeOn) v += (v * 4 - at(x - 1, y) - at(x + 1, y) - at(x, y - 1) - at(x, y + 1)) * ratio;
          const pb = 6 + ((x & 3) + (y & 3) * 4) * 3;
          const col = v < r[pb] ? 3 : v < r[pb + 1] ? 2 : v < r[pb + 2] ? 1 : 0;
          lo = (lo << 1) | (col & 1); hi = (hi << 1) | (col >> 1);
        }
        const o = 0x100 + (ty * 16 + tx) * 16 + py * 2;
        out[o] = lo; out[o + 1] = hi;
      }
      c.dirty = true;
    },
  };
  GbCart.CAM_W = CAM_W; GbCart.CAM_H = CAM_H;

  // ───────────────────────── TAMA5(バンダイ。時計つき)─────────────────────────
  // $A000 台は番地の bit0 だけを見る: 奇数 = レジスタ番号を選ぶ、偶数 = 選んだレジスタへ 4bit のデータ。
  //   レジスタ 0/1 = ROM バンクの下位/上位 4bit(書くとすぐ切り替わる)、4/5 = 書くデータの下位/上位、6 = 番地の bit4(bit0)とモード(bit3-1)、
  //   7 = 番地の下位 4bit(ここへ書いた時にモードの動作をする)、$A = 読むと $F1(生きている印)、$C/$D = 結果の下位/上位 4bit を読む($F0 を重ねて返る)。
  //   モード 0 = RAM(32 バイト)へ書く、1 = RAM を読む、2 = 命令(番地 0/1 = 時計を止める/動かす、4/5 = 分/時を書く、6/7 = 分/時を読む、$10/$11 = アラーム)、
  //   4 = 時計(TC8521 風。16 ニブル × 4 ページ)のレジスタ: 番地の下位 0/2/4/6 でページを選んで書く、1/3/5/7 で読む(番号はレジスタ 4、データはレジスタ 5)。
  // 時計は「今の実時刻+ずれ」で持ち、読むたびに桁へ直す(24 時間制として扱う。12 時間制の桁の意味は再現していない)。
  // 出どころ: mGBA の実装(MPL 2.0。読んで動作を確かめた。写してはいない)。★手元に該当ソフトが無く、実ソフトでは確かめていない
  TYPES[0xFD] = { mbc: 'tama5', ram: 1, battery: 1 };
  const T5_MASK = [0xF, 7, 0xF, 7, 0xF, 3, 7, 0xF, 3, 0xF, 1, 0xF, 0xF, 0, 0, 0, 0, 0, 0xF, 7, 0xF, 3, 7, 0xF, 3, 0, 1, 3, 0, 0, 0, 0];
  EXTRA.tama5 = {
    init(c) { c.t5 = { reg: 0, regs: new Uint8Array(8), ram: new Uint8Array(32), pages: new Uint8Array(64), disabled: false, offset: 0 }; EXTRA.tama5.reset(c); },
    reset(c) { const t = c.t5; t.reg = 0; t.regs.fill(0); t.pages[16 + 13] = 1; t.pages[32 + 13] = 2; t.pages[48 + 13] = 3; c.romBank = 1; },
    map(c) { c.lo = 0; c.hi = (c.romBank % c.romBanks) << 14; },
    write() {},
    // 今の時刻を時計ページ(ページ 0)の桁へ
    latch(c) {
      const t = c.t5, p = t.pages;
      if (t.disabled) return;
      const d = new Date(GbCart.now() + t.offset);
      const put = (i, v) => { p[i] = v % 10; p[i + 1] = (v / 10) | 0; };
      put(0, d.getSeconds()); put(2, d.getMinutes()); put(4, d.getHours()); p[6] = d.getDay();
      put(7, d.getDate()); put(9, d.getMonth() + 1); put(11, d.getFullYear() % 100);
    },
    // 時計ページの桁から「ずれ」を作り直す(ソフトが時刻を書いた後)
    sync(c) {
      const t = c.t5, p = t.pages, two = (i) => p[i] + p[i + 1] * 10;
      const d = new Date(2000 + two(11), Math.max(0, two(9) - 1), Math.max(1, two(7)), two(4), two(2), two(0));
      if (isFinite(d.getTime())) t.offset = d.getTime() - GbCart.now();
      c.dirty = true;
    },
    readRam(c, addr) {
      if (addr & 1) return 0xFF;
      const t = c.t5, r = t.regs;
      if (t.reg !== 0xC && t.reg !== 0xD) return 0xF1;
      const a5 = ((r[6] & 1) << 4) | r[7], mode = r[6] >> 1;
      let v = 0xF0;
      if (mode === 1) v = t.ram[a5];
      else if (mode === 2) { EXTRA.tama5.latch(c); v = a5 === 6 ? (t.pages[3] << 4) | t.pages[2] : a5 === 7 ? (t.pages[5] << 4) | t.pages[4] : a5; }
      else if (mode === 4) {
        if (t.reg === 0xD) return 0xFF;
        EXTRA.tama5.latch(c);
        const idx = r[4];
        if (idx > 13) v = 0; else if (r[7] & 1) v = t.pages[idx];
      }
      if (t.reg === 0xD) v >>= 4;
      return 0xF0 | (v & 0x0F);
    },
    writeRam(c, addr, v) {
      const t = c.t5, r = t.regs;
      if (addr & 1) { t.reg = v; return; }
      v &= 0x0F;
      if (t.reg >= 8) return;
      r[t.reg] = v;
      if (t.reg === 0 || t.reg === 1) { c.romBank = r[0] | (r[1] << 4); c._map(); return; }
      if (t.reg !== 7) return;
      const a5 = ((r[6] & 1) << 4) | r[7], out = (r[5] << 4) | r[4], mode = r[6] >> 1, p = t.pages;
      if (mode === 0) { t.ram[a5] = out; c.dirty = true; }
      else if (mode === 2) {
        switch (a5) {
          case 0x00: EXTRA.tama5.latch(c); t.disabled = true; for (let k = 0; k < 4; k++) p[k * 16 + 13] &= 7; c.dirty = true; break;
          case 0x01: t.disabled = false; p[0] = 0; p[1] = 0; for (let k = 0; k < 4; k++) p[k * 16 + 13] |= 8; EXTRA.tama5.sync(c); break;
          case 0x04: EXTRA.tama5.latch(c); p[2] = out & 0xF; p[3] = out >> 4; EXTRA.tama5.sync(c); break;
          case 0x05: EXTRA.tama5.latch(c); p[4] = out & 0xF; p[5] = out >> 4; EXTRA.tama5.sync(c); break;
          case 0x10: for (let k = 0; k < 4; k++) p[k * 16 + 13] &= 0xB; break;
          case 0x11: for (let k = 0; k < 4; k++) p[k * 16 + 13] |= 4; break;
        }
      } else if (mode === 4) {
        const idx = r[4], data = r[5];
        if (idx >= 13) return;
        switch (r[7]) {
          case 0: EXTRA.tama5.latch(c); p[idx] = data & T5_MASK[idx]; EXTRA.tama5.sync(c); break;
          case 2: p[16 + idx] = data & T5_MASK[idx + 16]; c.dirty = true; break;
          case 4: p[32 + idx] = data; c.dirty = true; break;
          case 6: p[48 + idx] = data; c.dirty = true; break;
        }
      }
    },
    // セーブ: RAM 32 バイト+時計の 4 ページ 64 ニブル+止めているか+「ずれ」(実時刻との差。時計はセーブを読んだ後も実時間で進む)
    getBattery(c) {
      const t = c.t5, out = new Uint8Array(32 + 64 + 8 + 8);
      out.set(t.ram); out.set(t.pages, 32); out[96] = t.disabled ? 1 : 0;
      if (t.disabled) EXTRA.tama5.sync(c);
      putF64(out, 104, t.offset);
      return out;
    },
    setBattery(c, bytes) {
      const t = c.t5;
      if (bytes.length < 32) return false;
      t.ram.set(bytes.subarray(0, 32));
      if (bytes.length >= 112) { t.pages.set(bytes.subarray(32, 96)); t.disabled = bytes[96] === 1; const o = f64(bytes, 104); if (isFinite(o)) t.offset = o; }
      return true;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
