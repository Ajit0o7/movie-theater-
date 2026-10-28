// Subtitles: .srt / .vtt parsing and an overlay renderer.
//
// The overlay is drawn by us rather than through <track>, so it works over every source:
// files, links, YouTube (an iframe) and WebRTC streams. Cue text is never treated as HTML;
// only <i>, <b> and <u> survive, rebuilt as DOM nodes.

export const MAX_SUBTITLE_BYTES = 2_000_000;
const MAX_CUES = 20_000;

const TIME = /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/;

function parseTime(text) {
  const m = TIME.exec(text);
  if (!m) return null;
  const [, h = '0', min, s, ms = '0'] = m;
  return Number(h) * 3600 + Number(min) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'", '&apos;': "'" };

/** Keeps <i>/<b>/<u> (normalised), drops every other tag, ASS overrides and entities. */
export function cleanCueText(raw) {
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\{\\[^}]*\}/g, '') // {\an8}, {\i1} … from ASS-converted files
    .replace(/<\s*(\/?)\s*([ibu])(?:\s[^>]*)?>/gi, (_m, close, tag) => `\u0001${close}${tag.toLowerCase()}\u0002`)
    .replace(/<[^>]*>/g, '') // <font …>, <v Name>, <c.class>, timestamps…
    .replace(/\u0001/g, '<')
    .replace(/\u0002/g, '>')
    .replace(/&(amp|lt|gt|nbsp|quot|#39|apos);/g, (e) => ENTITIES[e])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/** Parses SRT or WebVTT text into sorted cues: [{ start, end, text }]. */
export function parseSubtitles(input) {
  const text = String(input).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const timingAt = lines.findIndex((l) => l.includes('-->'));
    if (timingAt === -1) continue; // WEBVTT header, NOTE, STYLE, REGION, stray text
    const [from, rest = ''] = lines[timingAt].split('-->');
    const start = parseTime(from);
    const end = parseTime(rest); // VTT cue settings after the time are ignored
    if (start == null || end == null || end <= start) continue;
    const body = cleanCueText(lines.slice(timingAt + 1).join('\n'));
    if (body) cues.push({ start, end, text: body });
    if (cues.length >= MAX_CUES) break;
  }
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Decodes a subtitle file: UTF-8 when valid, otherwise Windows-1252 (common for old .srt). */
export function decodeSubtitleBytes(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

/** Cues showing at time t (several may overlap). `maxLen` = longest cue, to bound the search. */
export function activeCues(cues, t, maxLen) {
  let lo = 0;
  let hi = cues.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      last = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const out = [];
  for (let i = last; i >= 0 && cues[i].start >= t - maxLen; i--) {
    if (cues[i].end > t) out.unshift(cues[i]);
  }
  return out;
}

/** Builds safe DOM for a cue: text nodes plus <i>/<b>/<u> elements, <br> for line breaks. */
function renderCue(text, doc = document) {
  const root = doc.createElement('span');
  root.className = 'sub-cue';
  const stack = [root];
  for (const part of text.split(/(<\/?[ibu]>|\n)/)) {
    if (!part) continue;
    const top = stack[stack.length - 1];
    if (part === '\n') top.append(doc.createElement('br'));
    else if (/^<[ibu]>$/.test(part)) {
      const el = doc.createElement(part[1]);
      top.append(el);
      stack.push(el);
    } else if (/^<\/[ibu]>$/.test(part)) {
      if (stack.length > 1) stack.pop();
    } else top.append(doc.createTextNode(part));
  }
  return root;
}

export class SubtitleOverlay {
  /** `getTime()` returns the media time the viewer is seeing, or null when there is none. */
  constructor(element, getTime) {
    this.el = element;
    this.getTime = getTime;
    this.cues = [];
    this.maxLen = 0;
    this.offset = 0; // seconds; positive = show subtitles later
    this.visible = true;
    this.shownKey = '';
    this.timer = setInterval(() => this.render(), 100);
  }

  setCues(cues) {
    this.cues = cues;
    this.maxLen = cues.reduce((m, c) => Math.max(m, c.end - c.start), 0);
    this.render(true);
  }

  setOffset(seconds) {
    this.offset = Math.round(seconds * 1000) / 1000;
    this.render(true);
  }

  setVisible(visible) {
    this.visible = visible;
    this.render(true);
  }

  render(force = false) {
    const t = this.getTime();
    const cues = this.visible && this.cues.length && t != null ? activeCues(this.cues, t - this.offset, this.maxLen) : [];
    const key = cues.map((c) => `${c.start}:${c.text}`).join('|');
    if (!force && key === this.shownKey) return; // nothing changed: no DOM work
    this.shownKey = key;
    this.el.replaceChildren(...cues.map((c) => renderCue(c.text, this.el.ownerDocument)));
  }

  destroy() {
    clearInterval(this.timer);
    this.el.replaceChildren();
  }
}
