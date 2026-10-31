--[[
  NES APU → VGM 録音スクリプト (Mesen 2 用)

  ゲームを遊びながら(効果音・処理落ち込みで)サウンドレジスタの書き込みを VGM に記録する。
  できた .vgm は Sound Emulation Foundry の「ファイルを開く」でそのまま読める
  (VGM の NES APU チップとして再生・ピアノロール・MML 変換まで通る)。

  使い方
    1. Mesen 2 の Debug → Script Window でこのファイルを開いて Run。
       (設定 → Script Window → "Allow access to I/O and OS functions" を ON にしておく。
        ファイル書き出しに要る)
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
}

local SAMPLES_PER_FRAME = 735        -- VGM の 1/60 秒
local NES_APU_CLOCK = 1789772        -- VGM ヘッダ 0x84(NTSC)
local HEADER_SIZE = 0x100            -- v1.61 のヘッダは 0xC0 まで。余裕を持って 0x100

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
  frameSample = 0; emittedSamples = 0; recFrames = 0; fdsSeen = false; dpcmCache = {}
  writeHeader()
  emitInitial()
  recording = true
  emu.log("REC start → " .. filePath)
  emu.displayMessage("VGM", "REC start")
end

local function stopRecording()
  if not recording then return end
  recording = false
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

local function onWrite(addr, value)
  shadow[addr] = value
  if not recording then return end
  local aa = mapAddr(addr)
  if aa == nil then return end
  if addr == 0x4023 or (addr >= 0x4040 and addr <= 0x409E) then fdsSeen = true end
  local t = frameSample + fracSamples()
  if addr == 0x4015 and (value & 0x10) ~= 0 then emitDpcmBlock(t) end
  flushWait(t)
  out(string.char(0xB4, aa, value & 0xFF))
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
  shadow = {}
end

local function onScriptEnded()
  stopRecording()
end

-- ---------------------------------------------------------------- 登録
do
  local info = emu.getRomInfo()
  if info and info.name then romName = info.name:gsub("%.[^%.]+$", "") end
end
emu.addMemoryCallback(onWrite, emu.callbackType.write, 0x4000, 0x4017)
emu.addMemoryCallback(onWrite, emu.callbackType.write, 0x4023, 0x4023)
emu.addMemoryCallback(onWrite, emu.callbackType.write, 0x4040, 0x409F)
emu.addEventCallback(onStartFrame, emu.eventType.startFrame)
emu.addEventCallback(onEndFrame, emu.eventType.endFrame)
emu.addEventCallback(onReset, emu.eventType.reset)
emu.addEventCallback(onScriptEnded, emu.eventType.scriptEnded)
emu.log("nes-apu-vgm-recorder: ready (" .. (CFG.toggleKey or "no key") .. " to start/stop)")
if CFG.autoStart then startRecording() end
