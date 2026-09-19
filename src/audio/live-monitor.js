/*
 * 演奏入力のライブ発音 (MML.Audio.LiveMonitor) — 境界層
 *
 * PC鍵盤/画面ピアノ/MIDIで弾いた音を、その場でNSF系チップの音として鳴らす。
 * 段階1のモニタ用。段階2の録音では「録れる音」と「聴こえている音」が同じで
 * あることが重要なので、専用の合成は作らない。
 *
 * ■ レジスタ書き込みは AssignPreview を丸ごと再利用する
 *   src/audio/assign-preview.js が既に「借用先を1つ選び、毎フレーム音程と音量を
 *   その音源のレジスタへ書く」処理を全ファミリぶん持っている(2A03/VRC6/VRC7/FDS/
 *   N163/FME-7/MMC5)。**割当表を声部の数だけ渡せばそのまま多声シンセになる**
 *   (AssignPreviewは元々複数行を同時に鳴らすためのもの。段階5-aの和音対応は
 *   この性質にただ乗りしている)。
 *   別実装を書くと「モニタで聴いた音」と「変換・NSF書き出しの音」がずれるので、
 *   ここでは絶対に自前でレジスタを叩かない。
 *
 * ■ バッファ長は 512 サンプル(約11.6ms)
 *   ★ src/audio/stream-player.js の BUFFER_SIZE=4096(約93ms)をそのまま使うと、
 *     鍵を押してから音が出るまで100ms近く遅れて「弾ける」代物にならない。
 *     曲の再生と違い、演奏モニタは遅延がすべてなので短くする。代わりにメインスレッドが
 *     詰まると途切れやすいが、モニタ音が一瞬途切れるのは実害が小さい。
 *
 * ■ 打ち直し(リトリガー)は声部ごと
 *   レガートで音程だけ変えるとパルスchは位相リセットもエンベロープ再スタートもしない。
 *   鍵盤楽器としては打ち直してほしいので、音が変わる声部だけ「無音のフレームを1回
 *   流し込んでから新しい音を流す」= AssignPreview から見て キーオフ→キーオン に見せる。
 *   ★サンプルを1つも進めない間に2回 onFrame() を呼ぶので、無音は聞こえない。
 *   ★消音扱いにするのは**打ち直す声部だけ**。全声部を消すと、変わっていない音まで
 *     打ち直されて和音がガサつく。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Audio = MML.Audio || {};

  const BUFFER_SIZE   = 512;      // ~11.6ms @44100Hz
  const FRAME_RATE    = 60.0988;  // NTSC。AssignPreviewの想定フレームレート
  const NSF_GAIN      = 1.56;     // MmlStreamPlayer/NsfReplayStreamPlayer と同じ実測RMS校正値

  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  function createLimiter(audioCtx) {
    // stream-player.js createLimiter と同じ設定(音量感を揃えるため値も合わせる)
    const limiter = audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -3.0;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.05;
    return limiter;
  }

  /*
   * 押している音を声部へ配る。★規則の本体は src/input/quantize.js の
   * selectChordVoices(録音側の声部割当と同じ規則を使うため。2箇所に分けると
   * 「モニタで聴いた配り方」と「書き出される配り方」が食い違う)。
   * ★高い音から順に、割当表の先頭の声部へ入れる。2A03で pulse1/pulse2/triangle を
   *   使う場合、メロディがpulse1・ベースが三角波になり実際のファミコン曲の書き方と一致する。
   * ★声部が足りないときは「最高音と最低音を残す」。メロディとベースが生きていれば
   *   和音の内声が欠けても音楽として成立する(内声から捨てる)。
   */
  function selectVoices(notes, count) {
    return MML.Input.selectChordVoices(notes, count, (v) => v.note);
  }

  class LiveMonitor {
    constructor(audioCtx) {
      this.audioCtx = audioCtx;
      this.node     = null;
      this.gainNode = null;
      this.limiter  = null;
      this._ap      = null;   // AssignPreview
      this._targets = [{ target: 'pulse1', tone: '2' }];
      this._cur     = [];     // 声部ごとの { freq, vol } | null
      this._retrig  = [];     // このフレームだけ消音扱いにする声部
      this._frame   = 0;
      this._samplesIntoFrame = 0;
      this._samplesPerFrame  = audioCtx.sampleRate / FRAME_RATE;
      this.running  = false;
    }

    // ---- 設定 ----------------------------------------------------------

    /* 声部ごとの借用先。[{ target, tone }] を先頭=最高音の順で渡す */
    setTargets(targets) {
      const list = (targets && targets.length) ? targets.slice() : [{ target: 'pulse1', tone: '2' }];
      const sig = list.map(t => t.target + '/' + t.tone).join(',');
      if (sig === this._targetSig) return;
      this._targetSig = sig;
      this._targets = list;
      this._cur = new Array(list.length).fill(null);
      this._retrig = new Array(list.length).fill(false);
      if (this._ap) this._applyPlan();
    }

    /* 1声だけの従来API(PC鍵盤の単音モニタ等) */
    setTarget(target, tone) { this.setTargets([{ target, tone }]); }

    voiceCount() { return this._targets.length; }

    setVolume(v) {
      if (!this.gainNode) return;
      const g = Math.max(0, Math.min(1, v)) * NSF_GAIN;
      this.gainNode.gain.setTargetAtTime(g, this.audioCtx.currentTime, 0.01);
    }

    // ---- 発音 ----------------------------------------------------------

    /*
     * 押している音の一覧をそのまま渡す。[{ note, velocity }]。
     * 声部への配り方は selectVoices() 参照。空配列で全消音。
     */
    setVoices(notes) {
      const picked = selectVoices(notes || [], this._targets.length);
      for (let i = 0; i < this._targets.length; i++) {
        const v = picked[i] || null;
        const prev = this._cur[i];
        if (!v) { this._cur[i] = null; this._retrig[i] = false; continue; }
        const next = {
          note: v.note,
          freq: midiToFreq(v.note),
          vol: Math.max(0, Math.min(1, (v.velocity != null ? v.velocity : 100) / 127))
        };
        // その声部で鳴っていた音と違うなら打ち直す(同じ音の押し直しも打ち直す)
        this._retrig[i] = !!prev;
        if (prev && prev.note === next.note && prev.vol === next.vol) this._retrig[i] = false;
        this._cur[i] = next;
      }
      // ★フレーム境界を待たずに今すぐ反映する(待つと最大16.7msの遅れが乗る)
      this._apply();
    }

    /* 単音の従来API */
    setNote(note, velocity) {
      this.setVoices(note == null ? [] : [{ note, velocity }]);
    }

    allOff() { this.setVoices([]); }

    // ---- 開始 / 停止 ---------------------------------------------------

    start() {
      if (this.running) return;
      const ctx = this.audioCtx;
      const AP = MML.Audio && MML.Audio.AssignPreview;
      if (!AP) { console.error('[LiveMonitor] AssignPreview が読み込まれていません'); return; }
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();

      this._ap = new AP(ctx.sampleRate);
      this._ap.setProvider(() => this._provide());
      this._applyPlan();

      this.gainNode = ctx.createGain();
      this.gainNode.gain.value = NSF_GAIN;
      this.limiter = createLimiter(ctx);
      this.gainNode.connect(this.limiter);
      this.limiter.connect(MML.Audio.getMasterGain(ctx));

      this.node = ctx.createScriptProcessor(BUFFER_SIZE, 0, 1);
      this.node.onaudioprocess = (e) => this._fill(e.outputBuffer.getChannelData(0));
      this.node.connect(this.gainNode);
      this.running = true;
    }

    stop() {
      if (!this.running) return;
      this.running = false;
      this._cur = new Array(this._targets.length).fill(null);
      if (this.node) {
        this.node.onaudioprocess = null;
        try { this.node.disconnect(); } catch (e) { /* ignore */ }
        this.node = null;
      }
      if (this.gainNode) { try { this.gainNode.disconnect(); } catch (e) { /* ignore */ } this.gainNode = null; }
      if (this.limiter)  { try { this.limiter.disconnect();  } catch (e) { /* ignore */ } this.limiter = null; }
      this._ap = null;
    }

    dispose() { this.stop(); }

    // ---- 内部 ----------------------------------------------------------

    _applyPlan() {
      // kind:'any' = 借用先を絞らない。muted:false 固定(消音は setVoices([]) 側で行う)
      this._ap.setPlan(this._targets.map((t, i) => ({
        id: 'LIVE' + i, target: t.target, tone: t.tone, kind: 'any', muted: false
      })));
      this._apply();
    }

    /* AssignPreview が毎フレーム引くチャンネル状態(鍵盤表示 extractChannels と同じ形) */
    _provide() {
      return this._targets.map((t, i) => {
        const v = this._cur[i];
        if (this._retrig[i] || !v) return { id: 'LIVE' + i, freq: 0, vol: 0, active: false };
        return { id: 'LIVE' + i, freq: v.freq, vol: v.vol, active: true };
      });
    }

    _apply() {
      if (!this._ap) return;
      if (this._retrig.some(Boolean)) {
        // サンプルを進めずに「消音→発音」を続けて流すので、無音は聞こえないまま
        // キーオン(位相リセット/エンベロープ再スタート)だけが起きる。
        // 消音扱いにするのは打ち直す声部だけ(他の声部は鳴りっぱなしのまま)
        this._ap.onFrame(this._frame);
        this._retrig.fill(false);
      }
      this._ap.onFrame(this._frame);
    }

    _fill(out) {
      const ap = this._ap;
      if (!ap) { out.fill(0); return; }
      for (let i = 0; i < out.length; i++) {
        if (++this._samplesIntoFrame >= this._samplesPerFrame) {
          this._samplesIntoFrame -= this._samplesPerFrame;
          this._frame++;
          ap.onFrame(this._frame);
        }
        out[i] = ap.render();
      }
    }
  }

  MML.Audio.LiveMonitor = LiveMonitor;
  MML.Audio.selectMonitorVoices = selectVoices;   // 検証用に公開

})(window);
