// Subtitle Lens – background service worker
// Handles: word lookups (free dictionary + example sentences, or AI provider),
// text-to-speech, caching, saved words and opening the Deep Learning page.

const DEFAULT_SETTINGS = {
  provider: 'free', // 'free' | 'gemini' | 'openai'
  geminiKey: '',
  geminiModel: 'gemini-2.0-flash',
  openaiKey: '',
  openaiModel: 'gpt-4o-mini',
  openaiBaseUrl: 'https://api.openai.com/v1',
  explainLanguage: 'English', // language used for explanations (AI mode)
  voiceRate: 0.9,
  pauseVideoOnPick: true
};

const CACHE_LIMIT = 400;
const memCache = new Map();

// ---------------------------------------------------------------------------
// Action click -> open (or focus) the Deep Learning page
// ---------------------------------------------------------------------------
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('learn/learn.html');
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...(settings || {}) } });
});

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'lookup':
          return sendResponse({ ok: true, data: await lookup(msg.word, msg.context || '') });
        case 'speak':
          await speak(msg.text, msg.rate);
          return sendResponse({ ok: true });
        case 'stopSpeak':
          chrome.tts.stop();
          return sendResponse({ ok: true });
        case 'togglePick':
          // Broadcast to every frame of the tab (players are often inside iframes).
          if (sender.tab && sender.tab.id != null) {
            chrome.tabs.sendMessage(sender.tab.id, { type: 'pickToggle' }).catch(() => {});
          }
          return sendResponse({ ok: true });
        case 'getSettings':
          return sendResponse({ ok: true, data: await getSettings() });
        case 'saveWord':
          return sendResponse({ ok: true, data: await saveWord(msg.entry) });
        case 'clearCache':
          await clearCache();
          return sendResponse({ ok: true });
        default:
          return sendResponse({ ok: false, error: 'Unknown message' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();
  return true; // async response
});

// ---------------------------------------------------------------------------
// Text to speech (chrome.tts works on every site, no CSP issues)
// ---------------------------------------------------------------------------
async function speak(text, rate) {
  if (!text) return;
  const settings = await getSettings();
  chrome.tts.stop();
  chrome.tts.speak(String(text).slice(0, 1000), {
    lang: 'en-US',
    rate: typeof rate === 'number' ? rate : settings.voiceRate,
    enqueue: false
  });
}

