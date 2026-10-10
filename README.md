# Subtitle Lens – learn English words from movies (Chrome extension, MV3)

## Install
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `subtitle-lens` folder.
3. Pin the extension. Reload any video tabs that were already open.

## Mode 1 – While watching (Ctrl+Q)
1. Turn on subtitles in the player.
2. Press **Ctrl+Q**. The video pauses and pick mode starts. A clickable copy of the current subtitle line also appears.
3. Click any subtitle word. A panel opens showing:
   - the meaning in this scene (AI mode) and the dictionary meanings
   - pronunciation: IPA, a sound-it-out spelling, and 🔊 normal / 🐢 slow / 🎧 native audio
   - when to use it and how to say it
   - its meaning in different sentences
   - 10 example sentences (🔊 on each one; click any word in them to look that word up)
   - synonyms and opposites, plus ☆ to save the word
4. Press **Ctrl+Q** or **Esc** to exit. The video resumes.

Built-in support for YouTube, Netflix, Prime Video, Disney+, Max, Hulu, Vimeo, video.js, JW Player, Plyr, Shaka, Bitmovin and native HTML5 `<track>` captions. Other DOM-rendered subtitles use a generic fallback. Pick mode also works in fullscreen and inside player iframes.

## Mode 2 – Deep Learning (click the extension icon)
Upload `.srt`, `.vtt`, `.ass/.ssa`, `.sub` or `.txt`. The subtitles are turned into readable, timestamped paragraphs. Then:
- Click a word to look it up, or select several words to look up a phrase.
- Use the search box and adjust the font size.
- Turn sound-effect hiding on or off.

The other tabs are **My Words** (saved words, CSV export), **Settings** and **How to use**.

## Word sources
- **Free (default, no key):** dictionaryapi.dev for meanings, IPA and audio, plus Tatoeba for example sentences.
- **AI tutor (recommended):** add a Gemini key (free tier) or an OpenAI / OpenAI-compatible key in Settings. You get the meaning in the exact scene, usage notes, pronunciation tips and always 10 example sentences. You can also choose the language explanations are written in.

Pronunciation uses `chrome.tts`, so it works on every site.

## Files
```
manifest.json              MV3 manifest
background.js              lookups, AI calls, caching, TTS, saved words
shared/lookup-ui.js        word panel (Shadow DOM), shared by both modes
content/content.js         Ctrl+Q pick mode, subtitle detection, word-under-cursor
learn/learn.html|css|js    Deep Learning page, My Words, Settings
learn/subtitle-parser.js   SRT / VTT / ASS / MicroDVD / text parser
```
