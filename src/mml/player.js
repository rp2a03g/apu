/*
 * MML直接プレビュー再生
 * MML.Mml.render(source, opt)
 *
 * MMLコンパイラの出力(チャンネル別レジスタ書き込みログ、絶対アドレス)を、
 * 6502/NSFを経由せず直接 APU2A03 + 拡張音源チップ(複数同時可)に適用して
 * 音声波形を生成する。戻り値の形式は MML.Emu.captureSong() と互換。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Mml = MML.Mml = MML.Mml || {};

  function createExpansionAudioMap(expansions) {
    const Emu = MML.Emu;
    const map = {};
    for (const exp of expansions || []) {
      switch (exp) {
        case 'vrc6': map.vrc6 = new Emu.VRC6Audio(); break;
        case 'vrc7': map.vrc7 = new Emu.VRC7Audio(); break;
        case 'fds':  map.fds  = new Emu.FDSAudio(); break;
        case 'mmc5': map.mmc5 = new Emu.MMC5Audio(); break;
        case 'n163': map.n163 = new Emu.N163Audio(); break;
        case 'fme7': map.fme7 = new Emu.FME7Audio(); break;
      }
    }
    return map;
  }

  function isExpansionAddr(expansion, addr) {
    switch (expansion) {
      case 'vrc6':
        return (addr >= 0x9000 && addr <= 0x9002) || (addr >= 0xA000 && addr <= 0xA002) || (addr >= 0xB000 && addr <= 0xB002);
      case 'vrc7':
        return addr === 0x9010 || addr === 0x9030;
      case 'fds':
        return addr === 0x4023 || (addr >= 0x4040 && addr <= 0x408A);
      case 'mmc5':
        return addr >= 0x5000 && addr <= 0x5015;
      case 'n163':
        return addr === 0xF800 || addr === 0x4800;
      case 'fme7':
        return addr === 0xC000 || addr === 0xE000;
      default:
        return false;
    }
  }

  // 書き込みアドレスがどの拡張チップに属するか、Map内から探す
  function findExpansionForAddr(expansionMap, addr) {
    for (const name in expansionMap) {
      if (isExpansionAddr(name, addr)) return expansionMap[name];
    }
    return null;
  }

  function applyExpansionMute(expansionMap, muteOpt) {
    if (!muteOpt) return;
    for (const name in expansionMap) {
      if (muteOpt[name]) MML.Emu.applyMute(expansionMap[name].mute, muteOpt[name]);
    }
  }

  // DPCM(DMC)チャンネル用の仮想メモリバス。compile()が計算したdpcmLayout
  // ($C000-$FFFF内の配置)に従い実バイト列を配置し、APU2A03のDmcChannelが
  // 通常のbus.read(addr)経由でサンプルを読めるようにする
  // (src/mml/compiler.jsのlayoutDpcmSamples参照。APU2A03(null)だとDMCは常に無音)
  function buildDpcmBus(dpcmLayout) {
    // ページ(16KB)ごとにサンプルを敷き、窓4-7($C000-$FFFF、4KB×4)がどのページのどの4KBを見るかを
    // $5FFC-$5FFF への書込みで切り替える(2026-09-10、DPCMバンク切替)。番号付けはNSFと同じ
    // 「仮想バンク=ページ×4+k」。compiler.js segmentsToWriteLogDpcm が出す疑似書込みを
    // APU2A03.writeRegister が write() へ回してくる
    let pages = 1;
    for (const idx of Object.keys(dpcmLayout || {})) pages = Math.max(pages, (dpcmLayout[idx].page | 0) + 1);
    const mem = new Uint8Array(pages * 0x4000);
    for (const idx of Object.keys(dpcmLayout || {})) {
      const l = dpcmLayout[idx];
      mem.set(l.bytes, (l.page | 0) * 0x4000 + (l.addr - 0xC000));
    }
    const win = [0, 1, 2, 3]; // 窓4-7 → 仮想バンク(初期値=ページ0)
    return {
      read: (addr) => {
        addr &= 0xFFFF;
        if (addr < 0xC000) return 0;
        return mem[(win[(addr - 0xC000) >> 12] * 0x1000 + (addr & 0x0FFF)) % mem.length];
      },
      write: (addr, value) => { if (addr >= 0x5FFC && addr <= 0x5FFF) win[addr - 0x5FFC] = value & 0xFF; },
    };
  }

  Mml.render = function (source, opt = {}) {
    const compiled = MML.Mml.compile(source, opt);
    const sampleRate = opt.sampleRate || 44100;
    const frameRate = compiled.frameRate;

    const apu = new MML.Emu.APU2A03(buildDpcmBus(compiled.dpcmLayout));
    apu.reset();

    const expansionMap = createExpansionAudioMap(compiled.expansions);

    if (opt.mute) {
      if (opt.mute.apu) MML.Emu.applyMute(apu.mute, opt.mute.apu);
      applyExpansionMute(expansionMap, opt.mute.expansion);
    }

    const samplesPerFrame = sampleRate / frameRate;
    const totalSamples = Math.ceil(compiled.totalFrames * samplesPerFrame);
    const raw = new Float32Array(totalSamples);
    const writeLog = new Array(compiled.totalFrames);
    const regSnapshots = new Array(compiled.totalFrames);

    let cycleAccum = 0;
    let pos = 0;

    // 全チャンネル有効化 ($4015)
    apu.writeRegister(compiled.statusAddr, 0x0F);

    const runningRegs = { [compiled.statusAddr]: 0x0F };

    for (let f = 0; f < compiled.totalFrames; f++) {
      const frameWrites = [];
      for (const ch of compiled.channelLetters) {
        const writes = compiled.tracks[ch][f];
        for (const w of writes) {
          const target = findExpansionForAddr(expansionMap, w.addr);
          if (target) {
            target.writeRegister(w.addr, w.value);
          } else {
            apu.writeRegister(w.addr, w.value);
          }
          frameWrites.push(w);
          runningRegs[w.addr] = w.value;
        }
      }
      writeLog[f] = frameWrites;
      regSnapshots[f] = Object.assign({}, runningRegs);

      const samplesThisFrame = Math.round((f + 1) * samplesPerFrame) - Math.round(f * samplesPerFrame);
      for (let i = 0; i < samplesThisFrame && pos < totalSamples; i++) {
        cycleAccum += MML.Emu.CPU_CLOCK_NTSC / sampleRate;
        while (cycleAccum >= 1) {
          apu.clock();
          for (const name in expansionMap) expansionMap[name].clock();
          cycleAccum -= 1;
        }
        let sample = apu.mixSample();
        for (const name in expansionMap) sample += expansionMap[name].mixSample();
        raw[pos++] = sample;
      }
    }

    return {
      audio: MML.Emu.dcBlock(raw),
      sampleRate,
      totalFrames: compiled.totalFrames,
      samplesPerFrame,
      writeLog,
      regSnapshots,
      cpuSnapshots: null,
      memSnapshots: null,
      tempo: compiled.tempo,
      expansions: compiled.expansions,
      errors: compiled.errors
    };
  };

  /**
   * MMLを非同期でレンダリングする（UI をブロックしない）
   * @param {string} source
   * @param {object} opt
   * @param {function(done:number, total:number):void} [onProgress]
   * @returns {Promise<object>} render と同じ戻り値
   */
  Mml.renderAsync = async function (source, opt = {}, onProgress = null) {
    const CHUNK_FRAMES = 60;
    const compiled = MML.Mml.compile(source, opt);
    const sampleRate = opt.sampleRate || 44100;
    const frameRate = compiled.frameRate;

    const apu = new MML.Emu.APU2A03(buildDpcmBus(compiled.dpcmLayout));
    apu.reset();
    const expansionMap = createExpansionAudioMap(compiled.expansions);

    if (opt.mute) {
      if (opt.mute.apu) MML.Emu.applyMute(apu.mute, opt.mute.apu);
      applyExpansionMute(expansionMap, opt.mute.expansion);
    }

    const samplesPerFrame = sampleRate / frameRate;
    const totalSamples = Math.ceil(compiled.totalFrames * samplesPerFrame);
    const raw = new Float32Array(totalSamples);
    const writeLog = new Array(compiled.totalFrames);
    const regSnapshots = new Array(compiled.totalFrames);
    const runningRegs = { [compiled.statusAddr]: 0x0F };
    let cycleAccum = 0;
    let pos = 0;

    apu.writeRegister(compiled.statusAddr, 0x0F);

    for (let f = 0; f < compiled.totalFrames; f++) {
      const frameWrites = [];
      for (const ch of compiled.channelLetters) {
        const writes = compiled.tracks[ch][f];
        for (const w of writes) {
          const target = findExpansionForAddr(expansionMap, w.addr);
          if (target) {
            target.writeRegister(w.addr, w.value);
          } else {
            apu.writeRegister(w.addr, w.value);
          }
          frameWrites.push(w);
          runningRegs[w.addr] = w.value;
        }
      }
      writeLog[f] = frameWrites;
      regSnapshots[f] = Object.assign({}, runningRegs);

      const samplesThisFrame = Math.round((f + 1) * samplesPerFrame) - Math.round(f * samplesPerFrame);
      for (let i = 0; i < samplesThisFrame && pos < totalSamples; i++) {
        cycleAccum += MML.Emu.CPU_CLOCK_NTSC / sampleRate;
        while (cycleAccum >= 1) {
          apu.clock();
          for (const name in expansionMap) expansionMap[name].clock();
          cycleAccum -= 1;
        }
        let sample = apu.mixSample();
        for (const name in expansionMap) sample += expansionMap[name].mixSample();
        raw[pos++] = sample;
      }

      if ((f + 1) % CHUNK_FRAMES === 0) {
        if (onProgress) onProgress(f + 1, compiled.totalFrames);
        await new Promise(r => setTimeout(r, 0));
      }
    }

    if (onProgress) onProgress(compiled.totalFrames, compiled.totalFrames);
    return {
      audio: MML.Emu.dcBlock(raw),
      sampleRate,
      totalFrames: compiled.totalFrames,
      samplesPerFrame,
      writeLog,
      regSnapshots,
      cpuSnapshots: null,
      memSnapshots: null,
      tempo: compiled.tempo,
      expansions: compiled.expansions,
      errors: compiled.errors
    };
  };
})(window);
