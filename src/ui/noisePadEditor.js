/*
 * ノイズパッドの音色エディタ(ポップオーバー) — MML.UI.NoisePadEditor (2026-09-18)
 *
 *   MML.UI.NoisePadEditor.open(anchorEl, {
 *     tone, presetId, presetName, builtin, modified,   … 編集の出発点(パッドの現在の音色とプリセットの出自)
 *     onApplyPad(tone)                                   … 「このパッドだけに適用」(drumSamples の noise.custom)
 *     onSavePreset(id|null, name, tone)                  … プリセットを更新(id) / 新規(null)
 *     onDeletePreset(id) / onResetPreset(id)             … 追加分の削除 / 組み込みを元に戻す
 *     onAudition(tone)                                   … 試聴(main.js が MML.Mml.render で鳴らす)
 *   })
 *   MML.UI.NoisePadEditor.close()
 *
 * 音色の形は src/convert/noisePresets.js 冒頭。表は "15 12 8 | 4 0" の文字で編集する(| がループ位置、
 * MMLの定義と同じ書き方)。設定範囲: 周期 n0-15 / 長短 @0,@1 / 音量 v か @v / @EP / @EN / D。
 * ドラム(DPCM)パネル(src/ui/drumPanel.js)の ✎ ボタンから開く。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};
  const T = (key, params) => (MML.I18n ? MML.I18n.t(key, params) : key);

  let el = null;
  let onKey = null;

  const NOISE_PERIOD = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
  function idxLabel(i) {
    const hz = 1789773 / NOISE_PERIOD[i];
    const rate = hz >= 1000 ? (hz / 1000).toFixed(1) + 'kHz' : Math.round(hz) + 'Hz';
    const short = (hz / 93);
    const shortLabel = short >= 1000 ? (short / 1000).toFixed(2) + 'kHz' : short.toFixed(1) + 'Hz';
    return `n${i}  (${rate} / @1: ${shortLabel})`;
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function close() {
    if (el) { el.remove(); el = null; }
    if (onKey) { document.removeEventListener('keydown', onKey); onKey = null; }
  }

  function open(anchor, opt) {
    close();
    const NP = MML.Convert.NoisePresets;
    if (!NP) return;
    opt = opt || {};
    const tone = NP.sanitizeTone(opt.tone || NP.DEFAULT_TONE);
    const presetId = opt.presetId || null;
    const box = document.createElement('div');
    box.className = 'npe';
    box.innerHTML =
      `<div class="npe-title">${esc(opt.title || T('ノイズの音色'))}<button type="button" class="npe-close" aria-label="${T('閉じる')}">×</button></div>` +
      `<label class="npe-row"><span>${T('名前')}</span><input type="text" class="npe-name" value="${esc(opt.presetName || '')}" placeholder="${T('プリセット名(保存する時に使う)')}"></label>` +
      `<label class="npe-row"><span>${T('周期')}</span><select class="npe-idx">${NOISE_PERIOD.map((_, i) => `<option value="${i}">${esc(idxLabel(i))}</option>`).join('')}</select></label>` +
      `<label class="npe-row"><span>${T('長短')}</span><select class="npe-mode"><option value="0">@0 ${T('長周期(ホワイトノイズ)')}</option><option value="1">@1 ${T('短周期(金属的・音程感)')}</option></select></label>` +
      `<div class="npe-row npe-vol"><span>${T('音量')}</span>` +
        `<label><input type="radio" name="npe-voltype" value="v"> v</label><input type="number" class="npe-v" min="0" max="15" step="1">` +
        `<label><input type="radio" name="npe-voltype" value="env"> @v</label><input type="text" class="npe-env" placeholder="15 12 8 4 0" spellcheck="false">` +
      `</div>` +
      `<label class="npe-row"><span>@EP</span><input type="text" class="npe-ep" placeholder="${T('例: 0 -1 -1 -1 (空=なし。正=音程が上がる)')}" spellcheck="false"></label>` +
      `<label class="npe-row"><span>@EN</span><input type="text" class="npe-en" placeholder="${T('例: 0 2 2 (空=なし。正=index+1=下がる、16で巡回)')}" spellcheck="false"></label>` +
      `<label class="npe-row"><span>D</span><input type="number" class="npe-d" min="-127" max="126" step="1"><i class="npe-hint">${T('ディチューン(0=なし。D16 n0 の桁あふれ技は長短の @1 で代用可)')}</i></label>` +
      `<div class="npe-err" hidden></div>` +
      `<div class="npe-btns">` +
        `<button type="button" class="npe-play">♪ ${T('試聴')}</button>` +
        `<button type="button" class="npe-apply">${T('このパッドだけに適用')}</button>` +
        (presetId ? `<button type="button" class="npe-update">${T('プリセット「{name}」を更新', { name: opt.presetName || presetId })}</button>` : '') +
        `<button type="button" class="npe-saveas">${T('新しいプリセットとして保存')}</button>` +
        (presetId && !opt.builtin ? `<button type="button" class="npe-delete secondary">${T('プリセットを削除')}</button>` : '') +
        (presetId && opt.builtin && opt.modified ? `<button type="button" class="npe-reset secondary">${T('組み込みの値に戻す')}</button>` : '') +
      `</div>`;
    document.body.appendChild(box);
    el = box;

    const q = (s) => box.querySelector(s);
    q('.npe-idx').value = String(tone.idx);
    q('.npe-mode').value = String(tone.mode);
    const isEnv = tone.vol.type === 'env';
    box.querySelector(`input[name="npe-voltype"][value="${isEnv ? 'env' : 'v'}"]`).checked = true;
    q('.npe-v').value = isEnv ? 12 : tone.vol.v;
    q('.npe-env').value = isEnv ? NP.formatTable(tone.vol) : '';
    q('.npe-ep').value = tone.ep ? NP.formatTable(tone.ep) : '';
    q('.npe-en').value = tone.en ? NP.formatTable(tone.en) : '';
    q('.npe-d').value = tone.detune || 0;

    // 入力欄をいじったら自動でそのモードへ(ラジオを触る手間を省く)
    q('.npe-v').addEventListener('input', () => { box.querySelector('input[name="npe-voltype"][value="v"]').checked = true; });
    q('.npe-env').addEventListener('input', () => { box.querySelector('input[name="npe-voltype"][value="env"]').checked = true; });

    const showErr = (msg) => { const e = q('.npe-err'); e.textContent = msg || ''; e.hidden = !msg; };
    function read() {
      const volType = box.querySelector('input[name="npe-voltype"]:checked').value;
      let vol;
      if (volType === 'env') {
        const tbl = NP.parseTable(q('.npe-env').value, 0, 15);
        if (!tbl) { showErr(T('@v の表を読めません(例: 15 12 8 | 4 0)')); return null; }
        vol = { type: 'env', values: tbl.values, loop: tbl.loop };
      } else {
        vol = { type: 'v', v: parseInt(q('.npe-v').value, 10) };
      }
      const epStr = q('.npe-ep').value.trim(), enStr = q('.npe-en').value.trim();
      const ep = epStr ? NP.parseTable(epStr, -127, 126) : null;
      if (epStr && !ep) { showErr(T('@EP の表を読めません')); return null; }
      const en = enStr ? NP.parseTable(enStr, -127, 126) : null;
      if (enStr && !en) { showErr(T('@EN の表を読めません')); return null; }
      showErr('');
      return NP.sanitizeTone({
        idx: parseInt(q('.npe-idx').value, 10), mode: parseInt(q('.npe-mode').value, 10),
        vol, ep, en, detune: parseInt(q('.npe-d').value, 10) || 0,
      });
    }
    const nameOf = () => q('.npe-name').value.trim();

    q('.npe-close').addEventListener('click', close);
    q('.npe-play').addEventListener('click', () => { const t = read(); if (t && opt.onAudition) opt.onAudition(t); });
    q('.npe-apply').addEventListener('click', () => { const t = read(); if (t && opt.onApplyPad) { opt.onApplyPad(t); close(); } });
    const upd = q('.npe-update');
    if (upd) upd.addEventListener('click', () => { const t = read(); if (t && opt.onSavePreset) { opt.onSavePreset(presetId, nameOf() || opt.presetName, t); close(); } });
    q('.npe-saveas').addEventListener('click', () => {
      const t = read(); if (!t) return;
      const name = nameOf();
      if (!name) { showErr(T('名前を入れてください')); q('.npe-name').focus(); return; }
      if (opt.onSavePreset) { opt.onSavePreset(null, name, t); close(); }
    });
    const del = q('.npe-delete');
    if (del) del.addEventListener('click', () => { if (opt.onDeletePreset) { opt.onDeletePreset(presetId); close(); } });
    const rst = q('.npe-reset');
    if (rst) rst.addEventListener('click', () => { if (opt.onResetPreset) { opt.onResetPreset(presetId); close(); } });

    // 位置: アンカーの下。画面外へはみ出すなら内側へ寄せる(kbd-sample-menu と同じ)
    const rc = anchor.getBoundingClientRect();
    box.style.left = Math.round(Math.max(8, Math.min(rc.left, window.innerWidth - box.offsetWidth - 8))) + 'px';
    box.style.top = Math.round(Math.max(8, Math.min(rc.bottom + 4, window.innerHeight - box.offsetHeight - 8))) + 'px';
    onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    q('.npe-name').focus();
  }

  UI.NoisePadEditor = { open, close, isOpen: () => !!el };
})(window);
