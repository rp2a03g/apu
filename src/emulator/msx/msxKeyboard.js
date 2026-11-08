/*
 * MSX キーボードのマトリクス(日本語配列)と、PC のキー(KeyboardEvent.code)からの既定の対応表
 * MML.Emu.MsxKeyboard — 自前 MSX エミュレータ(DESIGN-MSX-CAPTURE.md §3.5、段階 7a)
 *
 * PPI(ポート 0xAA の下位 4 ビットで行を選び、0xA9 で 8 ビットを読む。押している=0)の 11 行(+日本語機の 11 行目)。
 * 行とビットの並びは MSX 日本語配列(JIS)の実機の表。英字配列(ANSI)との違いは行 1〜2 の記号の位置だけ。
 *   行 0 : 0 1 2 3 4 5 6 7(bit0〜7)
 *   行 1 : 8 9 - ^ ¥ @ [ ;
 *   行 2 : : ] , . / _ A B
 *   行 3 : C D E F G H I J
 *   行 4 : K L M N O P Q R
 *   行 5 : S T U V W X Y Z
 *   行 6 : SHIFT CTRL GRAPH CAPS かな F1 F2 F3
 *   行 7 : F4 F5 ESC TAB STOP BS SELECT RETURN
 *   行 8 : SPACE HOME INS DEL ← ↑ ↓ →
 *   行 9 : テンキー * + / 0 1 2 3 4
 *   行 10: テンキー 5 6 7 8 9 - , .
 *   行 11: 日本語機の 実行(bit1)/取消(bit3) (推定: 機種により無い。openMSX の JP 配列表に合わせた)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // キー名 → [行, ビット]
  const KEYS = {
    Digit0: [0, 0], Digit1: [0, 1], Digit2: [0, 2], Digit3: [0, 3], Digit4: [0, 4], Digit5: [0, 5], Digit6: [0, 6], Digit7: [0, 7],
    Digit8: [1, 0], Digit9: [1, 1], Minus: [1, 2], Caret: [1, 3], Yen: [1, 4], At: [1, 5], BracketLeft: [1, 6], Semicolon: [1, 7],
    Colon: [2, 0], BracketRight: [2, 1], Comma: [2, 2], Period: [2, 3], Slash: [2, 4], Underscore: [2, 5], A: [2, 6], B: [2, 7],
    C: [3, 0], D: [3, 1], E: [3, 2], F: [3, 3], G: [3, 4], H: [3, 5], I: [3, 6], J: [3, 7],
    K: [4, 0], L: [4, 1], M: [4, 2], N: [4, 3], O: [4, 4], P: [4, 5], Q: [4, 6], R: [4, 7],
    S: [5, 0], T: [5, 1], U: [5, 2], V: [5, 3], W: [5, 4], X: [5, 5], Y: [5, 6], Z: [5, 7],
    Shift: [6, 0], Ctrl: [6, 1], Graph: [6, 2], Caps: [6, 3], Kana: [6, 4], F1: [6, 5], F2: [6, 6], F3: [6, 7],
    F4: [7, 0], F5: [7, 1], Esc: [7, 2], Tab: [7, 3], Stop: [7, 4], BS: [7, 5], Select: [7, 6], Return: [7, 7],
    Space: [8, 0], Home: [8, 1], Ins: [8, 2], Del: [8, 3], Left: [8, 4], Up: [8, 5], Down: [8, 6], Right: [8, 7],
    NumMul: [9, 0], NumAdd: [9, 1], NumDiv: [9, 2], Num0: [9, 3], Num1: [9, 4], Num2: [9, 5], Num3: [9, 6], Num4: [9, 7],
    Num5: [10, 0], Num6: [10, 1], Num7: [10, 2], Num8: [10, 3], Num9: [10, 4], NumSub: [10, 5], NumComma: [10, 6], NumDot: [10, 7],
    Jikkou: [11, 1], Torikeshi: [11, 3],
  };

  // PC の KeyboardEvent.code → MSX キー名(既定。UI の設定で上書きできる)
  // 文字キーは「刻印の位置」で合わせる(日本語キーボードの PC なら記号も同じ位置になる)
  const DEFAULT_MAP = {
    Digit0: 'Digit0', Digit1: 'Digit1', Digit2: 'Digit2', Digit3: 'Digit3', Digit4: 'Digit4', Digit5: 'Digit5', Digit6: 'Digit6', Digit7: 'Digit7', Digit8: 'Digit8', Digit9: 'Digit9',
    Minus: 'Minus', Equal: 'Caret', IntlYen: 'Yen', Backslash: 'Yen', BracketLeft: 'At', BracketRight: 'BracketLeft', Semicolon: 'Semicolon', Quote: 'Colon', Backquote: 'BracketRight',
    Comma: 'Comma', Period: 'Period', Slash: 'Slash', IntlRo: 'Underscore',
    KeyA: 'A', KeyB: 'B', KeyC: 'C', KeyD: 'D', KeyE: 'E', KeyF: 'F', KeyG: 'G', KeyH: 'H', KeyI: 'I', KeyJ: 'J', KeyK: 'K', KeyL: 'L', KeyM: 'M',
    KeyN: 'N', KeyO: 'O', KeyP: 'P', KeyQ: 'Q', KeyR: 'R', KeyS: 'S', KeyT: 'T', KeyU: 'U', KeyV: 'V', KeyW: 'W', KeyX: 'X', KeyY: 'Y', KeyZ: 'Z',
    ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Graph', AltRight: 'Graph', CapsLock: 'Caps',
    KanaMode: 'Kana', Lang1: 'Kana', Lang2: 'Kana', NonConvert: 'Kana',
    F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', Escape: 'Esc', Tab: 'Tab', F8: 'Stop', End: 'Stop', Backspace: 'BS', F6: 'Select', PageUp: 'Select', Enter: 'Return', NumpadEnter: 'Return',
    Space: 'Space', Home: 'Home', Insert: 'Ins', Delete: 'Del', ArrowLeft: 'Left', ArrowUp: 'Up', ArrowDown: 'Down', ArrowRight: 'Right',
    NumpadMultiply: 'NumMul', NumpadAdd: 'NumAdd', NumpadDivide: 'NumDiv', Numpad0: 'Num0', Numpad1: 'Num1', Numpad2: 'Num2', Numpad3: 'Num3', Numpad4: 'Num4',
    Numpad5: 'Num5', Numpad6: 'Num6', Numpad7: 'Num7', Numpad8: 'Num8', Numpad9: 'Num9', NumpadSubtract: 'NumSub', NumpadComma: 'NumComma', NumpadDecimal: 'NumDot',
    PageDown: 'Jikkou', ScrollLock: 'Torikeshi',
  };

  const ROWS = 12;

  class MsxKeyboard {
    constructor() {
      this.rows = new Uint8Array(ROWS).fill(0xFF); // 押している=0
      this.map = Object.assign({}, DEFAULT_MAP);
    }
    reset() { this.rows.fill(0xFF); }
    /** MSX のキー名で押す/離す */
    setKey(name, down) {
      const k = KEYS[name];
      if (!k) return false;
      if (down) this.rows[k[0]] &= ~(1 << k[1]); else this.rows[k[0]] |= (1 << k[1]);
      return true;
    }
    /** 行とビットで押す/離す(UI のソフトキーボード等) */
    setMatrix(row, bit, down) {
      if (row < 0 || row >= ROWS) return;
      if (down) this.rows[row] &= ~(1 << bit); else this.rows[row] |= (1 << bit);
    }
    /** PC の KeyboardEvent.code で押す/離す。対応が無ければ false */
    setPcKey(code, down) {
      const name = this.map[code];
      return name ? this.setKey(name, down) : false;
    }
    readRow(row) { return row < ROWS ? this.rows[row] : 0xFF; }
    releaseAll() { this.rows.fill(0xFF); }
  }
  MsxKeyboard.KEYS = KEYS;
  MsxKeyboard.DEFAULT_MAP = DEFAULT_MAP;
  MsxKeyboard.ROWS = ROWS;
  Emu.MsxKeyboard = MsxKeyboard;
})(typeof window !== 'undefined' ? window : globalThis);
