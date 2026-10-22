// ==UserScript==
// @name         IG-Ultimate-TS-Menu
// @namespace    https://github.com/sudharsants28/IG-Ultimate-TS-Menu
// @version      7
// @description  One menu in the Instagram web DM header: Unsend (by message type), Export (TXT / JSON / HTML / PDF, optional photos, Kill or Export-till-here) and Jump to first message / date, all sharing one date-range picker. Includes a self-check.
// @author       TS
// @license      MIT
// @homepageURL  https://github.com/sudharsants28/IG-Ultimate-TS-Menu
// @supportURL   https://github.com/sudharsants28/IG-Ultimate-TS-Menu/issues
// @updateURL    https://raw.githubusercontent.com/sudharsants28/IG-Ultimate-TS-Menu/main/IG-Ultimate-TS-Menu.user.js
// @downloadURL  https://raw.githubusercontent.com/sudharsants28/IG-Ultimate-TS-Menu/main/IG-Ultimate-TS-Menu.user.js
// @icon         https://www.instagram.com/favicon.ico
// @match        https://www.instagram.com/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @connect      cdninstagram.com
// @connect      fbcdn.net
// @connect      instagram.com
// ==/UserScript==

/*
 * Credits
 * The Unsend engine is based on "instagram-dm-unsender" by Romain Lebesle
 * https://github.com/thoughtsunificator/instagram-dm-unsender
 * MIT License - Copyright (c) 2023 Romain Lebesle <oss@thoughtsunificator.me>
 */

