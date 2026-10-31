--[[
  サウンドレジスタ → VGM 録音スクリプト (Mesen 2 用)
  対応機種: NES/FC(拡張音源・FDS 込み)、ゲームボーイ/GBC、PC エンジン、マスターシステム/ゲームギア

  ゲームを遊びながら(効果音・処理落ち込みで)サウンドレジスタの書き込みを VGM に記録する。
  できた .vgm は Sound Emulation Foundry の「ファイルを開く」でそのまま読める
  (再生・ピアノロール・MML 変換まで通る)。設計は DESIGN-CAPTURE.md。
  Mesen が直接読める .nsf / .gbs / .hes を開いて走らせれば、そのドライバの出力も同じ形で録れる。

  使い方
    1. Mesen 2 の Debug → Script Window でこのファイルを開いて Run。
       (設定 → Script Window → "Allow access to I/O and OS functions" を ON にしておく。
        ファイル書き出しと ROM ヘッダ(NES のマッパー番号)の読み取りに要る)
    2. ゲームを進めて、録音したい所で F9 を押す(録音開始)。もう一度 F9 で停止。
       画面左上に REC 表示と経過フレーム数が出る。
    3. ファイルは Mesen のスクリプト用データフォルダ(emu.getScriptDataFolder())に
       <ROM名>_<日時>.vgm で出る。パスはスクリプトログに出る。

  仕組み(機種共通)
    - 機種は起動時に emu.getState().consoleType で判定し、機種表(CONSOLES)で
      「フックする範囲 → VGM コマンド → 影レジスタの復元順」を切り替える。符号化器(待ち・ヘッダ・
      GD3・flush)は共通。
    - 1 フレーム = VGM の 735 サンプル(0x62)で固定。実機のフレームレート(NES 60.0988Hz、
      GB 59.73Hz、PCE 59.8Hz、SMS 59.92Hz)に関係なく、本ツール側は 735 サンプル=1 フレームで
      区切るためフレームが 1 つもずれない(変換結果の正確さを優先)。処理落ちしたフレームは
      書き込みが無いフレームとしてそのまま残る。
    - 録音開始時点のレジスタ状態: スクリプト開始後の書き込みを影レジスタに控えておき、
      録音開始時にまとめて書き出す(音を出すイネーブルを最後に)。スクリプトを先に走らせてから
      ゲームを始めること(リセット後にスクリプトが自動再開する設定なら何もしなくてよい)。
    - preciseTiming=true にすると各書き込みにフレーム内の時刻(CPU サイクル)も付ける
      ($4011 直書き PCM の再生用)。毎書き込みで emu.getState() を呼ぶので重い。

  機種ごとの要点
    NES : $4000-$4017 / FDS($4023, $4040-$409F) → 0xB4。DPCM は $4015 bit4 を立てる直前に
          $4012/$4013 が指すサンプル本体を CPU 空間から読んで 0x67 type 0xC2 に入れる。
          拡張音源(VRC6/VRC7/MMC5/N163/SUNSOFT 5B)は規格に無いので本ツール専用ブロック
          (0x67 type 0xBF、先頭 "NESX")で運ぶ。どのチップかは ROM の iNES ヘッダのマッパー番号で
          決める(24/26=VRC6、85=VRC7、19=N163、5=MMC5、69=SUNSOFT 5B)。マッパー 26(VRC6b)は
          A0/A1 を入れ替えて NSF の慣例(VRC6a)に正規化。N163 は $4800 の読み出しも記録。
    GB  : $FF10-$FF3F → 0xB3(aa = アドレス − $FF10、波形 RAM は 0x20-0x2F)。開始時の復元は
          NR52 電源 → NR50/NR51 → ch3 DAC off → 波形 RAM → 各 ch(NRx4 はトリガ bit7 を落とす)。
          録音開始時に鳴っていた音は次のキーオンまで鳴らない。
    PCE : PSG($0800-$0809、MPR0=$FF で論理 $0800 に出ている前提。CFG.pcePsgBase で変更)→ 0xB9。
          波形は ch が止まっている間の $0806 書き込みを 32 バイトの影に写す。復元は
          主音量 → ch ごと(周波数・パン・ノイズ・波形(DDA でポインタを戻して 32 回)・制御)→ LFO。
    SMS : ポート $40-$7F → 0x50、ゲームギアのステレオ(ポート $06)→ 0x4F。復元は音程 → ノイズ →
          ステレオ → 音量。日本版 SMS の FM(YM2413)は未対応。Mesen のポート書き込みコールバックは
          smsPrgRom 型(ポート番号=アドレス)で届く癖があるので両方の型で登録している。
    headless テスト(GUI 無し・最高速)
      Mesen.exe --testRunner rom this.lua --timeout=120
      autoStart=true, stopAfterFrames=<n> にしておくと n フレーム録音して emu.stop() する。
]]

