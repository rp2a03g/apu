/*
 * MML AudioWorklet プロセッサ実装
 * worklet-loader.js によって APU コードと連結されて Blob URL として読み込まれる。
 * window / importScripts は使わない。globalThis.MML.Emu が使用可能な前提。
 */

const _MML_CPU_CLOCK = 1789773;

function _mmlIsExpansionAddr(expansion, addr) {
  switch (expansion) {
    case 'vrc6': return (addr >= 0x9000 && addr <= 0x9002) || (addr >= 0xA000 && addr <= 0xA002) || (addr >= 0xB000 && addr <= 0xB002);
    case 'vrc7': return addr === 0x9010 || addr === 0x9030;
    case 'fds':  return addr === 0x4023 || (addr >= 0x4040 && addr <= 0x408A);
    case 'mmc5': return addr >= 0x5000 && addr <= 0x5015;
    case 'n163': return addr === 0xF800 || addr === 0x4800;
    case 'fme7': return addr === 0xC000 || addr === 0xE000;
    default:     return false;
  }
}

function _mmlCreateExpansionMap(expansions) {
  const Emu = globalThis.MML.Emu;
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

// 書き込みアドレスがどの拡張チップに属するか、Map内から探す
function _mmlFindExpansionForAddr(expansionMap, addr) {
  for (const name in expansionMap) {
    if (_mmlIsExpansionAddr(name, addr)) return expansionMap[name];
  }
  return null;
}

class MmlProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.apu           = null;
    this.expansionMap  = {};
    this.tracks        = null;
    this.channelLetters = [];
    this.totalFrames   = 0;
    this.expansions    = [];
    this.statusAddr    = 0x4015;
    this.samplesPerFrame = 0;
    this.samplePos     = 0;
    this.currentFrame  = -1;
    this.cycleAccum    = 0;
    this.dcPrevX       = 0;
    this.dcPrevY       = 0;
    this.playing       = false;

    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'load':   this._load(msg);   break;
      case 'reload': this._reload(msg); break;
      case 'play':
        this.playing = true;
        break;
      case 'pause':
        this.playing = false;
        this.port.postMessage({ type: 'paused', samplePos: this.samplePos });
        break;
      case 'stop':
        this.playing = false;
        this._resetApu();
        this.samplePos    = 0;
        this.currentFrame = -1;
        this.dcPrevX = this.dcPrevY = 0;
        break;
      case 'seek': this._seek(msg.samplePos); break;
      case 'mute': this._applyMute(msg.mute);  break;
    }
  }

  _resetApu() {
    if (this.apu) {
      this.apu.reset();
      this.apu.writeRegister(this.statusAddr, 0x0F);
    }
    this.cycleAccum = 0;
  }

  _load(data) {
    const Emu = globalThis.MML.Emu;
    this.apu            = new Emu.APU2A03(null);
    this.expansions     = data.expansions || [];
    this.expansionMap   = _mmlCreateExpansionMap(this.expansions);
    this.statusAddr     = data.statusAddr;
    this.tracks         = data.tracks;
    this.channelLetters = data.channelLetters;
    this.totalFrames    = data.totalFrames;
    this.samplesPerFrame = sampleRate / data.frameRate;
    this.samplePos      = 0;
    this.currentFrame   = -1;
    this.cycleAccum     = 0;
    this.dcPrevX = this.dcPrevY = 0;
    this.playing        = false;
    this._resetApu();
    if (data.mute) this._applyMute(data.mute);
  }

  _reload(data) {
    this.tracks         = data.tracks;
    this.channelLetters = data.channelLetters;
    this.totalFrames    = data.totalFrames;
    this.samplePos      = 0;
    this.currentFrame   = -1;
    this.dcPrevX = this.dcPrevY = 0;
    this.playing        = false;
    this._resetApu();
  }

  _seek(targetSample) {
    const targetFrame = Math.min(
      Math.floor(targetSample / this.samplesPerFrame),
      this.totalFrames - 1
    );
    this._resetApu();
    for (const name in this.expansionMap) {
      if (this.expansionMap[name].reset) this.expansionMap[name].reset();
    }
    // 対象フレームまでレジスタ書き込みを高速リプレイ（音声生成なし）
    for (let f = 0; f <= targetFrame; f++) {
      for (const ch of this.channelLetters) {
        for (const w of this.tracks[ch][f]) {
          const target = _mmlFindExpansionForAddr(this.expansionMap, w.addr);
          if (target) {
            target.writeRegister(w.addr, w.value);
          } else {
            this.apu.writeRegister(w.addr, w.value);
          }
        }
      }
    }
    this.samplePos    = targetSample;
    this.currentFrame = targetFrame;
    this.dcPrevX = this.dcPrevY = 0;
  }

  _applyMute(mute) {
    if (!mute || !this.apu) return;
    const Emu = globalThis.MML.Emu;
    if (mute.apu) Emu.applyMute(this.apu.mute, mute.apu);
    if (mute.expansion) {
      for (const name in this.expansionMap) {
        if (mute.expansion[name]) Emu.applyMute(this.expansionMap[name].mute, mute.expansion[name]);
      }
    }
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!this.tracks || !this.playing) { out.fill(0); return true; }

    for (let i = 0; i < out.length; i++) {
      const frameForSample = Math.floor(this.samplePos / this.samplesPerFrame);

      if (frameForSample >= this.totalFrames) {
        for (let j = i; j < out.length; j++) out[j] = 0;
        this.playing = false;
        this.port.postMessage({ type: 'ended' });
        return true;
      }

      if (frameForSample !== this.currentFrame) {
        this.currentFrame = frameForSample;
        for (const ch of this.channelLetters) {
          for (const w of this.tracks[ch][this.currentFrame]) {
            const target = _mmlFindExpansionForAddr(this.expansionMap, w.addr);
            if (target) {
              target.writeRegister(w.addr, w.value);
            } else {
              this.apu.writeRegister(w.addr, w.value);
            }
          }
        }
      }

      this.cycleAccum += _MML_CPU_CLOCK / sampleRate;
      while (this.cycleAccum >= 1) {
        this.apu.clock();
        for (const name in this.expansionMap) this.expansionMap[name].clock();
        this.cycleAccum -= 1;
      }

      let raw = this.apu.mixSample();
      for (const name in this.expansionMap) raw += this.expansionMap[name].mixSample();

      // DCブロック（サンプル単位のIIR、capture.js の dcBlock と等価）
      const y = raw - this.dcPrevX + 0.999 * this.dcPrevY;
      this.dcPrevX = raw;
      this.dcPrevY = y;
      out[i] = y;
      this.samplePos++;
    }

    return true;
  }
}

registerProcessor('mml-processor', MmlProcessor);
