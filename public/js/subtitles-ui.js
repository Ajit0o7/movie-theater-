// Subtitles panel, drag & drop and overlay wiring. The file is shared with the room through
// the server; visibility, style and timing offset are each viewer's own.

import { MAX_SUBTITLE_BYTES, SubtitleOverlay, decodeSubtitleBytes, parseSubtitles } from './subtitles.js';
import { $, h } from './util.js';

const OFFSET_STEP = 0.25;
const SIZES = { s: ['S', 0.8], m: ['M', 1], l: ['L', 1.25], xl: ['XL', 1.55] };
const COLORS = { white: ['White', '#ffffff'], yellow: ['Yellow', '#ffe14d'], cyan: ['Cyan', '#7fe8ff'] };
const FONTS = { inter: ['Inter', 'var(--font-body)'], arial: ['Arial', 'Arial, Helvetica, sans-serif'], serif: ['Serif', 'Georgia, "Times New Roman", serif'] };
export const DEFAULT_SUB_STYLE = { size: 'm', color: 'white', font: 'inter', bg: 60, show: true };

const isSubtitleFile = (file) => /\.(srt|vtt)$/i.test(file?.name || '') || file?.type === 'text/vtt';

/**
 * @param {object} ctx
 * @param {() => number|null} ctx.getTime   media time the viewer sees (null: no timeline)
 * @param {(event: string, payload?: object) => Promise<object>} ctx.request  socket emit with ack
 * @param {(event: string) => void} ctx.send  socket emit without ack
 * @param {() => object} ctx.getSource       current room source
 * @param {(msg: string, opts?: object) => void} ctx.toast
 * @param {object} ctx.style                 persisted style settings (mutated)
 * @param {() => void} ctx.saveStyle
 */
