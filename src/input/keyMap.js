/*
 * PC鍵盤 → 音程の対応表 (MML.Input.KeyMap) — コア層
 *
 * トラッカー/DAWで定着している2段配列。下段(Z列)が基準オクターブ、上段(Q列)がその1つ上。
 *   下段: Z S X D C V G B H N J M , L . ; /   → C C# D D# E F F# G G# A A# B C C# D D# E
 *   上段: Q 2 W 3 E R 5 T 6 Y 7 U I 9 O 0 P [ = ]
 *
 * ★キーの識別には event.key ではなく **event.code(物理キー位置)** を使う。
 *   event.key は配列(JIS/US/AZERTY)や IME の状態で変わるため、JIS配列のPCでは
 *   記号キーがまるごとずれる。code なら「キーボードのどの位置か」で決まるので、
 *   どの配列でも同じ指使いで同じ音が出る。
 *
 * オクターブ番号はMMLの o<n> と同じ規約(o4 の c = MIDI 60 = C4)。
 * baseOctave=4 のとき下段Zが C4(MIDI 60)になる。
 *
 * DOM非依存(event.code の文字列を受け取るだけ)。
 */
(function (global) {
  'use strict';
  const MML   = global.MML = global.MML || {};
  const Input = MML.Input  = MML.Input  || {};

  // code → 基準オクターブのCからの半音数
  const SEMITONE_BY_CODE = {
    // 下段(基準オクターブ)
    KeyZ: 0,  KeyS: 1,  KeyX: 2,  KeyD: 3,  KeyC: 4,
    KeyV: 5,  KeyG: 6,  KeyB: 7,  KeyH: 8,  KeyN: 9,  KeyJ: 10, KeyM: 11,
    Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
    // 上段(+1オクターブ)
    KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16,
    KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
    KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
    BracketLeft: 29, Equal: 30, BracketRight: 31
  };

  // オクターブ移動(演奏入力モード中のみ有効。モード中は矢印キーを他で使わない)
  const OCTAVE_DOWN_CODES = { ArrowDown: 1, NumpadDivide: 1 };
  const OCTAVE_UP_CODES   = { ArrowUp: 1, NumpadMultiply: 1 };

  const OCTAVE_MIN = 0;
  const OCTAVE_MAX = 8;

  Input.KeyMap = {
    SEMITONE_BY_CODE,
    OCTAVE_MIN,
    OCTAVE_MAX,

    /* この code は演奏用に横取りしてよいか(音・オクターブ移動のどちらか) */
    handles(code) {
      return SEMITONE_BY_CODE[code] !== undefined ||
             OCTAVE_DOWN_CODES[code] !== undefined || OCTAVE_UP_CODES[code] !== undefined;
    },

    /* code → MIDIノート番号(対応が無ければ null)。範囲外になる場合も null */
    noteFor(code, baseOctave) {
      const semi = SEMITONE_BY_CODE[code];
      if (semi === undefined) return null;
      const oct = Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, Math.round(baseOctave)));
      const note = (oct + 1) * 12 + semi;   // o4 の c = MIDI 60
      return (note >= 0 && note <= 127) ? note : null;
    },

    /* オクターブ移動量(-1/+1)。移動キーでなければ 0 */
    octaveDelta(code) {
      if (OCTAVE_UP_CODES[code]) return 1;
      if (OCTAVE_DOWN_CODES[code]) return -1;
      return 0;
    },

    /*
     * 画面表示用の配列図。[{ code, label, semi, black }] を下段/上段の2列で返す。
     * label は「そのキーに刻印されている文字」ではなく物理位置の代表文字なので、
     * JIS配列でも記号キーの位置が同じであれば同じ音が出る(表示は目安)。
     */
    rows() {
      const lower = ['KeyZ','KeyS','KeyX','KeyD','KeyC','KeyV','KeyG','KeyB','KeyH','KeyN','KeyJ','KeyM','Comma','KeyL','Period','Semicolon','Slash'];
      const upper = ['KeyQ','Digit2','KeyW','Digit3','KeyE','KeyR','Digit5','KeyT','Digit6','KeyY','Digit7','KeyU','KeyI','Digit9','KeyO','Digit0','KeyP','BracketLeft','Equal','BracketRight'];
      const LABEL = { Comma: ',', Period: '.', Semicolon: ';', Slash: '/', BracketLeft: '[', BracketRight: ']', Equal: '=' };
      const BLACK = [1, 3, 6, 8, 10];
      const toRow = (codes) => codes.map(code => {
        const semi = SEMITONE_BY_CODE[code];
        return {
          code,
          label: LABEL[code] || code.replace(/^Key|^Digit/, ''),
          semi,
          black: BLACK.indexOf(((semi % 12) + 12) % 12) >= 0
        };
      });
      return { lower: toRow(lower), upper: toRow(upper) };
    }
  };

})(window);