local CFG = {
  autoStart       = false,  -- true: スクリプト開始と同時に録音開始
  toggleKey       = "F9",   -- 録音の開始/停止キー
  outDir          = nil,    -- nil: Mesen のスクリプト用データフォルダ
  preciseTiming   = false,  -- true: 書き込みごとにフレーム内時刻を付ける(重い。$4011 PCM 向け)
  stopAfterFrames = 0,      -- >0: このフレーム数を録音したら停止して emu.stop()(headless テスト用)
  flushEvery      = 60,     -- 何フレームごとにファイルを flush しヘッダを書き直すか(途中で落ちても読める)
  console         = nil,    -- nil: 自動判定 / "nes" "gb" "pce" "sms" "gg" で強制
  mapper          = nil,    -- NES: nil=ROM の iNES ヘッダから読む / 数値で強制(ヘッダが読めない時用)
  pcePsgBase      = 0x0800, -- PCE: PSG レジスタの論理アドレス(ハードウェアページ + $0800)
}

local SAMPLES_PER_FRAME = 735        -- VGM の 1/60 秒
local HEADER_SIZE = 0x100            -- v1.61 のヘッダは 0xC0 まで。余裕を持って 0x100
local NESX_TYPE = 0xBF               -- 規格外ブロックの型(src/vgm/vgmHeader.js VGM.NESX と一致させる)
-- NSF ヘッダと同じ拡張音源ビット
local CHIP_VRC6, CHIP_VRC7, CHIP_FDS, CHIP_MMC5, CHIP_N163, CHIP_FME7 = 1, 2, 4, 8, 16, 32

-- ---------------------------------------------------------------- 状態(共通)
local C = nil                -- 選ばれた機種表の項目
local recording = false
local file = nil
local filePath = nil
local frameSample = 0        -- 録音開始からの仮想時刻(サンプル)。フレーム頭の値
local emittedSamples = 0     -- ここまでに wait として書き出した合計
local recFrames = 0
local keyWasDown = false
local frameStartClock = 0    -- preciseTiming 用: このフレーム頭の CPU サイクル
local cyclesPerFrame = 0     -- 直前のフレームの実測(機種に依らない)
local romName = "rom"
local romExt = ""
local shadow = {}            -- addr → 最後に書かれた値(録音中でなくても追う)

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

-- ---------------------------------------------------------------- 書き出し(共通の符号化器)
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

local function fracSamples()
  if not CFG.preciseTiming or cyclesPerFrame <= 0 then return 0 end
  local st = emu.getState()
  local d = (st.masterClock or 0) - frameStartClock
  if d < 0 then d = 0 end
  local fr = d / cyclesPerFrame
  if fr > 0.999 then fr = 0.999 end
  return math.floor(fr * SAMPLES_PER_FRAME)
end

local function now() return frameSample + fracSamples() end

-- 「cmd aa dd」形式(0xB3/0xB4/0xB9)と「cmd dd」形式(0x50/0x4F)
local function emitReg(cmd, aa, dd, t)
  if C.beforeEmit then C.beforeEmit() end
  flushWait(t or now())
  out(string.char(cmd, aa & 0xFF, dd & 0xFF))
end
local function emitByte(cmd, dd, t)
  flushWait(t or now())
  out(string.char(cmd, dd & 0xFF))
end

