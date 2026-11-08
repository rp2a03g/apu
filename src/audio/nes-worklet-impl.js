/*
 * NES / MSX 本体を AudioWorklet の中で回す (nes-worklet バンドルの本体。DESIGN-CAPTURE.md §6/§7 段階 6b、DESIGN-MSX-CAPTURE.md §6 段階 7a)
 *
 * 本体クラスは load メッセージの machine('nes' | 'msx')で選ぶ(NesConsole / MsxConsole。外形は同じ)。State/Rewind も機種で選ぶ。
 * 以下「NES」「nes」とあるのは本体一般のこと(変数名は NES 時代のまま)。MSX だけの物: load の msx オプション(機種/BIOS/マッパー)、
 * key/keyReleaseAll(PC のキー → MSX キーボード)、rwframe の palette(逆再生の 8bit 画面の色)、loaded の chips。
 *
 * 音の時刻を基準にフレームを刻む: process() が 128 サンプルを求めるたびに、その分だけ CPU/PPU/APU を進める
 * (NesConsole.runSamples)。画面が 1 枚できるたびに主スレッドへ frame(Uint32Array の ArrayBuffer、転送)と、
 * 録音中ならそのフレームの書き込み列を送る。主スレッドは描くだけ。
 * 主スレッドからは load(ROM)/pad(入力)/reset/pause/record/rewind(飛ぶ)/rewindStart・rewindSpeed・rewindEnd(逆再生)を受ける。
 * 逆再生(押している間の巻き戻し)の間は本体を止め、無音を出しながら NesRewind の映像の輪から古い画面を rwframe
 * (8bit パレット番号)で送る。離したら rewindEnd でそのフレームへ本当に戻り、rewound を返す。
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
      this.rw = null; // 逆再生中 { speed, acc }
      this.machine = 'nes'; this.State = null; // load で機種に合わせる
      this.port.onmessage = (e) => this.onMessage(e.data || {});
    }
    onMessage(m) {
      try {
        switch (m.type) {
          case 'load': {
            const machine = m.machine === 'msx' ? 'msx' : 'nes';
            let nes, info;
            if (machine === 'msx') {
              // MSX: ROM(null なら BIOS だけで起動)+ 機種/BIOS(main 32K・sub/logo 16K、ArrayBuffer で届く)/マッパー種別
              const o = m.msx || {};
              const bios = {};
              if (o.bios) { for (const k of ['main', 'sub', 'logo', 'kanji', 'disk']) if (o.bios[k]) bios[k] = new Uint8Array(o.bios[k]); if (o.bios.name) bios.name = o.bios.name; }
              const cartB = o.cartB && o.cartB.kind ? { kind: o.cartB.kind, rom: o.cartB.rom ? new Uint8Array(o.cartB.rom) : null } : null; // 音源カートリッジ(FM-PAC/MSX-AUDIO/SCC-I)
              const disks = (o.disks || []).map((b) => new Uint8Array(b)); // .dsk 画像(7d)
              nes = new MML.Emu.MsxConsole(m.rom ? new Uint8Array(m.rom) : null, { machine: o.machine, bios: bios.main ? bios : null, mapperType: o.mapperType || undefined, cartB, disks, fdc: o.fdc || undefined });
              info = MML.Emu.MsxConsole.describe(nes);
            } else {
              nes = new MML.Emu.NesConsole(new Uint8Array(m.rom), { bios: m.bios ? new Uint8Array(m.bios) : null });
              info = MML.Emu.INES.describe(nes.rom);
            }
            nes.setSampleRate(sampleRate);
            nes.onFrame = () => this.onFrame();
            if (m.battery && nes.hasBattery) nes.setBattery(new Uint8Array(m.battery)); // 前回のセーブ(主スレッドが IndexedDB から)
            this.nes = nes;
            this.machine = machine;
            this.State = machine === 'msx' ? MML.Emu.MsxState : MML.Emu.NesState;
            const Rewind = machine === 'msx' ? MML.Emu.MsxRewind : MML.Emu.NesRewind;
            this.rewind = Rewind ? new Rewind(nes) : null;
            this.dcX = 0; this.dcY = 0;
            this.port.postMessage({ type: 'loaded', machine, info, chips: typeof nes.chips === 'function' ? nes.chips() : null, fps: nes.frameRate || 0, extBits: nes.extBits(), sampleRate, disks: nes.diskCount, battery: nes.hasBattery, w: this.frameW(), h: this.frameH() });
            break;
          }
          case 'key': // MSX: PC のキー(KeyboardEvent.code)を押す/離す。対応の無いキーは本体が無視する
            if (this.nes && typeof this.nes.setKey === 'function') this.nes.setKey(String(m.code || ''), !!m.down);
            break;
          case 'keyReleaseAll':
            if (this.nes && this.nes.keyboard && this.nes.keyboard.releaseAll) this.nes.keyboard.releaseAll();
            break;
          case 'unload': // 止める前の最後のセーブ要求。変化が無くても返事をする(主スレッドが待つ)
            this.postBattery(true);
            break;
          case 'disk': // FDS: side < 0 で取り出し、0 以上でその面を入れる
            if (!this.nes || typeof this.nes.insertDisk !== 'function') break;
            if (m.side < 0) this.nes.ejectDisk(); else this.nes.insertDisk(m.side | 0);
            if (this.rewind) this.rewind.clear();
            break;
          case 'diskAdd': { // MSX: .dsk を足してドライブ A に入れる(入れ替え。主スレッドが取り出し→少し待って送る)
            if (!this.nes || typeof this.nes.addDisk !== 'function') break;
            const n = this.nes.addDisk(new Uint8Array(m.image)); if (n >= 0) this.nes.insertDisk(n);
            if (this.rewind) this.rewind.clear();
            this.port.postMessage({ type: 'diskAdded', count: this.nes.diskCount, index: n });
            break;
          }
          case 'pad': if (this.nes) this.nes.setController(m.port | 0, m.bits | 0, m.turbo | 0); break;
          case 'turboRate': if (this.nes) this.nes.setTurboRate(m.frames | 0); break;
          case 'reset': if (this.nes) { this.nes.reset(); if (this.rewind) this.rewind.clear(); } break;
          case 'mix': { // 鍵盤表示のミュート/音量(2A03 は apu.mute/vol、拡張音源はマッパーの audio.mute/vol)。capture.js の applyMute/applyVolume と同じ流儀(バンドルに無いので自前)
            if (!this.nes) break;
            if (typeof this.nes.applyMix === 'function') { this.nes.applyMix(m.mute || null, m.volume || null); break; } // MSX: 本体が { psg: [...], scc: [...] } を受ける
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
          case 'rewindStart': // 逆再生を始める(押している間)。speed は 1 秒に何秒ぶん戻るか
            if (!this.nes || !this.rewind || this.rw) break;
            if (this.rewind.beginReverse()) this.rw = { speed: Math.max(1, Math.min(8, m.speed | 0) || 1), acc: 0, pending: null, pendingSeq: 0, lastPost: 0 };
            break;
          case 'rewindSpeed': if (this.rw) this.rw.speed = Math.max(1, Math.min(8, m.speed | 0) || 1); break;
          case 'rewindEnd': { // 離した: 表示していたフレームへ本当に戻る
            if (!this.nes || !this.rewind || !this.rw) break;
            this.rw = null;
            const got = this.rewind.endReverse();
            this.frameSeq = got;
            const frame = this.nes.frame.slice(0, this.frameW() * this.frameH());
            this.port.postMessage({ type: 'rewound', frame: frame.buffer, seq: got, oldest: this.rewind.oldest, w: this.frameW(), h: this.frameH() }, [frame.buffer]);
            break;
          }
          case 'rewind': { // frame(本体の frameCount)の終わりへ戻る。録音中なら像から取り直す。戻った所の画面と frameCount を返す
            if (!this.nes || !this.rewind || this.rw) break;
            const wasRec = !!this.nes.rec;
            this.nes.rec = null;
            const got = this.rewind.rewindTo(m.frame | 0);
            if (wasRec) this.nes.startRecording();
            this.frameSeq = got;
            const frame = this.nes.frame.slice(0, this.frameW() * this.frameH());
            this.port.postMessage({ type: 'rewound', frame: frame.buffer, seq: got, oldest: this.rewind.oldest, w: this.frameW(), h: this.frameH() }, [frame.buffer]);
            break;
          }
          case 'pause': this.paused = !!m.on; break;
          case 'speed': this.speed = Math.max(1, Math.min(8, m.n | 0)); break; // 早送り: 1 回の process で speed 回ぶん進める(音は最後の 1 回ぶんだけ出す)
          case 'saveState': // ステート保存: 木を写して主スレッドへ(構造化複製。IndexedDB に置くのは主スレッド)
            if (this.nes) this.port.postMessage({ type: 'state', state: this.State.save(this.nes), slot: m.slot });
            break;
          case 'loadState':
            if (this.nes) { const ok = this.State.load(this.nes, m.state); if (ok) { if (this.rewind) this.rewind.clear(); this.frameSeq = this.nes.frameCount; } this.port.postMessage({ type: 'stateLoaded', ok }); }
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
    frameW() { return (this.nes && this.nes.frameWidth) || 256; }
    frameH() { return (this.nes && this.nes.frameHeight) || 240; }
    onFrame() {
      const nes = this.nes;
      if (this.rewind) { if (this.rewind.replaying) return; this.rewind.onFrame(); } // 巻き戻しの再生中は送らない
      this.frameSeq = nes.frameCount; // 主スレッドのフレーム番号 = 本体の frameCount(巻き戻しで戻る)
      if (this.speed > 1 && (++this.ffSkip % this.speed) !== 0) { if ((this.frameSeq % 60) === 0) this.postBattery(false); return; } // 早送り中は speed 枚に 1 枚だけ送る(録音の書き込み列は次に送る時まで溜まる)
      const frame = nes.frame.slice(0, this.frameW() * this.frameH()); // MSX は幅がモードで変わる(frame は最大幅で確保。幅ぶんだけ送る)
      const msg = { type: 'frame', seq: this.frameSeq, frame: frame.buffer, underruns: nes.underruns, w: this.frameW(), h: this.frameH() };
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
    // 逆再生の 1 回(process ごと): 再生成を 1 フレーム進め、速さに応じて戻し、画面は 60 枚/秒まで(それ以上送ると主スレッドが詰まる)
    reverseTick() {
      const rw = this.rw, rewind = this.rewind;
      rewind.regenStep(1);
      rw.acc += rw.speed * 128 / (sampleRate / (this.nes.frameRate || 60.0988));
      for (let n = 0; rw.acc >= 1 && n < 8; n++) {
        const r = rewind.reverseStep();
        if (r === null) { rw.acc = Math.min(rw.acc, 1); break; } // まだ作っていない: 待つ(溜めない)
        if (r === false) { rw.acc = 0; break; }                   // これ以上戻れない
        rw.acc -= 1; rw.pending = r; rw.pendingSeq = rewind.rv.cur;
      }
      if (rw.pending && currentTime - rw.lastPost >= 1 / 61) {
        rw.lastPost = currentTime;
        const idx = rw.pending.slice(); rw.pending = null;
        const msg = { type: 'rwframe', seq: rw.pendingSeq, idx: idx.buffer, oldest: rewind.oldest, w: rewind.idxWidth || this.frameW(), h: this.frameH() };
        const tr = [idx.buffer];
        if (this.machine === 'msx' && rewind.palette) { const pal = (rewind.paletteOf ? rewind.paletteOf(rw.pendingSeq) : rewind.palette).slice(); msg.palette = pal.buffer; tr.push(pal.buffer); } // 8bit 画面の色(そのフレームの色表: パレット 16 色か GRAPHIC7 の 256 色)
        this.port.postMessage(msg, tr);
      }
    }
    process(inputs, outputs) {
      const out = outputs[0] && outputs[0][0];
      if (!out) return true;
      if (this.nes && this.rw) {
        out.fill(0); for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
        try { this.reverseTick(); } catch (e) { this.port.postMessage({ type: 'error', message: String((e && e.stack) || e) }); this.rw = null; }
        return true;
      }
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
