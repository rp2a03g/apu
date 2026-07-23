/*
 * Phase 1 動作確認用の最小サウンドドライバ（6502アセンブリ）
 * INIT/PLAY は何もせず RTS するだけのスタブ。
 * Phase 2以降でPSG制御ルーチンに置き換える。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Driver = MML.Driver = MML.Driver || {};

  Driver.SAMPLE_SOURCE =
`; ==========================================
; FamiMML Studio - サンプルドライバ (Phase1/2動作確認用)
; パルス1チャンネルで約440Hzのトーンを鳴らし続けるだけの最小例
; ==========================================
    .org $8000

INIT:
    LDA #$01
    STA $4015      ; パルス1のみ有効化
    LDA #$BF       ; duty=50%, 長さカウンタhalt=1, 固定音量=15
    STA $4000
    LDA #$00
    STA $4001      ; スイープ無効
    LDA #$FD       ; タイマ下位 (約440Hz)
    STA $4002
    LDA #$00
    STA $4003      ; タイマ上位=0
    RTS

PLAY:
    RTS

; --- データ領域例 ---
SONG_DATA:
    .byte $00, $01, $02, $03
    .word INIT
    .word PLAY
`;
})(window);
