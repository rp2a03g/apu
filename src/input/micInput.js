/*
 * マイク入力の薄いアダプタ (MML.Input.MicInput) — 境界層(navigator.* を触るのはここだけ)
 *
 * 聴音(src/ui/dictationPanel.js)が PCM を受け取るための入口。検出は一切しない。
 *
 * ■ 取り方(2026-10-12 の実測で決めたこと)
 *   - getUserMedia は echoCancellation / noiseSuppression / autoGainControl を全部 false にする。
 *     ノイズ抑制は定常的な鼻音を「雑音」と見て削り、AGC は同音連打の谷を埋める。
 *     Edge(Chromium)の file:// ページで指定が反映されることを確認済み(getSettings())。
 *   - PCM は AudioWorklet で 128 サンプルずつ受けて 2048 サンプルにまとめ、メインへ転送する。
 *     ★モジュールは data: URL で読む。file:// では Blob URL と相対パスが落ちる(2026-09-13 実測)。
 *       data: URL は btoa() を通すので本文は ASCII 限定(日本語コメントを書かない)。
 *   - Worklet が使えなければ ScriptProcessorNode(既存のストリームプレイヤーと同じ)。
 *   - ★起動時に getUserMedia を呼んではいけない(MIDI と同じ。file:// は許可を覚えないので毎回出る)。
 *     ユーザーが「マイクを開く」を押したときだけ呼ぶ。
 *
 * ■ 時刻
 *   onBlock(block, startTimeSec) の startTimeSec は AudioContext.currentTime 系。Worklet は
 *   currentFrame/sampleRate から正確に出る。ScriptProcessor は e.playbackTime を使う
 *   (入力バッファの時刻とは1バッファぶんずれるが、量子化前の入力オフセット較正に吸収される)。
 */
(function (global) {
  'use strict';
  const MML   = global.MML = global.MML || {};
  const Input = MML.Input  = MML.Input  || {};

  const CHUNK = 2048;

  // AudioWorkletProcessor 本文(ASCII のみ)
  const WORKLET_SRC = [
    'class MicTap extends AudioWorkletProcessor {',
    '  constructor() { super(); this.buf = new Float32Array(' + CHUNK + '); this.n = 0; this.start = currentFrame; }',
    '  process(inputs) {',
    '    const ch = inputs[0] && inputs[0][0]; if (!ch) return true;',
    '    if (this.n === 0) this.start = currentFrame - ch.length;',
    '    this.buf.set(ch, this.n); this.n += ch.length;',
    '    if (this.n >= ' + CHUNK + ') {',
    '      this.port.postMessage({ buf: this.buf.buffer, frame: this.start }, [this.buf.buffer]);',
    '      this.buf = new Float32Array(' + CHUNK + '); this.n = 0;',
    '    }',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("mml-mic-tap", MicTap);'
  ].join('\n');

  let stream = null, srcNode = null, tapNode = null, ctxRef = null, workletReady = null;

  function isSupported() {
    return !!(global.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /* 'granted' | 'prompt' | 'denied' | 'unknown' */
  async function permissionState() {
    try {
      if (!global.navigator || !navigator.permissions) return 'unknown';
      const p = await navigator.permissions.query({ name: 'microphone' });
      return p.state || 'unknown';
    } catch (e) { return 'unknown'; }
  }

  /* 入力デバイスの一覧。許可前はラベルが空のことがある */
  async function listDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter(d => d.kind === 'audioinput').map(d => ({ id: d.deviceId, label: d.label || '' }));
    } catch (e) { return []; }
  }

  async function ensureWorklet(ctx) {
    if (!ctx.audioWorklet) return false;
    if (workletReady && workletReady.ctx === ctx) return workletReady.ok;
    let ok = false;
    try {
      await ctx.audioWorklet.addModule('data:application/javascript;base64,' + btoa(WORKLET_SRC));
      ok = true;
    } catch (e) { console.warn('[mic] AudioWorklet unavailable, falling back to ScriptProcessor:', e && e.message); }
    workletReady = { ctx, ok };
    return ok;
  }

  /*
   * opts: { deviceId, onBlock(Float32Array, startTimeSec), onLevel? }
   * 戻り値 { sampleRate, method:'worklet'|'scriptprocessor', label }
   */
  async function open(ctx, opts) {
    if (!isSupported()) throw new Error('getUserMedia unavailable');
    close();
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
    if (opts && opts.deviceId) audio.deviceId = { exact: opts.deviceId };
    stream = await navigator.mediaDevices.getUserMedia({ audio });
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) { /* ignore */ } }
    ctxRef = ctx;
    srcNode = ctx.createMediaStreamSource(stream);
    const onBlock = (opts && opts.onBlock) || (() => {});
    const track = stream.getAudioTracks()[0];
    let method;
    if (await ensureWorklet(ctx)) {
      tapNode = new AudioWorkletNode(ctx, 'mml-mic-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
      tapNode.port.onmessage = (e) => {
        const d = e.data; if (!d || !d.buf) return;
        onBlock(new Float32Array(d.buf), d.frame / ctx.sampleRate);
      };
      srcNode.connect(tapNode);
      method = 'worklet';
    } else {
      tapNode = ctx.createScriptProcessor(CHUNK, 1, 1);
      tapNode.onaudioprocess = (e) => {
        const inp = e.inputBuffer.getChannelData(0);
        onBlock(new Float32Array(inp), e.playbackTime - inp.length / ctx.sampleRate);
      };
      srcNode.connect(tapNode);
      // ScriptProcessor は出力に繋がないと止まる環境がある(無音を出す)
      const sink = ctx.createGain(); sink.gain.value = 0;
      tapNode.connect(sink); sink.connect(ctx.destination);
      tapNode._sink = sink;
      method = 'scriptprocessor';
    }
    return { sampleRate: ctx.sampleRate, method, label: track ? track.label : '' };
  }

  function close() {
    if (tapNode) {
      try { tapNode.disconnect(); } catch (e) { /* ignore */ }
      if (tapNode.port) tapNode.port.onmessage = null;
      if (tapNode.onaudioprocess) tapNode.onaudioprocess = null;
      if (tapNode._sink) { try { tapNode._sink.disconnect(); } catch (e) { /* ignore */ } }
      tapNode = null;
    }
    if (srcNode) { try { srcNode.disconnect(); } catch (e) { /* ignore */ } srcNode = null; }
    if (stream) { for (const t of stream.getTracks()) { try { t.stop(); } catch (e) { /* ignore */ } } stream = null; }
    ctxRef = null;
  }

  function isOpen() { return !!stream; }

  Input.MicInput = { isSupported, permissionState, listDevices, open, close, isOpen, CHUNK };

})(window);
