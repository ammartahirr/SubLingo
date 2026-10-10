// Subtitle Lens – shared word-lookup overlay.
// Used by the content script (on video sites) and by the Deep Learning page.
// Renders inside a Shadow DOM so site styles cannot break it.
(function () {
  if (globalThis.SubtitleLensUI) return;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function send(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message));
          if (!res) return reject(new Error('No response from extension'));
          if (!res.ok) return reject(new Error(res.error || 'Request failed'));
          resolve(res.data);
        });
      } catch (e) {
        reject(new Error('Extension was updated or reloaded – please refresh this page.'));
      }
    });
  }

  // Split raw text into words / non-words, escape both, and let `fn` render each word.
  // (Escaping first would break words like don't -> don&#39;t.)
  const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
  function wrapWords(text, fn) {
    text = String(text == null ? '' : text);
    let out = '', last = 0, m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text))) {
      out += esc(text.slice(last, m.index)) + fn(m[0], esc(m[0]));
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }

  // Wrap every word of `text` into a clickable span; highlight forms of `target`.
  function clickableText(text, target) {
    const f = target ? target.toLowerCase() : '';
    return wrapWords(text, (w, e) => {
      const lw = w.toLowerCase().replace(/’/g, "'");
      const hit = f && (lw === f || (f.length > 3 && lw.startsWith(f.slice(0, Math.max(3, f.length - 2)))));
      return `<span class="w${hit ? ' hit' : ''}" data-w="${e}">${e}</span>`;
    });
  }

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .panel {
    pointer-events: auto;
    position: fixed; top: 4vh; right: 24px; z-index: 2;
    width: min(460px, calc(100vw - 32px)); max-height: 92vh;
    display: flex; flex-direction: column;
    background: #14161c; color: #e9ecf2; border: 1px solid #2c313c; border-radius: 16px;
    box-shadow: 0 20px 60px rgba(0,0,0,.55);
    font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    overflow: hidden; animation: pop .14s ease-out;
  }
  @keyframes pop { from { transform: translateY(8px); opacity: 0 } to { transform: none; opacity: 1 } }
  header { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid #262b35;
           background: linear-gradient(135deg, #1d2230, #161a23); cursor: move; user-select: none; }
  header .word { font-size: 24px; font-weight: 700; color: #fff; letter-spacing: .2px; }
  header .ipa { color: #9fb3ff; font-size: 15px; }
  header .spacer { flex: 1; }
  button { font: inherit; color: inherit; background: #232836; border: 1px solid #343b4b; border-radius: 9px;
           padding: 5px 9px; cursor: pointer; line-height: 1.2; }
  button:hover { background: #2d3446; }
  button.icon { padding: 5px 8px; }
  .body { overflow-y: auto; padding: 6px 16px 16px; }
  section { margin-top: 14px; }
  h3 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #8b93a7; font-weight: 700; }
  .ctx { background: #1b2030; border-left: 3px solid #6c8cff; padding: 8px 10px; border-radius: 8px; }
  .ctx .line { color: #aab3c8; font-style: italic; margin-bottom: 4px; }
  .pos { display: inline-block; font-size: 11px; color: #ffd27a; background: #3a3220; border-radius: 6px; padding: 0 6px; margin-right: 6px; }
  ol, ul { margin: 0; padding-left: 20px; }
  li { margin: 5px 0; }
  .ex { color: #aab3c8; font-style: italic; display: block; }
  .say { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .syll { font-weight: 700; color: #b6f2c4; font-size: 16px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { background: #222838; border: 1px solid #343b4b; border-radius: 999px; padding: 2px 10px; cursor: pointer; }
  .chip:hover { border-color: #6c8cff; }
  .w { cursor: pointer; border-radius: 3px; }
  .w:hover { background: rgba(108,140,255,.25); }
  .w.hit { color: #ffd27a; font-weight: 700; }
  .sent { display: flex; gap: 6px; align-items: flex-start; }
  .sent button { padding: 1px 6px; font-size: 12px; flex: none; margin-top: 1px; }
  .muted { color: #8b93a7; }
  .note { background: #2b2417; color: #ffd9a0; border-radius: 8px; padding: 8px 10px; margin-top: 12px; font-size: 13px; }
  .loading { padding: 30px 0; text-align: center; color: #8b93a7; }
  .spinner { width: 28px; height: 28px; border: 3px solid #2c313c; border-top-color: #6c8cff; border-radius: 50%;
             margin: 0 auto 10px; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg) } }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: #233; color: #8fe3c8; border: 1px solid #2f4d47; }
  .err { color: #ff9a9a; }
  `;

  class LookupPanel {
    constructor() {
      this.host = document.createElement('subtitle-lens-panel');
      // The host covers the viewport but lets clicks pass through, so you can keep
      // clicking other subtitle words while the panel is open.
      this.host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:none;pointer-events:none;';
      this.root = this.host.attachShadow({ mode: 'open' });
      this.root.innerHTML = `<style>${CSS}</style><div class="panel"></div>`;
      this.panel = this.root.querySelector('.panel');
      this.history = [];
      this.current = null;
      this.reqId = 0;
      this.onHide = null;

      // stop events leaking to the video player underneath
      ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'wheel', 'keydown', 'keyup', 'keypress']
        .forEach(t => this.host.addEventListener(t, (e) => {
          if (t === 'keydown' && e.key === 'Escape') { this.hide(); }
          e.stopPropagation();
        }));
      this.panel.addEventListener('click', (e) => this.handleClick(e));
      this.enableDrag();
    }

    mount() {
      const parent = document.fullscreenElement || document.webkitFullscreenElement || document.documentElement;
      // Fullscreen elements such as <video> can't hold children; fall back to their parent.
      const target = parent && parent.tagName === 'VIDEO' ? (parent.parentElement || document.documentElement) : parent;
      if (this.host.parentNode !== target) target.appendChild(this.host);
    }

    get isOpen() { return this.host.style.display !== 'none'; }

    hide() {
      this.host.style.display = 'none';
      this.history = [];
      try { send({ type: 'stopSpeak' }).catch(() => {}); } catch (_) {}
      if (this.onHide) this.onHide();
    }

    async show(word, context, { pushHistory = false, keepHistory = false } = {}) {
      word = String(word || '').trim();
      if (!word) return;
      if (pushHistory && this.current) this.history.push(this.current);
      else if (!pushHistory && !keepHistory) this.history = [];
      this.current = { word, context };
      this.mount();
      this.host.style.display = 'block';
      const id = ++this.reqId;
      this.panel.innerHTML = `
        <header><span class="word">${esc(word)}</span><span class="spacer"></span>
          <button class="icon" data-act="close" title="Close (Esc)">✕</button></header>
        <div class="body"><div class="loading"><div class="spinner"></div>Looking up “${esc(word)}”…</div></div>`;
      try {
        const data = await send({ type: 'lookup', word, context });
        if (id !== this.reqId) return;
        this.data = data;
        this.render(data);
      } catch (err) {
        if (id !== this.reqId) return;
        this.panel.querySelector('.body').innerHTML =
          `<p class="err">Could not look up “${esc(word)}”.</p><p class="muted">${esc(err.message)}</p>`;
      }
    }

    render(d) {
      const target = d.headword || d.word;
      const s = [];
      s.push(`<header>
        ${this.history.length ? '<button class="icon" data-act="back" title="Back">←</button>' : ''}
        <div><div class="word">${esc(d.headword || d.word)}</div>
          ${d.ipa ? `<div class="ipa">${esc(d.ipa)}</div>` : ''}</div>
        <span class="spacer"></span>
        <button class="icon" data-act="say" title="Pronounce">🔊</button>
        <button class="icon" data-act="slow" title="Pronounce slowly">🐢</button>
        <button class="icon" data-act="save" title="Save to My Words">☆</button>
        <button class="icon" data-act="close" title="Close (Esc)">✕</button>
      </header><div class="body">`);

      if (d.contextSentence || d.contextMeaning) {
        s.push(`<section><h3>In this scene</h3><div class="ctx">
          ${d.contextSentence ? `<div class="line">“${clickableText(d.contextSentence, d.word)}”</div>` : ''}
          ${d.contextMeaning ? `<div>${esc(d.contextMeaning)}</div>` : (d.source === 'free' ? '<div class="muted">Add an AI key in Settings to get the exact meaning in this scene.</div>' : '')}
        </div></section>`);
      }

      if (d.meanings && d.meanings.length) {
        s.push(`<section><h3>Meaning</h3><ol>${d.meanings.map(m => `
          <li>${m.pos ? `<span class="pos">${esc(m.pos)}</span>` : ''}${esc(m.definition)}
          ${m.example ? `<span class="ex">“${clickableText(m.example, target)}”</span>` : ''}</li>`).join('')}</ol></section>`);
      }

      s.push(`<section><h3>Pronunciation</h3><div class="say">
        ${d.syllables ? `<span class="syll">${esc(d.syllables)}</span>` : ''}
        ${d.ipa ? `<span class="ipa" style="color:#9fb3ff">${esc(d.ipa)}</span>` : ''}
        <button data-act="say">🔊 Normal</button><button data-act="slow">🐢 Slow</button>
        ${d.audioUrl ? '<button data-act="audio">🎧 Native audio</button>' : ''}
      </div>${d.howToSay ? `<p style="margin:6px 0 0">${esc(d.howToSay)}</p>` : ''}</section>`);

      if (d.whenToUse) {
        s.push(`<section><h3>When to use it</h3><p style="margin:0">${esc(d.whenToUse)}</p></section>`);
      }

      if (d.usageInSentences && d.usageInSentences.length) {
        s.push(`<section><h3>Meaning in different sentences</h3><ul>${d.usageInSentences.map((u, i) => `
          <li><div class="sent"><button data-act="speak-usage" data-i="${i}" title="Listen">🔊</button>
          <div><div>${clickableText(u.sentence, target)}</div><div class="muted">→ ${esc(u.meaning)}</div></div></div></li>`).join('')}</ul></section>`);
      }

      if (d.examples && d.examples.length) {
        s.push(`<section><h3>${d.examples.length} example sentences</h3><ol>${d.examples.map((e, i) => `
          <li><div class="sent"><button data-act="speak-ex" data-i="${i}" title="Listen">🔊</button>
          <span>${clickableText(e, target)}</span></div></li>`).join('')}</ol></section>`);
      }

      if (d.synonyms && d.synonyms.length) {
        s.push(`<section><h3>Similar words</h3><div class="chips">${d.synonyms.map(x => `<span class="chip" data-w="${esc(x)}">${esc(x)}</span>`).join('')}</div></section>`);
      }
      if (d.antonyms && d.antonyms.length) {
        s.push(`<section><h3>Opposites</h3><div class="chips">${d.antonyms.map(x => `<span class="chip" data-w="${esc(x)}">${esc(x)}</span>`).join('')}</div></section>`);
      }

      if (d.notes) s.push(`<div class="note">${esc(d.notes)}</div>`);
      s.push(`<p class="muted" style="font-size:12px;margin-top:14px">
        <span class="badge">${d.source === 'ai' ? 'AI tutor' : 'Free dictionary'}</span>
        &nbsp;Tip: click any word in the sentences to look it up.</p></div>`);
      this.panel.innerHTML = s.join('');
    }

    handleClick(e) {
      const btn = e.target.closest('[data-act]');
      const d = this.data;
      if (btn) {
        const act = btn.dataset.act;
        if (act === 'close') return this.hide();
        if (act === 'back') {
          const prev = this.history.pop();
          if (prev) this.show(prev.word, prev.context, { keepHistory: true });
          return;
        }
        if (!d) return;
        const word = d.headword || d.word;
        if (act === 'say') return send({ type: 'speak', text: word }).catch(() => {});
        if (act === 'slow') return send({ type: 'speak', text: word, rate: 0.55 }).catch(() => {});
        if (act === 'audio') {
          const a = new Audio(d.audioUrl);
          return a.play().catch(() => send({ type: 'speak', text: word }).catch(() => {}));
        }
        if (act === 'speak-ex') return send({ type: 'speak', text: d.examples[+btn.dataset.i] }).catch(() => {});
        if (act === 'speak-usage') return send({ type: 'speak', text: d.usageInSentences[+btn.dataset.i].sentence }).catch(() => {});
        if (act === 'save') {
          send({ type: 'saveWord', entry: {
            word, ipa: d.ipa, context: d.contextSentence,
            meaning: d.contextMeaning || (d.meanings[0] && d.meanings[0].definition) || ''
          } }).then(() => { btn.textContent = '★'; btn.title = 'Saved'; }).catch(() => {});
          return;
        }
      }
      const w = e.target.closest('[data-w]');
      if (w) {
        const sentenceEl = w.closest('li, .line');
        const ctx = sentenceEl ? sentenceEl.textContent.replace(/🔊/g, '').replace(/→.*$/s, '').trim() : '';
        this.show(w.dataset.w, ctx, { pushHistory: true });
      }
    }

    enableDrag() {
      let sx, sy, ox, oy, dragging = false;
      this.panel.addEventListener('mousedown', (e) => {
        const h = e.target.closest('header');
        if (!h || e.target.closest('button')) return;
        const r = this.panel.getBoundingClientRect();
        dragging = true; sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        e.preventDefault();
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        this.panel.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
        this.panel.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
        this.panel.style.right = 'auto';
      }, true);
      window.addEventListener('mouseup', () => { dragging = false; }, true);
    }
  }

  let instance = null;
  globalThis.SubtitleLensUI = {
    get panel() { return instance || (instance = new LookupPanel()); },
    send,
    esc,
    wrapWords,
    escRe
  };
})();
