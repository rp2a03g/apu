/*
 * Web MIDI アダプタ (MML.Input.MidiInput) — 入力境界
 *
 * 作業計画フェーズ3 段階4。MIDI機器の打鍵を「ノート番号 + ベロシティ + 時刻」まで
 * ほどいて src/ui/performInput.js へ渡すだけの薄い層。ここから先(モノフォニックの
 * 後着優先・TimedPitchEvent化・量子化)は入力源によらず共通の経路
 * (src/input/noteSource.js)が担うので、この層にロジックを増やしてはいけない。
 *
 * DESIGN.md §4 の「navigator.* を触る箇所は薄いアダプタとして分離する」に対応する部分。
 *
 * ■ MIDIバイト列の解釈で必ず要るもの
 *   ★ノートオンでベロシティ0は「ノートオフ」。MIDIの古典的な約束で、ランニング
 *     ステータスを使う機器はノートオフを一切送らずこちらだけで表現する。取りこぼすと
 *     音が鳴りっぱなしになる。
 *   ★0xF8(クロック)や0xFE(アクティブセンシング)は機器によっては毎秒何百回も飛んでくる。
 *     0xF0以上は全部捨てる。
 *   ランニングステータス(ステータスバイト省略)は、Web MIDI仕様が「完結した1メッセージを
 *   渡す」と定めているので展開済みで届く。念のため先頭が0x80未満なら解釈せず捨てる。
 *
 * ■ 時刻
 *   MIDIMessageEvent.timeStamp は performance.now() と同じ時間軸。そのまま使わず
 *   必ず MML.Input.Latency.contextTimeFromEvent() でオーディオ時間軸へ写す
 *   (段階0で測った入力オフセットの補正も、その先で一緒に効く)。
 */
(function (global) {
  'use strict';
  const MML   = global.MML = global.MML || {};
  const Input = MML.Input  = MML.Input  || {};

  let access   = null;    // MIDIAccess
  let enabled  = false;
  let status   = { state: 'off', message: '', deviceCount: 0 };
  let channel  = 0;       // 0 = 全チャンネル、1..16 = そのチャンネルだけ
  const disabledIds = new Set();  // ユーザーが外した入力ポート(セッション内のみ)

  const api = Input.MidiInput = {

    /* ({ type:'on'|'off', note, velocity, event }) */
    onNote: null,
    /* 機器の抜き差し/一覧の変化 */
    onDevicesChanged: null,

    isSupported() { return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function'; },
    isEnabled()   { return enabled; },
    getStatus()   { return Object.assign({}, status); },
    getChannel()  { return channel; },
    setChannel(ch) { channel = Math.max(0, Math.min(16, Math.round(ch) || 0)); },

    /*
     * 今の許可状態を聞く('granted' | 'prompt' | 'denied' | 'unknown' | 'unsupported')。
     * ★この問い合わせ自体はダイアログを出さない。
     *   requestMIDIAccess() は許可が 'prompt' のとき必ずダイアログを出すので、
     *   起動時の自動接続を 'granted' のときだけに絞るために使う
     *   (絞らないと、許可を覚えてくれない場所では開くたびに毎回聞かれる)。
     */
    async permissionState() {
      if (!api.isSupported()) return 'unsupported';
      if (!navigator.permissions || !navigator.permissions.query) return 'unknown';
      // sysex を明示する形と省略形の両方を試す(実装によってどちらかが TypeError になる)
      for (const q of [{ name: 'midi', sysex: false }, { name: 'midi' }]) {
        try {
          const st = await navigator.permissions.query(q);
          if (st && st.state) return st.state;
        } catch (e) { /* 次の形を試す */ }
      }
      return 'unknown';
    },

    /*
     * MIDIAccessを取得して受信を始める。★ユーザー操作から呼ぶこと
     * (許可プロンプトが出る場面なので、ページ読み込み中に勝手に呼ばない)。
     * sysex は要求しない: 音符を受け取るだけなら不要で、要求すると許可の敷居が上がる。
     */
    async enable() {
      if (!api.isSupported()) {
        status = { state: 'unsupported', message: '', deviceCount: 0 };
        return status;
      }
      try {
        access = await navigator.requestMIDIAccess({ sysex: false });
      } catch (e) {
        // NotAllowedError = 許可されなかった / SecurityError = 安全でない文脈
        status = { state: (e && e.name === 'NotAllowedError') ? 'denied' : 'error',
                   message: (e && e.message) || String(e), deviceCount: 0 };
        access = null;
        return status;
      }
      enabled = true;
      access.onstatechange = () => { attachAll(); notifyDevices(); };
      attachAll();
      notifyDevices();
      return status;
    },

    disable() {
      if (access) {
        access.onstatechange = null;
        for (const input of access.inputs.values()) input.onmidimessage = null;
      }
      access = null;
      enabled = false;
      status = { state: 'off', message: '', deviceCount: 0 };
    },

    /* [{ id, name, manufacturer, state, selected }] */
    getInputs() {
      if (!access) return [];
      return [...access.inputs.values()].map(i => ({
        id: i.id,
        name: i.name || '(no name)',
        manufacturer: i.manufacturer || '',
        state: i.state,
        selected: !disabledIds.has(i.id)
      }));
    },

    setInputSelected(id, on) {
      if (on) disabledIds.delete(id); else disabledIds.add(id);
      attachAll();
    },

    /*
     * 実機なしで受信経路を試すための注入口(作業計画の受け入れ条件はこれで満たせる)。
     * data は [status, data1, data2] のバイト列、timeStamp は performance.now() 系。
     */
    injectMessage(data, timeStamp) {
      handleMessage({ data: Uint8Array.from(data), timeStamp: timeStamp });
    }
  };

  function attachAll() {
    if (!access) return;
    let n = 0;
    for (const input of access.inputs.values()) {
      const on = !disabledIds.has(input.id);
      input.onmidimessage = on ? handleMessage : null;
      if (on) n++;
    }
    status = { state: 'ok', message: '', deviceCount: n };
  }

  function notifyDevices() {
    if (api.onDevicesChanged) {
      try { api.onDevicesChanged(api.getInputs()); } catch (e) { console.error(e); }
    }
  }

  function handleMessage(evt) {
    const d = evt && evt.data;
    if (!d || d.length < 1) return;
    const st = d[0];
    // 0x80未満 = ランニングステータスの続き(仕様上ここへは来ない)。0xF0以上 =
    // システム共通/リアルタイム(0xF8クロック・0xFEアクティブセンシング等の連投)
    if (st < 0x80 || st >= 0xF0) return;
    if (channel !== 0 && (st & 0x0F) !== (channel - 1)) return;

    const type = st & 0xF0;
    if (type === 0x90) {
      const note = d[1], vel = (d.length > 2) ? d[2] : 0;
      // ★ベロシティ0のノートオンはノートオフ
      emit(vel > 0 ? 'on' : 'off', note, vel, evt);
    } else if (type === 0x80) {
      emit('off', d[1], 0, evt);
    }
    // ピッチベンド/CC(サステインペダル含む)は当面扱わない。単音入力に必要な情報ではなく、
    // 対応するなら NoteSource 側の意味論(後着優先)ごと設計し直す必要がある
  }

  function emit(type, note, velocity, evt) {
    if (!api.onNote) return;
    try { api.onNote({ type, note, velocity, event: evt }); } catch (e) { console.error(e); }
  }

})(window);
