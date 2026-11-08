# openMSX 用: 音源レジスタの書き込み(PSG / SCC / MSX-MUSIC / MSX-AUDIO / turboR PCM)をフレーム番号つきでテキストに書く。
# 自前 MSX エミュレータの録音列(msxConsole.js の rec、msx-run.js --vgm)と突き合わせる基準。VGM ではなく「1 行 1 書き込み」の素朴な形
# (frame chip addr value)。本ツール側の比較は tools/headless/msx-reglog-diff.js(未作成。必要になったら書く)。
#
#   openmsx -machine Panasonic_FS-A1WSX -cart "game.rom" -script tools/openmsx/reglog.tcl
#   出力: _tmp_test/msx/ref/reglog.txt。終わりは手で openMSX を閉じる(または STOP フレームで exit)
#
# ★未検証(2026-11-09): この PC に openMSX が無い。debug set_watchpoint の引数の形(write_io / write_mem、範囲、条件、コマンド)と
#   $::wp_last_address / $::wp_last_value の名前はマニュアルの記憶。SCC は Konami SCC カートリッジが挿さっている時だけ $9800-$98FF が意味を持つ。
set OUT "_tmp_test/msx/ref/reglog.txt"
set STOP 3600
set frame 0
set fh [open $OUT w]
set psgReg 0

proc logw {chip addr value} { global fh frame; puts $fh "$frame $chip [format %04x $addr] [format %02x $value]" }

# PSG: $A0 でレジスタ番号、$A1 でデータ
debug set_watchpoint write_io 0xA0 {} { set ::psgReg [expr {$::wp_last_value & 0x0F}] }
debug set_watchpoint write_io 0xA1 {} { logw psg $::psgReg $::wp_last_value }
# MSX-MUSIC(OPLL): $7C 番号、$7D データ
debug set_watchpoint write_io 0x7C {} { set ::opllReg [expr {$::wp_last_value & 0x3F}] }
debug set_watchpoint write_io 0x7D {} { logw opll $::opllReg $::wp_last_value }
# MSX-AUDIO(Y8950): $C0 番号、$C1 データ
debug set_watchpoint write_io 0xC0 {} { set ::oplReg $::wp_last_value }
debug set_watchpoint write_io 0xC1 {} { logw opl $::oplReg $::wp_last_value }
# turboR PCM: $A4 データ、$A5 制御
debug set_watchpoint write_io 0xA4 {} { logw pcm 0xA4 $::wp_last_value }
debug set_watchpoint write_io 0xA5 {} { logw pcm 0xA5 $::wp_last_value }
# SCC($9800-$98FF)と SCC+($B800-$B8FF)、コナミ DAC($5000)
debug set_watchpoint write_mem {0x9800 0x98FF} {} { logw scc $::wp_last_address $::wp_last_value }
debug set_watchpoint write_mem {0xB800 0xB8FF} {} { logw scc $::wp_last_address $::wp_last_value }
debug set_watchpoint write_mem {0x5000 0x5FFF} {} { logw dac $::wp_last_address $::wp_last_value }

proc onFrame {} {
  global frame STOP fh
  incr frame
  if {$frame % 60 == 0} { flush $fh }
  if {$frame >= $STOP} { close $fh; exit }
  after frame onFrame
}
after frame onFrame
