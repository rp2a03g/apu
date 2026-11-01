/*
 * NES 本体を AudioWorklet の中で回す (nes-worklet バンドルの本体。DESIGN-CAPTURE.md §6/§7、段階 6b)
 *
 * 音の時刻を基準にフレームを刻む: process() が 128 サンプルを求めるたびに、その分だけ CPU/PPU/APU を進める
 * (NesConsole.runSamples)。画面が 1 枚できるたびに主スレッドへ frame(Uint32Array の ArrayBuffer、転送)と、
 * 録音中ならそのフレームの書き込み列を送る。主スレッドは描くだけ。
 * 主スレッドからは load(ROM)/pad(入力)/reset/pause/record を受ける。
 *
 * 出力は APU の混合(0〜1.16 程度、片側)を DC ブロッカー(stream-player.js と同じ係数)に通した物。
 * 音量(NSF_GAIN)とリミッタは主スレッド側の GainNode/DynamicsCompressor(src/ui/nesScreen.js)。
 *
 * バンドル: tools/build-capture-workers.ps1 の nesWorklet(cpu6502/apu2a03/n163/nes/*.js + この本文)。
 * data: URL で addModule するので file:// 直開きでも動く(src/ui/nesScreen.js)。
 */
(function (global) {
  'use strict';
  if (typeof AudioWorkletProcessor === 'undefined' || typeof registerProcessor !== 'function') return;
  const MML = global.MML;

  class NesWorkletProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.nes = null;
      this.paused = false;
      this.dcX = 0; this.dcY = 0;
      this.frameSeq = 0;
      this.port.onmessage = (e) => this.onMessage(e.data || {});
    }
    onMessage(m) {
      try {
        switch (m.type) {
          case 'load': {
            const nes = new MML.Emu.NesConsole(new Uint8Array(m.rom));
            nes.setSampleRate(sampleRate);
            nes.onFrame = () => this.onFrame();
            this.nes = nes;
            this.dcX = 0; this.dcY = 0;
            this.port.postMessage({ type: 'loaded', info: MML.Emu.INES.describe(nes.rom), extBits: nes.extBits(), sampleRate });
            break;
          }
          case 'pad': if (this.nes) this.nes.setController(m.port | 0, m.bits | 0); break;
          case 'reset': if (this.nes) this.nes.reset(); break;
          case 'pause': this.paused = !!m.on; break;
          case 'record':
            if (!this.nes) break;
            if (m.on) this.nes.startRecording();
            else { const frames = this.nes.stopRecording(); this.port.postMessage({ type: 'recordEnd', frames }); }
            break;
        }
      } catch (e) {
        this.port.postMessage({ type: 'error', message: String((e && e.stack) || e) });
      }
    }
    onFrame() {
      const nes = this.nes;
      const frame = nes.frame.slice();
      const msg = { type: 'frame', seq: ++this.frameSeq, frame: frame.buffer, underruns: nes.underruns };
      if (nes.rec) { msg.writes = nes.rec.frames.splice(0); }
      this.port.postMessage(msg, [frame.buffer]);
    }
    process(inputs, outputs) {
      const out = outputs[0] && outputs[0][0];
      if (!out) return true;
      if (!this.nes || this.paused) { out.fill(0); return true; }
      try {
        this.nes.runSamples(out);
      } catch (e) {
        this.port.postMessage({ type: 'error', message: String((e && e.stack) || e) });
        this.nes = null; out.fill(0); return true;
      }
      let x1 = this.dcX, y1 = this.dcY;
      for (let i = 0; i < out.length; i++) {
        const x = out[i];
        const y = x - x1 + 0.999 * y1;
        x1 = x; y1 = y;
        out[i] = y;
      }
      this.dcX = x1; this.dcY = y1;
      for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
      return true;
    }
  }
  registerProcessor('nes-console', NesWorkletProcessor);
})(typeof window !== 'undefined' ? window : globalThis);
