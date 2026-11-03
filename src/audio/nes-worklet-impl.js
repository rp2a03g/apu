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
      this.speed = 1; this.ffTmp = null; this.ffSkip = 0;
      this.dcX = 0; this.dcY = 0;
      this.frameSeq = 0;
      this.port.onmessage = (e) => this.onMessage(e.data || {});
    }
    onMessage(m) {
      try {
        switch (m.type) {
          case 'load': {
            const nes = new MML.Emu.NesConsole(new Uint8Array(m.rom), { bios: m.bios ? new Uint8Array(m.bios) : null });
            nes.setSampleRate(sampleRate);
            nes.onFrame = () => this.onFrame();
            if (m.battery) nes.setBattery(new Uint8Array(m.battery)); // 前回のセーブ(主スレッドが IndexedDB から)
            this.nes = nes;
            this.rewind = MML.Emu.NesRewind ? new MML.Emu.NesRewind(nes) : null;
            this.dcX = 0; this.dcY = 0;
            this.port.postMessage({ type: 'loaded', info: MML.Emu.INES.describe(nes.rom), extBits: nes.extBits(), sampleRate, disks: nes.diskCount, battery: nes.hasBattery });
            break;
          }
          case 'unload': // 止める前の最後のセーブ要求。変化が無くても返事をする(主スレッドが待つ)
            this.postBattery(true);
            break;
          case 'disk': // FDS: side < 0 で取り出し、0 以上でその面を入れる
            if (!this.nes) break;
            if (m.side < 0) this.nes.ejectDisk(); else this.nes.insertDisk(m.side | 0);
            if (this.rewind) this.rewind.clear();
            break;
          case 'pad': if (this.nes) this.nes.setController(m.port | 0, m.bits | 0, m.turbo | 0); break;
          case 'turboRate': if (this.nes) this.nes.setTurboRate(m.frames | 0); break;
          case 'reset': if (this.nes) { this.nes.reset(); if (this.rewind) this.rewind.clear(); } break;
          case 'mix': { // 鍵盤表示のミュート/音量(2A03 は apu.mute/vol、拡張音源はマッパーの audio.mute/vol)。capture.js の applyMute/applyVolume と同じ流儀(バンドルに無いので自前)
            if (!this.nes) break;
            const put = (target, source, conv) => {
              if (!target || !source) return;
              if (Array.isArray(target)) { for (let i = 0; i < target.length; i++) if (source[i] !== undefined) target[i] = conv(source[i]); }
              else for (const k of Object.keys(target)) if (source[k] !== undefined) target[k] = conv(source[k]);
            };
            const a = this.nes.mapper.audio;
            if (m.mute) { put(this.nes.apu.mute, m.mute.apu, (v) => !!v); if (a) put(a.mute, m.mute.ext, (v) => !!v); }
            if (m.volume) { put(this.nes.apu.vol, m.volume.apu, (v) => Math.max(0, Math.min(2, +v || 0))); if (a) put(a.vol, m.volume.ext, (v) => Math.max(0, Math.min(2, +v || 0))); }
            break;
          }
          case 'rewind': { // frame(本体の frameCount)の終わりへ戻る。録音中なら像から取り直す。戻った所の画面と frameCount を返す
            if (!this.nes || !this.rewind) break;
            const wasRec = !!this.nes.rec;
            this.nes.rec = null;
            const got = this.rewind.rewindTo(m.frame | 0);
            if (wasRec) this.nes.startRecording();
            this.frameSeq = got;
            const frame = this.nes.frame.slice();
            this.port.postMessage({ type: 'rewound', frame: frame.buffer, seq: got, oldest: this.rewind.oldest }, [frame.buffer]);
            break;
          }
          case 'pause': this.paused = !!m.on; break;
          case 'speed': this.speed = Math.max(1, Math.min(8, m.n | 0)); break; // 早送り: 1 回の process で speed 回ぶん進める(音は最後の 1 回ぶんだけ出す)
          case 'saveState': // ステート保存: 木を写して主スレッドへ(構造化複製。IndexedDB に置くのは主スレッド)
            if (this.nes) this.port.postMessage({ type: 'state', state: MML.Emu.NesState.save(this.nes), slot: m.slot });
            break;
          case 'loadState':
            if (this.nes) { const ok = MML.Emu.NesState.load(this.nes, m.state); if (ok) { if (this.rewind) this.rewind.clear(); this.frameSeq = this.nes.frameCount; } this.port.postMessage({ type: 'stateLoaded', ok }); }
            break;
          case 'record':
            // 録音は VGM(主スレッドが溜める)とライブ表示(ロールへ流す)の 2 つが使う。
            //   on: 既に録音中なら溜まった分(途中のフレーム込み)を writes として先に送ってから、像を取り直して始める
            //   off: 止めて recordEnd を返す。keep なら(ライブ表示が要るので)すぐ像を取り直して続ける。discard なら返さない
            if (!this.nes) break;
            if (m.on) {
              if (this.nes.rec) this.port.postMessage({ type: 'writes', frames: this.nes.stopRecording() }); // 途中のフレームも末尾に入る
              this.nes.startRecording();
            } else {
              const frames = this.nes.stopRecording();
              if (!m.discard) this.port.postMessage({ type: 'recordEnd', frames });
              if (m.keep) this.nes.startRecording();
            }
            break;
        }
      } catch (e) {
        this.port.postMessage({ type: 'error', message: String((e && e.stack) || e) });
      }
    }
    onFrame() {
      const nes = this.nes;
      if (this.rewind) { if (this.rewind.replaying) return; this.rewind.onFrame(); } // 巻き戻しの再生中は送らない
      this.frameSeq = nes.frameCount; // 主スレッドのフレーム番号 = 本体の frameCount(巻き戻しで戻る)
      if (this.speed > 1 && (++this.ffSkip % this.speed) !== 0) { if ((this.frameSeq % 60) === 0) this.postBattery(false); return; } // 早送り中は speed 枚に 1 枚だけ送る(録音の書き込み列は次に送る時まで溜まる)
      const frame = nes.frame.slice();
      const msg = { type: 'frame', seq: this.frameSeq, frame: frame.buffer, underruns: nes.underruns };
      if (nes.rec) { msg.writes = nes.rec.frames.splice(0); }
      this.port.postMessage(msg, [frame.buffer]);
      if ((this.frameSeq % 60) === 0) this.postBattery(false); // 1 秒ごとに、セーブ RAM が変わっていれば主スレッドへ
    }
    // セーブ RAM(バッテリ/FDS ディスク)を主スレッドへ送る。final=true は unload への返事(変化が無くても data 無しで返す)
    postBattery(final) {
      const nes = this.nes;
      if (!nes || !nes.hasBattery) { if (final) this.port.postMessage({ type: 'battery', final: true, data: null }); return; }
      if (!nes.batteryDirty) { if (final) this.port.postMessage({ type: 'battery', final: true, data: null }); return; }
      const data = nes.getBattery();
      nes.clearBatteryDirty();
      this.port.postMessage({ type: 'battery', final: !!final, data: data.buffer }, [data.buffer]);
    }
    process(inputs, outputs) {
      const out = outputs[0] && outputs[0][0];
      if (!out) return true;
      if (!this.nes || this.paused) { out.fill(0); return true; }
      try {
        if (this.speed > 1) {
          if (!this.ffTmp || this.ffTmp.length !== out.length) this.ffTmp = new Float32Array(out.length);
          for (let k = 1; k < this.speed; k++) this.nes.runSamples(this.ffTmp); // 捨てる分
        }
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
