/*
 * 演奏入力の共通形式 (MML.Input.NoteSource) — コア層
 *
 * PC鍵盤・画面ピアノ・(将来の)Web MIDI・鼻歌 のどれから来た打鍵でも、
 * ここを必ず通してから「今鳴らすべき音」と TimedPitchEvent 列に変換する。
 * 入力源ごとに発音や録音のロジックを書くと必ず食い違うので、規則はこの1箇所だけに置く。
 *
 * ■ 記録はポリフォニック、発音のビューはモノフォニック(段階5-a)
 *   ★和音対応で「後着優先」を壊さないために二層にしてある。
 *     ・押されている音は全部 _held に残る(これが本当の記録)
 *     ・「今鳴らすべき単音」は _held の末尾を指す**ビュー**
 *   既存の経路(TimedPitchEvent列・単音のライブモニタ)はビューだけを見るので、
 *   和音を足しても意味論が1行も変わらない。和音を扱う側は
 *   addNoteListener()(打鍵1つずつ)か onVoicesChange(押している全部)を使う。
 *
 * ■ モノフォニックのビュー(後着優先)
 *   ROADMAPフェーズ3の決定どおり、和音は当面「最後に押した音」を採る。押している音は
 *   スタックで持ち、後から押した音を離すと**前の音へ戻る**(古典的なモノシンセと同じ)。
 *   将来ポリフォニックにするときも、入力源側は何も変えずにここだけ差し替えればよい。
 *
 * ■ 時刻
 *   time は呼び出し側が渡す AudioContext.currentTime 系の秒(src/input/latency.js で
 *   performance時間軸から変換したもの)。★ここでは原点を引かない。録音開始時刻を引くのは
 *   録音側(段階2)の仕事で、NoteSourceは「渡された時間軸そのまま」を流す。
 *
 * ■ 出力(DESIGN.md §3 TimedPitchEvent)
 *   addEventListener(fn) で受ける { timeSec, midiNote, velocity }。midiNote=null は無音区間の開始。
 *   発音すべき音が変わった瞬間にだけ出るので、この列がそのまま量子化の入力になる。
 *
 * DOM非依存・デバイス非依存。単体テストは noteOn/noteOff を直接呼べばよい。
 */
