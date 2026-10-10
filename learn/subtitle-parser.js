// Subtitle Lens – subtitle file parser (SRT, VTT, ASS/SSA, MicroDVD SUB, plain text)
// Produces cues [{ start, end, text }] (seconds) and groups them into paragraphs.
(function () {
  function toSec(h, m, s, ms) {
    return (+h || 0) * 3600 + (+m || 0) * 60 + (+s || 0) + (+String(ms || 0).padEnd(3, '0').slice(0, 3)) / 1000;
  }

  // 00:01:02,345 | 00:01:02.345 | 01:02.345 | 0:01:02.34 (ASS)
  function parseTime(t) {
    const m = String(t).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
    if (!m) return NaN;
    return toSec(m[1], m[2], m[3], m[4]);
  }

  function cleanText(t) {
    return String(t)
      .replace(/\{\\[^}]*\}/g, '')            // ASS override tags {\i1}
      .replace(/\\[Nn]/g, ' ')                // ASS line breaks
      .replace(/\\h/g, ' ')
      .replace(/<[^>]+>/g, '')                 // <i>, <font>, <c.color>, <00:01.000>
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/\r/g, '')
      .split('\n').map(l => l.replace(/^\s*[-–—]\s*/, '').trim()).filter(Boolean).join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseSrtVtt(src) {
    const cues = [];
    const blocks = src.replace(/\r\n?/g, '\n').split(/\n{2,}/);
    for (const block of blocks) {
      const lines = block.split('\n').filter(l => l.trim() !== '');
      const ti = lines.findIndex(l => l.includes('-->'));
      if (ti === -1) continue;
      const [a, b] = lines[ti].split('-->');
      const start = parseTime(a);
      const end = parseTime(String(b).trim().split(/\s+/)[0]);
      const text = cleanText(lines.slice(ti + 1).join('\n'));
      if (text) cues.push({ start: isNaN(start) ? 0 : start, end: isNaN(end) ? 0 : end, text });
    }
    return cues;
  }

  function parseAss(src) {
    const cues = [];
    let format = null;
    let inEvents = false;
    for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.trim();
      if (/^\[.*\]$/.test(line)) { inEvents = /^\[events\]$/i.test(line); continue; }
      if (!inEvents) continue;
      if (/^format:/i.test(line)) {
        format = line.slice(7).split(',').map(s => s.trim().toLowerCase());
        continue;
      }
      if (!/^dialogue:/i.test(line)) continue;
      const fmt = format || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
      const parts = line.slice(9).split(',');
      const fields = parts.slice(0, fmt.length - 1).concat(parts.slice(fmt.length - 1).join(','));
      const get = (k) => (fields[fmt.indexOf(k)] || '').trim();
      // skip drawing commands / karaoke-only lines
      if (/\\p[1-9]/.test(get('text'))) continue;
      const text = cleanText(get('text'));
      if (text) cues.push({ start: parseTime(get('start')) || 0, end: parseTime(get('end')) || 0, text });
    }
    return cues.sort((x, y) => x.start - y.start);
  }

  function parseMicroDVD(src, fps = 23.976) {
    const cues = [];
    for (const line of src.replace(/\r\n?/g, '\n').split('\n')) {
      const m = line.match(/^\{(\d+)\}\{(\d*)\}(.*)$/);
      if (!m) continue;
      const text = cleanText(m[3].replace(/\{[^}]*\}/g, '').replace(/\|/g, '\n'));
      if (text) cues.push({ start: +m[1] / fps, end: (+m[2] || +m[1]) / fps, text });
    }
    return cues;
  }

  function parsePlain(src) {
    return src.replace(/\r\n?/g, '\n').split('\n').map(cleanText).filter(Boolean).map(text => ({ start: 0, end: 0, text }));
  }

  function parse(src, filename = '') {
    src = String(src || '').replace(/^\uFEFF/, '');
    const ext = (filename.split('.').pop() || '').toLowerCase();
    if (ext === 'ass' || ext === 'ssa' || /^\s*\[script info\]/i.test(src)) return { format: 'ASS/SSA', cues: parseAss(src) };
    if (/^\s*\{\d+\}\{\d*\}/m.test(src)) return { format: 'MicroDVD', cues: parseMicroDVD(src) };
    if (src.includes('-->')) return { format: /^\s*WEBVTT/.test(src) ? 'WebVTT' : 'SubRip', cues: parseSrtVtt(src) };
    return { format: 'Text', cues: parsePlain(src), noTimes: true };
  }

  const SFX_RE = /\[[^\]]*\]|\([^)]*\)|♪[^♪]*♪?|^[A-Z][A-Z .'-]{1,20}:\s*/g;

  function stripSfx(text) {
    return text.replace(SFX_RE, ' ').replace(/[♪♫#]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Group cues into readable paragraphs: break on long pauses or after a few
  // complete sentences.
  function toParagraphs(cues, { hideSfx = true, gap = 2.5, maxCues = 7 } = {}) {
    const paras = [];
    let cur = null;
    let prevEnd = -Infinity;
    for (const c of cues) {
      const text = hideSfx ? stripSfx(c.text) : c.text;
      if (!text || !/[\p{L}\p{N}]/u.test(text)) { prevEnd = c.end || prevEnd; continue; }
      const pause = c.start - prevEnd;
      const endsSentence = cur && /[.!?…"”]$/.test(cur.parts[cur.parts.length - 1]);
      if (!cur || pause > gap || (cur.parts.length >= maxCues && endsSentence) || cur.parts.length >= maxCues * 2) {
        cur = { start: c.start, parts: [] };
        paras.push(cur);
      }
      cur.parts.push(text);
      prevEnd = c.end || c.start;
    }
    return paras.map(p => ({ start: p.start, text: p.parts.join(' ').replace(/\s+/g, ' ').trim() }));
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }

  globalThis.SubtitleParser = { parse, toParagraphs, formatTime, cleanText, stripSfx };
})();
