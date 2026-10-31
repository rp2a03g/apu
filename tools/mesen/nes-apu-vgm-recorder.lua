--[[
  NES APU → VGM 録音スクリプト (Mesen 2 用)

  ゲームを遊びながら(効果音・処理落ち込みで)サウンドレジスタの書き込みを VGM に記録する。
  できた .vgm は Sound Emulation Foundry の「ファイルを開く」でそのまま読める
  (VGM の NES APU チップとして再生・ピアノロール・MML 変換まで通る)。設計は DESIGN-CAPTURE.md。

  使い方
    1. Mesen 2 の Debug → Script Window でこのファイルを開いて Run。
       (設定 → Script Window → "Allow access to I/O and OS functions" を ON にしておく。
        ファイル書き出しと ROM ヘッダ(マッパー番号)の読み取りに要る)
    2. ゲームを進めて、録音したい所で F9 を押す(録音開始)。もう一度 F9 で停止。
       画面左上に REC 表示と経過フレーム数が出る。
    3. ファイルは Mesen のスクリプト用データフォルダ(emu.getScriptDataFolder())に
       <ROM名>_<日時>.vgm で出る。パスはスクリプトログに出る。

  仕組み
    - $4000-$4017 / FDS($4023, $4040-$409F) への CPU 書き込みをフック(emu.addMemoryCallback)。
    - 1 フレーム = VGM の 735 サンプル(0x62)で固定。NTSC の実レートは 60.0988Hz なので
      VGM 上の時間は 0.16% 遅くなるが、本ツール側は 735 サンプル=1 フレームで区切るため
      フレームが 1 つもずれない(変換結果の正確さを優先)。処理落ちしたフレームは書き込みが
      無いフレームとしてそのまま残る。
    - DPCM: $4015 の bit4 を立てる書き込みの直前に、$4012/$4013 が指すサンプル本体を
      CPU 空間から読んで VGM データブロック(0x67 type 0xC2 "NES APU RAM write")に入れる。
      同じ場所・同じ内容なら 2 回目以降は省く。
    - 拡張音源(VRC6/VRC7/MMC5/N163/SUNSOFT 5B): VGM の規格に無いので、本ツール専用の
      データブロック(0x67 type 0xBF、先頭 "NESX")で運ぶ。標準プレイヤーは未知の型として
      読み飛ばす(2A03+FDS だけ鳴る)。どのチップかは ROM ファイルの iNES ヘッダのマッパー番号で決める
      (24/26=VRC6、85=VRC7、19=N163、5=MMC5、69=SUNSOFT 5B)。VRC6 のマッパー 26 はアドレス線
      A0/A1 が入れ替わっているので、NSF の慣例(VRC6a)に正規化して書く。
      N163 は $4800 の読み出しでもアドレスポインタが進むので、読み出しも記録する。
    - 録音開始時点のレジスタ状態: スクリプト開始後の書き込みを影レジスタに控えておき、
      録音開始時にまとめて書き出す。スクリプトを先に走らせてからゲームを始めること
      (リセット/パワーサイクル後にスクリプトが自動再開する設定なら何もしなくてよい)。
      スクリプトより前に書かれた値は分からないので、その場合は $4015=$0F だけ補う。
    - preciseTiming=true にすると各書き込みにフレーム内の時刻(CPU サイクル)も付ける
      ($4011 直書き PCM の再生用)。毎書き込みで emu.getState() を呼ぶので重い。

  headless テスト(GUI 無し・最高速)
    Mesen.exe --testRunner rom.nes this.lua --timeout=120
    autoStart=true, stopAfterFrames=<n> にしておくと n フレーム録音して emu.stop() する。
]]

local CFG = {
  autoStart       = false,  -- true: スクリプト開始と同時に録音開始
  toggleKey       = "F9",   -- 録音の開始/停止キー
  outDir          = nil,    -- nil: Mesen のスクリプト用データフォルダ
  preciseTiming   = false,  -- true: 書き込みごとにフレーム内時刻を付ける(重い。$4011 PCM 向け)
  stopAfterFrames = 0,      -- >0: このフレーム数を録音したら停止して emu.stop()(headless テスト用)
  flushEvery      = 60,     -- 何フレームごとにファイルを flush しヘッダを書き直すか(途中で落ちても読める)
  mapper          = nil,    -- nil: ROM の iNES ヘッダから読む / 数値で強制(ヘッダが読めない時用)
}

