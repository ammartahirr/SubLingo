// Subtitle Lens – Deep Learning page
(function () {
  const UI = globalThis.SubtitleLensUI;
  const P = globalThis.SubtitleParser;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

  let doc = null; // { name, format, cues, noTimes }
  let savedSet = new Set();

  // ------------------------------------------------------------------ tabs
  function showTab(name) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tabpane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
    if (name === 'words') renderWords();
    history.replaceState(null, '', '#' + name);
  }
  $$('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));

  // ---------------------------------------------------------------- upload
  const dz = $('#dropzone');
  const fileInput = $('#file');
  $('#pick').addEventListener('click', () => fileInput.click());
  dz.addEventListener('click', (e) => { if (e.target === dz) fileInput.click(); });
  fileInput.addEventListener('change', () => fileInput.files[0] && loadFile(fileInput.files[0]));
  ['dragenter', 'dragover'].forEach(t => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
  $('#newFile').addEventListener('click', () => { fileInput.value = ''; fileInput.click(); });

  async function readText(file) {
    const buf = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    // Many old subtitle files are Windows-1252 / Latin-1 encoded.
    if ((text.match(/\uFFFD/g) || []).length > 3) text = new TextDecoder('windows-1252').decode(buf);
    return text;
  }

  async function loadFile(file) {
    try {
      const text = await readText(file);
      const parsed = P.parse(text, file.name);
      if (!parsed.cues.length) throw new Error('No subtitle lines found in this file.');
      doc = { name: file.name, ...parsed };
      try { await chrome.storage.local.set({ lastDoc: doc }); } catch (_) { /* too big – fine */ }
      renderDoc();
    } catch (err) {
      alert('Could not read the subtitle file: ' + err.message);
    }
  }

  // ---------------------------------------------------------------- reader
  function sentenceSplit(text) {
    return text.match(/[^.!?…]+(?:[.!?…]+["”’)]*|$)/g) || [text];
  }

  function renderDoc() {
    if (!doc) return;
    dz.hidden = true;
    $('#reader').hidden = false;
    const paras = P.toParagraphs(doc.cues, { hideSfx: $('#hideSfx').checked });
    const showTimes = $('#showTimes').checked && !doc.noTimes;
    let words = 0;
    const uniq = new Set();

    const html = paras.map(p => {
      const sentences = sentenceSplit(p.text).map(s => s.trim()).filter(Boolean).map(s => {
        const inner = UI.wrapWords(s, (w, e) => {
          words++;
          const lw = w.toLowerCase().replace(/’/g, "'");
          uniq.add(lw);
          return `<span class="w${savedSet.has(lw) ? ' saved' : ''}" data-w="${e}">${e}</span>`;
        });
        return `<span class="s">${inner}</span>`;
      }).join(' ');
      return `<p>${showTimes ? `<span class="time">${P.formatTime(p.start)}</span>` : ''}${sentences}</p>`;
    }).join('');

    $('#text').innerHTML = html;
    $('#fname').textContent = doc.name;
    $('#stats').textContent = `· ${doc.format} · ${doc.cues.length} lines · ${paras.length} paragraphs · ${words.toLocaleString()} words · ${uniq.size.toLocaleString()} unique`;
    applySearch();
  }

  ['#showTimes', '#hideSfx'].forEach(id => $(id).addEventListener('change', renderDoc));
  $('#fontSize').addEventListener('input', (e) => { $('#text').style.fontSize = e.target.value + 'px'; });

  // Click a word -> lookup.  Select several words -> look up the phrase.
  $('#text').addEventListener('mouseup', (e) => {
    const sel = window.getSelection();
    const selected = sel ? sel.toString().trim() : '';
    if (selected && /\s/.test(selected) && selected.split(/\s+/).length <= 6) {
      const s = e.target.closest('.s');
      UI.panel.show(selected.replace(/[^\p{L}\p{N}' -]/gu, '').trim(), s ? s.textContent : '');
      return;
    }
    const w = e.target.closest('.w');
    if (!w) return;
    $$('.w.active').forEach(x => x.classList.remove('active'));
    w.classList.add('active', 'seen');
    const s = w.closest('.s');
    UI.panel.show(w.dataset.w, s ? s.textContent : '');
  });

  // Search / highlight
  function applySearch() {
    const q = $('#search').value.trim().toLowerCase();
    let first = null, n = 0;
    $$('#text .w').forEach(w => {
      const hit = q && w.dataset.w.toLowerCase().startsWith(q);
      w.classList.toggle('found', !!hit);
      if (hit) { n++; first = first || w; }
    });
    if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    $('#search').title = q ? `${n} matches` : '';
  }
  let searchTimer;
  $('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(applySearch, 250); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && UI.panel.isOpen) UI.panel.hide();
  });

  // -------------------------------------------------------------- my words
  async function loadSaved() {
    const { savedWords = [] } = await chrome.storage.local.get('savedWords');
    savedSet = new Set(savedWords.map(w => w.word));
    return savedWords;
  }

  async function renderWords() {
    const list = await loadSaved();
    $('#wordCount').textContent = `(${list.length})`;
    if (!list.length) {
      $('#wordsList').innerHTML = '<p class="muted card">No saved words yet. Press ☆ in the word panel to save one.</p>';
      return;
    }
    $('#wordsList').innerHTML = list.map((w, i) => `
      <div class="wordrow" data-i="${i}">
        <div class="wr-main">
          <span class="wr-word" data-w="${UI.esc(w.word)}">${UI.esc(w.word)}</span>
          ${w.ipa ? `<span class="muted">${UI.esc(w.ipa)}</span>` : ''}
          <div>${UI.esc(w.meaning)}</div>
          ${w.context ? `<div class="muted small">“${UI.esc(w.context)}”</div>` : ''}
        </div>
        <div class="wr-act">
          <button data-act="say" title="Pronounce">🔊</button>
          <button data-act="open" title="Open">📖</button>
          <button data-act="del" title="Remove">🗑</button>
        </div>
      </div>`).join('');
  }

  $('#wordsList').addEventListener('click', async (e) => {
    const row = e.target.closest('.wordrow');
    if (!row) return;
    const list = await loadSaved();
    const item = list[+row.dataset.i];
    if (!item) return;
    const act = e.target.closest('[data-act]')?.dataset.act || (e.target.closest('.wr-word') ? 'open' : '');
    if (act === 'say') UI.send({ type: 'speak', text: item.word }).catch(() => {});
    if (act === 'open') UI.panel.show(item.word, item.context);
    if (act === 'del') {
      list.splice(+row.dataset.i, 1);
      await chrome.storage.local.set({ savedWords: list });
      renderWords();
    }
  });

  $('#clearWords').addEventListener('click', async () => {
    if (!confirm('Remove all saved words?')) return;
    await chrome.storage.local.set({ savedWords: [] });
    renderWords();
  });

  $('#exportCsv').addEventListener('click', async () => {
    const list = await loadSaved();
    const q = (s) => '"' + String(s || '').replace(/"/g, '""') + '"';
    const csv = ['word,ipa,meaning,context,saved']
      .concat(list.map(w => [w.word, w.ipa, w.meaning, w.context, new Date(w.savedAt).toISOString()].map(q).join(',')))
      .join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv' }));
    a.download = 'subtitle-lens-words.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.savedWords) {
      savedSet = new Set((changes.savedWords.newValue || []).map(w => w.word));
      $$('#text .w').forEach(w => w.classList.toggle('saved', savedSet.has(w.dataset.w.toLowerCase().replace(/’/g, "'"))));
      if ($('#tab-words').classList.contains('active')) renderWords();
    }
  });

  // -------------------------------------------------------------- settings
  const form = $('#settingsForm');

  function updateProviderFields() {
    const p = form.provider.value;
    $$('fieldset[data-for]', form).forEach(f => { f.hidden = f.dataset.for !== p; });
  }

  async function loadSettings() {
    const s = await UI.send({ type: 'getSettings' });
    for (const [k, v] of Object.entries(s)) {
      const el = form.elements[k];
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    }
    $('#rateVal').textContent = form.voiceRate.value + '×';
    updateProviderFields();
  }

  form.provider.addEventListener('change', updateProviderFields);
  form.voiceRate.addEventListener('input', () => { $('#rateVal').textContent = form.voiceRate.value + '×'; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    // Read the form synchronously so permissions.request() still runs inside the user gesture.
    const s = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      s[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : el.value.trim();
    }
    if (!s.openaiBaseUrl) s.openaiBaseUrl = 'https://api.openai.com/v1';
    if (!s.geminiModel) s.geminiModel = 'gemini-2.0-flash';
    if (!s.openaiModel) s.openaiModel = 'gpt-4o-mini';
    if (!s.explainLanguage) s.explainLanguage = 'English';

    // Custom OpenAI-compatible endpoints need an extra host permission.
    if (s.provider === 'openai') {
      try {
        const origin = new URL(s.openaiBaseUrl).origin + '/*';
        if (origin !== 'https://api.openai.com/*') {
          const granted = await chrome.permissions.request({ origins: [origin] });
          if (!granted) { flash('Permission for ' + origin + ' was denied.', true); return; }
        }
      } catch (_) { flash('Base URL is not a valid URL.', true); return; }
    }
    const prev = await UI.send({ type: 'getSettings' }).catch(() => ({}));
    await chrome.storage.local.set({ settings: { ...prev, ...s } });
    await UI.send({ type: 'clearCache' }).catch(() => {});
    flash('Saved ✓');
  });

  $('#testVoice').addEventListener('click', () =>
    UI.send({ type: 'speak', text: 'Hello! This is how words will be pronounced.', rate: +form.voiceRate.value }).catch(() => {}));
  $('#clearCache').addEventListener('click', async () => { await UI.send({ type: 'clearCache' }); flash('Cache cleared ✓'); });

  function flash(msg, bad) {
    const el = $('#saveMsg');
    el.textContent = msg;
    el.className = bad ? 'err' : 'ok';
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { el.textContent = ''; }, 3500);
  }

  // ------------------------------------------------------------------ init
  (async function init() {
    await loadSaved();
    await loadSettings().catch(() => {});
    const { lastDoc } = await chrome.storage.local.get('lastDoc');
    if (lastDoc && lastDoc.cues && lastDoc.cues.length) { doc = lastDoc; renderDoc(); }
    const tab = location.hash.slice(1);
    if (['learn', 'words', 'settings', 'help'].includes(tab)) showTab(tab);
  })();
})();