(function () {
  'use strict';
  if (window.__igTSMenuLoaded) return;
  window.__igTSMenuLoaded = true;

  // =====================================================================
  //  Basic helpers
  // =====================================================================
  const VERSION = '7';
  const REPO_URL = 'https://github.com/sudharsants28/IG-Ultimate-TS-Menu';
  const STEP_DELAY = 400;   // export: ms to wait after each scroll step
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => (s || '').replace(/[\u00a0\u202f\u2009]/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const pad = n => String(n).padStart(2, '0');
  const el = (tag, css, text) => {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  };

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const DAYS = ['sun','mon','tue','wed','thu','fri','sat'];
  const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)';
  const reMD = new RegExp('\\b' + MON + '[a-z]*\\.?\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?', 'i');
  const reDM = new RegExp('\\b(\\d{1,2})\\s+' + MON + '[a-z]*\\.?(?:,?\\s+(\\d{4}))?', 'i');
  const monthIdx = m => MONTHS.findIndex(x => x.toLowerCase() === m.slice(0, 3).toLowerCase());
  const fmtDate = d => MONTHS[d.getMonth()] + ' ' + d.getDate() + ' ' + d.getFullYear();
  const fmtTime = d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const isoDay = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const safeName = s => s.replace(/[\\/:*?"<>|]/g, '_').trim() || 'chat';
  const todayMidnight = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };

  // =====================================================================
  //  Shared state
  // =====================================================================
  const st = {
    range: null,        // null = not chosen yet | {full:true} | {from:Date, to:Date|null}
    busy: null,         // null | 'jump' | 'export' | 'unsend'
    cancelled: false,
    partial: false,     // export only: 'Export till here' was pressed
    pending: null,      // action waiting for the date popup
    strategy: null
  };
  let ME = 'You', FRIEND = 'User2';
  let cover = null, wakeLock = null;

  const rangeFrom = () => (st.range && !st.range.full ? st.range.from : null);
  const rangeTo = () => (st.range && !st.range.full ? st.range.to : null);
  const rangeText = () => !st.range ? 'Select date'
    : st.range.full ? 'Full chat'
    : fmtDate(st.range.from) + ' \u2192 ' + (st.range.to ? fmtDate(st.range.to) : 'Today');

  // =====================================================================
  //  Scroller / DOM helpers
  // =====================================================================
  function findScrollableChild(parent) {
    for (const child of parent.children) {
      const s = getComputedStyle(child);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && child.scrollHeight > child.clientHeight) return child;
      const f = findScrollableChild(child);
      if (f) return f;
    }
    return null;
  }

  function findScroller() {
    const pagelet = document.querySelector("[data-pagelet='IGDMessagesList']");
    if (pagelet) {
      const s = findScrollableChild(pagelet);
      if (s) return s;
    }
    let best = null, bestArea = 0;
    for (const e of document.querySelectorAll('div')) {
      if (!/(auto|scroll)/.test(getComputedStyle(e).overflowY)) continue;
      if (e.scrollHeight <= e.clientHeight + 50) continue;
      const r = e.getBoundingClientRect();
      if (r.left < 250) continue;
      const area = r.width * r.height;
      if (area > bestArea) { best = e; bestArea = area; }
    }
    return best;
  }

  // Instagram's chat is column-reverse: scrollTop 0 = newest (bottom), most negative = oldest (top)
  const isReversed = e => getComputedStyle(e).flexDirection === 'column-reverse';
  const topPos = e => isReversed(e) ? -(e.scrollHeight - e.clientHeight) : 0;
  const atEnd = e => isReversed(e) ? e.scrollTop >= -5 : e.scrollTop + e.clientHeight >= e.scrollHeight - 5;

  // Container whose direct children are the message rows
  function getInner(scrollable) {
    let best = scrollable, bestCount = scrollable.children.length;
    (function search(e, depth) {
      if (depth > 3) return;
      for (const child of e.children) {
        if (child.children.length > bestCount) { best = child; bestCount = child.children.length; }
        search(child, depth + 1);
      }
    })(scrollable, 0);
    return best;
  }

  // Is this row one of MY messages? (flex-end check, same as the unsend script)
  const mineCache = new WeakMap();
  function rowSentByMe(row) {
    if (mineCache.has(row)) return mineCache.get(row);
    let res = false;
    const queue = [{ e: row, depth: 0 }];
    while (queue.length) {
      const { e, depth } = queue.shift();
      if (getComputedStyle(e).justifyContent === 'flex-end') { res = true; break; }
      if (depth < 8) for (const c of e.children) queue.push({ e: c, depth: depth + 1 });
    }
    mineCache.set(row, res);
    return res;
  }

  // ---------- timestamps ----------
  function parseStamp(raw) {
    const text = norm(raw);
    const t = text.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (!t) return null;
    let h = +t[1];
    const m = +t[2];
    const ap = (t[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    const now = new Date();
    let d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const low = text.toLowerCase();
    let a;
    if ((a = low.match(reMD))) {
      d = new Date(+(a[3] || now.getFullYear()), monthIdx(a[1]), +a[2]);
      if (!a[3] && d > now) d.setFullYear(d.getFullYear() - 1);
    } else if ((a = low.match(reDM))) {
      d = new Date(+(a[3] || now.getFullYear()), monthIdx(a[2]), +a[1]);
      if (!a[3] && d > now) d.setFullYear(d.getFullYear() - 1);
    } else if (/yesterday/.test(low)) {
      d.setDate(d.getDate() - 1);
    } else if (/today/.test(low)) {
      // already today
    } else if ((a = low.match(/\b(sun|mon|tue|wed|thu|fri|sat)/))) {
      const diff = ((now.getDay() - DAYS.indexOf(a[1]) + 7) % 7) || 7;
      d.setDate(d.getDate() - diff);
    }
    return { date: d, ts: new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m) };
  }

  function sepStamp(raw) {
    const text = norm(raw);
    if (text.length > 40 || !/\d{1,2}:\d{2}/.test(text)) return null;
    if (!/^(today|yesterday|sun|mon|tue|wed|thu|fri|sat|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}:\d{2}|\d{1,2}\s+[a-z])/i.test(text)) return null;
    return parseStamp(text);
  }

  const isCentered = (r, sr) => Math.abs((r.left + r.width / 2) - (sr.left + sr.width / 2)) < 80;

  // Every timestamp separator currently in the chat, sorted top (oldest) to bottom (newest).
  // y = r.top + scrollTop stays constant while scrolling = fixed position in the chat.
  function collectSeps(scroller) {
    const sr = scroller.getBoundingClientRect(), off = scroller.scrollTop, out = [];
    for (const e of scroller.querySelectorAll('div, span')) {
      if (e.children.length) continue;
      const tx = e.textContent;
      if (!tx || tx.length > 45 || !/\d{1,2}:\d{2}/.test(tx)) continue;
      const r = e.getBoundingClientRect();
      if (!r.width || !isCentered(r, sr)) continue;
      const s = sepStamp(tx);
      if (s) out.push({ y: r.top + off, date: s.date, ts: s.ts, el: e });
    }
    out.sort((a, b) => a.y - b.y);
    return out;
  }
  const firstStamp = scroller => { const s = collectSeps(scroller); return s.length ? s[0] : null; };

  // =====================================================================
  //  UI: styles + panel
  // =====================================================================
  const ITEM_H = 34, WHEEL_ROWS = 5;
  const css = document.createElement('style');
  css.textContent =
    '.igs-wrap{position:fixed;z-index:99999;display:flex;gap:8px;align-items:center;transform:translateX(-50%);}' +
    '.igs-panel{position:relative;display:flex;gap:8px;align-items:center;white-space:nowrap;' +
    'background:#1c1c1e;color:#fff;padding:6px 8px;border:1px solid #555;border-radius:12px;' +
    'font:14px/1.2 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4);}' +
    '.igs-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border:0;' +
    'border-radius:8px;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer;transition:filter .15s;}' +
    '.igs-btn:hover{filter:brightness(1.15)}' +
    '.igs-lbl:empty{display:none}' +
    '.igs-date{background:#3a3a3c}' +
    '.igs-jump{background:#16a34a;width:32px;padding:0;font-size:15px}' +
    '.igs-export{background:#0095f6}' +
    '.igs-unsend{background:#dc2626}' +
    '.igs-partial{background:#eab308;color:#1c1c1e}' +
    '.igs-ts{background:#7c3aed;width:32px;padding:0;font-size:13px;font-weight:800;letter-spacing:.5px;box-shadow:0 4px 16px rgba(0,0,0,.4)}' +
    '.igs-ts,.igs-ts:link,.igs-ts:visited,.igs-ts:hover,.igs-ts:active,.igs-ts:focus{color:#fff !important;font-weight:800 !important;text-decoration:none !important}' +
    '.igs-ts.igs-off,.igs-ts.igs-off:link,.igs-ts.igs-off:visited{color:#8e8e93 !important}' +
    '.igs-check{background:#fff;width:32px;padding:0;font-size:17px;box-shadow:0 4px 16px rgba(0,0,0,.4)}' +
    '.igs-check .igs-ico{filter:drop-shadow(1px 0 0 #000) drop-shadow(-1px 0 0 #000) drop-shadow(0 1px 0 #000) drop-shadow(0 -1px 0 #000)}' +
    '.igs-stop{background:#f97316 !important}' +
    '.igs-off{background:#4a4a4c !important;color:#8e8e93 !important;opacity:.6;pointer-events:none;cursor:default}' +
    '.igs-panel.igs-compact .igs-lbl{display:none}' +
    '.igs-mbtn{padding:8px 16px;border:0;border-radius:8px;color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer;}';
  document.head.appendChild(css);

  const wrap = el('div');             // [TS] [ strip ] [self-check]
  wrap.className = 'igs-wrap';
  wrap.style.display = 'none';
  wrap.style.left = '50%';
  wrap.style.top = '12px';
  const panel = el('div');
  panel.className = 'igs-panel';

  const face = (b, ico, lbl) => { b._i.textContent = ico; b._l.textContent = lbl || ''; };
  function mkBtn(cls, icoFirst, ico, lbl, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'igs-btn ' + cls;
    b.title = title;
    const i = el('span', null, ''); i.className = 'igs-ico';
    const l = el('span', null, ''); l.className = 'igs-lbl';
    icoFirst ? b.append(i, l) : b.append(l, i);
    b._i = i; b._l = l; b._def = { ico, lbl, title };
    face(b, ico, lbl);
    return b;
  }

  const dateBtn = mkBtn('igs-date', true, '\ud83d\udcc5', 'Select date', 'Choose a date range (or the full chat)');
  const jumpBtn = mkBtn('igs-jump', true, '\u23eb', '', 'Jump to the first message / chosen start date');
  const exportBtn = mkBtn('igs-export', false, '\u2b07', 'Export', 'Export chat (TXT / JSON / HTML / PDF)');
  const unsendBtn = mkBtn('igs-unsend', false, '\u2716', 'Unsend', 'Unsend your messages in the chosen range');
  const partialBtn = mkBtn('igs-partial', true, '\ud83d\udcbe', 'Export till here', 'Stop reading and export everything collected so far');
  partialBtn.style.display = 'none';   // only visible while an export is running
  const tsBtn = document.createElement('a');   // violet TS square -> project page on GitHub
  tsBtn.className = 'igs-btn igs-ts';
  tsBtn.textContent = 'TS';
  tsBtn.href = REPO_URL; tsBtn.target = '_blank'; tsBtn.rel = 'noopener noreferrer';
  tsBtn.title = 'IG-Ultimate-TS-Menu on GitHub';
  const checkBtn = mkBtn('igs-check', true, '\ud83d\ude91', '', 'Self-check: tests that everything this script needs is found on the page');

  function refreshDateBtn() {
    face(dateBtn, '\ud83d\udcc5', rangeText());
    dateBtn.title = 'Date range: ' + rangeText();
  }

  function setBusyUI(kind) {
    const map = { jump: jumpBtn, export: exportBtn, unsend: unsendBtn };
    for (const k of Object.keys(map)) {
      const b = map[k];
      b.classList.remove('igs-stop', 'igs-off');
      if (kind === null) { face(b, b._def.ico, b._def.lbl); b.title = b._def.title; }
      else if (k === kind) { b.classList.add('igs-stop'); face(b, '\u23f9', k === 'jump' ? '' : (k === 'export' ? 'Kill' : 'Stop')); b.title = k === 'export' ? 'Kill: cancel the export, no file is saved' : 'Stop'; }
      else b.classList.add('igs-off');
    }
    dateBtn.classList.toggle('igs-off', kind !== null);
    partialBtn.classList.remove('igs-off');
    partialBtn.style.display = kind === 'export' ? '' : 'none';
    checkBtn.classList.toggle('igs-off', kind !== null);                       // grey while anything runs
    tsBtn.classList.toggle('igs-off', kind !== null && kind !== 'check');      // TS greys out during operations
    if (kind !== null) closePop();
  }

  // =====================================================================
  //  Date picker (two scroll-wheel rows: From / To)
  // =====================================================================
  function makeWheel(labels, width, loop, match) {
    const n = labels.length, half = (WHEEL_ROWS - 1) / 2;
    let idx = 0, typed = '', lastKeyT = 0, dragged = false, lastWheel = 0;
    const holder = el('div', 'position:relative;width:' + width + 'px;height:' + (ITEM_H * WHEEL_ROWS) + 'px;overflow:hidden;' +
      'outline:none;border-radius:8px;cursor:ns-resize;touch-action:none;');
    holder.tabIndex = 0;
    const rows = [];
    for (let k = -half; k <= half; k++) {
      const d = el('div', 'position:absolute;left:0;right:0;top:' + ((k + half) * ITEM_H) + 'px;height:' + ITEM_H + 'px;' +
        'line-height:' + ITEM_H + 'px;text-align:center;font-size:18px;user-select:none;color:#fff;pointer-events:none;');
      rows.push(d); holder.append(d);
    }
    const band = el('div',
      'position:absolute;left:0;right:0;top:' + (ITEM_H * half) + 'px;height:' + ITEM_H + 'px;pointer-events:none;' +
      'border-top:1px solid #0095f6;border-bottom:1px solid #0095f6;background:rgba(0,149,246,.12);border-radius:6px;');
    holder.append(band);
    const wrap = i => loop ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
    const paint = () => {
      rows.forEach((d, j) => {
        const k = j - half, i = idx + k;
        d.textContent = (loop || (i >= 0 && i < n)) ? labels[wrap(i)] : '';
        d.style.opacity = Math.max(0.25, 1 - Math.abs(k) * 0.35);
        d.style.fontWeight = k === 0 ? '700' : '400';
      });
    };
    const set = i => { idx = wrap(i); paint(); };
    const move = k => set(idx + k);

    // mouse: click a row, wheel, drag
    holder.addEventListener('click', e => {
      if (dragged) return;
      const r = holder.getBoundingClientRect();
      move(Math.floor((e.clientY - r.top) / ITEM_H) - half);
    });
    holder.addEventListener('wheel', e => {
      e.preventDefault(); e.stopPropagation();
      const t = Date.now();
      if (t - lastWheel < 45) return;
      lastWheel = t;
      move(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
    holder.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const y0 = e.clientY, i0 = idx;
      dragged = false;
      const mv = ev => {
        const dy = ev.clientY - y0;
        if (Math.abs(dy) > 4) dragged = true;
        if (dragged) set(i0 - Math.round(dy / ITEM_H));
      };
      const up = () => {
        window.removeEventListener('pointermove', mv);
        window.removeEventListener('pointerup', up);
        setTimeout(() => { dragged = false; }, 0);
      };
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', up);
    });

    // keyboard: arrows, or just type (2, 15, jan, 2024 ...)
    const typeKey = ch => {
      const now = Date.now();
      if (now - lastKeyT > 1500) typed = '';      // buffer only expires after a pause, never between quick keystrokes
      lastKeyT = now;
      let m = match(typed + ch);
      if (m >= 0) typed += ch;
      else {                                      // combined text does not fit (e.g. "35" for a day): start a new one
        m = match(ch);
        typed = m >= 0 ? ch : '';
      }
      if (m >= 0) set(m);
    };
    holder.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key.length === 1 && /[0-9a-z]/i.test(e.key)) { e.preventDefault(); e.stopPropagation(); if (!e.repeat) typeKey(e.key.toLowerCase()); }
    });
    holder.addEventListener('mouseenter', () => holder.focus({ preventScroll: true }));
    holder.addEventListener('focus', () => { holder.style.boxShadow = '0 0 0 1px #0095f6'; });
    holder.addEventListener('blur', () => { holder.style.boxShadow = 'none'; });

    paint();
    return {
      el: holder,
      get: () => idx,
      set,
      focus: () => holder.focus({ preventScroll: true })
    };
  }

  const nowY = new Date().getFullYear();
  const YEARS = []; for (let y = 2010; y <= nowY; y++) YEARS.push(y);
  const startsWith = labels => buf => labels.findIndex(l => l.toLowerCase().startsWith(buf));
  const mkWheels = () => ({
    day: makeWheel(Array.from({ length: 31 }, (_, i) => String(i + 1)), 52, true, buf => {
      const v = /^\d+$/.test(buf) ? parseInt(buf, 10) : 0;
      return v >= 1 && v <= 31 ? v - 1 : -1;
    }),
    mon: makeWheel(MONTHS, 64, true, buf => {
      if (/^\d+$/.test(buf)) { const v = parseInt(buf, 10); return v >= 1 && v <= 12 ? v - 1 : -1; }
      return startsWith(MONTHS)(buf);
    }),
    year: makeWheel(YEARS.map(String), 72, false, startsWith(YEARS.map(String)))
  });
  const fromW = mkWheels(), toW = mkWheels();
  const setW = (w, d) => {
    w.day.set(d.getDate() - 1);
    w.mon.set(d.getMonth());
    w.year.set(Math.max(0, YEARS.indexOf(d.getFullYear())));
  };
  const readW = w => {
    const y = YEARS[w.year.get()], m = w.mon.get();
    const day = Math.min(w.day.get() + 1, new Date(y, m + 1, 0).getDate());   // 31 Feb -> 28/29 Feb
    let d = new Date(y, m, day);
    const t = todayMidnight();
    if (d > t) d = t;                                                         // no future dates
    return d;
  };

  const pop = el('div',
    'position:absolute;top:calc(100% + 10px);left:50%;transform:translateX(-50%);display:none;flex-direction:column;gap:10px;' +
    'background:#1c1c1e;color:#fff;padding:14px;border:1px solid #666;border-radius:14px;' +
    'box-shadow:0 8px 28px rgba(0,0,0,.55);cursor:default;');
  const popTitle = el('div', 'font:600 14px system-ui,sans-serif;text-align:center;', 'Select date range');
  const mkGroup = (title, w, extra) => {
    const g = el('div', 'display:flex;flex-direction:column;gap:6px;align-items:center;');
    const head = el('div', 'display:flex;gap:8px;align-items:center;height:26px;');
    head.append(el('div', 'font:600 13px system-ui,sans-serif;opacity:.9;', title));
    if (extra) head.append(extra);
    const row = el('div', 'display:flex;gap:4px;');
    row.append(w.day.el, w.mon.el, w.year.el);
    g.append(head, row);
    return { g, row };
  };
  let till = true;
  const tillBtn = el('button', 'padding:3px 10px;border:0;border-radius:6px;font:600 12px system-ui,sans-serif;cursor:pointer;color:#fff;');
  tillBtn.type = 'button';
  const gFrom = mkGroup('From', fromW);
  const gTo = mkGroup('To', toW, tillBtn);
  const updateTill = () => {
    tillBtn.textContent = till ? '\u2713 Till today' : 'Till today';
    tillBtn.style.background = till ? '#0095f6' : '#3a3a3c';
    gTo.row.style.opacity = till ? '0.3' : '1';
    gTo.row.style.pointerEvents = till ? 'none' : 'auto';
  };
  tillBtn.onclick = () => { till = !till; updateTill(); };
  const wheelsRow = el('div', 'display:flex;gap:18px;justify-content:center;');
  wheelsRow.append(gFrom.g, el('div', 'width:1px;background:#444;'), gTo.g);
  const popErr = el('div', 'color:#ff6b6b;font:13px system-ui,sans-serif;text-align:center;min-height:16px;');
  const popBtns = el('div', 'display:flex;gap:8px;');
  const fullBtn = el('button', 'background:#3a3a3c;flex:1;', 'Full chat');
  fullBtn.className = 'igs-mbtn'; fullBtn.type = 'button';
  const setBtn = el('button', 'background:#0095f6;flex:1;', 'Set date');
  setBtn.className = 'igs-mbtn'; setBtn.type = 'button';
  popBtns.append(fullBtn, setBtn);
  pop.append(popTitle, wheelsRow, popErr, popBtns);
  for (const ev of ['keydown', 'keyup', 'keypress']) pop.addEventListener(ev, e => e.stopPropagation());
  pop.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); dismissPop(); }
    else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); setBtn.click(); }
  });

  function openPop() {          // always opens fresh: nothing is remembered from last time
    pop.style.display = 'flex';
    setW(fromW, new Date());
    setW(toW, new Date());
    till = true;
    updateTill();
    popErr.textContent = '';
    fromW.day.focus();
  }
  function closePop() { pop.style.display = 'none'; }
  function resetRange() { st.range = null; refreshDateBtn(); }
  function dismissPop() { closePop(); st.pending = null; resetRange(); }
  function runPending() { const a = st.pending; st.pending = null; if (a) a(); }

  dateBtn.onclick = () => { if (pop.style.display === 'flex') dismissPop(); else openPop(); };
  fullBtn.onclick = () => { st.range = { full: true }; refreshDateBtn(); closePop(); runPending(); };
  setBtn.onclick = () => {
    const from = readW(fromW);
    const to = till ? null : readW(toW);
    if (to && to < from) { popErr.textContent = 'The end date is before the start date.'; return; }
    st.range = { full: false, from, to };
    refreshDateBtn(); closePop(); runPending();
  };
  document.addEventListener('mousedown', e => {
    if (pop.style.display === 'flex' && !pop.contains(e.target) && !dateBtn.contains(e.target)) dismissPop();
  });

  panel.append(dateBtn, jumpBtn, exportBtn, partialBtn, unsendBtn, pop);
  wrap.append(tsBtn, panel, checkBtn);
  document.body.appendChild(wrap);
  refreshDateBtn();

  // Keep the panel in the chat header, between the person's name and the call / video / info icons
  let placeSc = null, placeTick = 0;
  function placePanel(refind) {
    if (!location.pathname.startsWith('/direct/t/')) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'flex';
    if (refind || !placeSc || !placeSc.isConnected) placeSc = findScroller();
    if (!placeSc) { wrap.style.top = '12px'; wrap.style.left = '50%'; return; }
    const r = placeSc.getBoundingClientRect();
    panel.classList.remove('igs-compact');
    let w = wrap.offsetWidth;
    const avail = (r.right - 150) - (r.left + 220);
    if (w > avail) { panel.classList.add('igs-compact'); w = wrap.offsetWidth; }
    const h = wrap.offsetHeight;
    const top = Math.max(6, r.top - 42 - h / 2);             // vertical centre of the header
    let cx = r.left + r.width / 2;                           // centre of the chat area
    cx = Math.min(cx, r.right - 150 - w / 2);                // clear of call / video / info icons
    cx = Math.max(cx, r.left + 220 + w / 2);                 // clear of avatar + name
    wrap.style.top = top + 'px';
    wrap.style.left = Math.max(w / 2 + 6, cx) + 'px';
  }
  window.addEventListener('resize', () => placePanel(true));
  setTimeout(() => placePanel(true), 300);

  let lastPath = null;
  setInterval(() => {
    const changed = location.pathname !== lastPath;
    if (changed) {
      lastPath = location.pathname;
      st.range = null;                 // every chat starts on "Select date"
      st.pending = null;
      refreshDateBtn();
      closePop();
      if (st.busy) requestStop();
    }
    placePanel(changed || ++placeTick % 5 === 0);
  }, 1000);

  // =====================================================================
  //  Modals (confirmation + export options) and toast
  // =====================================================================
  function modal(build) {
    return new Promise(resolve => {
      const back = el('div', 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:100000;background:rgba(0,0,0,.6);' +
        'display:flex;align-items:center;justify-content:center;font:14px/1.4 system-ui,sans-serif;');
      const card = el('div', 'background:#1c1c1e;color:#fff;border:1px solid #555;border-radius:14px;padding:18px;width:390px;' +
        'max-width:92vw;box-shadow:0 10px 40px rgba(0,0,0,.6);display:flex;flex-direction:column;gap:12px;');
      let onEnter = null;
      const close = v => { document.removeEventListener('keydown', onKey, true); back.remove(); resolve(v); };
      const onKey = e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
        else if (e.key === 'Enter' && onEnter && e.target.tagName !== 'BUTTON') { e.preventDefault(); onEnter(); }
      };
      for (const ev of ['keydown', 'keyup', 'keypress']) card.addEventListener(ev, e => e.stopPropagation());
      back.addEventListener('mousedown', e => { if (e.target === back) close(null); });
      onEnter = build(card, close) || null;
      back.append(card);
      document.body.appendChild(back);
      document.addEventListener('keydown', onKey, true);
      const first = card.querySelector('input');
      if (first) { first.focus(); first.select(); }
    });
  }
  const mbtn = (text, bg) => { const b = el('button', 'background:' + bg + ';flex:1;', text); b.className = 'igs-mbtn'; b.type = 'button'; return b; };
  const mtitle = t => el('div', 'font:700 17px system-ui,sans-serif;', t);

  const KIND_DEFS = [
    ['text',  'Text',          'Text bubbles, links and emoji'],
    ['voice', 'Voice messages', ''],
    ['media', 'Media',         'Photos and videos you sent'],
    ['reel',  'Reels',         ''],
    ['post',  'Posts',         ''],
    ['other', 'Other',         'Stickers and anything else']
  ];
  const kindLabel = k => (KIND_DEFS.find(d => d[0] === k) || [k, k])[1];

  // Popup 1: what kind of messages to unsend
  const typesModal = () => modal((card, close) => {
    const sel = new Set();
    card.append(mtitle('What do you want to unsend?'));
    card.append(el('div', 'opacity:.8;font-size:13px;', 'Tick the kinds of YOUR messages to remove.'));
    const mkBox = round => el('span', 'width:20px;height:20px;box-sizing:border-box;border:2px solid #8e8e93;border-radius:' + (round ? '50%' : '5px') +
      ';display:inline-flex;align-items:center;justify-content:center;font:700 13px/1 system-ui,sans-serif;color:#fff;flex:none;');
    const mkRow = (label, sub, round, accent) => {
      const r = el('div', 'display:flex;gap:10px;align-items:center;padding:8px 10px;background:#2c2c2e;border-radius:8px;cursor:pointer;user-select:none;' + (accent ? 'border:1px solid #dc2626;' : ''));
      const b = mkBox(round), t = el('div', 'display:flex;flex-direction:column;');
      t.append(el('div', 'font-weight:600;', label));
      if (sub) t.append(el('div', 'font-size:12px;opacity:.7;', sub));
      r.append(b, t);
      return { r, b };
    };
    const list = el('div', 'display:flex;flex-direction:column;gap:6px;');
    const rows = {};
    for (const [k, label, sub] of KIND_DEFS) {
      rows[k] = mkRow(label, sub, false, false);
      rows[k].r.onclick = () => { if (sel.has(k)) sel.delete(k); else sel.add(k); paint(); };
      list.append(rows[k].r);
    }
    const nuke = mkRow('EVERYTHING (NUKE!)', 'Every kind of message', true, true);
    nuke.r.onclick = () => { for (const [k] of KIND_DEFS) sel.add(k); paint(); };
    list.append(nuke.r);
    card.append(list);

    const hint = el('div', 'color:#ff6b6b;font-size:12px;min-height:14px;');
    const row = el('div', 'display:flex;gap:8px;margin-top:2px;');
    const cancel = mbtn('Cancel', '#3a3a3c'), ok = mbtn('OK', '#3a3a3c');
    const paint = () => {
      for (const [k] of KIND_DEFS) {
        const on = sel.has(k);
        rows[k].b.textContent = on ? '\u2713' : '';
        rows[k].b.style.background = on ? '#0095f6' : 'transparent';
        rows[k].b.style.borderColor = on ? '#0095f6' : '#8e8e93';
      }
      const all = sel.size === KIND_DEFS.length;      // all squares ticked <-> EVERYTHING selected
      nuke.b.textContent = all ? '\u25cf' : '';
      nuke.b.style.background = all ? '#dc2626' : 'transparent';
      nuke.b.style.borderColor = all ? '#dc2626' : '#8e8e93';
      ok.style.background = sel.size ? '#0095f6' : '#3a3a3c';
      ok.style.opacity = sel.size ? '1' : '.45';
      ok.style.cursor = sel.size ? 'pointer' : 'default';
      if (sel.size) hint.textContent = '';
    };
    const submit = () => {
      if (!sel.size) { hint.textContent = 'Choose at least one kind first.'; return; }
      close({ all: sel.size === KIND_DEFS.length, kinds: KIND_DEFS.map(d => d[0]).filter(k => sel.has(k)) });
    };
    cancel.onclick = () => close(null);
    ok.onclick = submit;
    row.append(cancel, ok);
    card.append(hint, row);
    paint();
    return submit;
  });

  // Popup 2: final confirmation (range + kinds)
  const confirmUnsendModal = choice => modal((card, close) => {
    card.append(mtitle('Confirm unsend?'));
    card.append(el('div', 'background:#2c2c2e;border-radius:8px;padding:8px 12px;font-weight:600;', 'Range: ' + rangeText()));
    card.append(el('div', 'background:#2c2c2e;border-radius:8px;padding:8px 12px;font-weight:600;' + (choice.all ? 'color:#ff6b6b;' : ''),
      'Messages: ' + (choice.all ? 'EVERYTHING (NUKE!)' : choice.kinds.map(kindLabel).join(', '))));
    card.append(el('div', 'opacity:.8;font-size:13px;',
      'Only YOUR messages in this chat will be unsent' +
      (st.range && !st.range.full ? ', from the start date to the end date (or today).' : ' (the whole chat).') +
      ' This cannot be undone.'));
    const row = el('div', 'display:flex;gap:8px;');
    const cancel = mbtn('Cancel', '#3a3a3c'), ok = mbtn('Unsend', '#dc2626');
    cancel.onclick = () => close(null);
    ok.onclick = () => close(true);
    row.append(cancel, ok);
    card.append(row);
  });

  const exportModal = (detectedFriend, detectedMe) => modal((card, close) => {
    let fmt = null;                      // nothing preselected
    let media = false;                   // 'Include media' is off by default
    const inStyle = 'background:#2c2c2e;color:#fff;border:1px solid #555;border-radius:8px;padding:8px 10px;font:14px system-ui,sans-serif;width:100%;box-sizing:border-box;';
    const field = (label, val) => {
      const w = el('div', 'display:flex;flex-direction:column;gap:4px;');
      w.append(el('div', 'font-size:12px;opacity:.75;', label));
      const i = el('input', inStyle); i.type = 'text'; i.value = val;
      w.append(i);
      card.append(w);
      return i;
    };
    card.append(mtitle('Export chat'));
    card.append(el('div', 'background:#2c2c2e;border-radius:8px;padding:8px 12px;font-weight:600;', 'Range: ' + rangeText()));
    const meIn = field('Enter your desired print name:', detectedMe || '');
    const frIn = field("Enter other person's desired print name:", detectedFriend || '');
    const fw = el('div', 'display:flex;flex-direction:column;gap:4px;');
    fw.append(el('div', 'font-size:12px;opacity:.75;', 'Format'));
    const frow = el('div', 'display:flex;gap:8px;');
    const fbtns = {};
    const hint = el('div', 'color:#ff6b6b;font-size:12px;min-height:14px;');
    const row = el('div', 'display:flex;gap:8px;margin-top:4px;');
    const cancel = mbtn('Cancel', '#3a3a3c'), go = mbtn('Start Export', '#3a3a3c');
    const mrow = el('div', 'display:flex;align-items:center;justify-content:space-between;gap:10px;background:#2c2c2e;border-radius:8px;padding:8px 12px;');
    const mtxt = el('div', 'font-size:13px;line-height:1.3;', 'Include media');
    mtxt.append(el('div', 'font-size:11px;opacity:.65;', 'your photos \u00b7 HTML / PDF only'));
    const track = el('div', 'position:relative;width:40px;height:22px;border-radius:11px;flex:none;transition:background .15s;');
    const knob = el('div', 'position:absolute;top:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s;');
    track.append(knob); mrow.append(mtxt, track);
    const paintMedia = () => {
      const can = fmt === 'html' || fmt === 'pdf';
      track.style.background = can && media ? '#0095f6' : '#555';
      knob.style.left = can && media ? '20px' : '2px';
      mrow.style.opacity = can ? '1' : '.45';
      mrow.style.cursor = can ? 'pointer' : 'default';
    };
    mrow.onclick = () => {
      if (fmt !== 'html' && fmt !== 'pdf') { hint.textContent = 'Choose HTML or PDF to include media.'; return; }
      media = !media; hint.textContent = ''; paintMedia();
    };
    const paintF = () => {
      for (const k of Object.keys(fbtns)) fbtns[k].style.background = k === fmt ? '#0095f6' : '#3a3a3c';
      go.style.background = fmt ? '#0095f6' : '#3a3a3c';
      go.style.opacity = fmt ? '1' : '.45';
      go.style.cursor = fmt ? 'pointer' : 'default';
      paintMedia();
    };
    for (const [k, t] of [['txt', 'TXT'], ['json', 'JSON'], ['html', 'HTML'], ['pdf', 'PDF']]) {
      const b = mbtn(t, '#3a3a3c');
      b.onclick = () => { fmt = k; hint.textContent = ''; paintF(); };
      fbtns[k] = b; frow.append(b);
    }
    paintF();
    fw.append(frow); card.append(fw, mrow, hint);
    cancel.onclick = () => close(null);
    const submit = () => {
      if (!fmt) { hint.textContent = 'Choose a format first.'; return; }
      close({ me: meIn.value, friend: frIn.value, fmt, media: (fmt === 'html' || fmt === 'pdf') && media });
    };
    go.onclick = submit;
    row.append(cancel, go); card.append(row);
    return submit;
  });

  let toastEl = null, toastTimer = null;
  function toast(text, ms) {
    if (!toastEl) {
      toastEl = el('div', 'position:fixed;z-index:100001;background:rgba(28,28,30,.96);color:#fff;border:1px solid #555;' +
        'padding:8px 16px;border-radius:999px;font:14px system-ui,sans-serif;max-width:80vw;transform:translateX(-50%);pointer-events:none;');
      document.body.appendChild(toastEl);
    }
    const sc = findScroller();
    const r = sc ? sc.getBoundingClientRect() : { left: 0, width: innerWidth, bottom: innerHeight };
    toastEl.style.left = (r.left + r.width / 2) + 'px';
    toastEl.style.top = Math.max(60, r.bottom - 80) + 'px';
    toastEl.textContent = text;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, ms || 5000);
  }

  // =====================================================================
  //  Run control: cover over the chat, status line, keys, wake-lock
  // =====================================================================
  function makeCover(scroller, dim) {
    const r = scroller.getBoundingClientRect();
    const box = el('div',
      'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;' +
      'z-index:99998;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'font:15px system-ui,sans-serif;text-align:center;color:#fff;' +
      (dim ? 'background:rgba(0,0,0,.88);' : 'background:transparent;pointer-events:none;'));
    if (dim) {
      const hint = el('div', 'font-size:13px;opacity:.7;max-width:340px;',
        'Working\u2026 keep this tab visible and do not click inside the chat. Esc or the orange button = stop.');
      box.append(hint);
      for (const ev of ['wheel', 'touchmove']) box.addEventListener(ev, e => e.preventDefault(), { passive: false });
    }
    const status = el('div',
      'position:absolute;bottom:24px;left:50%;transform:translateX(-50%);max-width:90%;background:rgba(28,28,30,.96);' +
      'color:#fff;border:1px solid #555;padding:8px 18px;border-radius:999px;font:14px system-ui,sans-serif;');
    status.textContent = 'Starting\u2026';
    box.append(status);
    document.body.appendChild(box);
    return { set: t => { status.textContent = t; }, remove: () => box.remove() };
  }
  const setStatus = t => { if (cover) cover.set(t); };

  function onKey(e) {   // block real keyboard input while running (synthetic events from the script pass through)
    if (!e.isTrusted) return;
    if (e.key === 'Escape' && e.type === 'keydown') requestStop();
    e.preventDefault(); e.stopPropagation();
  }
  async function keepAwake() { try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {} }
  function releaseAwake() { try { if (wakeLock) wakeLock.release(); } catch (e) {} wakeLock = null; }
  const onVis = () => { if (!document.hidden && st.busy) keepAwake(); };

  // Pause while this tab is in the background (Chrome slows hidden tabs a lot)
  async function waitVisible() {
    if (!document.hidden) return;
    while (document.hidden && !st.cancelled && !st.partial) {
      setStatus('Paused \u2013 come back to this tab to continue');
      await sleep(700);
    }
    await sleep(1000);
  }

  function beginRun(kind, scroller, dim) {
    st.busy = kind; st.cancelled = false; st.partial = false;
    setBusyUI(kind);
    cover = makeCover(scroller, dim);
    for (const ev of ['keydown', 'keyup', 'keypress']) window.addEventListener(ev, onKey, true);
    document.addEventListener('visibilitychange', onVis);
    keepAwake();
  }
  function endRun() {
    if (cover) cover.remove();
    cover = null;
    for (const ev of ['keydown', 'keyup', 'keypress']) window.removeEventListener(ev, onKey, true);
    document.removeEventListener('visibilitychange', onVis);
    releaseAwake();
    st.busy = null; st.strategy = null; st.partial = false;
    setBusyUI(null);
    resetRange();
  }
  function requestStop() {          // Kill / Stop / Esc: cancel everything, nothing is saved
    st.cancelled = true;
    setStatus('Stopping\u2026');
    if (st.strategy) st.strategy.stop();
  }
  function requestPartial() {       // export only: stop reading, then save what has been collected so far
    if (st.busy !== 'export' || st.cancelled || st.partial) return;
    st.partial = true;
    partialBtn.classList.add('igs-off');
    setStatus('Finishing \u2013 building the file from what was collected\u2026');
  }

  // Scroll up until the first message (or until we are past the chosen start date)
  async function loadToTop(scroller, o) {
    let stable = 0, last = -1, n = 0;
    while (stable < o.stable && !st.cancelled && !st.partial) {
      await waitVisible();
      scroller.scrollTop = topPos(scroller);
      scroller.dispatchEvent(new Event('scroll'));
      setStatus(o.label + ' (' + (++n) + ')');
      await sleep(o.poll);
      if (o.from) {
        const f = firstStamp(scroller);
        if (f && f.date < o.from) return true;
      }
      if (scroller.scrollHeight === last) stable++; else stable = 0;
      last = scroller.scrollHeight;
    }
    return !st.cancelled && !st.partial;
  }

  // =====================================================================
  //  JUMP
  // =====================================================================
  async function startJump() {
    const scroller = findScroller();
    if (!scroller) { resetRange(); return toast('Could not find the message area. Click inside the chat and try again.'); }
    const from = rangeFrom();
    beginRun('jump', scroller, false);
    let msg = '';
    try {
      const ok = await loadToTop(scroller, {
        from, poll: 350, stable: 6,
        label: from ? 'Looking for ' + fmtDate(from) + '\u2026' : 'Scrolling to the first message\u2026'
      });
      if (!ok) msg = 'Stopped.';
      else if (from) {
        let t = collectSeps(scroller).find(s => s.date >= from);
        if (!t) {   // newer rows may not be in the page yet: walk down from the top until that day shows up
          scroller.scrollTop = topPos(scroller);
          await sleep(500);
          for (let guard = 0; guard < 4000 && !st.cancelled; guard++) {
            await waitVisible();
            t = collectSeps(scroller).find(s => s.date >= from);
            if (t || atEnd(scroller)) break;
            setStatus('Looking for ' + fmtDate(from) + '\u2026');
            const before = scroller.scrollTop;
            scroller.scrollTop = before + Math.max(150, Math.floor(scroller.clientHeight * 0.8));
            scroller.dispatchEvent(new Event('scroll'));
            await sleep(250);
            if (scroller.scrollTop === before) break;
          }
        }
        if (t) {
          const delta = t.el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
          scroller.scrollTop += delta;
          msg = t.date.getTime() === from.getTime()
            ? 'Jumped to ' + fmtDate(t.date)
            : 'No messages on ' + fmtDate(from) + ' \u2013 jumped to the nearest day: ' + fmtDate(t.date);
        } else msg = st.cancelled ? 'Stopped.' : 'No messages on or after ' + fmtDate(from) + '.';
      } else {
        scroller.scrollTop = topPos(scroller);
        msg = 'You are at the first message.';
      }
    } catch (err) {
      console.error('[IG-Ultimate-TS-Menu] jump failed', err);
      msg = 'Jump failed: ' + err.message;
    } finally { endRun(); }
    toast(msg);
  }

  // =====================================================================
  //  EXPORT
  // =====================================================================
  const RESERVED = /^(direct|explore|reels?|accounts|stories|p|tv|about|legal|privacy|directory|web|api|challenge|notifications|emails|session|oauth|developer|download|docs)$/i;
  const userFromPath = path => {
    const m = (path || '').match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
    return m && !RESERVED.test(m[1]) ? m[1] : null;
  };

  // The other person's Instagram username (from the profile link in the chat header), else the name shown there
  function detectFriendName(scroller) {
    try {
      const sr = scroller.getBoundingClientRect();
      const inHeader = r => r.width && r.bottom <= sr.top + 4 && r.top >= sr.top - 170;
      for (const a of document.querySelectorAll('a[href]')) {
        if (wrap.contains(a) || a.host !== location.host) continue;
        const r = a.getBoundingClientRect();
        if (!inHeader(r) || r.left < sr.left - 5) continue;
        const u = userFromPath(a.pathname);
        if (u) return u;
      }
      for (const e of document.querySelectorAll('h1, h2, span, div[dir="auto"]')) {
        if (wrap.contains(e)) continue;
        const r = e.getBoundingClientRect();
        if (!inHeader(r) || r.left < 250) continue;
        const t = norm(e.innerText);
        if (!t || t.length > 40 || t.indexOf('\n') !== -1 || !/\p{L}/u.test(t)) continue;
        if (/^(active|online|typing|seen)\b/i.test(t) || /\bago$/i.test(t)) continue;
        return t;
      }
    } catch (e) {}
    return null;
  }

  // Your own Instagram username (from the Profile link in the left menu); null if it cannot be read
  function detectMyName() {
    try {
      for (const a of document.querySelectorAll('a[href]')) {
        if (wrap.contains(a) || a.host !== location.host) continue;
        const u = userFromPath(a.pathname);
        if (!u) continue;
        const r = a.getBoundingClientRect();
        if (!r.width || r.left > 260) continue;
        const img = a.querySelector('img[alt]');
        if (/^profile$/i.test(norm(a.innerText)) || (img && /profile pic/i.test(img.getAttribute('alt') || ''))) return u;
      }
    } catch (e) {}
    return null;
  }

  const stats = { me: 0, friend: 0, fallback: 0, react: 0, reply: 0, quote: 0 };

  function senderOf(e, scroller, inner) {
    let row = null;
    for (let a = e; a && a !== scroller; a = a.parentElement) {
      if (a.parentElement === inner) { row = a; break; }
    }
    let mine;
    if (row) mine = rowSentByMe(row);
    else {
      stats.fallback++;
      mine = false;
      for (let a = e; a && a !== scroller; a = a.parentElement) {
        if (getComputedStyle(a).justifyContent === 'flex-end') { mine = true; break; }
      }
    }
    mine ? stats.me++ : stats.friend++;
    return mine ? ME : FRIEND;
  }

  const STATUS = /^(seen|delivered|sent|active now|active today|seen .{1,20}|sent .{1,20})$/i;
  const SEL = 'div[dir="auto"], span, img, video, a[href*="/reel/"], a[href*="/p/"]';
  const REPLY_RE = /^(you replied to .+|.+ replied to .+|replied to .+)$/i;
  const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0f\u20e3\u{1F3FB}-\u{1F3FF}\s]+$/u;
  const EMOJI_ANY = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;

  // Like innerText, but also keeps emoji that Instagram renders as <img alt="...">
  function textOf(e) {
    const imgs = e.querySelectorAll('img[alt]');
    let hasEmojiImg = false;
    for (const im of imgs) if (EMOJI_ANY.test(im.getAttribute('alt') || '')) { hasEmojiImg = true; break; }
    if (!hasEmojiImg) return norm(e.innerText);
    let s = '';
    (function walk(n) {
      if (n.nodeType === 3) { s += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (n.tagName === 'IMG') { const a = n.getAttribute('alt') || ''; if (EMOJI_ANY.test(a)) s += a; return; }
      if (n.tagName === 'BR') { s += '\n'; return; }
      for (const c of n.childNodes) walk(c);
      if (n.tagName === 'DIV' || n.tagName === 'P') { if (s && !s.endsWith('\n')) s += '\n'; }
    })(e);
    return norm(s.replace(/\n+$/, ''));
  }
  const smallFont = e => {
    let min = Infinity, n = 0;
    for (const x of [e, ...e.querySelectorAll('*')]) {
      if (n++ > 6) break;
      const f = parseFloat(getComputedStyle(x).fontSize);
      if (f) min = Math.min(min, f);
    }
    return min;
  };
  const linkText = link => (link.href.includes('/reel/') ? '<reel ' : '<post ') + link.href.split('?')[0] + '>';

  // ---------- photos for the HTML export (only photos YOU sent) ----------
  const IMG_MAX_SIDE = 800, IMG_MAX_COUNT = 600;
  let wantPhotos = false, photoCount = 0;

  const blobToDataUrl = b => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = rej; f.readAsDataURL(b); });
  async function shrink(blob) {                         // big photos -> max 800px JPEG so the file stays small
    if (blob.size < 120 * 1024) return blobToDataUrl(blob);
    try {
      const bmp = await createImageBitmap(blob);
      const k = Math.min(1, IMG_MAX_SIDE / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      if (bmp.close) bmp.close();
      return c.toDataURL('image/jpeg', 0.82);
    } catch (e) { return blobToDataUrl(blob); }
  }
  function gmBlob(url) {
    const gm = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
      : (typeof GM !== 'undefined' && GM && GM.xmlHttpRequest ? GM.xmlHttpRequest : null);
    if (!gm) return Promise.reject(new Error('no GM_xmlhttpRequest'));
    return new Promise((res, rej) => gm({
      method: 'GET', url, responseType: 'blob', timeout: 20000,
      onload: r => (r.status >= 200 && r.status < 300 && r.response) ? res(r.response) : rej(new Error('HTTP ' + r.status)),
      onerror: rej, ontimeout: () => rej(new Error('timeout'))
    }));
  }
  async function grabPhoto(img) {                        // -> data URL, or null (then the export keeps the <media> placeholder)
    const src = img.currentSrc || img.src;
    if (!src || /^data:/.test(src) && src.length < 200) return null;
    try {
      let blob;
      try { const r = await fetch(src, { mode: 'cors', credentials: 'omit' }); if (!r.ok) throw new Error('HTTP ' + r.status); blob = await r.blob(); }
      catch (e1) { blob = await gmBlob(src); }          // fallback: Violentmonkey/Tampermonkey download
      if (!blob || !/^image\//.test(blob.type || 'image/')) return null;
      return await shrink(blob);
    } catch (e) { console.warn('[IG-Ultimate-TS-Menu] photo skipped', e); return null; }
  }

  // Read every not-yet-read element currently in the chat; each one is read only once
  function readVisible(scroller, all, done, counter) {
    const sr = scroller.getBoundingClientRect();
    const inner = getInner(scroller);
    const off = scroller.scrollTop;
    const markTree = e => { done.add(e); for (const c of e.querySelectorAll('*')) done.add(c); };

    const addMsg = o => { all.push(o); if (counter.quote && o.y >= counter.quote.y - 4) counter.quote = null; };
    const addQuote = (e, y, text) => {
      stats.quote++;
      addMsg({ type: 'msg', kind: 'quote', y, n: counter.n++, who: senderOf(e, scroller, inner), text });
    };

    for (const e of scroller.querySelectorAll(SEL)) {
      if (done.has(e)) continue;
      const r = e.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const y = r.top + off;
      if (counter.quote && y > counter.quote.y + 170) counter.quote = null;

      // Reels / shared posts
      const link = e.tagName === 'A' ? e : e.closest('a[href*="/reel/"], a[href*="/p/"]');
      if (link) {
        done.add(e);
        if (done.has(link) && link !== e) continue;
        done.add(link);
        addMsg({ type: 'msg', y: link.getBoundingClientRect().top + off, n: counter.n++,
          who: senderOf(link, scroller, inner), text: linkText(link) });
        continue;
      }

      // Photos / videos / stickers (ignore avatars) + emoji drawn as small images
      if (e.tagName === 'IMG' || e.tagName === 'VIDEO') {
        done.add(e);
        const alt = e.tagName === 'IMG' ? (e.getAttribute('alt') || '').trim() : '';
        if (r.width > 100 && r.height > 100) {
          const who = senderOf(e, scroller, inner);
          const o = { type: 'msg', y, n: counter.n++, who, text: '<media>' };
          if (wantPhotos && e.tagName === 'IMG' && who === ME && photoCount < IMG_MAX_COUNT) { photoCount++; o.photoP = grabPhoto(e).then(d => { o.photo = d; return d; }); }
          addMsg(o);
          continue;
        }
        if (alt && EMOJI_ONLY.test(alt) && !e.closest('div[dir="auto"]')) {
          if (counter.quote) addQuote(e, y, alt);
          else if (r.width <= 30 && r.height <= 30) { stats.react++; all.push({ type: 'reaction', y, n: counter.n++, text: alt }); }
          else addMsg({ type: 'msg', y, n: counter.n++, who: senderOf(e, scroller, inner), text: alt });
        } else if (counter.quote && r.width >= 40 && r.height >= 40 && !/profile/i.test(alt)) {
          addQuote(e, y, '<media>');
        }
        continue;
      }

      // "X replied to Y" label
      const raw = e.textContent || '';
      if (raw.length <= 100 && /replied to/i.test(raw)) {
        const t = textOf(e).replace(/\n+/g, ' ');
        if (t && t.length <= 100 && REPLY_RE.test(t) && smallFont(e) <= 14) {
          markTree(e);
          stats.reply++;
          all.push({ type: 'msg', kind: 'replylabel', y, n: counter.n++, who: senderOf(e, scroller, inner), text: t });
          counter.quote = { y };
          continue;
        }
      }

      if (e.tagName === 'SPAN' && e.children.length) { done.add(e); continue; }
      if (e.tagName === 'DIV' && e.querySelector('div[dir="auto"]')) { done.add(e); continue; }
      const text = textOf(e);
      done.add(e);
      if (!text) continue;

      // Time separator?
      if (isCentered(r, sr)) {
        const s = sepStamp(text);
        if (s) { all.push({ type: 'sep', y, n: counter.n++, stamp: s, text }); continue; }
      }

      const partOfText = e.tagName === 'SPAN' && e.parentElement && e.parentElement.closest('div[dir="auto"]');

      if (counter.quote && !partOfText && !STATUS.test(text) && (e.tagName === 'SPAN' || EMOJI_ONLY.test(text))) {
        addQuote(e, y, text.replace(/\n+/g, '\n  '));
        continue;
      }

      if (EMOJI_ONLY.test(text) && r.height < 28 && r.width < 48 && !partOfText) {
        stats.react++;
        all.push({ type: 'reaction', y, n: counter.n++, text });
        continue;
      }

      if (e.tagName !== 'DIV') continue;
      if (STATUS.test(text)) continue;

      addMsg({ type: 'msg', y, n: counter.n++, who: senderOf(e, scroller, inner), text: text.replace(/\n+/g, '\n  ') });
    }
  }

  // Instagram's label uses the other person's @username; rewrite it with the names typed at export time
  function replyHeader(m) {
    const t = (m.text || '').trim();
    let a, sender, tgt;
    if ((a = t.match(/^you replied to (.+)$/i))) { sender = 'me'; tgt = a[1].trim(); }
    else if ((a = t.match(/^(.+?) replied to (.+)$/i))) { sender = 'friend'; tgt = a[2].trim(); }
    else if ((a = t.match(/^replied to (.+)$/i))) { sender = m.who === ME ? 'me' : 'friend'; tgt = a[1].trim(); }
    else return null;
    if (/^(their|his|her)\s|story|reel/i.test(tgt)) return null;
    const targetIsMe = sender === 'me' ? /^(yourself|you|myself)$/i.test(tgt) : /^(you|yourself)$/i.test(tgt);
    return (sender === 'me' ? 'you' : FRIEND) + ' replied to ' + (targetIsMe ? 'you' : FRIEND);
  }

  // One block's raw entries -> clean items (msg / reaction / reply)
  function buildItems(msgs) {
    const items = [], used = new Set();
    const nextMsg = from => {
      for (let j = from; j < msgs.length; j++) {
        if (used.has(j)) continue;
        const x = msgs[j];
        if (x.type === 'reaction') continue;
        if (x.kind === 'replylabel') return -1;
        if (x.type === 'msg') return j;
      }
      return -1;
    };
    for (let i = 0; i < msgs.length; i++) {
      if (used.has(i)) continue;
      const m = msgs[i];
      if (m.kind === 'replylabel') {
        const q = nextMsg(i + 1);
        const r = q === -1 ? -1 : nextMsg(q + 1);
        const head = replyHeader(m) || m.text;
        if (q !== -1 && r !== -1) {
          items.push({ t: 'reply', head, original: msgs[q].text, who: msgs[r].who, text: msgs[r].text, img: msgs[r].photo || null });
          used.add(q); used.add(r);
        } else if (q !== -1) {
          items.push({ t: 'reply', head, original: null, who: msgs[q].who, text: msgs[q].text });
          used.add(q);
        } else items.push({ t: 'reply', head, original: null, who: m.who, text: null });
        continue;
      }
      if (m.type === 'reaction') { items.push({ t: 'reaction', text: m.text }); continue; }
      items.push({ t: 'msg', who: m.who, text: m.text, img: m.photo || null });
    }
    return items;
  }

  // ---------- output formats ----------
  function buildTxt(kept) {
    const out = [];
    let lastDay = null;
    for (const b of kept) {
      const day = b.stamp ? fmtDate(b.stamp.date) : 'Unknown date';
      if (day !== lastDay) {
        if (out.length) out.push('');
        out.push(day, '');
        lastDay = day;
      }
      if (b.stamp) out.push(fmtTime(b.stamp.ts));
      for (const it of buildItems(b.msgs)) {
        if (it.t === 'msg') out.push('[' + it.who + '] ' + it.text);
        else if (it.t === 'reaction') out.push('    \u21b3 reaction: ' + it.text);
        else {
          out.push('\u21aa ' + it.head + (it.original !== null ? ' : ' + it.original : ''));
          if (it.text !== null) out.push('    > ' + it.text);
        }
      }
      out.push('');
    }
    return out.join('\n');
  }

  function buildJson(kept, fromDate, toDate) {
    const messages = [];
    for (const b of kept) {
      const date = b.stamp ? isoDay(b.stamp.date) : null;
      const time = b.stamp ? fmtTime(b.stamp.ts) : null;
      for (const it of buildItems(b.msgs)) {
        if (it.t === 'msg') messages.push({ date, time, type: 'message', sender: it.who, text: it.text });
        else if (it.t === 'reaction') messages.push({ date, time, type: 'reaction', text: it.text });
        else messages.push({ date, time, type: 'reply', sender: it.who, text: it.text,
          replyTo: { label: it.head, original: it.original } });
      }
    }
    return JSON.stringify({
      exportedWith: 'IG-Ultimate-TS-Menu',
      exportedAt: new Date().toISOString(),
      me: ME, friend: FRIEND,
      from: fromDate ? isoDay(fromDate) : null,
      to: toDate ? isoDay(toDate) : null,
      messages
    }, null, 2);
  }

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const escBr = s => esc(s).replace(/\n\s*/g, '<br>');

  function buildHtml(kept, fromDate, toDate, forPdf, docTitle) {
    let body = '', lastDay = null;
    const photoBubble = (who, src) =>
      '<div class="row ' + (who === ME ? 'me' : 'fr') + '"><div class="col"><img class="ph" alt="photo" src="' + src + '"></div></div>';
    const bubble = (who, inner, quote) =>
      '<div class="row ' + (who === ME ? 'me' : 'fr') + '"><div class="col">' + (quote || '') +
      (inner !== null ? '<div class="b">' + inner + '</div>' : '') + '</div></div>';
    for (const b of kept) {
      const day = b.stamp ? fmtDate(b.stamp.date) : 'Unknown date';
      if (day !== lastDay) { body += '<div class="day">' + esc(day) + '</div>'; lastDay = day; }
      if (b.stamp) body += '<div class="time">' + esc(fmtTime(b.stamp.ts)) + '</div>';
      for (const it of buildItems(b.msgs)) {
        if (it.t === 'msg') body += it.img ? photoBubble(it.who, it.img) : bubble(it.who, escBr(it.text));
        else if (it.t === 'reaction') body += '<div class="react">\u21b3 reaction ' + esc(it.text) + '</div>';
        else {
          const q = '<div class="q">\u21aa ' + esc(it.head) + (it.original !== null ? ': ' + escBr(it.original) : '') + '</div>';
          body += bubble(it.who, it.text !== null ? escBr(it.text) : null, q);
        }
      }
    }
    const range = (fromDate ? fmtDate(fromDate) : 'Start') + ' \u2192 ' + (toDate ? fmtDate(toDate) : fmtDate(new Date()));
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + (forPdf && docTitle ? esc(docTitle) : 'Chat with ' + esc(FRIEND)) + '</title><style>' +
      'body{font:15px/1.45 system-ui,sans-serif;background:#f5f5f7;color:#111;margin:0}' +
      '.wrap{max-width:720px;margin:0 auto;padding:24px 14px}' +
      'h1{font-size:20px;margin:0 0 4px}.sub{color:#777;font-size:13px;margin-bottom:18px}' +
      '.day{text-align:center;margin:22px 0 6px;font-weight:600;color:#555}' +
      '.time{text-align:center;color:#999;font-size:12px;margin:8px 0 4px}' +
      '.row{display:flex;margin:3px 0}.row.me{justify-content:flex-end}' +
      '.col{display:flex;flex-direction:column;max-width:78%}.me .col{align-items:flex-end}' +
      '.b{padding:8px 12px;border-radius:18px;word-break:break-word}' +
      '.me .b{background:#0095f6;color:#fff}.fr .b{background:#e6e6eb}' +
      '.ph{max-width:100%;max-height:520px;border-radius:18px;display:block}' +
      '.q{font-size:12px;color:#777;margin:2px 4px;border-left:3px solid #bbb;padding-left:8px}' +
      '.react{font-size:13px;color:#777;margin:0 12px}' +
      (forPdf
        ? '@page{margin:14mm}body{background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
          '.wrap{max-width:none;padding:0}.row,.q,.react,.ph{break-inside:avoid}.day,.time{break-after:avoid}.ph{max-height:420px}'
        : '@media (prefers-color-scheme:dark){body{background:#000;color:#eee}.fr .b{background:#262626}' +
          '.sub,.time,.q,.react{color:#999}.day{color:#bbb}.q{border-color:#555}}') +
      '</style></head><body><div class="wrap"><h1>Chat with ' + esc(FRIEND) + '</h1>' +
      '<div class="sub">' + esc(ME) + ' &amp; ' + esc(FRIEND) + ' \u00b7 ' + esc(range) + '</div>' + body +
      '</div></body></html>';
  }

  // PDF = the HTML layout opened in a hidden frame + the browser's own print window ("Save as PDF").
  async function printPdf(html, title) {
    const oldTitle = document.title;
    const fr = document.createElement('iframe');
    fr.setAttribute('aria-hidden', 'true');
    fr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;';
    document.body.appendChild(fr);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return; cleaned = true;
      try { document.title = oldTitle; } catch (e) { /* ignore */ }
      setTimeout(() => { try { fr.remove(); } catch (e) { /* ignore */ } }, 1000);
    };
    try {
      const d = fr.contentDocument, w = fr.contentWindow;
      d.open(); d.write(html); d.close();
      // wait (max 15 s) until embedded photos are drawn
      await Promise.race([
        Promise.all(Array.from(d.images).map(im => im.complete ? 0 : new Promise(r => { im.onload = im.onerror = r; }))),
        sleep(15000)
      ]);
      await sleep(300);
      w.addEventListener('afterprint', cleanup);
      setTimeout(cleanup, 600000);            // safety: remove the hidden frame after 10 minutes
      document.title = title;                 // the print window proposes this as the PDF file name
      w.focus();
      w.print();
    } catch (err) {
      console.error('[IG-Ultimate-TS-Menu] PDF print failed', err);
      cleanup();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
      a.download = title + '.html';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      toast('Could not open the print window. Saved as HTML instead: open it and press Ctrl+P.', 9000);
    }
  }

  async function startExport() {
    let scroller = findScroller();
    if (!scroller) { resetRange(); return toast('Could not find the message area. Click inside the chat and try again.'); }
    const myAuto = detectMyName() || '', frAuto = detectFriendName(scroller) || '';
    const ans = await exportModal(frAuto, myAuto);
    if (!ans) { resetRange(); return; }
    ME = norm(ans.me) || myAuto || 'You';          // empty field -> Instagram username
    FRIEND = norm(ans.friend) || frAuto || 'User2';
    scroller = findScroller();
    if (!scroller) { resetRange(); return toast('Could not find the message area. Click inside the chat and try again.'); }

    const fromDate = rangeFrom(), toDate = rangeTo();
    const ranged = !!(fromDate || toDate);
    const inRange = d => (!fromDate || d >= fromDate) && (!toDate || d <= toDate);
    stats.me = stats.friend = stats.fallback = stats.react = stats.reply = stats.quote = 0;
    wantPhotos = (ans.fmt === 'html' || ans.fmt === 'pdf') && !!ans.media; photoCount = 0;
    beginRun('export', scroller, true);
    let finalMsg = null, pdfJob = null;

    try {
      // 1) Scroll to the first message (or to the chosen start date)
      const ok = await loadToTop(scroller, { from: fromDate, poll: 500, stable: 4, label: 'Going to the first message\u2026' });
      if (st.partial && !st.cancelled) { finalMsg = 'Nothing collected yet \u2013 export cancelled, no file saved.'; return; }
      if (!ok || st.cancelled) { finalMsg = 'Export killed \u2013 no file saved.'; return; }

      // 2) Walk down toward the newest message, reading as we go
      const all = [], done = new WeakSet(), counter = { n: 0 };
      scroller.scrollTop = topPos(scroller);
      await sleep(800);
      let guard = 0, scanned = 0, pastEnd = false;
      while (guard++ < 20000 && !st.cancelled && !st.partial) {
        await waitVisible();
        readVisible(scroller, all, done, counter);
        if (toDate) {   // stop early once the walker has passed the end date
          const bottomY = scroller.getBoundingClientRect().bottom + scroller.scrollTop;
          for (; scanned < all.length; scanned++) {
            const e = all[scanned];
            if (e.type === 'sep' && e.stamp.date > toDate && e.y < bottomY) pastEnd = true;
          }
          if (pastEnd) break;
        }
        setStatus('Reading\u2026 ' + all.length + ' items' + (wantPhotos ? ', ' + photoCount + ' photos' : ''));
        if (atEnd(scroller)) break;
        const before = scroller.scrollTop;
        scroller.scrollTop = before + Math.max(150, Math.floor(scroller.clientHeight * 0.6));
        scroller.dispatchEvent(new Event('scroll'));
        await sleep(STEP_DELAY);
        if (scroller.scrollTop === before) break;
      }
      if (!st.partial && !st.cancelled) await sleep(600);
      readVisible(scroller, all, done, counter);
      if (st.cancelled) { finalMsg = 'Export killed \u2013 no file saved.'; return; }
      const cutShort = st.partial;   // reading was stopped early with 'Export till here'

      // 3) Order by position in the chat and drop duplicates
      all.sort((a, b) => (a.y - b.y) || (a.n - b.n));
      const sigOf = e => e.type + '|' + (e.who || '') + '|' + e.text;
      const entries = [];
      let dups = 0;
      for (const e of all) {
        const s = sigOf(e);
        let dup = false;
        for (let k = entries.length - 1; k >= 0 && k >= entries.length - 6; k--) {
          if (Math.abs(entries[k].y - e.y) < 12 && sigOf(entries[k]) === s) { dup = true; break; }
        }
        if (dup) dups++; else entries.push(e);
      }
      console.log('[IG-Ultimate-TS-Menu] raw:', all.length, 'kept:', entries.length, 'dups dropped:', dups,
        '| mine:', stats.me, 'friend:', stats.friend, 'fallback sender checks:', stats.fallback,
        '| reply labels:', stats.reply, 'reactions:', stats.react, 'quotes rescued:', stats.quote);

      // 4) Group into blocks (one per timestamp row)
      const blocks = [];
      let cur = { stamp: null, msgs: [] };
      for (const e of entries) {
        if (e.type === 'sep') {
          if (cur.msgs.length || cur.stamp) blocks.push(cur);
          cur = { stamp: e.stamp, msgs: [] };
        } else cur.msgs.push(e);
      }
      if (cur.msgs.length || cur.stamp) blocks.push(cur);

      const kept = blocks.filter(b => b.msgs.length && (!ranged || (b.stamp && inRange(b.stamp.date))));
      if (!kept.length) { finalMsg = cutShort ? 'Nothing collected yet \u2013 no file saved.' : 'No messages found in that range. Instagram may have changed its layout.'; return; }

      // 4b) HTML / PDF only: wait for the photos you sent to finish downloading
      let photosOk = 0;
      if (wantPhotos) {
        const withPhoto = kept.flatMap(b => b.msgs).filter(m => m.photoP);
        const raceStop = p => new Promise(res => {      // wait for a photo, but give up at once on Kill / Export till here
          const t = setInterval(() => { if (st.partial || st.cancelled) { clearInterval(t); res(null); } }, 150);
          p.then(v => { clearInterval(t); res(v); }, () => { clearInterval(t); res(null); });
        });
        let n = 0;
        for (const m of withPhoto) {
          if (st.cancelled || st.partial) break;       // partial: keep only the photos that already finished
          setStatus('Preparing photos\u2026 ' + (++n) + ' / ' + withPhoto.length);
          await raceStop(m.photoP);
        }
        if (st.cancelled) { finalMsg = 'Export killed \u2013 no file saved.'; return; }
        photosOk = withPhoto.filter(m => m.photo).length;
      }

      // 5) Build the file in the chosen format and download it
      let content, mime, ext;
      const nameBase = 'dm_' + safeName(FRIEND) + '_' + (fromDate ? isoDay(fromDate) : 'full') + '_to_' +
        (toDate ? isoDay(toDate) : isoDay(new Date())) + (cutShort ? '_partial' : '');
      if (ans.fmt === 'json') { content = buildJson(kept, fromDate, toDate); mime = 'application/json'; ext = 'json'; }
      else if (ans.fmt === 'html') { content = buildHtml(kept, fromDate, toDate); mime = 'text/html'; ext = 'html'; }
      else if (ans.fmt === 'pdf') { pdfJob = { html: buildHtml(kept, fromDate, toDate, true, nameBase), title: nameBase }; ext = 'pdf'; }
      else { content = buildTxt(kept); mime = 'text/plain'; ext = 'txt'; }

      if (!pdfJob) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([content], { type: mime + ';charset=utf-8' }));
        a.download = nameBase + '.' + ext;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      }

      const nMsgs = kept.reduce((s, b) => s + b.msgs.filter(m => m.type === 'msg').length, 0);
      finalMsg = (cutShort ? 'Partial export (stopped early): ' : 'Done: ') + kept.length + ' chat blocks, ' + nMsgs + ' messages exported (' + ext.toUpperCase() + ')' + (wantPhotos ? ', ' + photosOk + ' photo(s) embedded' : '') + '.' + (pdfJob ? " In the print window choose 'Save as PDF'." : '');
    } catch (err) {
      console.error('[IG-Ultimate-TS-Menu] export failed', err);
      finalMsg = 'Export failed: ' + err.message;
    } finally {
      wantPhotos = false;
      endRun();
    }
    if (finalMsg) toast(finalMsg, pdfJob ? 9000 : 7000);
    if (pdfJob) setTimeout(() => printPdf(pdfJob.html, pdfJob.title), 500);
  }

  // =====================================================================
  //  UNSEND  (engine based on thoughtsunificator/instagram-dm-unsender, fast timings)
  // =====================================================================
  const UNSEND_TEXT_VARIANTS = ['unsend', 'annulla invio', 'retirar', 'deshacer', 'retirer', 'zur\u00fccknehmen'];
  const LABEL_PATTERNS = [
    "[aria-label^='See more options for message']",
    "[aria-label*='more options']",
    "[aria-label*='More']",
    "[aria-label*='Altre opzioni']",
    "[aria-label*='opzioni']",
    "[aria-label*='opciones']",
    "[aria-label*='options']"
  ];

  function waitForElement(target, getElement, abortController) {
    return new Promise((resolve, reject) => {
      let mutationObserver;
      const abortHandler = () => {
        if (mutationObserver) mutationObserver.disconnect();
        reject(new Error('waitForElement aborted: ' + abortController.signal.reason));
      };
      abortController.signal.addEventListener('abort', abortHandler);
      let element = getElement();
      if (element) {
        resolve(element);
        abortController.signal.removeEventListener('abort', abortHandler);
      } else {
        mutationObserver = new MutationObserver((mutations, observer) => {
          element = getElement(mutations);
          if (element) {
            observer.disconnect();
            resolve(element);
            abortController.signal.removeEventListener('abort', abortHandler);
          }
        });
        mutationObserver.observe(target, { subtree: true, childList: true });
      }
    });
  }

  function clickElementAndWaitFor(clickTarget, target, getElement, abortController) {
    const promise = waitForElement(target, getElement, abortController);
    clickTarget.click();
    return getElement() || promise;
  }

  function dispatchHoverIn(target) {
    const rect = target.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, pointerId: 1, pointerType: 'mouse' };
    target.dispatchEvent(new PointerEvent('pointerenter', { ...o, bubbles: false }));
    target.dispatchEvent(new PointerEvent('pointerover', o));
    target.dispatchEvent(new PointerEvent('pointermove', o));
    target.dispatchEvent(new MouseEvent('mouseenter', { ...o, bubbles: false }));
    target.dispatchEvent(new MouseEvent('mouseover', o));
    target.dispatchEvent(new MouseEvent('mousemove', o));
  }

  function dismissStaleOverlays() {
    const staleDialog = document.querySelector('[role=dialog]');
    if (staleDialog) {
      const closeBtn = staleDialog.querySelector('button');
      if (closeBtn) closeBtn.click();
    }
    const activeMenu = document.querySelector('[role=menu], [role=listbox]');
    if (activeMenu) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }

  function findActionButton(scope) {
    for (const sel of LABEL_PATTERNS) {
      const e = scope.querySelector(sel);
      if (e) {
        const btn = e.closest('[role=button]') || e.closest('button');
        if (btn && scope.contains(btn)) return btn;
        if (e.tagName === 'BUTTON' || e.getAttribute('role') === 'button') return e;
      }
    }
    return scope.querySelector('[role=button][aria-haspopup=menu]');
  }

  async function showActionsMenuButton(root, abortController) {
    dismissStaleOverlays();
    const hoverTargets = [root];
    const collect = (e, depth) => {
      if (depth > 8) return;
      for (const child of e.children) { hoverTargets.push(child); collect(child, depth + 1); }
    };
    collect(root, 0);

    for (let attempt = 0; attempt < 3; attempt++) {
      if (abortController.signal.aborted) return null;
      for (const t of hoverTargets) dispatchHoverIn(t);
      await sleep(100);
      const btn = findActionButton(root);
      if (btn) return btn;
      dispatchHoverOut(root);
      await sleep(50);
    }

    const waitAbort = new AbortController();
    let promiseTimeout;
    const abortHandler = () => { waitAbort.abort('showActionsMenuButton step was aborted by the parent process'); clearTimeout(promiseTimeout); };
    abortController.signal.addEventListener('abort', abortHandler);
    for (const t of hoverTargets) dispatchHoverIn(t);
    try {
      return await Promise.race([
        waitForElement(root, () => findActionButton(root), waitAbort),
        new Promise((resolve, reject) => { promiseTimeout = setTimeout(() => reject('Timeout showActionsMenuButton'), 3000); })
      ]);
    } finally {
      waitAbort.abort();
      clearTimeout(promiseTimeout);
      abortController.signal.removeEventListener('abort', abortHandler);
    }
  }

  function dispatchHoverOut(target) {
    const rect = target.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, pointerId: 1, pointerType: 'mouse' };
    target.dispatchEvent(new PointerEvent('pointerout', o));
    target.dispatchEvent(new PointerEvent('pointerleave', { ...o, bubbles: false }));
    target.dispatchEvent(new MouseEvent('mouseout', o));
    target.dispatchEvent(new MouseEvent('mouseleave', { ...o, bubbles: false }));
  }

  async function openActionsMenu(actionButton, abortController) {
    const waitAbort = new AbortController();
    let promiseTimeout;
    const abortHandler = () => { waitAbort.abort('openActionsMenu step was aborted by the parent process'); clearTimeout(promiseTimeout); };
    abortController.signal.addEventListener('abort', abortHandler);
    const isUnsendText = text => UNSEND_TEXT_VARIANTS.some(v => text.trim().toLocaleLowerCase() === v);
    try {
      return await Promise.race([
        clickElementAndWaitFor(actionButton, document.body, mutations => {
          if (mutations) {
            const added = [...mutations.map(m => [...m.addedNodes])].flat().filter(n => n.nodeType === 1);
            for (const node of added) {
              const found = [...node.querySelectorAll('span,div')].find(n => isUnsendText(n.textContent) && n.firstChild?.nodeType === 3);
              if (found) return found;
            }
          }
          const spans = document.querySelectorAll('[role=menu] span, [role=menu] div, [role=menuitem] span, [role=menuitem] div');
          for (const s of spans) {
            if (isUnsendText(s.textContent) && s.firstChild?.nodeType === 3) return s;
          }
        }, waitAbort),
        new Promise((resolve, reject) => { promiseTimeout = setTimeout(() => reject('Timeout openActionsMenu'), 3000); })
      ]);
    } finally {
      waitAbort.abort();
      clearTimeout(promiseTimeout);
      abortController.signal.removeEventListener('abort', abortHandler);
    }
  }

  const openConfirmUnsendModal = (unsendButton, abortController) =>
    clickElementAndWaitFor(unsendButton, document.body, () => document.querySelector('[role=dialog] button'), abortController);

  async function confirmUnsend(dialogButton, abortController) {
    await clickElementAndWaitFor(dialogButton, document.body, () => document.querySelector('[role=dialog] button') === null, abortController);
  }

  // The whole workflow for one message row
  async function unsendRow(root, abortController) {
    try {
      const actionButton = await showActionsMenuButton(root, abortController);
      const unsendButton = await openActionsMenu(actionButton, abortController);
      const dialogButton = await openConfirmUnsendModal(unsendButton, abortController);
      await confirmUnsend(dialogButton, abortController);
      root.setAttribute('data-idmu-unsent', '');
      return true;
    } catch (ex) {
      console.error(ex);
      root.setAttribute('data-idmu-ignore', '');
      try {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(200);
        if (document.querySelector('[role=dialog]')) {
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await sleep(200);
        }
      } catch (error) { console.error(error); }
      throw new Error('Failed to execute workflow for this message');
    }
  }

  // Which side of the chosen date range is this row on? (uses the timestamp separator above it)
  function classifyRow(rect, scroller, seps, range) {
    const y = rect.bottom + scroller.scrollTop - 2;
    let found = null;
    for (let i = seps.length - 1; i >= 0; i--) { if (seps[i].y <= y) { found = seps[i]; break; } }
    if (!found) return 'unknown';
    if (range.from && found.date < range.from) return 'older';
    if (range.to && found.date > range.to) return 'newer';
    return 'in';
  }

  // What kind of message is this row?  text | voice | media | reel | post | other
  // (Instagram does not label them, so this is read from the layout. Unsure = 'other'.)
  function rowKind(row) {
    if (row.querySelector('a[href*="/reel/"]')) return 'reel';
    if (row.querySelector('a[href*="/p/"], a[href*="/tv/"]')) return 'post';
    if (row.querySelector('audio, [aria-label*="audio" i], [aria-label*="voice" i], [aria-label="Play"]')) return 'voice';
    for (const a of row.querySelectorAll('a[href]')) {          // links to other websites count as text
      const h = a.getAttribute('href') || '';
      if (/^https?:\/\//i.test(h) && !/^https?:\/\/(www\.)?instagram\.com\//i.test(h)) return 'text';
    }
    for (const m of row.querySelectorAll('img, video')) {
      const r = m.getBoundingClientRect();
      if (r.width > 100 && r.height > 100) {
        const alt = m.getAttribute('alt') || '';
        if (/profile/i.test(alt)) continue;
        return /sticker|gif/i.test(alt) ? 'other' : 'media';
      }
    }
    for (const d of row.querySelectorAll('div[dir="auto"], span[dir="auto"]')) {
      const t = textOf(d);
      if (t && !STATUS.test(t)) return 'text';
    }
    for (const im of row.querySelectorAll('img[alt]')) {         // emoji-only messages
      if (EMOJI_ONLY.test(im.getAttribute('alt') || '')) return 'text';
    }
    return 'other';
  }

  // First of MY messages that is still to be unsent (and inside the date range / chosen types)
  function getFirstVisibleMessage(root, abortController, range, types) {
    const inner = getInner(root);
    if (!inner) return;
    if (range) range.sawOlder = false;
    const elements = [...inner.children].filter(d => {
      if (d.hasAttribute('data-idmu-ignore') || d.hasAttribute('data-idmu-unsent') || d.hasAttribute('data-idmu-skip')) return false;
      if (!(d.querySelector('[role=none]') || d.querySelector('[role=presentation]'))) return false;
      return rowSentByMe(d);
    });
    elements.reverse();
    let seps = null;
    for (const element of elements) {
      if (abortController.signal.aborted) break;
      if (element.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true, opacityProperty: true }) === false) continue;
      const rect = element.getBoundingClientRect();
      if (rect.y + rect.height < 0 || rect.height === 0) continue;
      if (range) {
        seps = seps || collectSeps(root);
        const v = classifyRow(rect, root, seps, range);
        if (v === 'older') { range.sawOlder = true; element.setAttribute('data-idmu-skip', ''); continue; }
        if (v === 'newer') { element.setAttribute('data-idmu-skip', ''); continue; }
        if (v === 'unknown') continue;
      }
      if (types && !types.has(rowKind(element))) { element.setAttribute('data-idmu-skip', ''); continue; }
      element.setAttribute('data-idmu-ignore', '');
      return element;
    }
  }

  async function loadMoreMessages(root, abortController) {
    const scrollAbort = new AbortController();
    let findLoaderTimeout, resolveTimeout;
    const abortHandler = () => {
      scrollAbort.abort('abortHandler was aborted');
      clearTimeout(findLoaderTimeout);
      if (resolveTimeout) resolveTimeout();
    };
    abortController.signal.addEventListener('abort', abortHandler);

    const reversed = isReversed(root);
    const scrollToTopValue = reversed ? -(root.scrollHeight - root.clientHeight) : 0;
    const isAtTop = () => reversed ? root.scrollTop <= scrollToTopValue + 5 : root.scrollTop === 0;
    const beforeScroll = root.scrollTop, beforeHeight = root.scrollHeight;
    root.scrollTop = scrollToTopValue;

    const findVisibleLoader = () => {
      for (const bar of root.querySelectorAll('[role=progressbar]')) {
        const rect = bar.getBoundingClientRect(), rootRect = root.getBoundingClientRect();
        if (rect.height > 0 && rect.y >= rootRect.y - 100 && rect.y <= rootRect.y + rootRect.height + 100) return bar;
      }
      return null;
    };

    if (beforeScroll === 0 && root.scrollHeight <= root.clientHeight + 50) {   // chat fits in the viewport
      abortController.signal.removeEventListener('abort', abortHandler);
      return true;
    }

    if (isAtTop()) {
      await sleep(500);
      const loader = findVisibleLoader();
      if (loader) {
        await Promise.race([
          waitForElement(root, () => findVisibleLoader() === null, abortController),
          sleep(5000)
        ]);
        abortController.signal.removeEventListener('abort', abortHandler);
        return !(root.scrollHeight > beforeHeight);
      }
      if (!(root.scrollHeight > beforeHeight)) {
        abortController.signal.removeEventListener('abort', abortHandler);
        return true;
      }
    }

    let loadingElement;
    try {
      loadingElement = await Promise.race([
        waitForElement(root, () => {
          if (findVisibleLoader() === null) root.scrollTop = scrollToTopValue;
          return findVisibleLoader();
        }, scrollAbort),
        new Promise(resolve => {
          resolveTimeout = resolve;
          findLoaderTimeout = setTimeout(() => resolve(), 3000);
        })
      ]);
    } catch (ex) { console.error(ex); }
    scrollAbort.abort('Scrolling took too much time. Timeout after 10s');
    abortController.signal.removeEventListener('abort', abortHandler);
    clearTimeout(findLoaderTimeout);
    if (loadingElement && loadingElement !== true) {
      await Promise.race([
        waitForElement(root, () => findVisibleLoader() === null, abortController),
        sleep(5000)
      ]);
    }
    return isAtTop();
  }

  class Unsender {
    constructor(root, onStatus, range, types) {
      this.root = root;
      this.types = types || null;        // null = every kind of message
      this.onStatus = onStatus;
      this.range = range;                 // {from, to} or null (= whole chat)
      this.abort = new AbortController();
      this.unsent = 0; this.pages = 0; this.failures = 0;
      this.last = null; this.lastScrollTop = null; this.allLoaded = false;
      this.summary = '';
    }
    get aborted() { return this.abort.signal.aborted; }
    stop() { this.onStatus('Stopping\u2026'); this.abort.abort('Unsender stopped'); }

    clearMarkers() {
      document.querySelectorAll('[data-idmu-ignore],[data-idmu-skip]').forEach(e => {
        e.removeAttribute('data-idmu-ignore');
        e.removeAttribute('data-idmu-skip');
      });
    }

    async run() {
      this.clearMarkers();
      try {
        if (this.allLoaded ? true : await this.loadAll()) await this.unsendLoop();

        if (this.unsent === 0 && !this.aborted) {
          for (let retry = 1; retry <= 3; retry++) {
            this.onStatus('No messages detected, retrying (' + retry + '/3)...');
            await sleep(2000);
            if (this.aborted) break;
            this.allLoaded = false; this.failures = 0;
            this.clearMarkers();
            if (await this.loadAll()) await this.unsendLoop();
            if (this.unsent > 0 || this.aborted) break;
          }
        }
        this.summary = (this.aborted ? 'Stopped. ' : 'Done. ') + this.unsent + ' message(s) unsent.';
      } catch (ex) {
        console.error(ex);
        this.summary = 'Errored. ' + this.unsent + ' message(s) unsent.';
      }
    }

    // Load older pages until the top (or until we are past the chosen start date)
    async loadAll() {
      while (!this.aborted) {
        this.onStatus('Loading older messages\u2026' + (this.pages ? ' (' + this.pages + ')' : ''));
        let done;
        try { done = await loadMoreMessages(this.root, this.abort); }
        catch (ex) { console.error(ex); return false; }
        if (this.aborted) return false;
        if (done) {
          this.allLoaded = true;
          this.onStatus('All pages loaded (' + this.pages + ' in total). Unsending...');
          return true;
        }
        this.pages++;
        if (this.range && this.range.from) {
          const f = firstStamp(this.root);
          if (f && f.date < this.range.from) {
            this.allLoaded = true;
            this.onStatus('Reached the start date. Unsending...');
            return true;
          }
        }
      }
      return false;
    }

    async nextMessage() {
      const root = this.root, reversed = isReversed(root);
      const probe = () => { try { return getFirstVisibleMessage(root, this.abort, this.range, this.types); } catch (ex) { console.error(ex); } };
      let found = probe();
      if (found) return found;
      if (this.range && this.range.sawOlder) return false;   // everything left is older than the start date

      for (let pass = 0; pass < 3; pass++) {
        if (this.aborted) return false;
        if (reversed) {
          const minScroll = -(root.scrollHeight - root.clientHeight);
          const startPos = (pass === 0 && this.lastScrollTop !== null) ? Math.max(this.lastScrollTop, minScroll) : 0;
          const step = Math.abs(minScroll) < 500 ? 30 : 150;
          for (let i = startPos; i >= minScroll; i -= step) {
            if (this.aborted) return false;
            this.lastScrollTop = i;
            root.scrollTop = i;
            root.dispatchEvent(new Event('scroll'));
            await sleep(5);
            found = probe();
            if (found) return found;
            if (this.range && this.range.sawOlder) return false;
          }
        } else {
          const maxScroll = root.scrollHeight - root.clientHeight;
          const startScrollTop = (pass === 0 && this.lastScrollTop !== null) ? Math.min(this.lastScrollTop, maxScroll) : maxScroll;
          const step = maxScroll < 500 ? 30 : 150;
          for (let i = Math.max(1, startScrollTop); i > 0; i -= step) {
            if (this.aborted) return false;
            this.lastScrollTop = i;
            root.scrollTop = i;
            root.dispatchEvent(new Event('scroll'));
            await sleep(5);
            found = probe();
            if (found) return found;
            if (this.range && this.range.sawOlder) return false;
          }
        }
        this.lastScrollTop = null;
      }
      return false;
    }

    async unsendLoop() {
      while (!this.aborted) {
        if (this.failures >= 5) {
          this.onStatus('Stopped: ' + this.failures + ' consecutive failures. ' + this.unsent + ' message(s) unsent.');
          return;
        }
        await waitVisible();
        let canScroll = true, msgElement = null;
        try {
          this.onStatus('Retrieving next message... (' + this.unsent + ' unsent so far)');
          const row = await this.nextMessage();
          canScroll = row !== false;
          if (row) {
            this.onStatus('Unsending message... (' + (this.unsent + 1) + ')');

            // FAST: 0.3-0.6s randomized delay between unsends
            if (this.last !== null) {
              const elapsed = Date.now() - this.last.getTime();
              const minDelay = 300 + Math.floor(Math.random() * 300);
              if (elapsed < minDelay) {
                const waitMs = minDelay - elapsed;
                this.onStatus('Waiting ' + (waitMs / 1000).toFixed(1) + 's... (' + this.unsent + ' unsent so far)');
                await sleep(waitMs);
              }
            }
            if (this.aborted) return;

            msgElement = row;
            const unsent = await unsendRow(row, this.abort);

            if (unsent) {
              await sleep(400);   // FAST: 400ms verification wait
              const stillInDOM = msgElement.isConnected && !msgElement.hasAttribute('data-idmu-unsent');
              if (stillInDOM) {
                msgElement.removeAttribute('data-idmu-ignore');
                this.failures++;
                const backoffMs = Math.min(60000, 5000 * Math.pow(2, this.failures - 1));
                this.onStatus('Rate limit detected. Backing off ' + (backoffMs / 1000).toFixed(0) + 's... (' + this.unsent + ' unsent)');
                await sleep(backoffMs);
              } else {
                this.last = new Date();
                this.unsent++;
                this.failures = 0;
                this.lastScrollTop = null;
              }
            } else {
              msgElement.removeAttribute('data-idmu-ignore');
              this.failures++;
            }
          }
        } catch (ex) {
          console.error(ex);
          if (msgElement) msgElement.removeAttribute('data-idmu-ignore');
          this.failures++;
          const backoffMs = Math.min(60000, 3000 * Math.pow(2, this.failures - 1));
          this.onStatus('Workflow failed (' + this.failures + '/5), retrying in ' + (backoffMs / 1000).toFixed(0) + 's... (' + this.unsent + ' unsent)');
          await sleep(backoffMs);
        }
        if (!canScroll || this.aborted) return;
      }
    }
  }

  async function startUnsend() {
    const scroller = findScroller();
    if (!scroller) { resetRange(); return toast('Could not find the message area. Click inside the chat and try again.'); }
    const choice = await typesModal();
    if (!choice) { resetRange(); return; }
    const ok = await confirmUnsendModal(choice);
    if (!ok) { resetRange(); return; }
    const types = choice.all ? null : new Set(choice.kinds);
    const range = rangeFrom() ? { from: rangeFrom(), to: rangeTo() } : null;
    beginRun('unsend', scroller, true);
    const strategy = new Unsender(scroller, setStatus, range, types);
    st.strategy = strategy;
    let msg = '';
    try {
      await strategy.run();
      msg = strategy.summary;
    } catch (err) {
      console.error('[IG-Ultimate-TS-Menu] unsend failed', err);
      msg = 'Unsend failed: ' + err.message;
    } finally { endRun(); }
    toast(msg, 8000);
  }


  // =====================================================================
  //  SELF-CHECK  (read-only: only looks at the page, never changes the chat)
  // =====================================================================
  const reportModal = text => modal((card, close) => {
    card.style.width = '540px';
    card.append(mtitle('Self-check report'));
    card.append(el('pre', 'margin:0;background:#2c2c2e;border-radius:8px;padding:10px 12px;' +
      'font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;' +
      'max-height:55vh;overflow:auto;user-select:text;', text));
    card.append(el('div', 'font-size:12px;opacity:.7;',
      'Nothing in your chat was changed. The report has no messages and no usernames, only counts, settings and date labels.'));
    const row = el('div', 'display:flex;gap:8px;');
    const closeB = mbtn('Close', '#3a3a3c'), copyB = mbtn('Copy report', '#8b5cf6');
    closeB.onclick = () => close(null);
    copyB.onclick = async () => {
      let done = false;
      try { await navigator.clipboard.writeText(text); done = true; }
      catch (e1) {
        try {
          const ta = el('textarea', 'position:fixed;left:-9999px;top:0;');
          ta.value = text; document.body.appendChild(ta); ta.select();
          done = document.execCommand('copy'); ta.remove();
        } catch (e2) {}
      }
      copyB.textContent = done ? 'Copied!' : 'Select the text and copy it';
    };
    row.append(closeB, copyB);
    card.append(row);
  });

  async function runSelfCheck() {
    if (st.busy) return;
    st.busy = 'check'; setBusyUI('check');
    const lines = [];
    let problems = 0;
    const add = (tag, label, info) => lines.push((tag + '        ').slice(0, 8) + label + (info ? ': ' + info : ''));
    const ok = (l, i) => add('OK', l, i);
    const warn = (l, i) => add('WARN', l, i);
    const bad = (l, i) => { problems++; add('PROBLEM', l, i); };
    try {
      // ---- environment
      const ua = navigator.userAgent;
      const bm = ua.match(/(Edg|OPR|Firefox|Chrome|Version)\/([\d.]+)/);
      const browser = bm ? ({ Edg: 'Edge', OPR: 'Opera', Version: 'Safari' }[bm[1]] || bm[1]) + ' ' + bm[2].split('.')[0] : 'unknown';
      const lang = document.documentElement.lang || 'unknown';
      ok('Script', 'IG-Ultimate-TS-Menu v' + VERSION);
      ok('Browser', browser);
      if (/^en/i.test(lang)) ok('Instagram language', lang);
      else warn('Instagram language', lang + ' - date labels are only understood in English, so date ranges may not work');
      if (typeof Element.prototype.checkVisibility === 'function') ok('Browser feature checkVisibility', 'available');
      else bad('Browser feature checkVisibility', 'missing - Unsend needs a newer browser');
      if ('wakeLock' in navigator) ok('Screen wake-lock', 'available'); else warn('Screen wake-lock', 'not available (long runs may pause if the screen sleeps)');
      if (typeof GM_xmlhttpRequest === 'function') ok('Extension download helper', 'available (HTML / PDF photo fallback)');
      else warn('Extension download helper', 'not available (some photos may stay as placeholders)');

      if (!location.pathname.startsWith('/direct/t/')) {
        bad('Page', 'not inside a chat - open a conversation and run the check again');
      } else {
        // ---- chat area
        const sc = findScroller();
        if (!sc) bad('Chat area', 'NOT found');
        else {
          const r = sc.getBoundingClientRect();
          ok('Chat area', 'found (' + Math.round(r.width) + 'x' + Math.round(r.height) + ', ' +
            (isReversed(sc) ? 'column-reverse' : 'normal order') + ')');
          if (!document.querySelector("[data-pagelet='IGDMessagesList']")) warn('Chat area marker', 'IGDMessagesList not found, using the fallback search');

          // ---- message rows
          const inner = getInner(sc);
          const rows = [...inner.children];
          const real = rows.filter(d => d.querySelector('[role=none]') || d.querySelector('[role=presentation]'));
          const capped = real.slice(0, 400);
          const mine = capped.filter(rowSentByMe);
          const capNote = real.length > 400 ? ' (first 400 checked)' : '';
          if (!rows.length) bad('Message rows', '0 found');
          else if (!real.length) bad('Message rows', rows.length + ' containers, but none look like messages');
          else ok('Message rows', real.length + ' loaded');
          if (real.length && !mine.length) warn('Your messages', 'none detected among the loaded rows' + capNote + ' (or sender detection failed)');
          else if (mine.length) ok('Your messages', mine.length + ' detected' + capNote);

          // ---- date labels
          const seps = collectSeps(sc);
          if (!seps.length) bad('Date labels', '0 found - date range, jump-to-date and date-aware unsend will not work');
          else ok('Date labels', seps.length + ' found, oldest loaded ' + fmtDate(seps[0].date) + ', newest ' + fmtDate(seps[seps.length - 1].date) +
            ', example "' + norm(seps[0].el.textContent).slice(0, 30) + '"');
          const sr = sc.getBoundingClientRect(), unk = [];
          for (const e of sc.querySelectorAll('div, span')) {
            if (e.children.length) continue;
            const tx = e.textContent;
            if (!tx || tx.length > 45 || !/\d{1,2}:\d{2}/.test(tx)) continue;
            const rr = e.getBoundingClientRect();
            if (!rr.width || !isCentered(rr, sr)) continue;
            if (!sepStamp(tx)) unk.push(norm(tx).slice(0, 25));
          }
          if (unk.length) warn('Unrecognised date-like labels', unk.length + ' found, example "' + unk[0] + '"');

          // ---- "more options" button (hover only, nothing is clicked)
          const visibleMine = real.find(d => {
            const rr = d.getBoundingClientRect();
            if (rr.height <= 0 || rr.bottom <= sr.top + 5 || rr.top >= sr.bottom - 5) return false;
            if (d.checkVisibility && d.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true, opacityProperty: true }) === false) return false;
            return rowSentByMe(d);
          });
          if (!visibleMine) warn('"More options" button', 'not tested - scroll so one of YOUR messages is on screen, then run the check again');
          else {
            const targets = [visibleMine];
            (function collect(e, depth) { if (depth > 8) return; for (const c of e.children) { targets.push(c); collect(c, depth + 1); } })(visibleMine, 0);
            let btn = null;
            for (let attempt = 0; attempt < 3 && !btn; attempt++) {
              for (const t of targets) dispatchHoverIn(t);
              await sleep(150);
              btn = findActionButton(visibleMine);
              if (!btn) { dispatchHoverOut(visibleMine); await sleep(60); }
            }
            dispatchHoverOut(visibleMine);
            if (btn) ok('"More options" button', 'found on one of your messages');
            else bad('"More options" button', 'NOT found when hovering one of your messages - Unsend will fail');
          }

          // ---- names (only yes/no, so the report stays private)
          if (detectMyName()) ok('Your Instagram name', 'detected'); else warn('Your Instagram name', 'not detected (Export will use "You" if the field is left empty)');
          if (detectFriendName(sc)) ok('Other person name', 'detected'); else warn('Other person name', 'not detected (Export will use "User2" if the field is left empty)');
        }
      }
    } catch (err) {
      console.error('[IG-Ultimate-TS-Menu] self-check failed', err);
      bad('Self-check itself crashed', err.message);
    } finally {
      st.busy = null; setBusyUI(null);
    }
    const head = ['IG-Ultimate-TS-Menu self-check', 'Run: ' + new Date().toISOString(),
      problems ? 'RESULT: ' + problems + ' problem(s) found' : 'RESULT: all checks passed', '--------------------------------'];
    await reportModal(head.concat(lines).join('\n'));
  }

  // =====================================================================
  //  Buttons
  // =====================================================================
  // Date first or button first: if no date is chosen yet, the date popup opens and the action continues afterwards
  const withRange = fn => {
    if (st.range) fn();
    else { st.pending = fn; openPop(); }
  };

  jumpBtn.onclick = () => { if (st.busy === 'jump') return requestStop(); if (!st.busy) withRange(startJump); };
  exportBtn.onclick = () => { if (st.busy === 'export') return requestStop(); if (!st.busy) withRange(startExport); };
  partialBtn.onclick = requestPartial;
  checkBtn.onclick = () => { if (!st.busy) runSelfCheck(); };
  unsendBtn.onclick = () => { if (st.busy === 'unsend') return requestStop(); if (!st.busy) withRange(startUnsend); };
})();