local SAMPLES_PER_FRAME = 735        -- VGM の 1/60 秒
local NES_APU_CLOCK = 1789772        -- VGM ヘッダ 0x84(NTSC)
local HEADER_SIZE = 0x100            -- v1.61 のヘッダは 0xC0 まで。余裕を持って 0x100
local NESX_TYPE = 0xBF               -- 規格外ブロックの型(src/vgm/vgmHeader.js VGM.NESX と一致させる)
-- NSF ヘッダと同じ拡張音源ビット
local CHIP_VRC6, CHIP_VRC7, CHIP_FDS, CHIP_MMC5, CHIP_N163, CHIP_FME7 = 1, 2, 4, 8, 16, 32

-- ---------------------------------------------------------------- 状態
local recording = false
local file = nil
local filePath = nil
local frameSample = 0        -- 録音開始からの仮想時刻(サンプル)。フレーム頭の値
local emittedSamples = 0     -- ここまでに wait として書き出した合計
local recFrames = 0
local fdsSeen = false
local shadow = {}            -- addr → 最後に書かれた値(録音中でなくても追う)
local dpcmCache = {}         -- "addr:len" → サンプル本体(文字列)
local keyWasDown = false
local frameStartClock = 0    -- preciseTiming 用: このフレーム頭の CPU サイクル
local cyclesPerFrame = 29780.5
local romName = "nes"
local mapper = nil
local extBits = 0            -- 使う拡張音源(FDS を除く)
local ext = nil              -- 溜めている拡張音源書き込み { t, parts }
-- 拡張音源の影: VRC7 はレジスタ番号→値、N163 は RAM 128 バイトとポインタ、SUNSOFT 5B はレジスタ番号→値
local vrc7Sel, vrc7Regs = 0, {}
local n163Ram, n163Ptr, n163Inc = {}, 0, false
local fme7Sel, fme7Regs = 0, {}

