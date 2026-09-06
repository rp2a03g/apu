/*
 * メトロノーム (MML.Input.Metronome) — コア層
 *
 * ROADMAPフェーズ3(Web MIDI録音)/フェーズ4(鼻歌入力)の土台。演奏を録るには
 * 「拍がオーディオ時間軸(AudioContext.currentTime)上のどこにあるか」が正確に
 * 分かっている必要があるので、まずメトロノーム側でその時間軸を確立する。
 * 入力オフセットの較正(src/input/latency.js)もこのクリック音を基準に測る。
 *
 * ★ setInterval / requestAnimationFrame の中で「今」鳴らしてはいけない:
 *   どちらも数ms〜数十msの粒度でしか起動せず(背面タブでは1秒まで粗くなる)、
 *   そのタイミングで音を出すと必ずヨレる。代わりに
 *     「25msごとに目を覚まし、これから200ms以内に来る拍を
 *       OscillatorNode.start(正確なcontextTime) で先行予約する」
 *   というルックアヘッド方式を使う。実際の発音時刻はオーディオスレッドが
 *   持つので、メインスレッドがどれだけ詰まってもジッタは乗らない。
 *   (Chris Wilson "A Tale of Two Clocks" として知られる定石)
 *
 * DOM非依存。AudioContextは呼び出し側から渡す(DESIGN.md §4 のコア/UI分離)。
 * UI側は src/ui/metronomePanel.js。
 */
