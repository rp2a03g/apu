/*
 * MMLコンパイラ動作確認用のサンプル楽曲 (ppmck互換 基本コマンド)
 * A: パルス1 (メロディ)
 * B: パルス2 (ハーモニー)
 * C: 三角波 (ベース)
 * D: ノイズ (リズム)
 * E: DPCM 
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Mml = MML.Mml = MML.Mml || {};

  Mml.SAMPLE_SOURCE =
`; ==========================================
; Famicom Sound Editor - サンプルMML
; ==========================================
A t120 @0 o5 v12 l8 c d e f g a b4 >c4 <b a g f e d4 c2
B      @1 o4 v10 l8 e f g a b >c d4 c <b a g f e4 c4 c2
C      o3 v15 l4 c c g g a a g4 r4 c c g g a a g4 r4
D      o4 v8  l8 [c8 r8]8
`;
})(window);