-- ---------------------------------------------------------------- バイト列
local function u16(n) return string.char(n & 0xFF, (n >> 8) & 0xFF) end
local function u32(n) return string.char(n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF) end
local function utf16(s)
  local t = {}
  for i = 1, #s do
    local c = s:byte(i)
    if c >= 0x80 then c = 0x3F end -- 非 ASCII は '?'(GD3 は UTF-16LE。ここでは ASCII だけ正確に書く)
    t[#t + 1] = string.char(c, 0)
  end
  t[#t + 1] = string.char(0, 0)
  return table.concat(t)
end

-- CPU アドレス → VGM の NES APU レジスタ番号(0xB4 aa dd の aa)。対象外なら nil
local function mapAddr(a)
  if a >= 0x4000 and a <= 0x401F then
    if a == 0x4014 or a == 0x4016 then return nil end -- OAM DMA / コントローラ
    return a - 0x4000
  elseif a == 0x4023 then return 0x3F
  elseif a >= 0x4040 and a <= 0x407F then return 0x40 + (a - 0x4040)
  elseif a >= 0x4080 and a <= 0x409E then return 0x20 + (a - 0x4080)
  end
  return nil
end

-- ---------------------------------------------------------------- ROM 情報(マッパー番号)
local function readMapperFromRom(path)
  if not path or path == "" then return nil end
  local f = io.open(path, "rb")
  if not f then return nil end
  local hdr = f:read(16)
  f:close()
  if not hdr or #hdr < 16 or hdr:sub(1, 4) ~= "NES\26" then return nil end
  local b6, b7, b8 = hdr:byte(7), hdr:byte(8), hdr:byte(9)
  local m = (b6 >> 4) | (b7 & 0xF0)
  if (b7 & 0x0C) == 0x08 then m = m | ((b8 & 0x0F) << 8) end -- NES 2.0
  return m
end

local function extBitsForMapper(m)
  if m == 24 or m == 26 then return CHIP_VRC6
  elseif m == 85 then return CHIP_VRC7
  elseif m == 19 then return CHIP_N163
  elseif m == 5 then return CHIP_MMC5
  elseif m == 69 then return CHIP_FME7
  end
  return 0
end

-- 拡張音源の書き込みか(マッパーに応じて)。VRC6b(26)は A0/A1 を入れ替えて VRC6a の番地に正規化する
local function extAddr(a)
  if extBits & CHIP_VRC6 ~= 0 then
    local base, lo = a & 0xF000, a & 0x0FFF
    if (base == 0x9000 or base == 0xA000 or base == 0xB000) and lo <= 3 then
      if mapper == 26 then lo = ((lo & 1) << 1) | ((lo >> 1) & 1) end
      if lo <= 2 then return base + lo end
    end
  elseif extBits & CHIP_VRC7 ~= 0 then
    -- VRC7 の音源レジスタは $9010(選択)/$9030(データ)。アドレス線の未使用ビットは無視する
    if (a & 0xF030) == 0x9010 then return 0x9010 elseif (a & 0xF030) == 0x9030 then return 0x9030 end
  elseif extBits & CHIP_N163 ~= 0 then
    if (a & 0xF800) == 0x4800 then return 0x4800 elseif (a & 0xF800) == 0xF800 then return 0xF800 end
  elseif extBits & CHIP_MMC5 ~= 0 then
    if a >= 0x5000 and a <= 0x5015 then return a end
  elseif extBits & CHIP_FME7 ~= 0 then
    if (a & 0xE000) == 0xC000 then return 0xC000 elseif (a & 0xE000) == 0xE000 then return 0xE000 end
  end
  return nil
end

-- ---------------------------------------------------------------- 書き出し
local function out(s) file:write(s) end

-- 仮想時刻 t(サンプル)まで wait を書き出す
local function flushWait(t)
  local d = t - emittedSamples
  while d > 0 do
    if d == SAMPLES_PER_FRAME then out(string.char(0x62)); d = 0
    elseif d > 0xFFFF then out(string.char(0x61) .. u16(0xFFFF)); d = d - 0xFFFF
    else out(string.char(0x61) .. u16(d)); d = 0 end
  end
  if t > emittedSamples then emittedSamples = t end
end

local function nesxBlock(kind, payload)
  local body = "NESX" .. string.char(1, kind) .. payload
  return string.char(0x67, 0x66, NESX_TYPE) .. u32(#body) .. body
end

-- 溜めた拡張音源の書き込み列を 1 ブロックで書く(同じ時刻のものをまとめる)
local function flushExt()
  if not ext then return end
  flushWait(ext.t)
  out(nesxBlock(1, table.concat(ext.parts)))
  ext = nil
end

local function extWrite(a, v, read, t)
  if ext and ext.t ~= t then flushExt() end
  if not ext then ext = { t = t, parts = {} } end
  local frac = t - (t // SAMPLES_PER_FRAME) * SAMPLES_PER_FRAME
  frac = math.floor(frac * 128 / SAMPLES_PER_FRAME); if frac > 127 then frac = 127 end
  ext.parts[#ext.parts + 1] = string.char(a & 0xFF, (a >> 8) & 0xFF, read and 0 or (v & 0xFF), (read and 0x80 or 0) | frac)
end

local function writeHeader()
  local h = {}
  h[#h + 1] = "Vgm "                      -- 0x00
  h[#h + 1] = u32(0)                      -- 0x04 EOF offset(後で書き直す)
  h[#h + 1] = u32(0x00000161)             -- 0x08 version 1.61
  h[#h + 1] = u32(0)                      -- 0x0C SN76489
  h[#h + 1] = u32(0)                      -- 0x10 YM2413
  h[#h + 1] = u32(0)                      -- 0x14 GD3 offset(後で)
  h[#h + 1] = u32(0)                      -- 0x18 total samples(後で)
  h[#h + 1] = u32(0)                      -- 0x1C loop offset
  h[#h + 1] = u32(0)                      -- 0x20 loop samples
  h[#h + 1] = u32(60)                     -- 0x24 rate
  h[#h + 1] = u16(0) .. string.char(0, 0) -- 0x28 SN feedback/shift/flags
  h[#h + 1] = u32(0)                      -- 0x2C YM2612
  h[#h + 1] = u32(0)                      -- 0x30 YM2151
  h[#h + 1] = u32(HEADER_SIZE - 0x34)     -- 0x34 data offset
  local s = table.concat(h)
  s = s .. string.rep("\0", 0x84 - #s)
  s = s .. u32(NES_APU_CLOCK)             -- 0x84 NES APU(bit31=FDS。後で書き直す)
  s = s .. string.rep("\0", HEADER_SIZE - #s)
  out(s)
  -- 拡張音源のヘッダブロック(ストリーム先頭、初期書き込みより前)
  if extBits ~= 0 then out(nesxBlock(0, string.char(extBits))) end
end

local function patchHeader(final)
  local pos = file:seek("end")
  local gd3Pos = 0
  if final then
    -- 終端 0x66 → GD3
    out(string.char(0x66))
    gd3Pos = file:seek("end")
    -- GD3: track=録音日時 / game=ROM 名(本ツールの曲名表示は "game - track")
    local fields = utf16("gameplay " .. os.date("%Y-%m-%d %H:%M")) .. utf16("") .. utf16(romName) .. utf16("") ..
                   utf16("Nintendo Famicom / NES") .. utf16("") .. utf16("") .. utf16("") ..
                   utf16(os.date("%Y/%m/%d")) .. utf16("Mesen 2 + nes-apu-vgm-recorder.lua") ..
                   utf16("Recorded during gameplay (sound effects and lag frames included)")
    out("Gd3 " .. u32(0x100) .. u32(#fields) .. fields)
    pos = file:seek("end")
  end
  file:seek("set", 0x04); out(u32(pos - 4))
  if final then file:seek("set", 0x14); out(u32(gd3Pos - 0x14)) end
  file:seek("set", 0x18); out(u32(frameSample))
  file:seek("set", 0x84); out(u32(NES_APU_CLOCK | (fdsSeen and 0x80000000 or 0)))
  file:seek("end")
  file:flush()
end

-- 録音開始時: 影レジスタの内容をフレーム 0 の頭にまとめて書く
local function emitInitial()
  local function w(a, v) out(string.char(0xB4, mapAddr(a), v & 0xFF)) end
  if shadow[0x4017] then w(0x4017, shadow[0x4017]) end
  local order = { 0x4000, 0x4001, 0x4002, 0x4003, 0x4004, 0x4005, 0x4006, 0x4007,
                  0x4008, 0x400A, 0x400B, 0x400C, 0x400E, 0x400F,
                  0x4010, 0x4011, 0x4012, 0x4013 }
  for _, a in ipairs(order) do if shadow[a] then w(a, shadow[a]) end end
  -- $4015: DPCM(bit4) は鳴らし直さない(途中からの再生は復元できない)
  w(0x4015, shadow[0x4015] and (shadow[0x4015] & 0x0F) or 0x0F)
  local anyFds = false
  for a = 0x4040, 0x409E do if shadow[a] then anyFds = true; break end end
  if anyFds then
    fdsSeen = true
    w(0x4023, shadow[0x4023] or 0x83)
    w(0x4089, 0x80) -- 波形 RAM 書き込み許可
    for a = 0x4040, 0x407F do if shadow[a] then w(a, shadow[a]) end end
    for a = 0x4080, 0x408A do
      -- $4088(変調テーブル FIFO)は復元できないので飛ばす。$4089 は本来の値で書き戻す
      if a ~= 0x4088 and shadow[a] then w(a, shadow[a]) end
    end
  end
  -- 拡張音源(時刻 0 の NESX ブロック 1 つにまとめる)
  if extBits & CHIP_VRC6 ~= 0 then
    for _, a in ipairs({ 0x9000, 0x9001, 0x9002, 0xA000, 0xA001, 0xA002, 0xB000, 0xB001, 0xB002 }) do
      if shadow[a] then extWrite(a, shadow[a], false, 0) end
    end
  elseif extBits & CHIP_VRC7 ~= 0 then
    for r = 0, 0x3F do if vrc7Regs[r] then extWrite(0x9010, r, false, 0); extWrite(0x9030, vrc7Regs[r], false, 0) end end
  elseif extBits & CHIP_N163 ~= 0 then
    local any = false
    for i = 0, 127 do if n163Ram[i] then any = true; break end end
    if any then
      extWrite(0xF800, 0x80, false, 0) -- ポインタ 0、自動インクリメント
      for i = 0, 127 do extWrite(0x4800, n163Ram[i] or 0, false, 0) end
      extWrite(0xF800, (n163Inc and 0x80 or 0) | n163Ptr, false, 0) -- 本来のポインタへ戻す
    end
  elseif extBits & CHIP_MMC5 ~= 0 then
    for _, a in ipairs({ 0x5000, 0x5001, 0x5002, 0x5003, 0x5004, 0x5005, 0x5006, 0x5007, 0x5010, 0x5011, 0x5015 }) do
      if shadow[a] then extWrite(a, shadow[a], false, 0) end
    end
  elseif extBits & CHIP_FME7 ~= 0 then
    for r = 0, 15 do if fme7Regs[r] then extWrite(0xC000, r, false, 0); extWrite(0xE000, fme7Regs[r], false, 0) end end
    extWrite(0xC000, fme7Sel, false, 0)
  end
  flushExt()
end

local function emitDpcmBlock(t)
  local addr = 0xC000 + (shadow[0x4012] or 0) * 64
  local len = (shadow[0x4013] or 0) * 16 + 1
  local parts = {}
  for i = 0, len - 1 do
    local a = addr + i
    if a > 0xFFFF then a = 0x8000 + (a - 0x10000) end -- DMC は $FFFF の次を $8000 から読む
    parts[#parts + 1] = string.char(emu.read(a, emu.memType.nesMemory) & 0xFF)
  end
  local data = table.concat(parts)
  local key = addr .. ":" .. len
  if dpcmCache[key] == data then return end
  dpcmCache[key] = data
  flushWait(t)
  -- VGM データブロック: 0x67 0x66 type size(4) [先頭 2 バイト=書込先アドレス][本体]
  out(string.char(0x67, 0x66, 0xC2) .. u32(len + 2) .. u16(addr) .. data)
end

-- ---------------------------------------------------------------- 録音の開始/停止
local function startRecording()
  local dir = CFG.outDir or emu.getScriptDataFolder()
  if dir == nil or dir == "" then dir = "." end
  local sep = package.config:sub(1, 1)
  if dir:sub(-1) ~= sep then dir = dir .. sep end
  filePath = dir .. romName:gsub("[^%w%-_%.]", "_") .. "_" .. os.date("%Y%m%d_%H%M%S") .. ".vgm"
  local f, err = io.open(filePath, "w+b")
  if not f then
    emu.log("録音ファイルを開けない: " .. tostring(err) .. " (Script Window 設定の I/O 許可を確認)")
    return
  end
  file = f
  frameSample = 0; emittedSamples = 0; recFrames = 0; fdsSeen = false; dpcmCache = {}; ext = nil
  writeHeader()
  emitInitial()
  recording = true
  emu.log("REC start → " .. filePath)
  emu.displayMessage("VGM", "REC start")
end

local function stopRecording()
  if not recording then return end
  recording = false
  flushExt()
  patchHeader(true)
  file:close(); file = nil
  emu.log(string.format("REC stop: %d frames (%.1fs) → %s", recFrames, recFrames / 60.0988, filePath))
  emu.displayMessage("VGM", string.format("REC stop (%d frames)", recFrames))
end

-- ---------------------------------------------------------------- フック
local function fracSamples()
  if not CFG.preciseTiming then return 0 end
  local st = emu.getState()
  local d = (st.masterClock or 0) - frameStartClock
  if d < 0 then d = 0 end
  local fr = d / cyclesPerFrame
  if fr > 0.999 then fr = 0.999 end
  return math.floor(fr * SAMPLES_PER_FRAME)
end

-- 拡張音源の影(録音中でなくても追う)
local function trackExt(a, v)
  shadow[a] = v
  if a == 0x9010 then vrc7Sel = v & 0x3F
  elseif a == 0x9030 then vrc7Regs[vrc7Sel] = v
  elseif a == 0xF800 then n163Ptr = v & 0x7F; n163Inc = (v & 0x80) ~= 0
  elseif a == 0x4800 then n163Ram[n163Ptr] = v; if n163Inc then n163Ptr = (n163Ptr + 1) & 0x7F end
  elseif a == 0xC000 then fme7Sel = v & 0x0F
  elseif a == 0xE000 then fme7Regs[fme7Sel] = v
  end
end

local function onWrite(addr, value)
  local ea = extAddr(addr)
  if ea then
    trackExt(ea, value)
    if recording then extWrite(ea, value, false, frameSample + fracSamples()) end
    return
  end
  shadow[addr] = value
  if not recording then return end
  local aa = mapAddr(addr)
  if aa == nil then return end
  if addr == 0x4023 or (addr >= 0x4040 and addr <= 0x409E) then fdsSeen = true end
  local t = frameSample + fracSamples()
  flushExt()
  if addr == 0x4015 and (value & 0x10) ~= 0 then emitDpcmBlock(t) end
  flushWait(t)
  out(string.char(0xB4, aa, value & 0xFF))
end

-- N163 $4800 の読み出し(ポインタが進む)。書き込みと同じ列に read 印で入れる
local function onReadN163(addr, value)
  if (addr & 0xF800) ~= 0x4800 then return end
  if n163Inc then n163Ptr = (n163Ptr + 1) & 0x7F end
  if recording then extWrite(0x4800, 0, true, frameSample + fracSamples()) end
end

local function onStartFrame()
  if CFG.preciseTiming then
    local st = emu.getState()
    frameStartClock = st.masterClock or 0
    if st.clockRate and st.clockRate > 0 then cyclesPerFrame = st.clockRate / 60.0988 end
  end
end

local function onEndFrame()
  -- 録音のトグル(キーの押下エッジ)
  if CFG.toggleKey then
    -- headless(--testRunner)ではキー名を解決できず例外になる。例外が出たらキー監視をやめる
    -- (コールバック内の例外は Mesen がログに出すだけで、スクリプトは止まらない。
    --  放っておくと毎フレーム例外で wait もヘッダ更新も飛ぶ)
    local ok, down = pcall(emu.isKeyPressed, CFG.toggleKey)
    if not ok then CFG.toggleKey = nil; down = false end
    if down and not keyWasDown then
      if recording then stopRecording() else startRecording() end
    end
    keyWasDown = down
  end
  if recording then
    flushExt() -- 拡張音源の書き込みはそのフレームの中に置く
    recFrames = recFrames + 1
    frameSample = recFrames * SAMPLES_PER_FRAME
    if CFG.flushEvery > 0 and recFrames % CFG.flushEvery == 0 then
      flushWait(frameSample)
      patchHeader(false)
    end
    pcall(emu.drawString, 2, 2, string.format("REC %d (%.1fs)", recFrames, recFrames / 60.0988), 0xFF4040, 0x000000)
    if CFG.stopAfterFrames > 0 and recFrames >= CFG.stopAfterFrames then
      stopRecording()
      emu.stop(0)
    end
  else
    pcall(emu.drawString, 2, 2, (CFG.toggleKey or "?") .. ": REC", 0xA0A0A0, 0x000000)
  end
end

local function onReset()
  shadow = {}; vrc7Regs = {}; n163Ram = {}; n163Ptr = 0; n163Inc = false; fme7Regs = {}
end

local function onScriptEnded()
  stopRecording()
end

-- ---------------------------------------------------------------- 登録
do
  local info = emu.getRomInfo()
  if info and info.name then romName = info.name:gsub("%.[^%.]+$", "") end
  mapper = CFG.mapper
  if mapper == nil and info then
    local ok, m = pcall(readMapperFromRom, info.path)
    if ok then mapper = m end
  end
  extBits = mapper and extBitsForMapper(mapper) or 0
end
emu.addMemoryCallback(onWrite, emu.callbackType.write, 0x4000, 0x4017)
emu.addMemoryCallback(onWrite, emu.callbackType.write, 0x4023, 0x4023)
emu.addMemoryCallback(onWrite, emu.callbackType.write, 0x4040, 0x409F)
if extBits & CHIP_VRC6 ~= 0 then emu.addMemoryCallback(onWrite, emu.callbackType.write, 0x9000, 0xB003) end
if extBits & CHIP_VRC7 ~= 0 then emu.addMemoryCallback(onWrite, emu.callbackType.write, 0x9000, 0x9FFF) end
if extBits & CHIP_MMC5 ~= 0 then emu.addMemoryCallback(onWrite, emu.callbackType.write, 0x5000, 0x5015) end
if extBits & CHIP_N163 ~= 0 then
  emu.addMemoryCallback(onWrite, emu.callbackType.write, 0x4800, 0x4FFF)
  emu.addMemoryCallback(onWrite, emu.callbackType.write, 0xF800, 0xFFFF)
  emu.addMemoryCallback(onReadN163, emu.callbackType.read, 0x4800, 0x4FFF)
end
if extBits & CHIP_FME7 ~= 0 then emu.addMemoryCallback(onWrite, emu.callbackType.write, 0xC000, 0xFFFF) end
emu.addEventCallback(onStartFrame, emu.eventType.startFrame)
emu.addEventCallback(onEndFrame, emu.eventType.endFrame)
emu.addEventCallback(onReset, emu.eventType.reset)
emu.addEventCallback(onScriptEnded, emu.eventType.scriptEnded)
emu.log(string.format("nes-apu-vgm-recorder: ready (%s to start/stop, mapper %s, expansion bits %d)",
  CFG.toggleKey or "no key", tostring(mapper), extBits))
if CFG.autoStart then startRecording() end