export function setupSubtitles(ctx) {
  const overlay = new SubtitleOverlay($('#subtitles'), ctx.getTime);
  let current = null; // { id, sourceId, name, by }

  // ---- style -------------------------------------------------------------------------
  function applyStyle() {
    const s = ctx.style;
    const el = $('#subtitles');
    el.style.setProperty('--sub-scale', SIZES[s.size]?.[1] ?? 1);
    el.style.setProperty('--sub-color', COLORS[s.color]?.[1] ?? '#fff');
    el.style.setProperty('--sub-font', FONTS[s.font]?.[1] ?? 'inherit');
    el.style.setProperty('--sub-bg', String((s.bg ?? 60) / 100));
    $('#subs-bg').value = String(s.bg ?? 60);
    $('#subs-bg-out').textContent = `${s.bg ?? 60}%`;
    $('#subs-show').checked = s.show !== false;
    overlay.setVisible(s.show !== false);
    renderPicker('#subs-size', SIZES, 'size');
    renderPicker('#subs-color', COLORS, 'color');
    renderPicker('#subs-font', FONTS, 'font');
  }

  function renderPicker(selector, options, key) {
    $(selector).replaceChildren(
      ...Object.entries(options).map(([id, [label]]) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(ctx.style[key] === id), 'data-value': id, text: label }),
      ),
    );
  }

  for (const [selector, key] of [['#subs-size', 'size'], ['#subs-color', 'color'], ['#subs-font', 'font']]) {
    $(selector).addEventListener('click', (e) => {
      const btn = e.target.closest('[data-value]');
      if (!btn) return;
      ctx.style[key] = btn.dataset.value;
      ctx.saveStyle();
      applyStyle();
    });
  }
  $('#subs-bg').addEventListener('input', (e) => {
    ctx.style.bg = Number(e.target.value);
    ctx.saveStyle();
    applyStyle();
  });
  $('#subs-show').addEventListener('change', (e) => setVisible(e.target.checked));

  function setVisible(show) {
    ctx.style.show = show;
    ctx.saveStyle();
    applyStyle();
    renderStatus();
  }

  // ---- offset ------------------------------------------------------------------------
  function setOffset(seconds, { announce = true } = {}) {
    overlay.setOffset(Math.max(-60, Math.min(60, seconds)));
    const label = `${overlay.offset > 0 ? '+' : ''}${overlay.offset.toFixed(2)}s`;
    $('#subs-offset').textContent = label;
    if (announce && current) ctx.toast(`Subtitle timing ${label}${overlay.offset > 0 ? ' (later)' : overlay.offset < 0 ? ' (earlier)' : ''}`, { duration: 1500 });
  }

  // ---- shared state ------------------------------------------------------------------
  function renderStatus() {
    $('#subs-name').textContent = current ? current.name : 'No subtitles';
    $('#subs-meta').textContent = current
      ? `Shared with everyone${current.by ? ` · added by ${current.by}` : ''} · ${overlay.cues.length} lines`
      : 'Load an .srt or .vtt file; everyone in the room gets it. You can also drop the file anywhere on the screen.';
    $('#subs-loaded-row').hidden = !current;
    $('#subs-btn').classList.toggle('on', Boolean(current) && ctx.style.show !== false);
  }

  /** Applies the room's subtitles (from the join snapshot or a broadcast). */
  function applyState(subs, { actor = null, quiet = false } = {}) {
    if (subs && subs.sourceId !== ctx.getSource()?.id) subs = null;
    const changed = (subs?.id ?? null) !== (current?.id ?? null);
    if (!changed) return;
    if (subs) {
      const cues = parseSubtitles(subs.text);
      current = { id: subs.id, sourceId: subs.sourceId, name: subs.name, by: subs.by };
      overlay.setCues(cues);
      setOffset(0, { announce: false });
      if (!quiet) ctx.toast(`${actor ? `${actor} added` : 'Added'} subtitles “${subs.name}”`, { tone: 'success' });
    } else {
      const had = current;
      current = null;
      overlay.setCues([]);
      if (had && !quiet) ctx.toast(actor ? `${actor} removed the subtitles` : 'Subtitles removed');
    }
    renderStatus();
  }

  /** The movie changed: its subtitles no longer apply. */
  function onSourceChanged(source) {
    if (current && current.sourceId !== source?.id) applyState(null, { quiet: true });
  }

  async function loadFile(file) {
    if (!file) return;
    if (!isSubtitleFile(file)) {
      ctx.toast('Subtitles must be an .srt or .vtt file.', { tone: 'error' });
      return;
    }
    if (file.size > MAX_SUBTITLE_BYTES) {
      ctx.toast('That subtitle file is too large (over 2 MB).', { tone: 'error' });
      return;
    }
    const src = ctx.getSource();
    if (!src || !['url', 'youtube', 'local', 'stream'].includes(src.type)) {
      ctx.toast('Start a movie first (subtitles need a timeline, so not a screen share), then add its subtitles.', { tone: 'warn', duration: 6000 });
      return;
    }
    const text = decodeSubtitleBytes(await file.arrayBuffer());
    const cues = parseSubtitles(text);
    if (!cues.length) {
      ctx.toast('No subtitle lines found in that file. Is it a valid .srt or .vtt?', { tone: 'error' });
      return;
    }
    const res = await ctx.request('subs:set', { name: file.name, text });
    if (res.error) ctx.toast(res.error, { tone: 'error' });
  }

  $('#subs-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    loadFile(file);
  });

  // ---- drag & drop anywhere ----------------------------------------------------------
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    $('#drop-hint').hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#drop-hint').hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault(); // allow drop; never let the browser open the file
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#drop-hint').hidden = true;
    const file = [...e.dataTransfer.files].find(isSubtitleFile) ?? e.dataTransfer.files[0];
    loadFile(file);
  });

  applyStyle();
  renderStatus();

  return {
    applyState,
    onSourceChanged,
    loadFile,
    toggleVisible: () => {
      if (!current) return false;
      setVisible(ctx.style.show === false);
      ctx.toast(ctx.style.show === false ? 'Subtitles hidden' : 'Subtitles shown', { duration: 1200 });
      return true;
    },
    nudge: (delta) => current && setOffset(overlay.offset + delta),
    earlier: () => current && setOffset(overlay.offset - OFFSET_STEP),
    later: () => current && setOffset(overlay.offset + OFFSET_STEP),
    resetOffset: () => setOffset(0),
    remove: () => current && ctx.send('subs:clear'),
    get hasSubtitles() {
      return Boolean(current);
    },
  };
}
