-- Mesen 2 headless で「決まったフレームにボタンを押し、決まったフレームで画面を PNG に保存」する。
-- 自前 NES エミュレータ(src/emulator/nes/、tools/headless/nes-run.js)の画面と見比べる基準を作るための物。
--
--   Mesen.exe --testRunner "game.nes" "tools/mesen/ref-screenshot.lua" --timeout=120
--
-- 設定はこのファイル冒頭の CFG(コピーして書き換える)。nes-run.js の --press と同じ意味:
--   press = { {btn="start", from=700, to=710}, {btn="right", from=900, to=1300} }
--   shots = { 1300 }  … このフレーム番号(0 始まり、runFrame の回数と同じ)の終わりに保存
--   out   = 保存先(フレーム番号が付く)。ScriptWindow.AllowIoOsAccess=true が要る
local CFG = {
  press = { {btn = "start", from = 700, to = 710}, {btn = "right", from = 900, to = 1300} },
  shots = { 1300 },
  out = "C:/Users/user/Desktop/mml/_tmp_test/nes/ref",
  stop = 1301,
}

local frame = 0
local function padAt(f)
  local p = {}
  for _, pr in ipairs(CFG.press) do
    if f >= pr.from and f <= pr.to then p[pr.btn] = true end
  end
  return p
end
local function shotSet()
  local s = {}
  for _, f in ipairs(CFG.shots) do s[f] = true end
  return s
end
local shots = shotSet()

emu.addEventCallback(function()
  -- startFrame: このフレームの入力を決める
  local ok, err = pcall(function()
    emu.setInput(padAt(frame), 0)
  end)
  if not ok then emu.log("setInput: " .. tostring(err)) end
end, emu.eventType.startFrame)

emu.addEventCallback(function()
  local ok, err = pcall(function()
    if shots[frame] then
      local png = emu.takeScreenshot()
      local f = io.open(CFG.out .. "_" .. frame .. ".png", "wb")
      f:write(png); f:close()
      emu.log("saved " .. CFG.out .. "_" .. frame .. ".png")
    end
    frame = frame + 1
    if frame >= CFG.stop then emu.stop(0) end
  end)
  if not ok then emu.log("endFrame: " .. tostring(err)) end
end, emu.eventType.endFrame)