(function (global) {
  'use strict';
  const MML   = global.MML = global.MML || {};
  const Input = MML.Input  = MML.Input  || {};

  const NOTE_MIN = 0;
  const NOTE_MAX = 127;

  class NoteSource {
    constructor(opts = {}) {
      this.onChange = null; // (active|null, prev|null) 発音を切り替えるべき時だけ呼ぶ
      this._listeners = []; // (timedPitchEvent) 単音ビュー。onChange の後で呼ぶ
      this._noteListeners = []; // ({type,note,velocity,timeSec}) 打鍵1つずつ(和音の記録用)
      this.onVoicesChange = null; // (voices[]) 押している音が増減したとき(多声モニタ用)
      this._held    = [];   // 押されている音 [{ note, velocity, time, sourceId }] 古い順
      this._active  = null; // 今鳴らすべき音(= _held の末尾)
      this._defaultVelocity = (opts.velocity != null) ? opts.velocity : 100;
    }

    /*
     * TimedPitchEvent の購読。録音(src/ui/recordPanel.js)が使う。
     * 単一のコールバック代入ではなく配列にしてあるのは、録音中に別の購読者
     * (将来の入力ログ/デバッグ表示)が付いても互いに潰し合わないようにするため。
     */
    addEventListener(fn) { if (typeof fn === 'function' && this._listeners.indexOf(fn) < 0) this._listeners.push(fn); }
    removeEventListener(fn) { const i = this._listeners.indexOf(fn); if (i >= 0) this._listeners.splice(i, 1); }

    /*
     * 打鍵そのものの購読(和音の記録用)。{ type:'on'|'off', note, velocity, timeSec }。
     * 単音ビュー(addEventListener)と違い、裏で押している音の増減も全部流れる。
     */
    addNoteListener(fn) { if (typeof fn === 'function' && this._noteListeners.indexOf(fn) < 0) this._noteListeners.push(fn); }
    removeNoteListener(fn) { const i = this._noteListeners.indexOf(fn); if (i >= 0) this._noteListeners.splice(i, 1); }

    getActive() { return this._active; }
    /* 押されている音のノート番号(古い順)。UIのハイライト用 */
    getHeld()   { return this._held.map(h => h.note); }
    /* 押されている音そのもの(古い順)。多声モニタが声部へ配るのに使う */
    getVoices() { return this._held.slice(); }

    noteOn(note, opts = {}) {
      const n = Math.round(note);
      if (!Number.isFinite(n) || n < NOTE_MIN || n > NOTE_MAX) return;
      const entry = {
        note: n,
        velocity: (opts.velocity != null) ? opts.velocity : this._defaultVelocity,
        time: (opts.time != null) ? opts.time : null,
        sourceId: opts.sourceId || null
      };
      // 既に押されている音を押し直したら、スタックの末尾へ動かして打ち直す
      // (キーリピートはアダプタ側で弾く。ここへ来るのは画面ピアノの連打など本物の打鍵)
      const at = this._held.findIndex(h => h.note === n);
      if (at >= 0) this._held.splice(at, 1);
      this._held.push(entry);
      this._emitNote('on', entry.note, entry.velocity, entry.time);
      this._setActive(entry, true);
    }

    noteOff(note, opts = {}) {
      const n = Math.round(note);
      const at = this._held.findIndex(h => h.note === n);
      if (at < 0) return;
      const wasActive = (this._active && this._active.note === n);
      const offTime = (opts.time != null) ? opts.time : null;
      this._held.splice(at, 1);
      this._emitNote('off', n, 0, offTime);
      // 裏で押していた音を離しただけでも声部は減るので、多声モニタへは必ず知らせる
      this._notifyVoices();
      if (!wasActive) return;  // 裏で押されていた音を離しただけ: 発音は変わらない
      const next = this._held.length ? this._held[this._held.length - 1] : null;
      if (next) {
        // 戻り先の時刻は「今」(離した時刻)。押した時刻のままだと録音で過去に音が生える
        next.time = (opts.time != null) ? opts.time : next.time;
      }
      this._setActive(next, true, (opts.time != null) ? opts.time : null);
    }

    /* 全部離す(フォーカス喪失・モード終了・パニック) */
    allOff(time) {
      if (!this._held.length && !this._active) return;
      const t = (time != null) ? time : null;
      for (const h of this._held) this._emitNote('off', h.note, 0, t);
      this._held.length = 0;
      this._setActive(null, true, (time != null) ? time : null);
    }

    _setActive(entry, notify, timeOverride) {
      const prev = this._active;
      this._active = entry || null;
      if (!notify) return;
      this._notifyVoices();
      if (this.onChange) {
        try { this.onChange(this._active, prev); } catch (e) { console.error(e); }
      }
      if (this._listeners.length) {
        const t = (timeOverride != null) ? timeOverride
          : (this._active && this._active.time != null) ? this._active.time : null;
        const ev = {
          timeSec: t,
          midiNote: this._active ? this._active.note : null,
          velocity: this._active ? this._active.velocity : 0
        };
        // 購読者が途中で外れても走査が崩れないよう複製してから回す
        for (const fn of this._listeners.slice()) {
          try { fn(ev); } catch (e) { console.error(e); }
        }
      }
    }

    _emitNote(type, note, velocity, timeSec) {
      if (!this._noteListeners.length) return;
      const ev = { type, note, velocity, timeSec };
      for (const fn of this._noteListeners.slice()) {
        try { fn(ev); } catch (e) { console.error(e); }
      }
    }

    _notifyVoices() {
      if (!this.onVoicesChange) return;
      try { this.onVoicesChange(this._held.slice()); } catch (e) { console.error(e); }
    }
  }

  Input.NoteSource = NoteSource;

})(window);
