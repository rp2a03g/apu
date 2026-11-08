# openMSX 用: 決まったフレームにキー/ジョイスティックを入れ、決まったフレームで画面を PNG に保存し、VDP レジスタを書き出す。
# 自前 MSX エミュレータ(src/emulator/msx/、tools/headless/msx-run.js --png)の画面と見比べる基準を作るための物(Mesen の ref-screenshot.lua の MSX 版)。
#
#   openmsx -machine Panasonic_FS-A1WSX -cart "game.rom" -script tools/openmsx/ref-screenshot.tcl
#   (ディスクなら -diska "game.dsk"。機種は openMSX の machines/ にある名前。本ツールの msx2 は C-BIOS の "C-BIOS_MSX2_JP" が近い)
#
# 設定は下の CFG(コピーして書き換える)。msx-run.js の --press/--key と同じ意味:
#   press : {btn from to} の並び。btn は up/down/left/right/a/b(ジョイスティック 1)または openMSX のキー名(SPACE/RETURN/F1 …、keymatrixdown で押す)
#   shots : このフレーム番号(0 始まり、VBlank の回数)の終わりに PNG を保存
#   out   : 保存先の接頭辞(フレーム番号が付く)。stop: このフレームで openMSX を終える
# ★未検証(2026-11-09): この PC に openMSX が無く、実行していない。openMSX の Tcl API(after frame / screenshot / keymatrixdown / debug read)の名前は
#   マニュアルの記憶で書いた。動かないときはまず `help` で名前を確かめること。
set CFG(press) {{SPACE 700 710} {right 900 1300}}
set CFG(shots) {1300}
set CFG(out) "_tmp_test/msx/ref/openmsx"
set CFG(stop) 1301

# キー名 → キーマトリクスの行とビット(日本語配列。msxKeyboard.js の表と同じ)
array set KEYMAP {
  SPACE {8 0} RETURN {7 7} ESC {7 2} F1 {6 5} F2 {6 6} F3 {6 7} F4 {7 0} F5 {7 1} STOP {7 4} SELECT {7 6}
  LEFT {8 4} UP {8 5} DOWN {8 6} RIGHT {8 7} Y {5 6} N {4 3} SHIFT {6 0} CTRL {6 1} GRAPH {6 2}
}
# ジョイスティック 1(joyporta に plug された keyjoystick1 を使わず、PSG R14 の値を直接作るのは難しいので keyjoystick1 のキーを押す)
array set JOY { up {Up} down {Down} left {Left} right {Right} a {Space} b {Lalt} }

set frame 0
set held {}

proc pressedAt {f} {
  global CFG
  set out {}
  foreach p $CFG(press) {
    lassign $p btn from to
    if {$f >= $from && $f <= $to} { lappend out $btn }
  }
  return $out
}
proc applyInput {f} {
  global held KEYMAP JOY
  set want [pressedAt $f]
  foreach b $held { if {$b ni $want} { releaseBtn $b } }
  foreach b $want { if {$b ni $held} { pressBtn $b } }
  set held $want
}
proc pressBtn {b} {
  global KEYMAP JOY
  if {[info exists KEYMAP($b)]} { lassign $KEYMAP($b) row bit; keymatrixdown $row [expr {1 << $bit}] } \
  elseif {[info exists JOY($b)]} { keymatrixdown {*}[keyOf $JOY($b)] }
}
proc releaseBtn {b} {
  global KEYMAP JOY
  if {[info exists KEYMAP($b)]} { lassign $KEYMAP($b) row bit; keymatrixup $row [expr {1 << $bit}] } \
  elseif {[info exists JOY($b)]} { keymatrixup {*}[keyOf $JOY($b)] }
}
# keyjoystick1 の既定キー(カーソル/スペース/左 Alt)をマトリクスで押す
proc keyOf {name} {
  switch -- $name { Up {return {8 32}} Down {return {8 64}} Left {return {8 16}} Right {return {8 128}} Space {return {8 1}} Lalt {return {6 4}} }
  return {8 1}
}
proc dumpVdp {f} {
  global CFG
  set fh [open "$CFG(out)_${f}_vdp.txt" w]
  set regs {}
  for {set r 0} {$r < 47} {incr r} { lappend regs [format %02x [debug read "VDP regs" $r]] }
  puts $fh "frame $f regs $regs"
  puts $fh "status [format %02x [debug read "VDP status regs" 0]] [format %02x [debug read "VDP status regs" 1]] [format %02x [debug read "VDP status regs" 2]]"
  close $fh
}
proc onFrame {} {
  global frame CFG
  applyInput $frame
  if {$frame in $CFG(shots)} {
    screenshot -raw "$CFG(out)_${frame}.png"
    dumpVdp $frame
    puts stderr "shot $frame"
  }
  if {$frame >= $CFG(stop)} { exit }
  incr frame
  after frame onFrame
}
after frame onFrame