// ---------------------------------------------------------------------------
// Saved words ("My words")
// ---------------------------------------------------------------------------
async function saveWord(entry) {
  const { savedWords = [] } = await chrome.storage.local.get('savedWords');
  const word = String(entry.word || '').toLowerCase();
  const filtered = savedWords.filter(w => w.word !== word);
  filtered.unshift({
    word,
    meaning: entry.meaning || '',
    context: entry.context || '',
    ipa: entry.ipa || '',
    savedAt: Date.now()
  });
  await chrome.storage.local.set({ savedWords: filtered.slice(0, 2000) });
  return filtered.length;
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------
async function cacheGet(key) {
  if (memCache.has(key)) return memCache.get(key);
  const { lookupCache = {} } = await chrome.storage.local.get('lookupCache');
  const hit = lookupCache[key];
  if (hit) memCache.set(key, hit.data);
  return hit ? hit.data : null;
}

async function cacheSet(key, data) {
  memCache.set(key, data);
  const { lookupCache = {} } = await chrome.storage.local.get('lookupCache');
  lookupCache[key] = { t: Date.now(), data };
  const keys = Object.keys(lookupCache);
  if (keys.length > CACHE_LIMIT) {
    keys.sort((a, b) => lookupCache[a].t - lookupCache[b].t)
      .slice(0, keys.length - CACHE_LIMIT)
      .forEach(k => delete lookupCache[k]);
  }
  await chrome.storage.local.set({ lookupCache });
}

async function clearCache() {
  memCache.clear();
  await chrome.storage.local.remove('lookupCache');
}

// ---------------------------------------------------------------------------
// Lookup pipeline
// ---------------------------------------------------------------------------
function normalizeWord(raw) {
  return String(raw || '')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .toLowerCase()
    .trim();
}

// Very small English lemmatizer used as a fallback when the dictionary has no entry.
function lemmaCandidates(w) {
  const c = new Set([w]);
  if (w.endsWith("'s")) c.add(w.slice(0, -2));
  if (w.endsWith("n't")) c.add(w.slice(0, -3));
  if (/'(ll|re|ve|d|m)$/.test(w)) c.add(w.replace(/'(ll|re|ve|d|m)$/, ''));
  if (w.endsWith('ies')) c.add(w.slice(0, -3) + 'y');
  if (w.endsWith('es')) c.add(w.slice(0, -2));
  if (w.endsWith('s') && !w.endsWith('ss')) c.add(w.slice(0, -1));
  if (w.endsWith('ied')) c.add(w.slice(0, -3) + 'y');
  if (w.endsWith('ed')) {
    c.add(w.slice(0, -2));
    c.add(w.slice(0, -1));
    if (/([b-df-hj-np-tv-z])\1ed$/.test(w)) c.add(w.slice(0, -3));
  }
  if (w.endsWith('ing')) {
    const stem = w.slice(0, -3);
    c.add(stem);
    c.add(stem + 'e');
    if (/([b-df-hj-np-tv-z])\1$/.test(stem)) c.add(stem.slice(0, -1));
  }
  if (w.endsWith('ly')) c.add(w.slice(0, -2));
  if (w.endsWith('er')) c.add(w.slice(0, -2));
  if (w.endsWith('est')) c.add(w.slice(0, -3));
  return [...c].filter(x => x.length > 1 || x === w);
}