(function (global) {
  'use strict';
  const MML   = global.MML   = global.MML   || {};
  const Input = MML.Input    = MML.Input    || {};

  const LOOKAHEAD_MS       = 25;   // スケジューラを起こす間隔
  const SCHEDULE_AHEAD_SEC = 0.2;  // 何秒先までクリックを予約するか(前面タブでの通常値)
  /*
   * ★背面タブ対策: ブラウザは非表示タブの setInterval を1秒程度まで間引く。
   *   予約幅が200msのままだと1回の起動で200msぶんしか埋められず、残りは
   *   「もう過去になった拍」として捨てられる ＝ タブを切り替えた瞬間に
   *   メトロノームが実質無音になる(実測: このアプリを背面にすると起動間隔938〜1001ms)。
   *   そこで直近の起動間隔を実測し、予約幅をその2.5倍まで自動で広げる。
   *   広げると音は途切れないが、テンポ/音量変更の反映はその幅ぶん遅れる。
   */
  const MAX_SCHEDULE_AHEAD_SEC = 2.0;
  const SCHEDULE_AHEAD_FACTOR  = 2.5;
  const TICK_HISTORY_MAX   = 512;  // nearestTick() 用に覚えておく拍の数

  /*
   * クリック音の仕様。矩形波なのはチップチューン用途に合わせたもので、
   * 短い矩形バーストは古典的な「カチ」音になる。
   *   accent  = 小節頭   beat = 拍   sub = 拍内の刻み   countIn = カウントイン中
   */
  const CLICK_SPEC = {
    accent:  { freq: 1800, amp: 1.00, decay: 0.045 },
    beat:    { freq: 1200, amp: 0.62, decay: 0.035 },
    sub:     { freq:  900, amp: 0.30, decay: 0.025 },
    countIn: { freq: 1500, amp: 0.80, decay: 0.040 }
  };

  class Metronome {
    /*
     * opts.destination: 接続先ノード。既定は audioCtx.destination。
     *   ★ MML.Audio.getMasterGain() は通さない。メトロノームは曲の一部ではない
     *     補助音なので、曲の音量を絞っても聞こえ続けてほしいし、将来の録音や
     *     WAV書き出しに混ざってはいけない。
     */
    constructor(audioCtx, opts = {}) {
      this.ctx = audioCtx;
      this.output = audioCtx.createGain();
      this.output.gain.value = (opts.volume != null) ? opts.volume : 0.5;
      this.output.connect(opts.destination || audioCtx.destination);

      this.bpm          = 120;
      this.beatsPerBar  = 4;
      this.subdivision  = 1;   // 1拍を何回刻むか (1=4分, 2=8分, 3=3連8分, 4=16分)

      this.onTick       = null; // (tickInfo) 予約した瞬間に呼ぶ(発音時刻ではない)
      this.onCountInEnd = null; // (contextTime) カウントイン明けの拍0を予約した瞬間

      this._timer        = null;
      this._nextTickTime = 0;
      this._tickIndex    = 0;   // カウントイン明けの最初のクリックが 0(カウントイン中は負)
      this._countInTicks = 0;
      this._countInDone  = true;
      this._downbeatTime = 0;
      this._history      = [];
      this._live         = new Set(); // 発音予約済みノード(stop時に確実に黙らせる)
      this._lastScheduleAt = 0;       // 前回_schedule()を実行したcontextTime
      this._observedGap    = 0;       // 実測した起動間隔(秒)。背面タブで伸びる
    }

    // ---- 設定 ----------------------------------------------------------

    /*
     * 走行中のテンポ変更は、既に予約済み(最大200ms先まで)のクリックには効かない。
     * 実用上は無視できる遅れなので、予約済みぶんを取り消す複雑さは持たない。
     */
    setTempo(bpm)          { if (Number.isFinite(bpm) && bpm > 0) this.bpm = bpm; }
    setBeatsPerBar(n)      { if (Number.isFinite(n) && n >= 1) this.beatsPerBar = Math.round(n); }
    setSubdivision(n)      { if (Number.isFinite(n) && n >= 1) this.subdivision = Math.round(n); }
    setVolume(v) {
      const g = Math.max(0, Math.min(1, v));
      // 即値代入だと走行中に「ブツッ」と鳴るので短い時定数で追従させる
      this.output.gain.setTargetAtTime(g, this.ctx.currentTime, 0.01);
    }

    tickDurSec()   { return 60 / this.bpm / this.subdivision; }
    isRunning()    { return this._timer !== null; }
    /* カウントイン明けの拍0のcontextTime(start()時点で確定する) */
    downbeatTime() { return this._downbeatTime; }

    // ---- 開始 / 停止 ---------------------------------------------------

    /*
     * opts.countInBars: カウントインの小節数(0=なし)
     * opts.at:          開始contextTime(既定は「今」+ 余裕)
     * opts.startIndex:  最初に鳴らす拍の番号(既定0)。曲の途中から再生を始めたときに
     *                   小節頭のアクセントを曲の小節線へ合わせるために使う
     * 戻り値: カウントイン明けの拍0のcontextTime
     */
    start(opts = {}) {
      if (this._timer !== null) this.stop();
      const ctx = this.ctx;
      // ユーザー操作起点で呼ばれる想定。suspendedのままだと無音になる
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();

      const bars = Math.max(0, Math.round(opts.countInBars || 0));
      this._countInTicks = bars * this.beatsPerBar * this.subdivision;
      this._countInDone  = (this._countInTicks === 0);
      const startIndex   = Math.round(opts.startIndex || 0);
      this._tickIndex    = startIndex - this._countInTicks;
      // currentTimeちょうどに置くと最初の1発が予約に間に合わず落ちるので余裕を入れる
      this._nextTickTime = (opts.at != null) ? opts.at : (ctx.currentTime + 0.12);
      this._downbeatTime = this._nextTickTime + this._countInTicks * this.tickDurSec();
      this._history.length = 0;
      this._lastScheduleAt = 0;
      this._observedGap    = 0;

      this._schedule();
      this._timer = setInterval(() => this._schedule(), LOOKAHEAD_MS);
      return this._downbeatTime;
    }

    stop() {
      if (this._timer !== null) { clearInterval(this._timer); this._timer = null; }
      // 予約済みでまだ鳴っていないクリックを黙らせる(stop直後に数発鳴るのを防ぐ)
      for (const n of this._live) { try { n.osc.stop(); } catch (e) { /* ignore */ } }
      this._live.clear();
      this._history.length = 0;
      this._countInDone = true;
    }

    dispose() {
      this.stop();
      try { this.output.disconnect(); } catch (e) { /* ignore */ }
    }

    // ---- 較正・量子化から使う問い合わせ ---------------------------------

    /*
     * contextTime に最も近い拍を返す(無ければ null)。
     * 予約済み(=まだ鳴っていない)拍も履歴に入れてあるので、
     * 「次の拍を先取りして叩いた」場合も正しく最寄りの拍が引ける。
     * opts.countIn === false でカウントイン中の拍を除外する。
     */
    nearestTick(contextTime, opts = {}) {
      let best = null, bestAbs = Infinity;
      for (const t of this._history) {
        if (opts.countIn === false && t.countIn) continue;
        const a = Math.abs(contextTime - t.time);
        if (a < bestAbs) { bestAbs = a; best = t; }
      }
      if (!best) return null;
      return { index: best.index, time: best.time, kind: best.kind,
               countIn: best.countIn, barBeat: best.barBeat,
               delta: contextTime - best.time };
    }

    // ---- 内部 ----------------------------------------------------------

    _ticksPerBar() { return this.beatsPerBar * this.subdivision; }

    /* 小節内での位置。idxが負(カウントイン中)でも正しく回るよう剰余を正規化する */
    _posInBar(idx) {
      const per = this._ticksPerBar();
      return ((idx % per) + per) % per;
    }

    _kindFor(idx) {
      const m = this._posInBar(idx);
      if (m === 0) return 'accent';
      return (m % this.subdivision === 0) ? 'beat' : 'sub';
    }

    _schedule() {
      const ctx = this.ctx;
      const now = ctx.currentTime;

      // 起動間隔の実測。伸びたら即座に追従し、縮んだらゆっくり戻す(タブを前面に
      // 戻した直後に予約幅がいきなり縮んで穴が空くのを防ぐ)
      if (this._lastScheduleAt > 0) {
        this._observedGap = Math.max(now - this._lastScheduleAt, this._observedGap * 0.9);
      }
      this._lastScheduleAt = now;
      const horizon = now + Math.min(MAX_SCHEDULE_AHEAD_SEC,
        Math.max(SCHEDULE_AHEAD_SEC, this._observedGap * SCHEDULE_AHEAD_FACTOR));
      // 想定外にnextTickTimeが遅れた場合でも1回のループで無限に積まないための保険
      let guard = 512;

      while (this._nextTickTime < horizon && guard-- > 0) {
        const idx = this._tickIndex;

        if (this._nextTickTime < now + 0.005) {
          // 既に過去になった拍は鳴らさずに番号と時刻だけ進める。
          // 背面タブでsetIntervalが1秒に間引かれると数十拍ぶん遅れて復帰するので、
          // これが無いと復帰の瞬間に溜まったクリックが一斉に鳴る
          this._nextTickTime += this.tickDurSec();
          this._tickIndex++;
          continue;
        }

        const countIn = idx < 0;
        const kind    = this._kindFor(idx);
        // カウントイン中は小節頭だけaccent、他は専用の音にして本編と区別する
        this._click(this._nextTickTime, (countIn && kind !== 'accent') ? 'countIn' : kind);

        const info = {
          index: idx, time: this._nextTickTime, kind, countIn,
          barBeat: Math.floor(this._posInBar(idx) / this.subdivision) + 1,
          // カウントイン中の「あと何拍」(UI表示用)。本編では0
          countInLeft: countIn ? Math.ceil(-idx / this.subdivision) : 0
        };
        this._history.push(info);
        if (this._history.length > TICK_HISTORY_MAX) {
          this._history.splice(0, this._history.length - TICK_HISTORY_MAX);
        }
        if (this.onTick) { try { this.onTick(info); } catch (e) { console.error(e); } }

        if (idx === 0 && !this._countInDone) {
          this._countInDone = true;
          if (this.onCountInEnd) {
            try { this.onCountInEnd(this._nextTickTime); } catch (e) { console.error(e); }
          }
        }

        this._nextTickTime += this.tickDurSec();
        this._tickIndex++;
      }
    }

    _click(time, specKey) {
      const spec = CLICK_SPEC[specKey] || CLICK_SPEC.beat;
      const ctx  = this.ctx;
      const osc  = ctx.createOscillator();
      const g    = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(spec.freq, time);
      // 立ち上がりは1msかける(0秒で立てると別のクリックノイズが乗る)。
      // exponentialRampは0を扱えないので下限は0.0001
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(spec.amp, time + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0001, time + spec.decay);
      osc.connect(g);
      g.connect(this.output);
      osc.start(time);
      osc.stop(time + spec.decay + 0.005);

      const entry = { osc, g };
      this._live.add(entry);
      osc.onended = () => {
        this._live.delete(entry);
        try { osc.disconnect(); g.disconnect(); } catch (e) { /* ignore */ }
      };
    }
  }

  Input.Metronome = Metronome;
  Input.METRONOME_CLICK_SPEC = CLICK_SPEC;

})(window);
