// Subtitle Lens – content script
// Ctrl+Q toggles "pick mode". In pick mode the video pauses and any word in the
// on-screen subtitles can be clicked to open the lookup overlay.
(function () {
  if (window.__subtitleLensLoaded) return;
  window.__subtitleLensLoaded = true;

  const UI = globalThis.SubtitleLensUI;
  const IS_TOP = window === window.top;

  // Subtitle containers of popular players / sites.
  const SUB_SELECTORS = [
    // YouTube
    '.ytp-caption-segment', '.caption-window', '.ytp-caption-window-container',
    // Netflix
    '.player-timedtext', '.player-timedtext-text-container',
    // Prime Video
    '.atvwebplayersdk-captions-text', '.atvwebplayersdk-captions-overlay',
    // Disney+
    '.dss-subtitle-renderer-cue', '.dss-subtitle-renderer-line', '.dss-subtitle-renderer-cue-window',
    // Max / HBO
    '[data-testid="CueBoxContainer"]', '[data-testid="caption_renderer_overlay"]',
    // Hulu
    '.CaptionBox', '.ClosedCaption', '.caption-text-box',
    // Generic players
    '.vjs-text-track-display', '.vjs-text-track-cue',      // video.js
    '.vp-captions',                                        // Vimeo
    '.jw-text-track-container', '.jw-captions',            // JW Player
    '.plyr__captions', '.plyr__caption',                   // Plyr
    '.shaka-text-container',                               // Shaka
    '.bmpui-ui-subtitle-overlay', '.bmpui-subtitle-region-container', // Bitmovin
    '.mejs__captions-layer', '.mejs-captions-layer',       // MediaElement
    '.fp-captions', '.flowplayer .fp-subtitle',            // Flowplayer
    '.dplayer-subtitle', '.art-subtitle'                   // DPlayer / ArtPlayer
  ].join(',');

  const GENERIC_SELECTORS = '[class*="subtitle" i], [class*="caption" i], [class*="timedtext" i], [class*="cue" i]';
  const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

  let pickMode = false;
  let pausedByUs = null;
  let settings = { pauseVideoOnPick: true };
  let barTimer = null;
  let blockNextClick = false;

  // ------------------------------------------------------------------ styles
  const style = document.createElement('style');
  style.textContent = `
    html.subtitle-lens-pick, html.subtitle-lens-pick * { cursor: help !important; }
    html.subtitle-lens-pick ${SUB_SELECTORS.split(',').map(s => s.trim()).join(', html.subtitle-lens-pick ')} {
      pointer-events: auto !important; user-select: text !important;
    }`;
  const addStyle = () => (document.head || document.documentElement).appendChild(style);
  if (document.documentElement) addStyle(); else document.addEventListener('DOMContentLoaded', addStyle);

  // --------------------------------------------------------------- helpers
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05;
  }

  function videos() {
    return [...document.querySelectorAll('video')].filter(isVisible);
  }

  function mainVideo() {
    let best = null, area = 0;
    for (const v of videos()) {
      const r = v.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > area) { area = a; best = v; }
    }
    return best;
  }

  function cleanCue(text) {
    return String(text || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\{\\[^}]*\}/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function rectsIntersect(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  // Text of the subtitles that are currently on screen.
  function currentSubtitleText() {
    // 1) Known DOM subtitle containers (outermost visible ones only)
    const known = [...document.querySelectorAll(SUB_SELECTORS)]
      .filter(isVisible)
      .filter((el, _, all) => !all.some(o => o !== el && o.contains(el)));
    let text = known.map(el => el.innerText || el.textContent).join(' ');
    text = cleanCue(text);
    if (text) return text;

    // 2) Native <track> captions (rendered by the browser, not clickable in the DOM)
    for (const v of videos()) {
      for (const track of v.textTracks || []) {
        if (track.mode === 'disabled' || !track.activeCues) continue;
        const t = [...track.activeCues].map(c => cleanCue(c.text)).filter(Boolean).join(' ');
        if (t) return t;
      }
    }

    // 3) Generic: caption-ish elements that sit on top of a video
    const vids = videos().map(v => v.getBoundingClientRect());
    if (vids.length) {
      const gen = [...document.querySelectorAll(GENERIC_SELECTORS)]
        .filter(isVisible)
        .filter(el => {
          const r = el.getBoundingClientRect();
          return vids.some(vr => rectsIntersect(r, vr)) && (el.innerText || '').trim().length < 400;
        })
        .filter((el, _, all) => !all.some(o => o !== el && o.contains(el)));
      text = cleanCue(gen.map(el => el.innerText).join(' '));
      if (text) return text;
    }
    return '';
  }

  // Find the word under (x, y) inside a list of text nodes.
  function wordInTextNodes(nodes, x, y) {
    const range = document.createRange();
    const PAD = 2;
    for (const node of nodes) {
      const text = node.nodeValue;
      if (!text || !text.trim()) continue;
      // quick reject using the whole node's box
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      if (x < box.left - PAD || x > box.right + PAD || y < box.top - PAD || y > box.bottom + PAD) continue;
      WORD_RE.lastIndex = 0;
      let m;
      while ((m = WORD_RE.exec(text))) {
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        for (const r of range.getClientRects()) {
          if (x >= r.left - PAD && x <= r.right + PAD && y >= r.top - PAD && y <= r.bottom + PAD) {
            return { word: m[0].replace(/[’'-]+$/, ''), node };
          }
        }
      }
    }
    return null;
  }

  function textNodesUnder(el) {
    const out = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function contextFor(node) {
    const el = node.parentElement;
    if (!el) return '';
    const container = el.closest(SUB_SELECTORS) || el.closest(GENERIC_SELECTORS);
    if (container) {
      // climb to the outermost subtitle container for the full line
      let top = container, p = container.parentElement;
      while (p && p.closest && p.matches(SUB_SELECTORS)) { top = p; p = p.parentElement; }
      return cleanCue(top.innerText || top.textContent).slice(0, 400);
    }
    // generic: nearest block-ish ancestor
    let block = el;
    while (block && block.parentElement && (block.innerText || '').length < 25) block = block.parentElement;
    return cleanCue((block && (block.innerText || block.textContent)) || el.textContent).slice(0, 400);
  }

  function isOurs(e) {
    const path = e.composedPath ? e.composedPath() : [];
    return path.some(n => n && n.tagName && /^SUBTITLE-LENS-/.test(n.tagName));
  }

  function findWordAt(x, y) {
    // 1) Known subtitle containers (works even if they had pointer-events:none)
    const subs = [...document.querySelectorAll(SUB_SELECTORS)].filter(isVisible);
    for (const el of subs) {
      const r = el.getBoundingClientRect();
      if (x < r.left - 4 || x > r.right + 4 || y < r.top - 4 || y > r.bottom + 4) continue;
      const hit = wordInTextNodes(textNodesUnder(el), x, y);
      if (hit) return hit;
    }
    // 2) Any element under the cursor (generic sites, custom players)
    const stack = document.elementsFromPoint(x, y);
    for (const el of stack) {
      if (/^SUBTITLE-LENS-/.test(el.tagName) || el.tagName === 'VIDEO') continue;
      const direct = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE);
      const hit = wordInTextNodes(direct, x, y);
      if (hit) return hit;
    }
    return null;
  }

  // ------------------------------------------------------------ pick bar
  // Shows the pick-mode hint and a clickable copy of the current subtitle line.
  // The copy is essential for native <track> captions, which aren't in the DOM.
  const bar = (() => {
    const host = document.createElement('subtitle-lens-bar');
    host.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483646;pointer-events:none;display:none;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host { all: initial; }
      .wrap { position: fixed; left: 50%; transform: translateX(-50%); bottom: 18%; max-width: 86vw;
              display: flex; flex-direction: column; align-items: center; gap: 8px;
              font: 14px/1.4 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
      .hint { pointer-events: auto; background: rgba(20,22,28,.92); color: #e9ecf2; border: 1px solid #3a4153;
              border-radius: 999px; padding: 6px 14px; box-shadow: 0 6px 24px rgba(0,0,0,.4); white-space: nowrap; }
      .hint b { color: #ffd27a; }
      .line { pointer-events: auto; background: rgba(10,12,16,.88); color: #fff; border-radius: 10px;
              padding: 8px 14px; font-size: 22px; line-height: 1.5; text-align: center; border: 1px solid #3a4153; }
      .line:empty { display: none; }
      .w { cursor: pointer; border-radius: 4px; padding: 0 2px; }
      .w:hover { background: #6c8cff; color: #fff; }
      .x { cursor: pointer; margin-left: 8px; color: #8b93a7; }
    </style>
    <div class="wrap"><div class="line"></div>
      <div class="hint">🔎 <b>Subtitle Lens</b> – click any subtitle word &nbsp;·&nbsp; <b>Ctrl+Q</b> / <b>Esc</b> to exit<span class="x" title="Exit">✕</span></div>
    </div>`;
    const line = root.querySelector('.line');
    let lastText = null;
    root.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target.closest('.x')) return togglePick();
      const w = e.target.closest('.w');
      if (w) UI.panel.show(w.dataset.w, line.dataset.text || '');
    });
    ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick'].forEach(t =>
      host.addEventListener(t, e => e.stopPropagation()));

    return {
      host,
      showHint: true,
      mount() {
        const fs = document.fullscreenElement || document.webkitFullscreenElement;
        const target = fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
        if (host.parentNode !== target) target.appendChild(host);
      },
      show() { this.mount(); host.style.display = 'block'; this.update(); },
      hide() { host.style.display = 'none'; lastText = null; },
      update() {
        const text = currentSubtitleText();
        if (text === lastText) return;
        lastText = text;
        line.dataset.text = text;
        line.innerHTML = text
          ? UI.wrapWords(text, (w, e) => `<span class="w" data-w="${e}">${e}</span>`)
          : '';
        root.querySelector('.hint').style.display = this.showHint ? '' : 'none';
      }
    };
  })();

  // ------------------------------------------------------------ pick mode
  function shouldShowUI() {
    if (videos().length) return true;
    return IS_TOP && !document.querySelector('iframe');
  }

  async function setPick(on) {
    if (on === pickMode) return;
    pickMode = on;
    document.documentElement.classList.toggle('subtitle-lens-pick', on);
    if (on) {
      try { settings = await UI.send({ type: 'getSettings' }); } catch (_) {}
      if (!pickMode) return;
      const v = mainVideo();
      if (v && settings.pauseVideoOnPick !== false && !v.paused) {
        try { v.pause(); pausedByUs = v; } catch (_) {}
      }
      if (shouldShowUI()) {
        bar.show();
        clearInterval(barTimer);
        barTimer = setInterval(() => bar.update(), 400);
      }
    } else {
      clearInterval(barTimer);
      bar.hide();
      if (UI.panel.isOpen) UI.panel.hide();
      if (pausedByUs) {
        try { pausedByUs.play(); } catch (_) {}
        pausedByUs = null;
      }
    }
  }

  function togglePick() {
    // Ask the background to broadcast so all frames (incl. player iframes) switch together.
    UI.send({ type: 'togglePick' }).catch(() => setPick(!pickMode));
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'pickToggle') setPick(!pickMode);
  });

  // ------------------------------------------------------------ keyboard
  window.addEventListener('keydown', (e) => {
    const isCtrlQ = e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && (e.code === 'KeyQ' || e.key === 'q' || e.key === 'Q');
    if (isCtrlQ) {
      e.preventDefault();
      e.stopImmediatePropagation();
      togglePick();
      return;
    }
    if (e.key === 'Escape' && (pickMode || UI.panel.isOpen)) {
      e.stopImmediatePropagation();
      if (UI.panel.isOpen) UI.panel.hide();
      else togglePick();
    }
  }, true);

  // ------------------------------------------------------------ mouse
  function onPointerDown(e) {
    blockNextClick = false;
    if (!pickMode || e.button !== 0 || isOurs(e)) return;
    const hit = findWordAt(e.clientX, e.clientY);
    if (!hit) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    blockNextClick = true;
    const ctx = contextFor(hit.node) || currentSubtitleText();
    UI.panel.show(hit.word, ctx);
  }

  function swallow(e) {
    if (!pickMode || isOurs(e)) return;
    if (blockNextClick) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'click') blockNextClick = false;
    }
  }

  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('mousedown', swallow, true);
  window.addEventListener('pointerup', swallow, true);
  window.addEventListener('mouseup', swallow, true);
  window.addEventListener('click', swallow, true);
  window.addEventListener('dblclick', (e) => { if (pickMode && !isOurs(e)) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);

  // Keep overlays visible when entering / leaving fullscreen.
  const remount = () => {
    if (bar.host.style.display !== 'none') bar.mount();
    if (UI.panel.isOpen) UI.panel.mount();
  };
  document.addEventListener('fullscreenchange', remount);
  document.addEventListener('webkitfullscreenchange', remount);

  // If the user resumes the video manually we no longer need to resume it ourselves.
  document.addEventListener('play', (e) => { if (e.target === pausedByUs) pausedByUs = null; }, true);
})();