async function lookup(rawWord, context) {
  const word = normalizeWord(rawWord);
  if (!word) throw new Error('No word to look up');
  const settings = await getSettings();
  const useAI = (settings.provider === 'gemini' && settings.geminiKey) ||
                (settings.provider === 'openai' && settings.openaiKey);

  const ctx = String(context || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const key = (useAI ? `ai:${settings.provider}:${settings.explainLanguage}:` : 'free:') +
              word + (useAI ? '|' + ctx : '');
  const cached = await cacheGet(key);
  if (cached) return cached;

  // Dictionary data is always fetched: it gives IPA + real audio.
  const dictPromise = fetchDictionary(word).catch(() => null);

  let result;
  if (useAI) {
    try {
      const [ai, dict] = await Promise.all([fetchAI(word, ctx, settings), dictPromise]);
      result = mergeAI(word, ctx, ai, dict);
    } catch (err) {
      const dict = await dictPromise;
      result = await buildFree(word, ctx, dict);
      result.notes = `AI lookup failed (${err.message}). Showing free dictionary result.`;
    }
  } else {
    result = await buildFree(word, ctx, await dictPromise);
  }

  if (result.meanings.length || result.contextMeaning) await cacheSet(key, result);
  return result;
}

// ------------------------------- Free sources -------------------------------
async function fetchJSON(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch (_) {}
      const e = new Error(`HTTP ${res.status}${detail ? ': ' + detail : ''}`);
      e.status = res.status;
      throw e;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDictionary(word) {
  for (const candidate of lemmaCandidates(word)) {
    try {
      const data = await fetchJSON(
        `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(candidate)}`
      );
      if (Array.isArray(data) && data.length) return { headword: candidate, entries: data };
    } catch (e) {
      if (e.status && e.status !== 404) throw e;
    }
  }
  return null;
}

function parseDictionary(dict) {
  const out = { headword: '', ipa: '', audioUrl: '', meanings: [], synonyms: [], antonyms: [], examples: [] };
  if (!dict) return out;
  out.headword = dict.headword;
  const syn = new Set();
  const ant = new Set();
  for (const entry of dict.entries) {
    if (!out.ipa && entry.phonetic) out.ipa = entry.phonetic;
    for (const p of entry.phonetics || []) {
      if (!out.ipa && p.text) out.ipa = p.text;
      if (p.audio) {
        // prefer US audio
        if (!out.audioUrl || /-us\.mp3$/.test(p.audio)) out.audioUrl = p.audio;
      }
    }
    for (const m of entry.meanings || []) {
      (m.synonyms || []).forEach(s => syn.add(s));
      (m.antonyms || []).forEach(s => ant.add(s));
      for (const d of m.definitions || []) {
        out.meanings.push({ pos: m.partOfSpeech || '', definition: d.definition || '', example: d.example || '' });
        (d.synonyms || []).forEach(s => syn.add(s));
        (d.antonyms || []).forEach(s => ant.add(s));
        if (d.example) out.examples.push(d.example);
      }
    }
  }
  out.synonyms = [...syn].slice(0, 12);
  out.antonyms = [...ant].slice(0, 8);
  return out;
}

async function fetchTatoeba(word, max = 15) {
  const sentences = [];
  const push = (t) => { if (t && !sentences.includes(t)) sentences.push(t); };

  // Newer official API
  try {
    const d = await fetchJSON(
      `https://api.tatoeba.org/unstable/sentences?lang=eng&q=${encodeURIComponent('=' + word)}&sort=relevance&limit=${max}`,
      {}, 8000
    );
    (d.data || d.results || []).forEach(s => push(s.text));
  } catch (_) { /* fall through */ }

  // Legacy search API
  if (sentences.length < 10) {
    try {
      const d = await fetchJSON(
        `https://tatoeba.org/en/api_v0/search?from=eng&query=${encodeURIComponent('=' + word)}&orphans=no&unapproved=no&sort=relevance`,
        {}, 8000
      );
      (d.results || []).forEach(s => push(s.text));
    } catch (_) { /* ignore */ }
  }
  return sentences;
}

function containsWord(sentence, words) {
  return words.some(w => new RegExp(`(^|[^\\p{L}])${escapeRe(w)}([^\\p{L}]|$)`, 'iu').test(sentence));
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function buildFree(word, ctx, dict) {
  const parsed = parseDictionary(dict);
  const forms = [...new Set([word, parsed.headword].filter(Boolean))];

  let tatoeba = [];
  try { tatoeba = await fetchTatoeba(word); } catch (_) {}
  if (tatoeba.length < 10 && parsed.headword && parsed.headword !== word) {
    try { tatoeba = tatoeba.concat(await fetchTatoeba(parsed.headword)); } catch (_) {}
  }

  const examples = [];
  const add = (s) => {
    s = String(s || '').trim();
    if (s && !examples.some(e => e.toLowerCase() === s.toLowerCase())) examples.push(s);
  };
  parsed.examples.forEach(add);
  tatoeba.filter(s => containsWord(s, forms)).forEach(add);
  tatoeba.forEach(add);

  // "Meaning in different sentences": one sentence per sense
  const usageInSentences = parsed.meanings
    .filter(m => m.example)
    .slice(0, 6)
    .map(m => ({ sentence: m.example, meaning: `(${m.pos}) ${m.definition}` }));

  const posCounts = {};
  parsed.meanings.forEach(m => { posCounts[m.pos] = (posCounts[m.pos] || 0) + 1; });
  const posText = Object.entries(posCounts).map(([p, n]) => `${p} (${n} sense${n > 1 ? 's' : ''})`).join(', ');

  let whenToUse = '';
  if (parsed.meanings.length) {
    whenToUse = `“${parsed.headword || word}” is used as: ${posText}. ` +
      `The most common sense is: ${parsed.meanings[0].definition}` +
      (parsed.synonyms.length ? ` You can often replace it with: ${parsed.synonyms.slice(0, 5).join(', ')}.` : '');
  }

  return {
    source: 'free',
    word,
    headword: parsed.headword || word,
    ipa: parsed.ipa,
    audioUrl: parsed.audioUrl,
    syllables: '',
    contextSentence: ctx,
    contextMeaning: '',
    meanings: parsed.meanings.slice(0, 12),
    whenToUse,
    howToSay: parsed.ipa ? `Say it like ${parsed.ipa}. Use the 🔊 buttons to hear it at normal and slow speed.` : '',
    usageInSentences,
    examples: examples.slice(0, 10),
    synonyms: parsed.synonyms,
    antonyms: parsed.antonyms,
    notes: parsed.meanings.length ? '' : 'No dictionary entry found. It may be a name, slang or a misspelling. Add an AI key in Settings for smarter results.'
  };
}

// --------------------------------- AI mode ----------------------------------
function buildPrompt(word, ctx, lang) {
  return `You are an English vocabulary tutor for a learner who is watching a movie.
The learner clicked the word "${word}"${ctx ? ` in this subtitle line: "${ctx}"` : ''}.
Write all explanations in ${lang} (keep the example sentences themselves in English).
Return ONLY a JSON object with exactly these keys:
{
  "headword": "dictionary form of the word",
  "ipa": "IPA in American English, e.g. /prəˌnʌnsiˈeɪʃən/",
  "syllables": "simple sound-it-out spelling with the stressed syllable in CAPITALS, e.g. pruh-nun-see-AY-shun",
  "contextMeaning": "what the word means in the given subtitle line (empty string if no line)",
  "meanings": [{"pos": "part of speech", "definition": "clear simple definition", "example": "short example"}],
  "whenToUse": "2-4 sentences: when and in which situations/registers (formal, casual, slang, rude...) to use it, common collocations and mistakes",
  "howToSay": "practical pronunciation tips: stress, tricky sounds, silent letters, US vs UK differences",
  "usageInSentences": [{"sentence": "an English sentence", "meaning": "what the word means in that sentence"}],
  "examples": ["exactly 10 natural, varied English sentences that use the word, from everyday to movie-style dialogue"],
  "synonyms": ["up to 8"],
  "antonyms": ["up to 5"]
}
Give 2-6 meanings and 4-6 usageInSentences that show DIFFERENT senses of the word.`;
}

async function fetchAI(word, ctx, s) {
  const prompt = buildPrompt(word, ctx, s.explainLanguage || 'English');
  let text = '';
  if (s.provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.geminiModel)}:generateContent?key=${encodeURIComponent(s.geminiKey)}`;
    const data = await fetchJSON(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, responseMimeType: 'application/json' }
      })
    }, 30000);
    text = (((data.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text).join('') || '';
  } else {
    const base = (s.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const data = await fetchJSON(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.openaiKey}` },
      body: JSON.stringify({
        model: s.openaiModel,
        temperature: 0.4,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You reply with valid JSON only.' },
          { role: 'user', content: prompt }
        ]
      })
    }, 30000);
    text = data.choices?.[0]?.message?.content || '';
  }
  return parseLooseJSON(text);
}

function parseLooseJSON(text) {
  try { return JSON.parse(text); } catch (_) {}
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error('AI returned an invalid response');
}

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

function mergeAI(word, ctx, ai, dict) {
  const parsed = parseDictionary(dict);
  return {
    source: 'ai',
    word,
    headword: str(ai.headword) || parsed.headword || word,
    ipa: str(ai.ipa) || parsed.ipa,
    audioUrl: parsed.audioUrl,
    syllables: str(ai.syllables),
    contextSentence: ctx,
    contextMeaning: str(ai.contextMeaning),
    meanings: arr(ai.meanings).map(m => ({ pos: str(m.pos), definition: str(m.definition), example: str(m.example) })),
    whenToUse: str(ai.whenToUse),
    howToSay: str(ai.howToSay),
    usageInSentences: arr(ai.usageInSentences).map(u => ({ sentence: str(u.sentence), meaning: str(u.meaning) })),
    examples: arr(ai.examples).map(str).filter(Boolean).slice(0, 10),
    synonyms: arr(ai.synonyms).map(str).slice(0, 10),
    antonyms: arr(ai.antonyms).map(str).slice(0, 6),
    notes: ''
  };
}
