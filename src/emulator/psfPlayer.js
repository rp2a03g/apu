/*
 * PSF1 プレイヤー(CPU + バス + SPU + HLE BIOS の結線)
 * MML.Emu.PsfPlayer
 *
 *   const info = await MML.PSF.load(bytes, resolveLib);
 *   const p = new MML.Emu.PsfPlayer(info);
 *   p.reset();
 *   const { left, right } = p.render(44100);   // 44.1kHz のステレオ Float32Array
 *
 * - 44.1kHz(SPU の実レート)で生成する。出力レートへの変換は呼び出し側(ストリームプレイヤー)。
 * - speedFactor: CPU とタイマ/VBlank だけ速める(SPU クロックは不変=音程は変わらない)。
 *   CPU は bus.sync に渡すサイクルを「実時間 × speedFactor」ぶん回す。
 * - アイドル省略(厳密): 1スライス(約128サイクル)を実行した前後で CPU 状態(全レジスタ/hi/lo/
 *   PC/nextPc/SR/CAUSE)が完全に一致し、その間に書き込み・時間依存 I/O の読み出し・副作用のある
 *   BIOS 呼び出しが無ければ、その状態は「割込みが来るまで変わらない不動点」。以後は同じサイクル数
 *   ずつ時間だけ進め、割込み要求が立った時点で実行に戻る。実行した場合と完全に同じ結果になる
 *   (tools/headless で idleSkip on/off の出力一致を確認する)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const SYNC_INTERVAL = 128;      // 何サイクルごとに周辺を進めるか
  const DEFAULT_SP = 0x801FFFF0 | 0;

  class PsfPlayer {
    constructor(info) {
      this.info = info;
      this.spu = new Emu.SpuPsx();
      this.bus = new Emu.PsxBus(this.spu);
      this.cpu = new Emu.CPUR3000(this.bus);
      this.bios = new Emu.PsxBios(this.bus, this.cpu);
      this.bus.setRefresh(info.refresh || 60);
      this.frameRate = this.bus.frameRate;
      this.sampleRate = Emu.SPU_PSX_RATE;
      this.speedFactor = 1;
      this.idleSkip = true;
      this.stats = { steps: 0, idleCycles: 0 };
      this.reset();
    }

    get mute() { return this.spu.mute; }

    reset() {
      const bus = this.bus, cpu = this.cpu, info = this.info;
      bus.reset();
      bus.setRefresh(info.refresh || 60);
      this.bios.reset();
      this.bios.install();
      for (const seg of info.segments) bus.loadSegment(seg.addr, seg.data);
      cpu.reset();
      cpu.sr = 0x40000401 | 0;   // CU2, IM2, IEc(割込みは I_MASK で止まっている)
      const sp = info.sp ? info.sp : DEFAULT_SP;
      cpu.setEntry(info.pc, sp, info.gp);
      cpu.r[30] = sp;
      cpu.r[31] = Emu.PsxBios.TRAP.IDLE; // main から戻ってきたら何もしないループ
      this.cycleTarget = 0;
      this.stats.steps = 0; this.stats.idleCycles = 0;
      this.samplesOut = 0;
      this.regSnap = new Int32Array(38);
    }

    get halted() { return this.cpu.halted; }
    get haltReason() { return this.bios.haltReason; }

    /**
     * SPU サンプルが n 個溜まるまで CPU/周辺を回す
     */
    runUntilSamples(n) {
      const bus = this.bus, cpu = this.cpu, bios = this.bios;
      const snap = this.regSnap;
      const realCycles = () => (this.speedFactor === 1 ? cpu.cycles : Math.round(cpu.cycles / this.speedFactor));
      while (bus.audioAvailable < n) {
        if (cpu.halted) {
          // 止まっても音(リリース等)は出し続ける: 時間だけ進める
          cpu.cycles += 768;
          bus.sync(realCycles());
          continue;
        }
        const idle = this.idleSkip;
        let wSeq = 0, ioSeq = 0, bSeq = 0;
        if (idle) { this.saveState(snap); wSeq = bus.writeSeq; ioSeq = bus.ioSeq; bSeq = bios.sideEffectSeq; }
        const start = cpu.cycles;
        const sliceEnd = start + SYNC_INTERVAL;
        while (cpu.cycles < sliceEnd && !cpu.halted) cpu.step();
        this.stats.steps++;
        bus.sync(realCycles());
        if (idle && !bus.irqLine && !cpu.halted && bus.writeSeq === wSeq && bus.ioSeq === ioSeq &&
            bios.sideEffectSeq === bSeq && this.sameState(snap)) {
          // 不動点: 同じスライスを実行し続けるのと同じだけ時間を進める
          const used = cpu.cycles - start;
          while (!bus.irqLine && bus.audioAvailable < n) {
            cpu.cycles += used;
            this.stats.idleCycles += used;
            bus.sync(realCycles());
          }
        }
      }
    }

    saveState(a) {
      const cpu = this.cpu;
      a.set(cpu.r);
      a[32] = cpu.hi; a[33] = cpu.lo; a[34] = cpu.pc; a[35] = cpu.nextPc;
      a[36] = cpu.sr; a[37] = cpu.cause | (cpu.branchDelay ? 0x40000000 : 0);
    }

    sameState(a) {
      const cpu = this.cpu, r = cpu.r;
      if (a[34] !== cpu.pc || a[35] !== cpu.nextPc || a[36] !== cpu.sr || a[32] !== cpu.hi || a[33] !== cpu.lo) return false;
      if (a[37] !== (cpu.cause | (cpu.branchDelay ? 0x40000000 : 0))) return false;
      for (let i = 1; i < 32; i++) if (a[i] !== r[i]) return false;
      return true;
    }

    /**
     * 44.1kHz で n サンプル生成する
     * @returns {{left:Float32Array, right:Float32Array}}
     */
    render(n) {
      const left = new Float32Array(n), right = new Float32Array(n);
      this.renderInto(left, right, 0, n);
      return { left, right };
    }

    renderInto(left, right, offset, n) {
      const bus = this.bus;
      const tmp = [0, 0];
      let done = 0;
      while (done < n) {
        const want = Math.min(4096, n - done);
        this.runUntilSamples(want);
        for (let i = 0; i < want; i++) {
          bus.popSample(tmp);
          left[offset + done + i] = tmp[0] / 32768;
          right[offset + done + i] = tmp[1] / 32768;
        }
        done += want;
      }
      this.samplesOut += n;
    }
  }

  // ── キャプチャ ──────────────────────────────────────────
  // フレームは SPU の 44.1kHz を 735 サンプルずつ区切った 60Hz(ビデオの 59.83Hz とは独立。
  // ロール/変換/再生の時間軸をサンプル単位の整数にそろえるため)。
  const SAMPLES_PER_FRAME = 735;
  const FRAME_RATE = 44100 / SAMPLES_PER_FRAME;   // = 60
  // スナップショット(フレーム末尾時点)の配置: ボイスごとに VOICE_FIELDS 個 + 全体
  const SNAP = {
    VOICE_FIELDS: 11,
    PHASE: 0,   // 0=off 1=attack 2=decay 3=sustain 4=release
    PITCH: 1,   // VxPitch レジスタ(0x1000 = 原音 44.1kHz)
    LEVEL: 2,   // ADSR レベル 0..0x7FFF
    VOLL: 3, VOLR: 4,   // 現在音量(スイープ適用後、-0x8000..0x7FFF)
    START: 5,   // 開始アドレス(バイト)
    SERIAL: 6,  // キーオン通し番号
    FLAGS: 7,   // bit0 noise, bit1 pmon, bit2 reverb
    CUR: 8,     // 現在の ADPCM ブロックアドレス(バイト)
    SAMPLE: 9,  // キーオン時に鳴らし始めたサンプルの番号(cap.samples の添字、未発音は -1)
    TRACK: 10,  // キーオンを出したドライバ内部のトラック番号(cap.trackProbe.tracks の添字、不明は -1)
    MAIN_L: 24 * 11, MAIN_R: 24 * 11 + 1,
    LENGTH: 24 * 11 + 2,
  };

  // FNV-1a 32bit(バイト列)。サンプル内容の同定用(音色キー 'pcm:<hash>' / ドラムパッド)
  function fnvBytes(bytes, from, to) {
    let h = 0x811c9dc5;
    for (let i = from; i < to; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * SPU RAM 上のサンプルを、実際に鳴るループ構造どおりに復号して同定する(SpuPsx.describeSample)。
   * repeatReg/ignoreFlag はキーオンしたフレーム末尾のボイス状態(ドライバがレジスタで指定したループ先)。
   * @returns {{addr, pcm:Int16Array, loopStart:number|null, looped:boolean, endMute:boolean, blocks, loopAddr,
   *            bytes:Uint8Array(頭+ループ部の生 ADPCM。音色ハッシュ用), hash, rate:44100}}
   */
  function describeSample(ram, addr, repeatReg, ignoreFlag) {
    const d = Emu.SpuPsx.describeSample(ram, addr, repeatReg, ignoreFlag);
    let total = 0;
    for (const [a, b] of d.byteRanges) total += Math.max(0, Math.min(ram.length, b) - a);
    const bytes = new Uint8Array(total + 4);
    let o = 0;
    for (const [a, b] of d.byteRanges) { const e = Math.min(ram.length, b); bytes.set(ram.subarray(a, e), o); o += e - a; }
    // ループ位置も同定に含める(同じ波形でもループ先が違えば別の音)
    const ls = d.loopStart == null ? 0xFFFFFFFF : d.loopStart;
    bytes[o] = ls & 0xFF; bytes[o + 1] = (ls >>> 8) & 0xFF; bytes[o + 2] = (ls >>> 16) & 0xFF; bytes[o + 3] = (ls >>> 24) & 0xFF;
    return {
      addr: addr & 0x7FFF0, pcm: d.pcm, loopStart: d.loopStart, looped: d.looped,
      endMute: d.endMute, blocks: d.blocks, loopAddr: d.loopAddr, rate: 44100,
      bytes, hash: fnvBytes(bytes, 0, bytes.length),
    };
  }

  function takeSnapshot(spu, sampleOfVoice, trackOfVoice) {
    const a = new Int32Array(SNAP.LENGTH);
    const F = SNAP.VOICE_FIELDS;
    for (let i = 0; i < 24; i++) {
      const v = spu.voices[i], o = i * F;
      a[o] = v.phase; a[o + 1] = spu.regs[i * 8 + 2]; a[o + 2] = v.level;
      a[o + 3] = v.volL; a[o + 4] = v.volR; a[o + 5] = (spu.regs[i * 8 + 3] << 3) & 0x7FFFF;
      a[o + 6] = v.keyOnSerial;
      a[o + 7] = ((spu.non >> i) & 1) | (((spu.pmon >> i) & 1) << 1) | (((spu.eon >> i) & 1) << 2);
      a[o + 8] = v.curAddr;
      a[o + 9] = sampleOfVoice[i];
      a[o + 10] = trackOfVoice[i];
    }
    a[SNAP.MAIN_L] = spu.mainVolL; a[SNAP.MAIN_R] = spu.mainVolR;
    return a;
  }

  // ── ドライバ内部トラックの推定 ─────────────────────────────────────────
  // PS1 のドライバの多くは、キーオンのたびに空いているボイスを次々と使い回す(余韻を残したまま次の音を
  // 別ボイスで鳴らす)。ボイス番号では旋律がばらばらになるので、ドライバ自身の「トラック(シーケンスの
  // パート)構造体」を CPU の実行中の状態から推定し、キーオンにトラック番号を付ける。
  // 逆アセンブルはしない。短く試し走らせして次の2か所の CPU 状態を集め、候補を採点する:
  //  1) SPU のボイスレジスタ(ピッチ/開始アドレス)を書く瞬間
  //  2) 1) の書き込み元が「ボイスごとの影テーブル(base + voice*stride)」の一括書き出しだった場合は、
  //     その影テーブルへ書き込む瞬間(もう一度試し走らせして RAM 書き込みを監視する)
  // 候補 = 書き込み命令の pc × (汎用レジスタ r1..r31 | スタック sp+0..0xFC)。キーオン直前(4フレーム以内)の
  // 値でキーオンを分類し、次を満たす最良のものをトラックとみなす:
  //  - 値がすべて RAM 上のポインタで、2〜64 種類
  //  - 1種類がボイス1本に張り付いていない(=ボイス構造体ではない)
  //  - 同じ値のキーオンが同じサンプルを鳴らす割合(純度)が高く、同じフレームに重ならない
  //  - 値が等間隔に並ぶ(構造体の配列。音色データへのポインタ等は不規則なので落ちる)
  // 実測(2026-09-14、tools/headless/pool-regroup-score.js / 24曲の自動探索): ナムコ系・北斗の拳・
  // Philosoma・桃太郎伝説・信長の野望 烈風伝・オウガバトル・FF8・クロノ・サガフロ2 で見つかる。
  // Crash Bandicoot・ペルソナ2・かまいたちの夜は見つからない(合成chの推定に戻る)。
  const PROBE_STACK_WORDS = 64;
  const physAddr = (x) => (x >>> 0) & 0x1FFFFFFF;
  const isRamPtr = (x) => { const p = physAddr(x); return p >= 0x10000 && p < 0x200000; };

  async function probeRun(info, secs, tables, yieldFn, budgetMs, minKeyons) {
    const player = new PsfPlayer(info);
    const { spu, bus, cpu } = player;
    const events = [], keyons = [];
    const grab = (kind, v) => {
      const r = new Uint32Array(32);
      for (let i = 0; i < 32; i++) r[i] = cpu.r[i] >>> 0;
      const st = new Uint32Array(PROBE_STACK_WORDS);
      const sp = cpu.r[29];
      if (isRamPtr(sp)) for (let k = 0; k < PROBE_STACK_WORDS; k++) st[k] = bus.read32((sp + k * 4) | 0) >>> 0;
      events.push({ kind, v, f: Math.floor(spu.sampleCount / SAMPLES_PER_FRAME), pc: physAddr(cpu.pc), r, st });
    };
    spu.onWrite = (index) => { if (index < 0xC0 && ((index & 7) === 2 || (index & 7) === 3)) grab('spu', index >> 3); };
    spu.onKeyOn = (v, addr) => keyons.push({ v, f: Math.floor(spu.sampleCount / SAMPLES_PER_FRAME), addr, ev: events.length });
    if (tables && tables.length) {
      for (const m of ['write8', 'write16', 'write32']) {
        const orig = bus[m];
        bus[m] = function (a, val) {
          const p = physAddr(a);
          if (p < 0x200000) {
            for (const t of tables) if (p >= t.base && p < t.base + 24 * t.stride) { grab('ram', ((p - t.base) / t.stride) | 0); break; }
          }
          return orig.call(bus, a, val);
        };
      }
    }
    const total = Math.round(secs * FRAME_RATE) * SAMPLES_PER_FRAME;
    const now = (typeof performance !== 'undefined' && performance.now) ? () => performance.now() : () => Date.now();
    const tmp = [0, 0];
    let done = 0;
    // ★止める判定は4フレームごとに見る(時間の区切りごとに見ると、どこで止まるかが実行ごとに変わり、
    //   見つかるトラックの並び=トラック番号が鍵盤表示と変換で食い違った)
    const enough = () => done >= total || player.halted || (minKeyons && keyons.length >= minKeyons && done >= 8 * 44100);
    while (!enough()) {
      const t0 = now();
      while (!enough() && now() - t0 < budgetMs) {
        player.runUntilSamples(SAMPLES_PER_FRAME * 4);
        for (let i = 0; i < SAMPLES_PER_FRAME * 4; i++) bus.popSample(tmp);
        done += SAMPLES_PER_FRAME * 4;
      }
      if (yieldFn) await yieldFn();
    }
    return { events, keyons, done };
  }

  // 同じ pc のボイスレジスタ書き込みで、あるレジスタが base + voice*stride になっている = 影テーブル
  function findShadowTables(events) {
    const byPc = new Map();
    for (const e of events) if (e.kind === 'spu') { if (!byPc.has(e.pc)) byPc.set(e.pc, []); byPc.get(e.pc).push(e); }
    const found = [];
    for (const evs of byPc.values()) {
      if (evs.length < 24 || new Set(evs.map(e => e.v)).size < 4) continue;
      // 基準の2点は後半から取る(曲の初期化で別のテーブルを一巡することがある。ナムコ系で実測)
      const late = evs.slice(evs.length >> 1);
      for (let k = 1; k < 32; k++) {
        const a = late.find(e => isRamPtr(e.r[k]));
        const b = a && late.find(e => e.v !== a.v && isRamPtr(e.r[k]));
        if (!b) continue;
        const stride = (physAddr(b.r[k]) - physAddr(a.r[k])) / (b.v - a.v);
        if (!Number.isInteger(stride) || stride < 4 || stride > 0x400) continue;
        const base = physAddr(a.r[k]) - a.v * stride;
        let ok = 0;
        for (const e of evs) if (physAddr(e.r[k]) === base + e.v * stride) ok++;
        if (ok >= evs.length * 0.8) found.push({ base, stride });
      }
    }
    // 同じテーブルの別表現(先頭+2 を指すレジスタ等)は1つにまとめる
    const out = [];
    for (const t of found.sort((x, y) => x.base - y.base)) {
      if (!out.some(u => u.stride === t.stride && Math.abs(u.base - t.base) < t.stride)) out.push({ base: t.base & ~1, stride: t.stride });
    }
    return out.slice(0, 4);
  }

  const gcd = (a, b) => { while (b) { const t = a % b; a = b; b = t; } return a; };

  function scoreTrackCandidates(events, keyons, kind) {
    // キーオンごとに、同じボイスへの直前(4フレーム以内)の各 pc の最後の書き込みを結び付ける
    const lastByVoice = Array.from({ length: 24 }, () => new Map());
    const links = new Map(); // pc → [{e, kon}]
    let ei = 0;
    for (const kon of keyons) {
      while (ei < kon.ev) { const e = events[ei++]; if (e.kind === kind) lastByVoice[e.v].set(e.pc, e); }
      for (const [pc, e] of lastByVoice[kon.v]) {
        if (kon.f - e.f > 4) continue;
        if (!links.has(pc)) links.set(pc, []);
        links.get(pc).push({ e, kon });
      }
      lastByVoice[kon.v].clear();
    }
    const cands = [];
    for (const [pc, ls] of links) {
      if (ls.length < keyons.length * 0.6) continue;
      const voicesUsed = new Set(ls.map(l => l.kon.v)).size;
      for (let s = 1; s < 32 + PROBE_STACK_WORDS; s++) {
        const reg = s < 32 ? s : 0, stackOff = s < 32 ? -1 : (s - 32) * 4;
        const groups = new Map();
        let bad = 0;
        for (const l of ls) {
          const val = reg ? l.e.r[reg] : l.e.st[stackOff >> 2];
          if (!isRamPtr(val)) { if (++bad > ls.length * 0.01) break; continue; }
          const g = physAddr(val);
          if (!groups.has(g)) { if (groups.size >= 64) { bad = Infinity; break; } groups.set(g, []); }
          groups.get(g).push(l.kon);
        }
        if (bad > ls.length * 0.01 || groups.size < 2) continue;
        let pure = 0, overlap = 0, voiceSum = 0;
        for (const g of groups.values()) {
          const bySmp = new Map(), byFrame = new Map(), vs = new Set();
          for (const k of g) {
            bySmp.set(k.addr, (bySmp.get(k.addr) || 0) + 1);
            byFrame.set(k.f, (byFrame.get(k.f) || 0) + 1);
            vs.add(k.v);
          }
          let mx = 0; for (const n of bySmp.values()) if (n > mx) mx = n;
          pure += mx;
          for (const n of byFrame.values()) if (n > 1) overlap += n - 1;
          voiceSum += vs.size;
        }
        const n = ls.length - bad;
        const purity = pure / n, overlapRate = overlap / n, voicesPerGroup = voiceSum / groups.size;
        const voiceBound = voicesPerGroup <= 1.05 && groups.size >= voicesUsed * 0.8;
        const addrs = [...groups.keys()].sort((x, y) => x - y);
        let g = 0; for (let i = 1; i < addrs.length; i++) g = gcd(g, addrs[i] - addrs[i - 1]);
        const regular = g >= 4 && (addrs[addrs.length - 1] - addrs[0]) / g <= 1024;
        cands.push({ kind, pc, reg, stackOff, groups: groups.size, purity, overlapRate, voicesPerGroup,
          coverage: n / keyons.length, voiceBound, regular, stride: g, addrs,
          score: purity - overlapRate * 0.5 + Math.min(1, n / keyons.length) * 0.1 });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    return cands;
  }

  Emu._psfTrackProbeInternals = { probeRun, findShadowTables, scoreTrackCandidates }; // ヘッドレス診断用
  const acceptTrackCandidate = (c) => c && !c.voiceBound && c.regular && c.purity >= 0.7 && c.overlapRate <= 0.5 && c.coverage >= 0.6;

  /**
   * ドライバ内部トラックのフック位置を推定する(キャプチャ前の試し走らせ。副作用なし)。
   * @returns {Promise<{found:boolean, reason?:string, kind?:'spu'|'ram', pc?, reg?, stackOff?, table?:{base,stride},
   *                    tracks?:number[], groups?, purity?, overlapRate?, coverage?, keyons?}>}
   *   tracks はトラック構造体の物理アドレス(昇順)。スナップショットの TRACK はこの添字(後から見つかったものは末尾に足す)
   */
  Emu.probePsfTracksAsync = async function (info, opt) {
    opt = opt || {};
    const secs = opt.seconds || 20;
    const yieldFn = opt.yieldFn || null, budget = opt.sliceBudgetMs || 8;
    const a = await probeRun(info, secs, null, yieldFn, budget, 400);
    if (a.keyons.length < 16) return { found: false, reason: 'keyons', keyons: a.keyons.length };
    const cands = scoreTrackCandidates(a.events, a.keyons, 'spu');
    const tables = findShadowTables(a.events);
    if (tables.length) {
      const b = await probeRun(info, a.done / 44100, tables, yieldFn, budget, 0);
      const viaTable = scoreTrackCandidates(b.events, b.keyons, 'ram');
      // 本キャプチャのフックが同じ RAM 範囲だけを見るように、監視したテーブルを持たせる
      for (const c of viaTable) { c.tables = tables; cands.push(c); }
      cands.sort((x, y) => y.score - x.score);
    }
    const best = cands.find(acceptTrackCandidate);
    if (!best) {
      const top = cands[0];
      // 診断用: 上位候補の要約(tools/headless/pool-regroup-score.js が表示する)
      const summary = cands.slice(0, 3).map(c => `${c.kind}@${c.pc.toString(16)} ${c.reg ? 'r' + c.reg : 'sp+' + c.stackOff.toString(16)} g${c.groups} p${c.purity.toFixed(2)} o${c.overlapRate.toFixed(2)} cov${c.coverage.toFixed(2)}${c.voiceBound ? ' voice' : ''}${c.regular ? '' : ' irregular'}`);
      return { found: false, reason: top ? (top.voiceBound ? 'voiceBound' : 'weak') : 'none', keyons: a.keyons.length, tables: tables, top: summary };
    }
    return {
      found: true, kind: best.kind, pc: best.pc, reg: best.reg, stackOff: best.stackOff,
      tables: best.kind === 'ram' ? best.tables : null,
      tracks: best.addrs, stride: best.stride, groups: best.groups,
      purity: best.purity, overlapRate: best.overlapRate, coverage: best.coverage, keyons: a.keyons.length,
    };
  };

  /**
   * PSF をキャプチャする(再生用の書き込みログ + ロール/変換用のフレームスナップショット)。
   * @param {object} info  MML.PSF.load() の結果(Worker へは structured clone で渡せる)
   * @param {object} opt   {durationSeconds, regsOnly(音声を作らない), speedFactor, mute,
   *                        sliceBudgetMs, yieldFn, shouldCancel}
   * @param {function} onProgress (doneFrames, totalFrames, cap)
   * @returns {Promise<object>} cap
   *   frameLog[f]: Int32Array [offInFrame, (index<<16)|value, ...]  SPU レジスタ書き込み
   *   ramLog: [{f, off, addr, data:Int16Array}]  SPU RAM 転送(連続したハーフワードはまとめる)
   *   snapshots[f]: Int32Array(SNAP.LENGTH)  フレーム末尾の状態
   *   audioL/audioR: Float32Array(44.1kHz)  regsOnly でなければ
   */
  Emu.capturePsfSongAsync = async function (info, opt, onProgress) {
    opt = opt || {};
    const player = new PsfPlayer(info);
    if (opt.speedFactor) player.speedFactor = opt.speedFactor;
    const spu = player.spu, bus = player.bus;
    if (opt.mute) Emu.applyMute(spu.mute, opt.mute);
    const totalFrames = Math.max(1, Math.round((opt.durationSeconds || 180) * FRAME_RATE));
    const totalSamples = totalFrames * SAMPLES_PER_FRAME;
    const wantAudio = !opt.regsOnly;
    const cap = {
      frameRate: FRAME_RATE, samplesPerFrame: SAMPLES_PER_FRAME, totalFrames,
      frameLog: [], ramLog: [], snapshots: [],
      samples: [],             // [{addr, pcm, loopStart, looped, endMute, blocks, hash, rate}]
      audioL: wantAudio ? new Float32Array(totalSamples) : null,
      audioR: wantAudio ? new Float32Array(totalSamples) : null,
      player,
    };
    // サンプルの同定: 同じアドレスでも RAM が書き換わったら内容ハッシュで見直す
    // ★サンプル番号はキーオンしたフレームの末尾で決める。ループ先をレジスタで指定するドライバ(FF7 の AKAO 等)は
    //   キーオンの前後に repeat レジスタを書くので、キーオンの瞬間ではまだ分からない
    const sampleOfVoice = new Int32Array(24).fill(-1);
    const pendingStart = new Int32Array(24).fill(-1);
    const byKey = new Map();     // 'start:repeat:ignore' → {gen, id}
    const byHash = new Map();    // hash → id
    let ramGen = 0;
    const sampleIdFor = (addr, repeatReg, ignore) => {
      const key = addr + ':' + repeatReg + ':' + (ignore ? 1 : 0);
      const c = byKey.get(key);
      if (c && c.gen === ramGen) return c.id;
      const desc = describeSample(spu.ram, addr, repeatReg, ignore);
      let id = byHash.get(desc.hash);
      if (id === undefined) { id = cap.samples.length; cap.samples.push(desc); byHash.set(desc.hash, id); }
      byKey.set(key, { gen: ramGen, id });
      return id;
    };
    const resolvePending = () => {
      for (let v = 0; v < 24; v++) {
        if (pendingStart[v] < 0) continue;
        const voice = spu.voices[v];
        sampleOfVoice[v] = sampleIdFor(pendingStart[v], voice.repeatAddr, voice.ignoreLoopAddr);
        pendingStart[v] = -1;
      }
    };
    let cur = [];            // 今のフレームの書き込み
    let curFrame = 0;
    // ドライバ内部トラック(Emu.probePsfTracksAsync)。regsOnly(ロール/変換用)だけ。opt.trackProbe===false で無効
    const trackOfVoice = new Int32Array(24).fill(-1);
    let noteTrackOwner = null;   // (voice) → そのボイスへ書いたトラックを控える
    let trackAtKeyOn = null;     // (voice) → キーオン時点のトラック番号
    if (opt.regsOnly && opt.trackProbe !== false) {
      const probe = await Emu.probePsfTracksAsync(info, { yieldFn: opt.yieldFn, sliceBudgetMs: opt.sliceBudgetMs });
      cap.trackProbe = probe;
      if (probe.found) {
        const cpu = player.cpu;
        const owner = new Int32Array(24).fill(-1), ownerFrame = new Int32Array(24).fill(-1000);
        const trackIndex = new Map(probe.tracks.map((a, i) => [a, i]));
        noteTrackOwner = (v) => {
          const val = probe.reg ? cpu.r[probe.reg] : bus.read32((cpu.r[29] + probe.stackOff) | 0);
          if (!isRamPtr(val)) return;
          owner[v] = physAddr(val); ownerFrame[v] = curFrame;
        };
        trackAtKeyOn = (v) => {
          if (curFrame - ownerFrame[v] > 4) return -1;
          let id = trackIndex.get(owner[v]);
          if (id === undefined) { id = probe.tracks.length; probe.tracks.push(owner[v]); trackIndex.set(owner[v], id); }
          return id;
        };
        if (probe.kind === 'ram') {
          const tables = probe.tables;
          for (const m of ['write8', 'write16', 'write32']) {
            const orig = bus[m];
            bus[m] = function (a, val) {
              const p = physAddr(a);
              if (p < 0x200000 && physAddr(cpu.pc) === probe.pc) {
                for (const t of tables) if (p >= t.base && p < t.base + 24 * t.stride) { noteTrackOwner(((p - t.base) / t.stride) | 0); break; }
              }
              return orig.call(bus, a, val);
            };
          }
        }
      }
    }
    spu.onKeyOn = (voice, addr) => {
      pendingStart[voice] = addr;
      if (trackAtKeyOn) trackOfVoice[voice] = trackAtKeyOn(voice);
    };
    let ramChunk = null;     // {f, off, addr, vals:[]}
    const flushRam = () => {
      if (!ramChunk) return;
      cap.ramLog.push({ f: ramChunk.f, off: ramChunk.off, addr: ramChunk.addr, data: Int16Array.from(ramChunk.vals) });
      ramChunk = null;
    };
    const spuHookPc = (noteTrackOwner && cap.trackProbe.kind === 'spu') ? cap.trackProbe.pc : -1;
    spu.onWrite = (index, value) => {
      cur.push(spu.sampleCount - curFrame * SAMPLES_PER_FRAME, (index << 16) | value);
      if (spuHookPc >= 0 && index < 0xC0 && ((index & 7) === 2 || (index & 7) === 3) && physAddr(player.cpu.pc) === spuHookPc) noteTrackOwner(index >> 3);
    };
    spu.onRamWrite = (addr, value) => {
      ramGen++;
      const sc = spu.sampleCount;
      const f = Math.floor(sc / SAMPLES_PER_FRAME);
      const off = sc - f * SAMPLES_PER_FRAME;
      if (ramChunk && ramChunk.f === f && ramChunk.off === off &&
          addr === ramChunk.addr + ramChunk.vals.length * 2 && ramChunk.vals.length < 65536) {
        ramChunk.vals.push(value);
      } else {
        flushRam();
        ramChunk = { f, off, addr, vals: [value] };
      }
    };
    bus.onSample = (s) => {
      // clock() 直後。sampleCount は生成済みサンプル数
      if (s.sampleCount % SAMPLES_PER_FRAME === 0) {
        flushRam();
        resolvePending();
        cap.frameLog.push(Int32Array.from(cur));
        cap.snapshots.push(takeSnapshot(s, sampleOfVoice, trackOfVoice));
        cur = [];
        curFrame++;
      }
    };
    const yieldFn = opt.yieldFn || (() => new Promise(r => setTimeout(r, 0)));
    const budget = opt.sliceBudgetMs || (opt.regsOnly ? 8 : 15);
    const now = (typeof performance !== 'undefined' && performance.now) ? () => performance.now() : () => Date.now();
    const tmp = [0, 0];
    let popped = 0;
    const CHUNK = SAMPLES_PER_FRAME * 4;
    while (curFrame < totalFrames) {
      if (opt.shouldCancel && opt.shouldCancel()) { cap.cancelled = true; break; }
      const t0 = now();
      while (curFrame < totalFrames && now() - t0 < budget) {
        const want = Math.min(CHUNK, totalSamples - popped);
        if (want <= 0) break;
        player.runUntilSamples(want);
        for (let i = 0; i < want; i++) {
          bus.popSample(tmp);
          if (wantAudio) { cap.audioL[popped + i] = tmp[0] / 32768; cap.audioR[popped + i] = tmp[1] / 32768; }
        }
        popped += want;
      }
      if (onProgress && curFrame < totalFrames) onProgress(curFrame, totalFrames, cap);
      if (curFrame < totalFrames) await yieldFn();
    }
    // runUntilSamples は要求より少し先まで進むことがあるので、曲長の外のフレームは捨てる
    if (cap.frameLog.length > totalFrames) { cap.frameLog.length = totalFrames; cap.snapshots.length = totalFrames; }
    cap.ramLog = cap.ramLog.filter(r => r.f < totalFrames);
    spu.onWrite = null; spu.onRamWrite = null; spu.onKeyOn = null; bus.onSample = null;
    cap.bios = { halted: player.halted, haltReason: player.haltReason, unknownCalls: [...player.bios.unknownCalls.entries()] };
    if (onProgress) onProgress(cap.frameLog.length, totalFrames, cap);
    return cap;
  };

  /**
   * キャプチャした書き込みログを SPU だけで再生する(CPU は動かさない)。
   * ストリームプレイヤー/WAV 書き出し/ヘッドレス検証で共有する。
   * cap は {frameLog, ramLog} を持っていればよい(Worker から差分で育つ途中の配列でもよい)。
   *
   * 時間の持ち方: pos = 曲のサンプル位置(実数)。step() は「pos 以下に記録された書き込みを
   * 反映 → SPU を1サンプル進める → pos += speed」。speed=1 なら元のエミュレーションと
   * サンプル単位で一致する(tools/headless/psf-replay-check.js)。speed≠1 はログの進みだけを
   * 変え、SPU のクロック(=音程)は変えない(他形式の Replay プレイヤーと同じテンポ変更)。
   */
  class PsfReplay {
    constructor(cap) {
      this.cap = cap;
      this.spu = new Emu.SpuPsx();
      this.spu.replayMode = true;
      this.speed = 1;
      this.reset();
    }
    reset() {
      this.spu.reset();
      this.pos = 0;            // 曲のサンプル位置(実数)
      this.wFrame = 0;         // 書き込みを反映済みのフレーム
      this.wIdx = 0;           // frameLog[wFrame] の次の書き込み(ペア単位で +2)
      this.rIdx = 0;           // ramLog の次
    }
    get frame() { return Math.floor(this.pos / SAMPLES_PER_FRAME); }
    /** 次の1サンプルを生成できるか(キャプチャが追いついているか) */
    ready() { return Math.floor(this.pos / SAMPLES_PER_FRAME) < this.cap.frameLog.length; }
    /** 曲長(キャプチャ予定の全フレーム)に達したか */
    ended(totalFrames) { return Math.floor(this.pos / SAMPLES_PER_FRAME) >= totalFrames; }
    /** 曲のサンプル位置 target(整数)までの RAM 転送とレジスタ書き込みを反映する */
    applyUpTo(target) {
      const cap = this.cap, spu = this.spu;
      const ramLog = cap.ramLog;
      const tf = Math.floor(target / SAMPLES_PER_FRAME);
      while (this.rIdx < ramLog.length) {
        const r = ramLog[this.rIdx];
        if (r.f * SAMPLES_PER_FRAME + r.off > target) break;
        const d = r.data;
        for (let i = 0; i < d.length; i++) spu.ramWrite16Direct(r.addr + i * 2, d[i]);
        this.rIdx++;
      }
      while (this.wFrame <= tf && this.wFrame < cap.frameLog.length) {
        const w = cap.frameLog[this.wFrame];
        const limit = (this.wFrame < tf) ? Infinity : target - tf * SAMPLES_PER_FRAME;
        while (this.wIdx < w.length && w[this.wIdx] <= limit) {
          const packed = w[this.wIdx + 1];
          spu.writeReg(packed >>> 16, packed & 0xFFFF);
          this.wIdx += 2;
        }
        if (this.wFrame < tf) { this.wFrame++; this.wIdx = 0; } else break;
      }
    }
    /** 1サンプル生成(ready() が true のときだけ呼ぶ) */
    step() {
      this.applyUpTo(Math.floor(this.pos));
      this.spu.clock();
      this.pos += this.speed;
    }
    /**
     * frame の先頭へ移動する。0..frame-1 の RAM 転送と書き込みを SPU を回さずに流し直す。
     * ADPCM の再生位置や ADSR の途中経過は復元しない(SPC の再生と同じ割り切り)。
     * 鳴りっぱなしの音を作らないよう KON は流さない。
     */
    seekFrame(frame) {
      const cap = this.cap, spu = this.spu;
      frame = Math.max(0, Math.min(frame, cap.frameLog.length));
      this.reset();
      const ramLog = cap.ramLog;
      for (let f = 0; f < frame; f++) {
        while (this.rIdx < ramLog.length && ramLog[this.rIdx].f <= f) {
          const r = ramLog[this.rIdx++];
          for (let i = 0; i < r.data.length; i++) spu.ramWrite16Direct(r.addr + i * 2, r.data[i]);
        }
        const w = cap.frameLog[f];
        for (let i = 0; i < w.length; i += 2) {
          const idx = w[i + 1] >>> 16;
          if (idx === 0xC4 || idx === 0xC5) continue;
          spu.writeReg(idx, w[i + 1] & 0xFFFF);
        }
      }
      this.pos = frame * SAMPLES_PER_FRAME;
      this.wFrame = frame; this.wIdx = 0;
    }
  }

  PsfPlayer.SAMPLES_PER_FRAME = SAMPLES_PER_FRAME;
  PsfPlayer.FRAME_RATE = FRAME_RATE;
  PsfPlayer.SNAP = SNAP;
  Emu.PsfReplay = PsfReplay;
  Emu.PSF_SNAP = SNAP;
  Emu.describePsfSample = describeSample;
  Emu.PsfPlayer = PsfPlayer;
})(window);
