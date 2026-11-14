/*
 * バーコードを入れる小窓 MML.UI.BarcodeDialog(ゲームボーイのバーコードボーイ、ファミコンのデータック/バーコードバトラー II の共用)
 *
 *   BarcodeDialog.open({ title, onDigits(digits) })  数字(13 桁か 8 桁)が決まったら onDigits を呼んで閉じる
 *   BarcodeDialog.close()
 *
 * 入れ方は 2 つ: 数字を打つ(12 桁/7 桁なら検査数字を足す)か、カメラでバーコードを写す。
 * カメラは getUserMedia の映像を canvas へ写し、input/barcodeScan.js で中ほどの行を読む(ブラウザに BarcodeDetector があればそれも使う)。
 * 検査数字が合わない数字を打った時は、確かめてからそのまま読ませることもできる(ゲームによっては合わない番号を使う)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};
  const T = (s, vars) => (MML.I18n && MML.I18n.t ? MML.I18n.t(s, vars) : s);

  let root = null, stream = null, raf = 0, video = null, canvas = null, detector = null, busy = false;

  function stopCamera() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
    if (video) { video.srcObject = null; video.hidden = true; }
  }
  function close() {
    stopCamera();
    if (root) { root.remove(); root = null; }
    video = null; canvas = null;
  }

  function open(opts) {
    close();
    opts = opts || {};
    const Ean = MML.Emu && MML.Emu.Ean;
    root = document.createElement('div');
    root.className = 'barcode-dlg';
    root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
    const box = document.createElement('div'); box.className = 'barcode-dlg-box';
    const title = document.createElement('div'); title.className = 'barcode-dlg-title'; title.textContent = opts.title || T('バーコードを読ませる');
    const row = document.createElement('div'); row.className = 'barcode-dlg-row';
    const input = document.createElement('input'); input.type = 'text'; input.inputMode = 'numeric'; input.maxLength = 20; input.className = 'barcode-dlg-input'; input.placeholder = T('数字 13 桁か 8 桁');
    const okBtn = document.createElement('button'); okBtn.type = 'button'; okBtn.textContent = T('読ませる');
    const camBtn = document.createElement('button'); camBtn.type = 'button'; camBtn.textContent = T('カメラで読む');
    const closeBtn = document.createElement('button'); closeBtn.type = 'button'; closeBtn.textContent = T('閉じる');
    const note = document.createElement('div'); note.className = 'barcode-dlg-note';
    video = document.createElement('video'); video.className = 'barcode-dlg-video'; video.playsInline = true; video.muted = true; video.hidden = true;
    canvas = document.createElement('canvas');
    row.appendChild(input); row.appendChild(okBtn);
    const row2 = document.createElement('div'); row2.className = 'barcode-dlg-row'; row2.appendChild(camBtn); row2.appendChild(closeBtn);
    box.appendChild(title); box.appendChild(row); box.appendChild(video); box.appendChild(note); box.appendChild(row2);
    root.appendChild(box); document.body.appendChild(root);
    const say = (s) => { note.textContent = s || ''; };
    let confirmBad = '';
    const submit = (digits) => { const cb = opts.onDigits; close(); if (cb) cb(digits); };
    const tryInput = () => {
      let d = Ean ? Ean.withCheck(input.value) : String(input.value).replace(/\D/g, '');
      if (d.length !== 13 && d.length !== 8) { say(T('13 桁か 8 桁の数字を入れてください(12 桁/7 桁なら検査数字を足します)')); return; }
      if (Ean && !Ean.check(d) && confirmBad !== d) { confirmBad = d; say(T('検査数字が合いません。このまま読ませるなら、もう一度押してください')); return; }
      submit(d);
    };
    okBtn.addEventListener('click', tryInput);
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') tryInput(); else if (e.key === 'Escape') close(); });
    closeBtn.addEventListener('click', close);
    camBtn.addEventListener('click', async () => {
      if (stream) { stopCamera(); camBtn.textContent = T('カメラで読む'); say(''); return; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { say(T('このブラウザではカメラを使えません')); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } catch (e) { say(T('カメラを開けません({msg})', { msg: e && e.name ? e.name : String(e) })); return; }
      if (!root) { for (const t of stream.getTracks()) t.stop(); stream = null; return; } // 許可を待つ間に閉じられた
      video.srcObject = stream; video.hidden = false;
      try { await video.play(); } catch (e) { /* 自動再生不可でも frame は取れることがある */ }
      camBtn.textContent = T('カメラを止める');
      say(T('バーコードを横向きのまま、枠いっぱいに写してください'));
      if (!detector && typeof global.BarcodeDetector === 'function') { try { detector = new global.BarcodeDetector({ formats: ['ean_13', 'ean_8'] }); } catch (e) { detector = null; } }
      let last = 0;
      const tick = (now) => {
        raf = requestAnimationFrame(tick);
        if (!video || now - last < 120 || busy || video.readyState < 2 || !video.videoWidth) return;
        last = now;
        const w = Math.min(960, video.videoWidth), h = Math.round(video.videoHeight * w / video.videoWidth);
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const S = MML.Input && MML.Input.BarcodeScan;
        const got = S ? S.scanImage(img.data, w, h) : null;
        if (got) { input.value = got; submit(got); return; }
        if (detector) {
          busy = true;
          detector.detect(canvas).then((list) => { busy = false; if (!root) return; const c = list && list.find((x) => /^\d{8}$|^\d{13}$/.test(x.rawValue || '')); if (c) { input.value = c.rawValue; submit(c.rawValue); } }).catch(() => { busy = false; });
        }
      };
      raf = requestAnimationFrame(tick);
    });
    setTimeout(() => { if (input.isConnected) input.focus(); }, 0);
    return root;
  }

  UI.BarcodeDialog = { open, close, get isOpen() { return !!root; } };
})(typeof window !== 'undefined' ? window : globalThis);