local function writeHeader()
  local h = {}
  for i = 1, HEADER_SIZE do h[i] = 0 end
  local function set32(off, v) for i = 0, 3 do h[off + i + 1] = (v >> (8 * i)) & 0xFF end end
  local function set16(off, v) for i = 0, 1 do h[off + i + 1] = (v >> (8 * i)) & 0xFF end end
  local function set8(off, v) h[off + 1] = v & 0xFF end
  h[1], h[2], h[3], h[4] = 0x56, 0x67, 0x6D, 0x20  -- "Vgm "
  set32(0x08, 0x00000161)             -- version 1.61
  set32(0x24, 60)                     -- rate
  set32(0x34, HEADER_SIZE - 0x34)     -- data offset
  C.header({ set32 = set32, set16 = set16, set8 = set8 })
  local s = {}
  for i = 1, HEADER_SIZE do s[i] = string.char(h[i]) end
  out(table.concat(s))
  if C.afterHeader then C.afterHeader() end
end

local function patchHeader(final)
  local pos = file:seek("end")
  local gd3Pos = 0
  if final then
    out(string.char(0x66)) -- 終端
    gd3Pos = file:seek("end")
    -- GD3: track=録音日時 / game=ROM 名(本ツールの曲名表示は "game - track")
    local fields = utf16("gameplay " .. os.date("%Y-%m-%d %H:%M")) .. utf16("") .. utf16(romName) .. utf16("") ..
                   utf16(C.system) .. utf16("") .. utf16("") .. utf16("") ..
                   utf16(os.date("%Y/%m/%d")) .. utf16("Mesen 2 + vgm-recorder.lua") ..
                   utf16("Recorded during gameplay (sound effects and lag frames included)")
    out("Gd3 " .. u32(0x100) .. u32(#fields) .. fields)
    pos = file:seek("end")
  end
  file:seek("set", 0x04); out(u32(pos - 4))
  if final then file:seek("set", 0x14); out(u32(gd3Pos - 0x14)) end
  file:seek("set", 0x18); out(u32(frameSample))
  if C.patchHeader then C.patchHeader() end
  file:seek("end")
  file:flush()
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
  frameSample = 0; emittedSamples = 0; recFrames = 0
  if C.startRecording then C.startRecording() end
  writeHeader()
  C.emitInitial()
  recording = true
  emu.log("REC start → " .. filePath)
  emu.displayMessage("VGM", "REC start")
end

local function stopRecording()
  if not recording then return end
  recording = false
  if C.beforeEmit then C.beforeEmit() end
  patchHeader(true)
  file:close(); file = nil
  emu.log(string.format("REC stop: %d frames (%.1fs) → %s", recFrames, recFrames / 60, filePath))
  emu.displayMessage("VGM", string.format("REC stop (%d frames)", recFrames))
end

-- ================================================================ 機種表
local CONSOLES = {}

-- ---------------------------------------------------------------- NES / FC
do
  local NES_APU_CLOCK = 1789772
  local fdsSeen = false
  local dpcmCache = {}         -- "addr:len" → サンプル本体(文字列)
  local mapper = nil
  local extBits = 0            -- 使う拡張音源(FDS を除く)
  local ext = nil              -- 溜めている拡張音源書き込み { t, parts }
  -- 拡張音源の影: VRC7 はレジスタ番号→値、N163 は RAM 128 バイトとポインタ、SUNSOFT 5B はレジスタ番号→値
  local vrc7Sel, vrc7Regs = 0, {}
  local n163Ram, n163Ptr, n163Inc = {}, 0, false
  local fme7Sel, fme7Regs = 0, {}

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
      if recording then extWrite(ea, value, false, now()) end
      return
    end
    shadow[addr] = value
    if not recording then return end
    local aa = mapAddr(addr)
    if aa == nil then return end
    if addr == 0x4023 or (addr >= 0x4040 and addr <= 0x409E) then fdsSeen = true end
    local t = now()
    flushExt()
    if addr == 0x4015 and (value & 0x10) ~= 0 then emitDpcmBlock(t) end
    flushWait(t)
    out(string.char(0xB4, aa, value & 0xFF))
  end

  -- N163 $4800 の読み出し(ポインタが進む)。書き込みと同じ列に read 印で入れる
  local function onReadN163(addr, value)
    if (addr & 0xF800) ~= 0x4800 then return end
    if n163Inc then n163Ptr = (n163Ptr + 1) & 0x7F end
    if recording then extWrite(0x4800, 0, true, now()) end
  end

  CONSOLES.nes = {
    system = "Nintendo Famicom / NES",
    init = function(info)
      mapper = CFG.mapper
      if mapper == nil and info then
        local ok, m = pcall(readMapperFromRom, info.path)
        if ok then mapper = m end
      end
      extBits = mapper and extBitsForMapper(mapper) or 0
      return string.format("mapper %s, expansion bits %d", tostring(mapper), extBits)
    end,
    hook = function()
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
    end,
    header = function(h) h.set32(0x84, NES_APU_CLOCK) end,  -- bit31=FDS は patchHeader で
    afterHeader = function()
      -- 拡張音源のヘッダブロック(ストリーム先頭、初期書き込みより前)
      if extBits ~= 0 then out(nesxBlock(0, string.char(extBits))) end
    end,
    patchHeader = function()
      file:seek("set", 0x84); out(u32(NES_APU_CLOCK | (fdsSeen and 0x80000000 or 0)))
    end,
    startRecording = function() fdsSeen = false; dpcmCache = {}; ext = nil end,
    beforeEmit = flushExt,
    endFrame = flushExt,  -- 拡張音源の書き込みはそのフレームの中に置く
    -- 録音開始時: 影レジスタの内容をフレーム 0 の頭にまとめて書く
    emitInitial = function()
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
    end,
    reset = function()
      vrc7Regs = {}; n163Ram = {}; n163Ptr = 0; n163Inc = false; fme7Regs = {}
    end,
  }
end

-- ---------------------------------------------------------------- ゲームボーイ / GBC
do
  local GB_CLOCK = 4194304
  local BASE = 0xFF10
  local function onWrite(addr, value)
    shadow[addr] = value
    if recording then emitReg(0xB3, addr - BASE, value) end
  end
  CONSOLES.gb = {
    system = "Nintendo Game Boy",
    init = function() return "" end,
    hook = function() emu.addMemoryCallback(onWrite, emu.callbackType.write, 0xFF10, 0xFF3F) end,
    header = function(h) h.set32(0x80, GB_CLOCK) end,
    emitInitial = function()
      local function w(a, v) out(string.char(0xB3, a - BASE, v & 0xFF)) end
      local nr52 = shadow[0xFF26]
      if nr52 ~= nil and (nr52 & 0x80) == 0 then w(0xFF26, 0); return end  -- 音源電源 OFF のまま
      w(0xFF26, 0x80)                          -- 電源 ON(他のレジスタはこの後でないと書けない)
      if shadow[0xFF24] then w(0xFF24, shadow[0xFF24]) end  -- NR50 主音量
      if shadow[0xFF25] then w(0xFF25, shadow[0xFF25]) end  -- NR51 パン
      w(0xFF1A, 0)                             -- ch3 DAC off(波形 RAM を書くため)
      for a = 0xFF30, 0xFF3F do if shadow[a] then w(a, shadow[a]) end end
      for a = 0xFF10, 0xFF23 do
        local v = shadow[a]
        if v and a ~= 0xFF15 and a ~= 0xFF1F then
          -- NRx4 のトリガ(bit7)は落とす(鳴らし直さない。長さカウンタの状態は復元できない)
          if a == 0xFF14 or a == 0xFF19 or a == 0xFF1E or a == 0xFF23 then v = v & 0x7F end
          w(a, v)
        end
      end
    end,
    reset = function() end,
  }
end

-- ---------------------------------------------------------------- PC エンジン
do
  local PCE_CLOCK = 3579545
  local sel = 0
  local global = {}            -- r1(主音量) r8 r9(LFO)
  local ch = {}                -- [0..5] = { reg={}, wave={}, wptr=0, ctrl=0, hasWave=false }
  local function resetState()
    sel = 0; global = {}; ch = {}
    for i = 0, 5 do ch[i] = { reg = {}, wave = {}, wptr = 0, ctrl = 0, hasWave = false } end
  end
  resetState()
  local function onWrite(addr, value)
    local r = addr - CFG.pcePsgBase
    if r == 0 then sel = value & 7
    elseif r == 1 or r == 8 or r == 9 then global[r] = value
    elseif sel < 6 then
      local c = ch[sel]
      if r == 4 then
        -- DDA(bit6)が 1→0 で波形ポインタが 0 に戻る(apuHuC6280.js と同じ)
        if (c.ctrl & 0x40) ~= 0 and (value & 0x40) == 0 then c.wptr = 0 end
        c.ctrl = value
      elseif r == 6 then
        -- DDA 中は DAC 直書き(波形には入らない)。ch が鳴っている間は実機のポインタは再生で動くが、
        -- ゲームは止めてから書くのが普通なので書き込み順の影で足りる
        if (c.ctrl & 0x40) == 0 then c.wave[c.wptr] = value; c.wptr = (c.wptr + 1) & 31; c.hasWave = true end
      else c.reg[r] = value end
    end
    if recording then emitReg(0xB9, r, value) end
  end
  CONSOLES.pce = {
    system = "NEC PC Engine",
    init = function() return string.format("PSG at $%04X", CFG.pcePsgBase) end,
    hook = function() emu.addMemoryCallback(onWrite, emu.callbackType.write, CFG.pcePsgBase, CFG.pcePsgBase + 9) end,
    header = function(h) h.set32(0xA4, PCE_CLOCK) end,
    emitInitial = function()
      local function w(r, v) out(string.char(0xB9, r, v & 0xFF)) end
      w(1, global[1] or 0xFF)  -- 主音量
      for i = 0, 5 do
        local c = ch[i]
        local any = c.hasWave or c.ctrl ~= 0 or next(c.reg) ~= nil
        if any then
          w(0, i)
          if c.reg[2] then w(2, c.reg[2]) end
          if c.reg[3] then w(3, c.reg[3]) end
          if c.reg[5] then w(5, c.reg[5]) end
          if c.reg[7] then w(7, c.reg[7]) end
          if c.hasWave then
            w(4, 0x40); w(4, 0x00)  -- DDA を立てて戻し、波形ポインタを 0 に
            for k = 0, 31 do w(6, c.wave[k] or 0) end
          end
          w(4, c.ctrl)  -- イネーブル(bit7)を最後に
        end
      end
      if global[8] then w(8, global[8]) end
      if global[9] then w(9, global[9]) end
      w(0, sel)
    end,
    reset = resetState,
  }
end

-- ---------------------------------------------------------------- マスターシステム / ゲームギア
do
  local SN_CLOCK = 3579545
  local latchCh, latchType = 0, 0
  local tone, vol, noise, ggStereo = {}, {}, nil, nil
  local function resetState() latchCh, latchType = 0, 0; tone = {}; vol = {}; noise = nil; ggStereo = nil end
  local function onPort(port, value)
    if (value & 0x80) ~= 0 then
      latchCh, latchType = (value >> 5) & 3, (value >> 4) & 1
      if latchType == 1 then vol[latchCh] = value & 0x0F
      elseif latchCh == 3 then noise = value & 0x07
      else tone[latchCh] = ((tone[latchCh] or 0) & 0x3F0) | (value & 0x0F) end
    else
      if latchType == 1 then vol[latchCh] = value & 0x0F
      elseif latchCh == 3 then noise = value & 0x07
      else tone[latchCh] = ((tone[latchCh] or 0) & 0x00F) | ((value & 0x3F) << 4) end
    end
    if recording then emitByte(0x50, value) end
  end
  local function onPortGg(port, value)
    ggStereo = value
    if recording then emitByte(0x4F, value) end
  end
  local function make(isGg)
    return {
      system = isGg and "Sega Game Gear" or "Sega Master System",
      init = function() return "" end,
      hook = function()
        -- Mesen 2(2.2.1 で実測)はポート書き込みのコールバックを smsPort 型では鳴らさず、ポート番号を
        -- CPU アドレスとみなした絶対アドレス(= ROM の先頭 256 バイト、smsPrgRom 型)に当ててくる。
        -- 両方登録しておく(どちらか一方しか当たらない。ROM の $0040-$007F への書き込みは誤検出になるが実用上無い)
        for _, mt in ipairs({ emu.memType.smsPort, emu.memType.smsPrgRom }) do
          emu.addMemoryCallback(onPort, emu.callbackType.write, 0x40, 0x7F, emu.cpuType.sms, mt)
          if isGg then emu.addMemoryCallback(onPortGg, emu.callbackType.write, 0x06, 0x06, emu.cpuType.sms, mt) end
        end
      end,
      header = function(h)
        h.set32(0x0C, SN_CLOCK)
        h.set16(0x28, 0x0009); h.set8(0x2A, 16); h.set8(0x2B, 0)  -- Sega 既定の feedback / shift / flags
      end,
      emitInitial = function()
        local function w(v) out(string.char(0x50, v & 0xFF)) end
        for c = 0, 2 do
          if tone[c] then w(0x80 | (c << 5) | (tone[c] & 0x0F)); w((tone[c] >> 4) & 0x3F) end
        end
        if noise then w(0xE0 | noise) end
        if ggStereo then out(string.char(0x4F, ggStereo & 0xFF)) end
        for c = 0, 3 do if vol[c] then w(0x90 | (c << 5) | vol[c]) end end  -- 音量を最後に
      end,
      reset = resetState,
    }
  end
  CONSOLES.sms = make(false)
  CONSOLES.gg = make(true)
end

-- ---------------------------------------------------------------- フック(共通)
local function onStartFrame()
  if CFG.preciseTiming then
    local st = emu.getState()
    local c = st.masterClock or 0
    if frameStartClock > 0 and c > frameStartClock then cyclesPerFrame = c - frameStartClock end
    frameStartClock = c
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
    if C.endFrame then C.endFrame() end
    recFrames = recFrames + 1
    frameSample = recFrames * SAMPLES_PER_FRAME
    if CFG.flushEvery > 0 and recFrames % CFG.flushEvery == 0 then
      flushWait(frameSample)
      patchHeader(false)
    end
    pcall(emu.drawString, 2, 2, string.format("REC %d (%.1fs)", recFrames, recFrames / 60), 0xFF4040, 0x000000)
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
  if C.reset then C.reset() end
end

local function onScriptEnded()
  stopRecording()
end

-- ---------------------------------------------------------------- 機種判定と登録
local function detectConsole()
  if CFG.console then return CFG.console end
  local ok, st = pcall(emu.getState)
  local ct = (ok and st) and st.consoleType or nil
  if ct == "Nes" then return "nes"
  elseif ct == "Gameboy" then return "gb"
  elseif ct == "PcEngine" then return "pce"
  elseif ct == "Sms" then return (romExt == "gg") and "gg" or "sms"
  end
  -- consoleType が取れなければ拡張子で
  local byExt = { nes = "nes", fds = "nes", nsf = "nes", unf = "nes", gb = "gb", gbc = "gb", gbs = "gb",
                  pce = "pce", hes = "pce", sms = "sms", sg = "sms", gg = "gg" }
  return byExt[romExt] or "nes"
end

do
  local info = emu.getRomInfo()
  if info and info.name then
    romName = info.name:gsub("%.[^%.]+$", "")
    romExt = (info.name:match("%.([^%.]+)$") or ""):lower()
  end
  local kind = detectConsole()
  C = CONSOLES[kind]
  if not C then emu.log("vgm-recorder: unknown console '" .. tostring(kind) .. "'"); return end
  local detail = C.init(info) or ""
  C.hook()
  emu.addEventCallback(onStartFrame, emu.eventType.startFrame)
  emu.addEventCallback(onEndFrame, emu.eventType.endFrame)
  emu.addEventCallback(onReset, emu.eventType.reset)
  emu.addEventCallback(onScriptEnded, emu.eventType.scriptEnded)
  emu.log(string.format("vgm-recorder: ready (%s, %s to start/stop%s)",
    kind, CFG.toggleKey or "no key", detail ~= "" and (", " .. detail) or ""))
end
if CFG.autoStart then startRecording() end
