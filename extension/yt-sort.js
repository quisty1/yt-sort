// ==UserScript==
// @name              yt-sort
// @namespace         https://github.com/quisty1/yt-sort/
// @version           1.0.0
// @description       Sort playlists by duration, see total watch time, and remove unavailable videos.
// @author            Yaroslav
// @homepageURL       https://github.com/quisty1/yt-sort
// @supportURL        https://github.com/quisty1/yt-sort/issues
// @icon              https://raw.githubusercontent.com/quisty1/yt-sort/main/extension/icons/icon48.png
// @downloadURL       https://raw.githubusercontent.com/quisty1/yt-sort/main/extension/yt-sort.js
// @updateURL         https://raw.githubusercontent.com/quisty1/yt-sort/main/extension/yt-sort.js
// @match             http://*.youtube.com/*
// @match             https://*.youtube.com/*
// @grant             none
// @run-at            document-idle
// ==/UserScript==

/*
 * YouTube playlist sorter.
 *
 * Every reorder is verified against either the current DOM or a fresh server
 * response. The extension reports success only after the final order has been
 * checked, and it surfaces partial or rejected operations in the on-page log.
 */
(() => {
  'use strict';
  const VERSION = '1.0.0';

  // Keep a direct reference to the page window because the API engine needs
  // YouTube-owned globals such as ytcfg and ytInitialData. unsafeWindow keeps
  // the file compatible with page-context userscript managers as well.
  const pageWin =
    (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

  // Store the mount guard on the page itself to make repeated injection idempotent.
  if (pageWin.__ytSortLoaded) return;
  pageWin.__ytSortLoaded = true;

  // ======================================================================== settings
  const SETTINGS_KEY = 'ytsort.settings';
  // A finite sentinel keeps unknown durations sortable without relying on Infinity serialization.
  const SENTINEL_LAST = 999999999999999999;

  const DEFAULTS = Object.freeze({
    sortMode: 'asc', // 'asc' | 'desc'
    scope: 'all', // 'all' | 'loaded'
    pacing: 400, // ms base unit for scroll/poll pacing (>=100)
    tolerancePct: 10, // acceptable missing % vs reported count (0-100)
    filterEnabled: false,
    filterMinSec: 0,
    filterMaxSec: 36000,
    logVisible: false,
    maxMovesPerRun: 0, // 0 = unlimited (test hook)
    engine: 'auto', // 'auto' (API if available, else drag) | 'api' | 'drag'
    apiBatchSize: 40, // moves per edit_playlist request
    apiPacingMs: 250, // delay between batch requests
    reloadAfterSort: true, // refresh the page after a successful sort so the new order is visible
  });

  // Clamp a numeric setting to its supported range and fall back on invalid input.
  const num = (v, dflt, lo, hi) => {
    const n = typeof v === 'string' ? parseInt(v, 10) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  };
  // Normalize booleans restored from storage.
  const bool = (v, dflt) =>
    typeof v === 'boolean'
      ? v
      : v === 'true'
        ? true
        : v === 'false'
          ? false
          : dflt;

  // Sanitize persisted settings before any value reaches sorting or UI code.
  const validateSettings = (raw) => {
    const out = {
      sortMode: raw.sortMode === 'desc' ? 'desc' : 'asc',
      scope: raw.scope === 'loaded' ? 'loaded' : 'all',
      pacing: num(raw.pacing, DEFAULTS.pacing, 100, 5000),
      tolerancePct: num(raw.tolerancePct, DEFAULTS.tolerancePct, 0, 100),
      filterEnabled: bool(raw.filterEnabled, DEFAULTS.filterEnabled),
      filterMinSec: num(raw.filterMinSec, DEFAULTS.filterMinSec, 0, 360000),
      filterMaxSec: num(raw.filterMaxSec, DEFAULTS.filterMaxSec, 0, 360000),
      logVisible: bool(raw.logVisible, DEFAULTS.logVisible),
      maxMovesPerRun: num(raw.maxMovesPerRun, 0, 0, 100000),
      engine: ['auto', 'api', 'drag'].includes(raw.engine)
        ? raw.engine
        : 'auto',
      apiBatchSize: num(raw.apiBatchSize, DEFAULTS.apiBatchSize, 1, 100),
      apiPacingMs: num(raw.apiPacingMs, DEFAULTS.apiPacingMs, 0, 10000),
      reloadAfterSort: bool(raw.reloadAfterSort, DEFAULTS.reloadAfterSort),
    };
    if (out.filterMinSec > out.filterMaxSec)
      [out.filterMinSec, out.filterMaxSec] = [
        out.filterMaxSec,
        out.filterMinSec,
      ];
    return out;
  };

  // Restore saved settings when available.
  const loadSettings = () => {
    try {
      const stored = localStorage.getItem(SETTINGS_KEY);
      if (stored)
        return validateSettings({ ...DEFAULTS, ...JSON.parse(stored) });
    } catch (e) {
      console.error('[YTSort] settings load failed:', e);
    }
    return { ...DEFAULTS };
  };
  // Persist preferences locally; storage failures must never interrupt a playlist operation.
  const saveSettings = (s) => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch (e) {
      console.error('[YTSort] settings save failed:', e);
    }
  };
  let settings = loadSettings();

  // ======================================================================== utils
  // Resolve after a delay without blocking YouTube's main thread.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Produce compact local timestamps for the operation log.
  const ts = () => {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((x) => String(x).padStart(2, '0'))
      .join(':');
  };

  // Convert YouTube's MM:SS or HH:MM:SS labels into seconds.
  const parseDurationText = (text) => {
    const t = (text || '').trim();
    if (!/^\d+:\d{1,2}(:\d{1,2})?$/.test(t)) return null; // LIVE / SHORTS / empty → null
    const parts = t.split(':').reverse();
    let sec = parseInt(parts[0], 10) || 0;
    if (parts[1]) sec += (parseInt(parts[1], 10) || 0) * 60;
    if (parts[2]) sec += (parseInt(parts[2], 10) || 0) * 3600;
    return sec;
  };
  // Format a duration for individual video rows.
  const fmtDuration = (s) => {
    if (s === null || s === undefined) return 'N/A';
    const h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60),
      sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`;
  };
  // Format a duration as readable hours, minutes, and seconds for detailed logs.
  const fmtLong = (s) => {
    const h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60),
      sec = s % 60;
    return h > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };
  // Format aggregate durations for the compact overview card.
  const fmtOverviewDuration = (s) => {
    const h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h} hr ${m} min`;
    if (m > 0) return `${m} min`;
    return `${Math.max(0, s)} sec`;
  };

  // DOM builder - NEVER use innerHTML: YouTube enforces Trusted Types (TrustedHTML) and any
  // innerHTML assignment throws. Discovered live 2026-07-18; also safer with hostile titles.
  const elt = (tag, attrs = {}, ...children) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'checked') e.checked = !!v;
      else if (k === 'value') e.value = v;
      else e.setAttribute(k, String(v));
    }
    for (const c of children)
      if (c)
        e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return e;
  };

  // Poll a predicate; resolves true when it passes, false on timeout or abort.
  const pollUntil = async (pred, timeoutMs, intervalMs, isAborted) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (isAborted && isAborted()) return false;
      let ok = false;
      try {
        ok = !!pred();
      } catch {
        /* transient DOM churn */
      }
      if (ok) return true;
      if (Date.now() >= deadline) return false;
      await wait(intervalMs);
    }
  };

  // ======================================================================== logging
  let logEl = null;
  let statusEl = null;
  const logEntries = [];
  const MAX_LOG = 1000;

  // Rebuild the visible log when a newly mounted panel adopts retained entries.
  const renderLog = () => {
    if (!logEl) return;
    logEl.textContent = '';
    for (const e of logEntries)
      logEl.appendChild(elt('div', { class: 'yts-log-line', text: e.line }));
    if (!logEntries.length) logEl.textContent = '[Ready]';
    logEl.scrollTop = logEl.scrollHeight;
  };
  // Write one timestamped message to the console, panel, and tab-local history.
  const log = (msg) => {
    const line = `[${ts()}] ${msg}`;
    console.log(line);
    logEntries.push({ line });
    if (logEntries.length > MAX_LOG) logEntries.shift();
    if (logEl) {
      // O(1) append instead of rebuilding the whole log each call
      if (logEntries.length === 1) logEl.textContent = '';
      logEl.appendChild(elt('div', { class: 'yts-log-line', text: line }));
      while (logEl.childElementCount > MAX_LOG)
        logEl.removeChild(logEl.firstChild);
      logEl.scrollTop = logEl.scrollHeight;
    }
    queueSaveLog();
  };
  // Update the live-region status without adding a verbose log entry.
  const setStatus = (msg) => {
    if (statusEl) statusEl.textContent = msg;
  };
  // Reveal the diagnostic log when an operation needs user attention.
  const showLog = () => {
    if (logEl) logEl.style.display = 'block';
    const details = document.querySelector('.yts-tools');
    if (details && !details.open) details.open = true;
  };

  // Log persistence. A successful sort auto-refreshes the page, which wiped the log at exactly the
  // moment you most want it - to see what happened, or to report a failure. Mirror the lines into
  // sessionStorage (per-tab, survives a reload, gone when the tab closes) and restore them on the
  // next mount behind a divider, so a run's log outlives the refresh that run triggered.
  const LOG_KEY = 'ytsort:log';
  const saveLog = () => {
    try {
      sessionStorage.setItem(
        LOG_KEY,
        JSON.stringify(logEntries.slice(-MAX_LOG).map((e) => e.line)),
      );
    } catch {
      /* quota / private mode - logging must never break a sort */
    }
  };
  let logSaveTimer = null;
  // Coalesce rapid updates so large sorts do not write session storage for every move.
  const queueSaveLog = () => {
    if (logSaveTimer) return;
    logSaveTimer = setTimeout(() => {
      logSaveTimer = null;
      saveLog();
    }, 300);
  };
  const restoreLog = () => {
    try {
      const lines = JSON.parse(sessionStorage.getItem(LOG_KEY) || '[]');
      if (!Array.isArray(lines) || !lines.length) return;
      for (const line of lines.slice(-MAX_LOG)) logEntries.push({ line });
      logEntries.push({
        line: '──────── above: earlier in this tab, kept across the page refresh ────────',
      });
    } catch {
      /* ignore a corrupt entry */
    }
  };
  // Flush synchronously on the way out so an auto-refresh can't beat the debounce.
  window.addEventListener('pagehide', saveLog);

  // ======================================================================== network signal
  // Advisory phantom-move detector: counts the page's own edit_playlist calls. Only consulted
  // once at least one call has been observed (so DOM-only environments stay silent).
  const netSignal = { calls: 0, everSeen: false };
  // Observe YouTube's own reorder requests without changing their behavior.
  const hookNetwork = () => {
    try {
      const origFetch = window.fetch;
      if (origFetch) {
        window.fetch = function (...a) {
          try {
            const u =
              typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url) || '';
            if (u.includes('edit_playlist')) {
              netSignal.calls++;
              netSignal.everSeen = true;
            }
          } catch {
            /* never break the page */
          }
          return origFetch.apply(this, a);
        };
      }
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, u, ...rest) {
        try {
          if (String(u).includes('edit_playlist')) {
            netSignal.calls++;
            netSignal.everSeen = true;
          }
        } catch {
          /* noop */
        }
        return origOpen.call(this, m, u, ...rest);
      };
    } catch (e) {
      console.warn('[YTSort] network hook unavailable:', e);
    }
  };

  // ======================================================================== adapters
  // Read YouTube's localized playlist count from either the current or legacy header markup.
  // All DOM knowledge lives here. entry: { el, handle, id, title, durSec }
  const readReportedCount = () => {
    // current camelCase view-model rows, then legacy selectors
    const texts = [];
    for (const el of document.querySelectorAll(
      '.ytContentMetadataViewModelMetadataRow span',
    ))
      texts.push(el.textContent);
    for (const el of document.querySelectorAll(
      'ytd-playlist-byline-renderer .metadata-stats span, .metadata-stats span.yt-formatted-string',
    ))
      texts.push(el.textContent);
    for (const t of texts) {
      // locale-tolerant: grouping may be "," "." NBSP or thin space ("1.234 Videos", "1 234 vidéos")
      const m = (t || '').match(/(\d[\d.,\s  ]*)\s*videos?/i);
      if (m) {
        const n = parseInt(m[1].replace(/\D/g, ''), 10);
        if (Number.isFinite(n)) return n;
      }
    }
    return null;
  };

  // Return the active playlist identifier, or null outside a playlist route.
  const currentListId = () =>
    location.pathname === '/playlist'
      ? new URLSearchParams(location.search).get('list')
      : null;

  // Is this playlist reorderable by the current user? Owned/editable playlists expose a "Sort by"
  // menu that offers a "Manual" option (and render drag handles in Manual mode). Playlists you don't
  // own have neither, so we say so clearly instead of failing with a confusing error.
  const playlistIsEditable = () => {
    const menu = document.querySelector(
      'yt-sort-filter-sub-menu-renderer, ytd-sort-filter-sub-menu-renderer',
    );
    if (menu && /manual/i.test(menu.textContent || '')) return true;
    if (document.querySelector('ytd-playlist-video-renderer yt-icon#reorder'))
      return true;
    return false;
  };

  // Adapter for the classic Polymer playlist rows that expose drag handles.
  const PolymerAdapter = {
    name: 'polymer',
    present: () => !!document.querySelector('ytd-playlist-video-renderer'),
    canSort: true,
    collect() {
      const scope =
        document.querySelector('ytd-playlist-video-list-renderer') || document;
      const out = [];
      let i = 0;
      for (const el of scope.querySelectorAll('ytd-playlist-video-renderer')) {
        const handle = el.querySelector('yt-icon#reorder');
        const anchor = el.querySelector('a#thumbnail');
        const idm =
          anchor && anchor.href
            ? anchor.href.match(/[?&]v=([A-Za-z0-9_-]+)/)
            : null;
        const durEl = anchor && anchor.querySelector('#text');
        const titleEl = el.querySelector('#video-title');
        const data = el.data || el.__data || null; // Polymer element data carries setVideoId (playlist-item id)
        out.push({
          el,
          handle,
          id: idm ? idm[1] : `__idx${i}`,
          setVideoId:
            (data &&
              (data.setVideoId ||
                (data.playlistVideoRenderer &&
                  data.playlistVideoRenderer.setVideoId))) ||
            null,
          title: titleEl ? titleEl.textContent.trim() : '',
          durSec: durEl
            ? parseDurationText(durEl.innerText || durEl.textContent)
            : null,
          url: anchor && anchor.href ? anchor.href : '',
        });
        i++;
      }
      return out;
    },
    manualSortActive() {
      const h = document.querySelector(
        'ytd-playlist-video-renderer yt-icon#reorder',
      );
      if (!h) return null;
      return h.offsetParent !== null && getComputedStyle(h).display !== 'none';
    },
    reportedCount: readReportedCount,
  };

  // Adapter for YouTube's newer lockup cards, which can be inspected but not dragged.
  const LockupAdapter = {
    name: 'lockup',
    present: () => !!document.querySelector('yt-lockup-view-model'),
    canSort: false, // no reorder affordance exists in this view (2026-07 capture)
    collect() {
      const out = [];
      let i = 0;
      for (const el of document.querySelectorAll('yt-lockup-view-model')) {
        const badge = el.querySelector('badge-shape');
        const titleEl = el.querySelector(
          'h3.ytLockupMetadataViewModelHeadingReset a, a.ytLockupMetadataViewModelTitle, h3',
        );
        const anchor = el.querySelector('a');
        const idm =
          anchor && anchor.href
            ? anchor.href.match(/[?&]v=([A-Za-z0-9_-]+)/)
            : null;
        out.push({
          el,
          handle: null,
          id: idm ? idm[1] : `__idx${i}`,
          title: titleEl ? titleEl.textContent.trim() : '',
          durSec: badge ? parseDurationText(badge.textContent) : null,
          url: anchor && anchor.href ? anchor.href : '',
        });
        i++;
      }
      return out;
    },
    manualSortActive: () => null,
    reportedCount: readReportedCount,
  };

  // Select the first adapter that recognizes the playlist markup currently on screen.
  const detectAdapter = () => {
    if (PolymerAdapter.present()) return PolymerAdapter;
    if (LockupAdapter.present()) return LockupAdapter;
    return null;
  };

  // ======================================================================== ordering planner
  // Calculate a comparable duration while pushing excluded or unknown entries to the end.
  const sortKey = (entry, s) => {
    const passes = !s.filterEnabled
      ? true
      : entry.durSec === null
        ? false
        : entry.durSec >= s.filterMinSec && entry.durSec <= s.filterMaxSec;
    if (!passes || entry.durSec === null)
      return s.sortMode === 'asc' ? SENTINEL_LAST : -1;
    return entry.durSec;
  };
  // Build a deterministic target order without mutating the collected entries.
  const planOrder = (entries, s) => {
    const keyed = entries.map((e, i) => ({ e, key: sortKey(e, s), i }));
    keyed.sort((a, b) => {
      if (a.key !== b.key)
        return s.sortMode === 'asc' ? a.key - b.key : b.key - a.key;
      if (a.e.title && b.e.title) return a.e.title.localeCompare(b.e.title);
      return 0; // stable sort preserves relative order
    });
    return keyed.map((k) => k.e);
  };
  // Count positions whose current video differs from the planned video.
  const misplacedCount = (entries, target) => {
    let bad = 0;
    for (let i = 0; i < target.length; i++)
      if (entries[i] && entries[i].id !== target[i].id) bad++;
    return bad;
  };

  // ======================================================================== InnerTube API engine
  // Reorders via YouTube's own edit_playlist endpoint - no DOM drags, no viewport constraints,
  // no lazy-load fighting. Requires: playlist-item ids (setVideoId), an INNERTUBE_CONTEXT, and
  // page-context SAPISIDHASH auth. Verification reads server truth from a fresh page fetch.
  const YtApi = {
    // The API path is usable only when YouTube exposed its request context to the page.
    available() {
      const d = pageWin.ytcfg && pageWin.ytcfg.data_;
      return !!(d && d.INNERTUBE_CONTEXT);
    },
    // Build the authorization value YouTube expects from the signed-in session cookie.
    async sapisidHash() {
      const get = (n) =>
        (
          document.cookie.split('; ').find((c) => c.startsWith(n + '=')) || ''
        ).split('=')[1];
      const sapisid =
        get('SAPISID') || get('__Secure-3PAPISID') || get('__Secure-1PAPISID');
      if (!sapisid) return null;
      const t = Math.floor(Date.now() / 1000);
      const origin = 'https://www.youtube.com';
      const buf = await crypto.subtle.digest(
        'SHA-1',
        new TextEncoder().encode(`${t} ${sapisid} ${origin}`),
      );
      const hex = [...new Uint8Array(buf)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return `SAPISIDHASH ${t}_${hex}`;
    },
    // Parse initial page data from fetched HTML, falling back to the live page object.
    extractInitialData(html) {
      const m =
        html.match(/ytInitialData\s*=\s*(\{.*?\});<\/script>/s) ||
        html.match(/ytInitialData"?\]?\s*=\s*(\{.*?\});/s);
      try {
        return m ? JSON.parse(m[1]) : pageWin.ytInitialData || null;
      } catch {
        return null;
      }
    },
    // Token nesting varies across YouTube layouts, so search the response subtree recursively.
    findToken(x) {
      if (!x || typeof x !== 'object') return null;
      if (x.continuationCommand && x.continuationCommand.token)
        return x.continuationCommand.token;
      for (const k in x) {
        const t = this.findToken(x[k]);
        if (t) return t;
      }
      return null;
    },
    // Harvest playlistVideoRenderer items AND the video-list continuation token. CRITICAL: a
    // playlist page can have MULTIPLE continuationItemRenderers (video list + related sections);
    // the RIGHT token is the one that is a SIBLING of the playlistVideoRenderer items. Grabbing any
    // continuationItemRenderer (e.g. a related-playlists section) yields a token YouTube answers
    // with an empty page, so only 100 videos ever load. (Live-confirmed bug, 2026-07-18.)
    harvest(root, items) {
      let token = null;
      // Scan a sibling array for the continuation token that sits WITH the video items
      // (see the CRITICAL note above harvest()). Returns the token, or null if this
      // array isn't the right one.
      const findSiblingToken = (arr) => {
        let hasVideos = false,
          sibToken = null;
        for (const el of arr) {
          if (el && el.playlistVideoRenderer) hasVideos = true;
          if (el && el.continuationItemRenderer) {
            const t = this.findToken(el.continuationItemRenderer);
            if (t) sibToken = t;
          }
        }
        return hasVideos && sibToken ? sibToken : null;
      };
      const pushVideoItem = (r) => {
        const title =
          (r.title &&
            (r.title.simpleText ||
              (r.title.runs && r.title.runs.map((x) => x.text).join('')))) ||
          '';
        const statusTitle = title.trim().replace(/^\[\s*|\s*\]$/g, '');
        let durSec = r.lengthSeconds ? parseInt(r.lengthSeconds, 10) : null;
        if (!Number.isFinite(durSec)) durSec = null;
        const unavailable =
          r.isPlayable === false ||
          !!r.unplayableText ||
          /^(deleted|private|unavailable) video$/i.test(statusTitle);
        let unavailableReason = '';
        if (/deleted/i.test(statusTitle)) unavailableReason = 'Deleted';
        else if (/private/i.test(statusTitle)) unavailableReason = 'Private';
        else if (unavailable) unavailableReason = 'Unavailable';
        items.push({
          id: r.videoId || `__set_${r.setVideoId}`,
          setVideoId: r.setVideoId || null,
          title,
          durSec,
          unavailable,
          unavailableReason,
        });
      };
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) {
          const sibToken = findSiblingToken(o);
          if (sibToken) token = sibToken; // only trust a token that sits WITH the videos
          for (const el of o) walk(el);
          return;
        }
        if (
          o.playlistVideoRenderer &&
          (o.playlistVideoRenderer.videoId ||
            o.playlistVideoRenderer.setVideoId)
        ) {
          pushVideoItem(o.playlistVideoRenderer);
          return;
        }
        for (const k in o) walk(o[k]);
      };
      walk(root);
      return token;
    },
    // Read the FULL item list (id, setVideoId, title, durSec), including entries YouTube hides
    // from the normal playlist page. The regular page response omits private/deleted/blocked
    // videos entirely, so checking isPlayable on that response can incorrectly report zero.
    // `params: wgYCCAA=` is YouTube's own "Show unavailable videos" browse mode.
    async fetchServerItems(listId) {
      const context = pageWin.ytcfg.data_.INNERTUBE_CONTEXT;
      const key = pageWin.ytcfg.data_.INNERTUBE_API_KEY;
      const auth = await this.sapisidHash();
      const headers = {
        'Content-Type': 'application/json',
        'X-Origin': 'https://www.youtube.com',
      };
      if (auth) headers.Authorization = auth;
      let data = null;
      try {
        const res = await fetch(
          'https://www.youtube.com/youtubei/v1/browse' +
            (key ? `?key=${key}` : '?prettyPrint=false'),
          {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify({
              context,
              browseId: `VL${listId}`,
              params: 'wgYCCAA=',
            }),
          },
        );
        if (!res.ok) return null;
        data = await res.json();
      } catch {
        return null;
      }
      if (!data) return null;

      const items = [];
      let token = this.harvest(data, items);
      let guard = 0,
        truncated = false;
      while (token && guard < 80) {
        guard++;
        let cjson = null;
        try {
          const cres = await fetch(
            'https://www.youtube.com/youtubei/v1/browse' +
              (key ? `?key=${key}` : '?prettyPrint=false'),
            {
              method: 'POST',
              credentials: 'include',
              headers,
              body: JSON.stringify({ context, continuation: token }),
            },
          );
          if (!cres.ok) {
            truncated = true;
            break;
          } // a failed continuation = incomplete list
          cjson = await cres.json();
        } catch {
          truncated = true;
          break;
        }
        const nextToken = this.harvest(cjson, items);
        if (nextToken === token) {
          truncated = true;
          break;
        } // stuck: didn't advance
        token = nextToken;
      }
      if (guard >= 80 && token) truncated = true; // hit the page cap with more to read
      // truncated marks a list that is NOT known-complete - callers must not treat it as authoritative
      items.truncated = truncated;
      return items;
    },
    // Send a batch of actions in one edit_playlist request. The server applies dependent moves
    // sequentially, making the request rather than each individual move the main unit of cost.
    async sendActions(listId, context, actions) {
      const auth = await this.sapisidHash();
      if (!auth) return { ok: false, error: 'no-sapisid' };
      const t0 = Date.now();
      let res;
      try {
        res = await fetch(
          'https://www.youtube.com/youtubei/v1/browse/edit_playlist?prettyPrint=false',
          {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              Authorization: auth,
              'X-Origin': 'https://www.youtube.com',
            },
            body: JSON.stringify({ context, playlistId: listId, actions }),
          },
        );
      } catch (e) {
        return {
          ok: false,
          error: 'network: ' + (e && e.message ? e.message : e),
        };
      }
      let j = null;
      try {
        j = await res.json();
      } catch {
        /* non-json */
      }
      const succeeded =
        res.ok && (!j || !j.status || j.status === 'STATUS_SUCCEEDED');
      return {
        ok: succeeded,
        ms: Date.now() - t0,
        httpStatus: res.status,
        apiStatus: j && j.status,
        error: !succeeded
          ? (j && j.error && (j.error.message || j.error)) ||
            'http ' + res.status
          : null,
      };
    },
  };

  // ======================================================================== drag fallback
  // Dispatch one mouse event with the coordinates used by YouTube's reorder handlers.
  const fireMouse = (type, elem, cx, cy) => {
    elem.dispatchEvent(
      new MouseEvent(type, {
        view: window,
        bubbles: true,
        cancelable: true,
        clientX: cx,
        clientY: cy,
      }),
    );
  };
  // Reproduce the full pointer and drag event sequence between two playlist handles.
  const simulateDrag = (elemDrag, elemDrop) => {
    let p = elemDrag.getBoundingClientRect();
    const c1x = Math.floor((p.left + p.right) / 2),
      c1y = Math.floor((p.top + p.bottom) / 2);
    p = elemDrop.getBoundingClientRect();
    const c2x = Math.floor((p.left + p.right) / 2),
      c2y = Math.floor((p.top + p.bottom) / 2);
    fireMouse('mousemove', elemDrag, c1x, c1y);
    fireMouse('mouseenter', elemDrag, c1x, c1y);
    fireMouse('mouseover', elemDrag, c1x, c1y);
    fireMouse('mousedown', elemDrag, c1x, c1y);
    fireMouse('dragstart', elemDrag, c1x, c1y);
    fireMouse('drag', elemDrag, c1x, c1y);
    fireMouse('mousemove', elemDrag, c1x, c1y);
    fireMouse('drag', elemDrag, c2x, c2y);
    fireMouse('mousemove', elemDrop, c2x, c2y);
    fireMouse('mouseenter', elemDrop, c2x, c2y);
    fireMouse('dragenter', elemDrop, c2x, c2y);
    fireMouse('mouseover', elemDrop, c2x, c2y);
    fireMouse('dragover', elemDrop, c2x, c2y);
    fireMouse('drop', elemDrop, c2x, c2y);
    fireMouse('dragend', elemDrag, c2x, c2y);
    fireMouse('mouseup', elemDrag, c2x, c2y);
  };

  // ======================================================================== loading engine
  // Move the page viewport to trigger YouTube's lazy playlist renderer.
  const scrollToBottom = () => {
    const se = document.scrollingElement;
    if (se) se.scrollTop = se.scrollHeight;
  };
  // Restore the playlist header and controls after background collection.
  const scrollToTop = () => {
    const se = document.scrollingElement;
    if (se) se.scrollTop = 0;
  };

  // Loads until no growth for 3 stable checks (or reported count reached). Poll-based, no fixed sleeps.
  const loadAll = async (adapter, run, reported) => {
    let entries = adapter.collect();
    let stable = 0,
      guard = 0;
    while (!run.stopRequested && stable < 3 && guard < 80) {
      const before = entries.length;
      if (reported !== null && before >= reported) break;
      scrollToBottom();
      const grew = await pollUntil(
        () => adapter.collect().length > before,
        run.pacing * 6,
        Math.max(100, run.pacing / 2),
        () => run.stopRequested,
      );
      entries = adapter.collect();
      if (grew && entries.length > before) {
        stable = 0;
        log(
          `Loaded ${entries.length}${reported ? ' / ' + reported : ''} videos…`,
        );
      } else stable++;
      guard++;
    }
    scrollToTop();
    await wait(Math.max(120, run.pacing / 3));
    return adapter.collect();
  };

  // ======================================================================== sort controller
  // Only one SortRun may own the playlist at a time.
  let activeRun = null;

  // Encapsulates one cancellable sort and freezes all settings used by that run.
  class SortRun {
    constructor(adapter, s) {
      this.adapter = adapter;
      this.s = { ...s }; // Per-run copy prevents settings changes from altering active work.
      this.pacing = this.s.pacing;
      this.stopRequested = false;
      this.moves = 0;
      this.phantomSuspects = 0;
      this.listId = currentListId(); // the playlist this run belongs to - re-checked every iteration
    }
    // Request cooperative cancellation at the next safe boundary.
    stop() {
      this.stopRequested = true;
    }
    // Wait in short slices so the Stop button can preempt settling delays.
    async waitAbortable(ms) {
      const end = Date.now() + ms;
      while (Date.now() < end && !this.stopRequested)
        await wait(Math.min(60, end - Date.now()));
    }
    // After an API sort the reorder is on YouTube's servers but the on-screen list is still the old
    // order - refresh so the user sees the result. The hostname guard prevents reloads in local
    // development pages.
    maybeReload() {
      if (
        this.s.reloadAfterSort &&
        /(^|\.)youtube\.com$/i.test(location.hostname)
      ) {
        log('🔄 Refreshing the page to show the sorted order…');
        setTimeout(() => {
          try {
            location.reload();
          } catch {
            /* ignore */
          }
        }, 1500);
      }
    }

    // ---- engine selection: API is primary when available (instant, no DOM), drag is fallback ----
    // API engine sorts the WHOLE server playlist, so it only applies to scope 'all' (even when
    // explicitly requested). scope 'loaded' always uses the DOM drag engine.
    // Returns a terminal result if the API engine ran (success or failure); null to fall through
    // to the drag engine (never attempted, or attempted and not viable for this playlist).
    async tryApiEngine() {
      const { s } = this;
      const apiReachable = YtApi.available();
      const wantApi =
        s.scope === 'all' &&
        this.listId &&
        (s.engine === 'api' || (s.engine === 'auto' && apiReachable));
      // Explain why auto mode chose the slower fallback when the page API is unavailable.
      if (
        !apiReachable &&
        s.engine === 'auto' &&
        s.scope === 'all' &&
        this.listId
      ) {
        log(
          "⚠️ YouTube's API context (ytcfg) isn't reachable, so sorting will use the slower drag-and-drop fallback. Reload the playlist or reinstall the extension if this keeps happening.",
        );
      }
      if (!wantApi) return null;
      if (!apiReachable)
        return this.fail(
          '❌ Sort failed: API engine requested but INNERTUBE_CONTEXT is unavailable on this page.',
        );
      const apiResult = await this.executeApi();
      if (apiResult) return apiResult; // null → API not viable (e.g. no setVideoIds); fall through to drag
      log(
        'ℹ️ API engine unavailable for this playlist - falling back to drag engine.',
      );
      return null;
    }

    // ---- load phase + preconditions ----
    // Returns { result } when the run is already terminal (fail/cancelled/already-sorted), or
    // { entries, totalPlanned } to continue into the move loop.
    async loadAndPlan(adapter, reported) {
      const { s } = this;
      let entries =
        s.scope === 'all'
          ? await loadAll(adapter, this, reported)
          : adapter.collect();
      if (this.stopRequested) return { result: this.cancelled() };
      if (entries.length === 0) {
        return {
          result: this.fail(
            `Cannot sort: found 0 videos on this page (adapter: ${adapter.name}). Nothing was changed.`,
          ),
        };
      }

      if (!adapter.canSort) {
        return {
          result: this.fail(
            `Cannot sort: this playlist view (${adapter.name} layout) has no reorder handles. The playlist overview and CSV export still work. Nothing was changed.`,
          ),
        };
      }
      const manual = adapter.manualSortActive();
      if (manual === false) {
        return {
          result: this.fail(
            'Cannot sort: drag handles are hidden because the playlist "Sort by" is not set to Manual. Switch it to Manual and try again. Nothing was changed.',
          ),
        };
      }
      const missing =
        reported !== null ? Math.max(0, reported - entries.length) : 0;
      if (reported !== null && missing > 0) {
        const allowed = Math.ceil((s.tolerancePct / 100) * reported);
        if (missing > allowed) {
          return {
            result: this.fail(
              `❌ Sort failed: only ${entries.length} of ${reported} reported videos loaded (missing ${missing}, tolerance allows ${allowed}). Increase tolerance in Settings or retry. Nothing was sorted.`,
            ),
          };
        }
        log(
          `⚠️ Proceeding with ${entries.length} of ${reported} reported videos (${missing} unavailable/not loaded, within ${s.tolerancePct}% tolerance).`,
        );
      }

      const totalPlanned = misplacedCount(entries, planOrder(entries, s));
      log(`📊 ${entries.length} videos loaded, ~${totalPlanned} moves needed.`);
      if (totalPlanned === 0) {
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        log('✅ Sort complete! Playlist was already in order (0 moves).');
        setStatus('Done · already in order');
        return { result: { ok: true, moves: 0 } };
      }

      return { entries, totalPlanned };
    }

    // Guard checks re-run every loop iteration: identity, sort-mode, and the two move caps.
    // Returns a terminal result to stop the run; null to continue.
    loopGuardFailure(adapter, moveCap) {
      const { s } = this;
      if (this.stopRequested) return this.cancelled();
      // identity + precondition re-checks: SPA navigation mid-run must never sort another playlist
      if (currentListId() !== this.listId) {
        return this.fail(
          `❌ Sort failed: the page navigated away from the playlist mid-sort (${this.listId} → ${currentListId() || 'not a playlist'}). ${this.moves} verified moves were applied before stopping. Nothing on the new page was touched.`,
        );
      }
      if (adapter.manualSortActive() === false) {
        return this.fail(
          `❌ Sort failed: the playlist "Sort by" left Manual mode mid-run - drag handles are hidden. Switch back to Manual and run Sort again. ${this.moves} verified moves were applied.`,
        );
      }
      if (s.maxMovesPerRun > 0 && this.moves >= s.maxMovesPerRun) {
        log(
          `Sort stopped: move cap ${s.maxMovesPerRun} reached (test mode). ${this.moves} verified moves applied.`,
        );
        setStatus('Stopped at move cap');
        return { ok: false, capped: true, moves: this.moves };
      }
      if (this.moves >= moveCap) {
        return this.fail(
          `❌ Sort failed: exceeded the safety bound of ${moveCap} moves without converging - aborting to avoid a livelock. ${this.moves} moves were applied; verify the playlist manually.`,
        );
      }
      return null;
    }

    // Re-collects the DOM each iteration and recovers from a mid-sort collapse (lazy unload).
    // Returns { result } to stop the run; { entries } to continue with the fresh list.
    async refreshEntriesForLoop(adapter, maxSeen, reported) {
      const { s } = this;
      let entries = adapter.collect();
      // list collapsed mid-sort (lazy unload)? confirm it is not a transient render dip first
      if (s.scope === 'all' && entries.length < maxSeen.n) {
        await this.waitAbortable(Math.max(200, this.pacing / 2));
        entries = adapter.collect();
      }
      if (s.scope === 'all' && entries.length < maxSeen.n) {
        log(
          `⚠️ List collapsed to ${entries.length}/${maxSeen.n} - re-loading…`,
        );
        entries = await loadAll(adapter, this, reported);
        if (this.stopRequested) return { result: this.cancelled() };
        if (entries.length < maxSeen.n) {
          const allowed = Math.ceil((s.tolerancePct / 100) * maxSeen.n);
          if (maxSeen.n - entries.length > allowed) {
            return {
              result: this.fail(
                `❌ Sort failed: playlist collapsed to ${entries.length} of ${maxSeen.n} loaded videos and would not re-load (tolerance ${allowed}). ${this.moves} moves were applied before the failure.`,
              ),
            };
          }
          log(
            `⚠️ Continuing with ${entries.length} of ${maxSeen.n} (within tolerance).`,
          );
          maxSeen.n = entries.length;
        }
      }
      if (entries.length > maxSeen.n) {
        maxSeen.n = entries.length;
      }
      return { entries };
    }

    // ---- move loop: one VERIFIED move per iteration, replanned from fresh DOM ----
    // Returns a terminal result on fail/cancel/cap; null once the list is fully ordered.
    async runMoveLoop(adapter, entries, reported, totalPlanned) {
      const { s } = this;
      const maxSeen = { n: entries.length };
      let moveCap = entries.length * 3 + 20; // grows with maxSeen (late-loading playlists)

      for (;;) {
        const guardFail = this.loopGuardFailure(adapter, moveCap);
        if (guardFail) return guardFail;

        const refreshed = await this.refreshEntriesForLoop(
          adapter,
          maxSeen,
          reported,
        );
        if (refreshed.result) return refreshed.result;
        entries = refreshed.entries;
        moveCap = Math.max(moveCap, maxSeen.n * 3 + 20); // no-op unless maxSeen just grew

        const target = planOrder(entries, s);
        let j = 0;
        while (
          j < target.length &&
          entries[j] &&
          entries[j].id === target[j].id
        )
          j++;
        if (j >= target.length) break; // fully ordered

        const wantId = target[j].id;
        const srcIdx = entries.findIndex((e) => e.id === wantId);
        if (srcIdx === -1 || !entries[srcIdx].handle || !entries[j].handle) {
          return this.fail(
            `❌ Sort failed: lost track of video "${target[j].title}" (or its drag handle) while sorting. ${this.moves} moves were applied.`,
          );
        }

        const ok = await this.verifiedMove(entries[srcIdx], j, wantId);
        if (ok) this.moves++; // count BEFORE the stop-check so a cancel report reflects DOM reality
        if (this.stopRequested) return this.cancelled();
        if (!ok) {
          return this.fail(
            `❌ Sort failed: the move for "${target[j].title}" did not apply after 3 attempts - YouTube is not accepting reorders right now (wrong sort mode, throttling, or a layout change). ${this.moves} verified moves were applied before stopping.`,
          );
        }
        log(
          `🔄 Moved "${target[j].title.slice(0, 40)}" → #${j + 1}  (${this.moves}/~${totalPlanned})`,
        );
        setStatus(`Sorting · ${this.moves} of ~${totalPlanned}`);
        await this.waitAbortable(Math.max(80, this.pacing / 4)); // brief settle; correctness comes from verification, not waiting
      }

      return null;
    }

    // ---- final verification pass (truth-only reporting) ----
    finalVerify(adapter, reported, startNetCalls) {
      const finalEntries = adapter.collect();
      const bad = misplacedCount(finalEntries, planOrder(finalEntries, this.s));
      scrollToTop();
      log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      if (bad === 0) {
        const netMoves = netSignal.calls - startNetCalls;
        log(
          `✅ Sort complete! ${this.moves} moves applied and re-verified in final order (${finalEntries.length} videos${reported !== null && finalEntries.length < reported ? ` of ${reported} reported - the rest are unavailable/hidden` : ''}).`,
        );
        if (netSignal.everSeen && netMoves < this.moves) {
          log(
            `⚠️ Only ${netMoves} of ${this.moves} moves produced a server save call - reload the page once to confirm YouTube kept the order.`,
          );
        }
        log(
          '⚠️ Keep the playlist sort on "Manual" - switching to an automatic sort discards this order.',
        );
        setStatus(`Done · moved ${this.moves}`);
        this.maybeReload();
        return { ok: true, moves: this.moves };
      }
      return this.fail(
        `❌ Sort failed final verification: ${bad} of ${finalEntries.length} videos are out of place. ${this.moves} moves were applied; run Sort again to finish.`,
      );
    }

    // Select an engine, enforce ownership checks, and run the complete verified sort.
    async execute() {
      const { adapter, s } = this;
      const reported = adapter.reportedCount();
      // Editability precondition (applies to both engines): only playlists you own can be reordered.
      if (!playlistIsEditable()) {
        return this.fail(
          'Cannot sort this playlist. You can only reorder a playlist you own (or your Watch Later). Nothing was changed.',
        );
      }
      if (s.filterEnabled)
        log(
          `🎯 Filter: ${Math.floor(s.filterMinSec / 60)}-${Math.floor(s.filterMaxSec / 60)} min (outside range → end of list)`,
        );

      const apiResult = await this.tryApiEngine();
      if (apiResult) return apiResult;

      const loaded = await this.loadAndPlan(adapter, reported);
      if (loaded.result) return loaded.result;
      const { entries, totalPlanned } = loaded;

      const startNetCalls = netSignal.calls;
      const loopResult = await this.runMoveLoop(
        adapter,
        entries,
        reported,
        totalPlanned,
      );
      if (loopResult) return loopResult;

      return this.finalVerify(adapter, reported, startNetCalls);
    }

    // API engine: read full item list from server, compute target order, emit one edit_playlist
    // move per out-of-place item, verify against a fresh server read. Returns a result object,
    // or null if the API route isn't viable for this playlist (caller falls back to drag).
    async executeApi() {
      const { s } = this;
      const context = pageWin.ytcfg.data_.INNERTUBE_CONTEXT;
      log('⚡ Reading playlist…');
      let items;
      try {
        items = await YtApi.fetchServerItems(this.listId);
      } catch (e) {
        log('⚠️ API read failed (' + (e && e.message ? e.message : e) + ').');
        return null;
      }
      if (!items || items.length === 0) {
        log('⚠️ API returned no items.');
        return null;
      }
      if (items.some((it) => !it.setVideoId)) {
        log(
          `⚠️ ${items.filter((it) => !it.setVideoId).length}/${items.length} items lack a setVideoId - API cannot address them.`,
        );
        return null;
      }
      // A truncated harvest is NOT the authoritative full list - never sort against it (it would
      // reposition the never-read tail). Fall back to the DOM-verified drag engine instead.
      if (items.truncated) {
        log(
          `⚠️ API read was cut short (${items.length} of an unknown total) - not sorting a partial list.`,
        );
        return null;
      }

      const reported = this.adapter.reportedCount();
      if (reported !== null && items.length < reported) {
        const allowed = Math.ceil((s.tolerancePct / 100) * reported);
        if (reported - items.length > allowed)
          return this.fail(
            `❌ Sort failed: server returned ${items.length} of ${reported} videos (missing ${reported - items.length}, tolerance ${allowed}). Nothing was changed.`,
          );
      }
      log(`📊 ${items.length} videos. Sorting…`);

      // Self-healing outer loop: apply the plan, then RE-READ server truth and repeat until the
      // server itself reports fully sorted. This absorbs phantom ACKs and any server-side drift -
      // each pass only needs to fix whatever the previous pass didn't actually land.
      const MAX_PASSES = 5;
      let bad = misplacedCount(items, planOrder(items, s));
      for (let pass = 1; pass <= MAX_PASSES && bad > 0; pass++) {
        const target = planOrder(items, s);
        if (pass > 1)
          log(`🔁 Pass ${pass}: ${bad} still out of place - correcting…`);

        const passResult = await this.apiPass(items, target, context);
        if (passResult) return passResult; // stop/cancel/fail terminal from within the pass

        // re-read server truth for the next pass / final check
        try {
          items = await YtApi.fetchServerItems(this.listId);
        } catch (e) {
          items = null;
        }
        if (!items || !items.length) {
          log(
            `✅ Sort complete! ${this.moves} API moves applied (could not re-read the server to double-check - reload to confirm).`,
          );
          setStatus(`Done · moved ${this.moves}`);
          this.maybeReload();
          return {
            ok: true,
            moves: this.moves,
            engine: 'api',
            unverified: true,
          };
        }
        const prevBad = bad;
        bad = misplacedCount(items, planOrder(items, s));
        if (bad === 0) break; // verified sorted
        if (bad >= prevBad) {
          // not converging - stop rather than spin
          return this.fail(
            `❌ Sort failed: the server keeps reverting moves (${bad} of ${items.length} still out of place after pass ${pass}). ${this.moves} moves applied; YouTube may be throttling - try again shortly.`,
          );
        }
      }

      // ONLY report success if the server-verified misplaced count is actually 0. Exhausting
      // MAX_PASSES while still improving (bad>0) is a FAILURE, not a silent success.
      log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      if (bad === 0) {
        log(
          `✅ Sort complete! ${this.moves} API moves applied and re-verified against the server (${items.length} videos).`,
        );
        log('⚠️ Keep the playlist sort on "Manual" to preserve this order.');
        setStatus(`Done · moved ${this.moves}`);
        this.maybeReload();
        return { ok: true, moves: this.moves, engine: 'api' };
      }
      return this.fail(
        `❌ Sort failed: ${bad} of ${items.length} videos still out of place after ${MAX_PASSES} passes. ${this.moves} moves applied; run Sort again to finish.`,
      );
    }

    // Compute EVERY needed move up front, simulating sequential apply against a scratch
    // copy of `items` (matching the server's proven batch semantics) so each action's
    // predecessor is honest.
    computeMoveActions(items, target) {
      const live = [...items];
      const actions = [];
      for (let j = 0; j < target.length; j++) {
        if (live[j] && live[j].setVideoId === target[j].setVideoId) continue; // already in place
        const a = {
          action: 'ACTION_MOVE_VIDEO_AFTER',
          setVideoId: target[j].setVideoId,
        };
        if (j > 0) a.movedSetVideoIdPredecessor = target[j - 1].setVideoId;
        actions.push(a);
        const from = live.findIndex(
          (it) => it.setVideoId === target[j].setVideoId,
        );
        if (from !== -1) {
          const [m] = live.splice(from, 1);
          live.splice(j, 0, m);
        }
      }
      return actions;
    }

    // Send one batch, retrying up to 3 times. Returns { ok: true, res } on success, or a
    // terminal result object (cancelledApi()/fail()) to bubble straight out of apiPass.
    async sendBatchWithRetry(context, chunk) {
      let res,
        ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        if (this.stopRequested) return this.cancelledApi();
        res = await YtApi.sendActions(this.listId, context, chunk);
        ok = res.ok;
        if (!ok) {
          log(
            `⚠️ API batch attempt ${attempt}/3 failed (${res.error}) - retrying…`,
          );
          await this.waitAbortable(Math.max(400, this.pacing));
        }
      }
      if (!ok)
        return this.fail(
          `❌ Sort failed: an API batch of ${chunk.length} moves failed after 3 attempts (${res && res.error}). ${this.moves} moves applied; run Sort again to finish.`,
        );
      return { ok: true, res };
    }

    // One pass of the plan: compute EVERY needed move up front, then send them in batches
    // of apiBatchSize. Returns a terminal result object to abort the whole sort, or null
    // when the pass finished.
    async apiPass(items, target, context) {
      const { s } = this;
      const actions = this.computeMoveActions(items, target);
      if (!actions.length) return null;

      let passMoves = 0; // pass-local, so the progress readout denominator is honest
      for (let i = 0; i < actions.length; i += s.apiBatchSize) {
        if (this.stopRequested) return this.cancelledApi();
        if (currentListId() !== this.listId)
          return this.fail(
            `❌ Sort failed: navigated away from the playlist mid-sort. ${this.moves} API moves were applied.`,
          );
        let chunk = actions.slice(i, i + s.apiBatchSize);
        if (s.maxMovesPerRun > 0) {
          // test hook: trim to the remaining allowance
          const allowance = s.maxMovesPerRun - this.moves;
          if (allowance <= 0) break;
          if (chunk.length > allowance) chunk = chunk.slice(0, allowance);
        }

        const batchResult = await this.sendBatchWithRetry(context, chunk);
        if (!batchResult.ok) return batchResult;

        this.moves += chunk.length;
        passMoves += chunk.length;
        log(
          `⚡ ${passMoves}/${actions.length} this pass (${this.moves} total, batch of ${chunk.length} in ${batchResult.res.ms}ms)`,
        );
        setStatus(`Sorting · ${passMoves} of ${actions.length}`);
        if (s.maxMovesPerRun > 0 && this.moves >= s.maxMovesPerRun) {
          log(
            `Sort stopped: move cap ${s.maxMovesPerRun} reached (test mode). ${this.moves} API moves applied.`,
          );
          setStatus('Stopped at move cap');
          return { ok: false, capped: true, moves: this.moves, engine: 'api' };
        }
        await this.waitAbortable(s.apiPacingMs);
      }
      return null;
    }

    // Return a consistent terminal result for an API sort stopped by the user.
    cancelledApi() {
      log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      log(
        `⛔ Sort cancelled by user. ${this.moves} API moves were applied before stopping.`,
      );
      setStatus('Stopped');
      return { ok: false, cancelled: true, moves: this.moves, engine: 'api' };
    }

    // Fire the drag, then poll fresh DOM until the item occupies the target slot. Retry ≤3.
    async verifiedMove(srcEntry, targetIdx, wantId) {
      const moveTimeout = Math.max(5000, this.pacing * 8);
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (this.stopRequested) return false;
        // re-resolve elements fresh each attempt (re-renders stale old references)
        const cur = this.adapter.collect();
        const src = cur.find((e) => e.id === wantId);
        const dst = cur[targetIdx];
        if (!src || !dst || !src.handle || !dst.handle) return false;
        if (cur[targetIdx].id === wantId) return true; // already landed (late apply)
        const snapshot = cur.map((e) => e.id).join(',');
        // CRITICAL (live finding 2026-07-18): YouTube's drop handling is coordinate-sensitive -
        // the DESTINATION row must be visible or the server resolves the drop to whatever row
        // occupies those viewport coordinates. The dragged item rides on the event target, so
        // scroll the TARGET into view, never the source.
        try {
          dst.el.scrollIntoView({ behavior: 'auto', block: 'center' });
        } catch {
          /* non-fatal */
        }
        await wait(60); // let layout settle before reading rects
        simulateDrag(src.handle, dst.handle);
        const landed = await pollUntil(
          () => {
            const now = this.adapter.collect();
            return now[targetIdx] && now[targetIdx].id === wantId;
          },
          moveTimeout,
          Math.max(120, this.pacing / 2),
          () => this.stopRequested,
        );
        if (landed) {
          // Polymer applies drags optimistically and re-syncs from server data moments later -
          // a wrong server-side move REVERTS the DOM. Re-check after a settle before trusting it.
          await this.waitAbortable(Math.max(250, this.pacing / 2));
          const now = this.adapter.collect();
          if (now[targetIdx] && now[targetIdx].id === wantId) return true;
          log(
            `⚠️ Move looked applied but was reverted by the page (attempt ${attempt}/3) - retrying…`,
          );
          continue;
        }
        const nowSnapshot = this.adapter
          .collect()
          .map((e) => e.id)
          .join(',');
        if (nowSnapshot !== snapshot) return true; // order changed some other way - let the outer loop replan
        log(`⚠️ Move attempt ${attempt}/3 did not apply - retrying…`);
      }
      return false;
    }

    // Return a consistent terminal result for a drag sort stopped by the user.
    cancelled() {
      log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      log(
        `⛔ Sort cancelled by user. ${this.moves} verified moves were applied before stopping.`,
      );
      setStatus('Stopped');
      return { ok: false, cancelled: true, moves: this.moves };
    }
    // Surface a terminal failure and preserve the number of successfully applied moves.
    fail(msg) {
      log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      log(
        msg.startsWith('❌') || msg.startsWith('Cannot sort')
          ? msg
          : '❌ ' + msg,
      );
      showLog();
      setStatus('Could not finish · details below');
      return { ok: false, moves: this.moves };
    }
  }

  // ======================================================================== features
  // One page-scrolling task at a time: Stats/Export drive the same scroll loop the sorter uses,
  // so running them concurrently with a sort would corrupt drag verification.
  let activeTask = null;
  // Points the Stop button at whichever operation currently owns the page.
  let stoppableRun = null;
  // Cache the last complete server read so the overview and cleanup dialog share one snapshot.
  let overviewItems = null;
  let overviewListId = null;
  let overviewRequestId = 0;
  let overviewCountEl = null;
  let overviewDurationEl = null;
  let overviewAverageEl = null;
  let cleanupButton = null;
  // Claim exclusive access to scrolling and playlist mutations for one named task.
  const claimTask = (name, run) => {
    if (activeTask) {
      showLog();
      log(
        `⚠️ ${name} unavailable: a ${activeTask} is already running - wait for it to finish (or press Stop).`,
      );
      return false;
    }
    activeTask = name;
    stoppableRun = run || null;
    return true;
  };

  // Reset overview controls while a fresh server snapshot is being loaded.
  const setOverviewLoading = () => {
    if (overviewCountEl) overviewCountEl.textContent = '…';
    if (overviewDurationEl) overviewDurationEl.textContent = 'Calculating…';
    if (overviewAverageEl) overviewAverageEl.textContent = 'Entire playlist';
    if (cleanupButton) {
      cleanupButton.disabled = true;
      cleanupButton.textContent = 'Checking unavailable videos…';
    }
  };

  // Render aggregate duration data and enable cleanup when unavailable entries exist.
  const renderOverview = (items, listId = currentListId()) => {
    overviewItems = items;
    overviewListId = listId;
    const available = items.filter(
      (it) => !it.unavailable && it.durSec !== null,
    );
    const unavailable = items.filter((it) => it.unavailable);
    const unknownDuration = items.filter(
      (it) => !it.unavailable && it.durSec === null,
    ).length;
    const total = available.reduce((sum, it) => sum + it.durSec, 0);
    const average = available.length ? Math.floor(total / available.length) : 0;
    if (overviewCountEl) overviewCountEl.textContent = String(items.length);
    if (overviewDurationEl)
      overviewDurationEl.textContent = fmtOverviewDuration(total);
    if (overviewAverageEl)
      overviewAverageEl.textContent = available.length
        ? `Average ${fmtOverviewDuration(average)}${unknownDuration ? ` · ${unknownDuration} without duration` : ''}`
        : 'No available videos';
    if (cleanupButton) {
      cleanupButton.disabled = unavailable.length === 0;
      cleanupButton.textContent = unavailable.length
        ? `Remove unavailable · ${unavailable.length}`
        : 'No unavailable videos';
    }
  };

  // Fetch an authoritative playlist snapshot and ignore stale responses after navigation.
  const refreshPlaylistOverview = async () => {
    const requestId = ++overviewRequestId;
    const listId = currentListId();
    if (!listId) return;
    setOverviewLoading();
    try {
      const items = YtApi.available()
        ? await YtApi.fetchServerItems(listId)
        : null;
      if (requestId !== overviewRequestId || currentListId() !== listId) return;
      if (!items || items.truncated)
        throw new Error('playlist read incomplete');
      renderOverview(items, listId);
    } catch {
      if (requestId !== overviewRequestId) return;
      overviewItems = null;
      overviewListId = null;
      if (overviewCountEl) overviewCountEl.textContent = '—';
      if (overviewDurationEl)
        overviewDurationEl.textContent = 'Could not calculate';
      if (overviewAverageEl) overviewAverageEl.textContent = 'Refresh the page';
      if (cleanupButton) {
        cleanupButton.disabled = false;
        cleanupButton.textContent = 'Retry calculation';
      }
    }
  };

  // Remove confirmed unavailable entries in bounded batches and verify the server result.
  const removeUnavailable = async (items, expectedListId) => {
    const listId = currentListId();
    if (!listId || listId !== expectedListId) {
      setStatus('Playlist changed · run the check again');
      return;
    }
    if (!listId || !YtApi.available()) {
      setStatus('Could not connect to YouTube');
      return;
    }
    const targets = items.filter((it) => it.unavailable && it.setVideoId);
    if (!targets.length) {
      setStatus('No unavailable videos');
      return;
    }

    const control = {
      stopRequested: false,
      stop() {
        this.stopRequested = true;
      },
    };
    if (!claimTask('cleanup', control)) return;
    setRunningUi(true);
    log(`🧹 Removing ${targets.length} unavailable videos…`);
    setStatus(`Removing: 0 of ${targets.length}`);
    try {
      const context = pageWin.ytcfg.data_.INNERTUBE_CONTEXT;
      for (let i = 0; i < targets.length; i += 40) {
        if (control.stopRequested) {
          setStatus('Removal stopped');
          await refreshPlaylistOverview();
          return;
        }
        if (currentListId() !== listId)
          throw new Error('the page changed to another playlist');
        const chunk = targets.slice(i, i + 40);
        const actions = chunk.map((it) => ({
          action: 'ACTION_REMOVE_VIDEO',
          setVideoId: it.setVideoId,
        }));
        let result = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          result = await YtApi.sendActions(listId, context, actions);
          if (result.ok) break;
          await wait(400);
        }
        if (!result || !result.ok)
          throw new Error(
            (result && result.error) || 'YouTube rejected the request',
          );
        setStatus(
          `Removing: ${Math.min(i + chunk.length, targets.length)} of ${targets.length}`,
        );
        if (i + chunk.length < targets.length) await wait(settings.apiPacingMs);
      }

      const fresh = await YtApi.fetchServerItems(listId);
      const removedIds = new Set(targets.map((it) => it.setVideoId));
      const remaining =
        fresh && fresh.filter((it) => removedIds.has(it.setVideoId));
      if (!fresh || fresh.truncated || remaining.length)
        throw new Error(
          `could not verify removal of ${remaining ? remaining.length : targets.length} videos`,
        );
      log(
        `✅ Removed ${targets.length} unavailable videos and verified the playlist.`,
      );
      setStatus(`Done · removed ${targets.length}`);
      renderOverview(fresh, listId);
      if (/^(www\.)?youtube\.com$/i.test(location.hostname))
        setTimeout(() => location.reload(), 1200);
    } catch (e) {
      log(`❌ Cleanup failed: ${e && e.message ? e.message : e}`);
      showLog();
      setStatus('Removal did not fully complete · details below');
      await refreshPlaylistOverview();
    } finally {
      activeTask = null;
      stoppableRun = null;
      setRunningUi(false);
    }
  };

  // Show the unavailable entries and require an explicit destructive-action confirmation.
  const showCleanupPreview = () => {
    const unavailable = (overviewItems || []).filter((it) => it.unavailable);
    if (!unavailable.length) {
      setStatus('No unavailable videos');
      return;
    }
    const removable = unavailable.filter((it) => it.setVideoId);
    const overlay = elt('div', { class: 'yts-overlay' });
    const modal = elt('div', {
      class: 'yts-modal yts-modal-narrow ' + themeClass(),
      role: 'dialog',
      'aria-modal': 'true',
    });
    modal.appendChild(elt('h3', { text: 'Remove unavailable videos?' }));
    modal.appendChild(
      elt('p', {
        class: 'yts-modal-copy',
        text: `Found ${unavailable.length}. They will be permanently removed from this playlist.`,
      }),
    );
    const list = elt('div', { class: 'yts-cleanup-list' });
    unavailable
      .slice(0, 30)
      .forEach((it) =>
        list.appendChild(
          elt(
            'div',
            { class: 'yts-cleanup-item' },
            elt('span', { text: it.title || 'Unavailable video' }),
            elt('small', { text: it.unavailableReason || 'Unavailable' }),
          ),
        ),
      );
    if (unavailable.length > 30)
      list.appendChild(
        elt('div', {
          class: 'yts-list-more',
          text: `And ${unavailable.length - 30} more…`,
        }),
      );
    modal.appendChild(list);
    modal.appendChild(
      elt('div', {
        class: 'yts-warning',
        text: 'This action cannot be undone.',
      }),
    );
    const removeButton = elt('button', {
      class: 'yts-btn yts-danger',
      'data-act': 'remove',
      text: `Remove ${removable.length}`,
    });
    removeButton.disabled = removable.length === 0;
    modal.appendChild(
      elt(
        'div',
        { class: 'yts-btns' },
        elt('button', {
          class: 'yts-btn',
          'data-act': 'cancel',
          text: 'Cancel',
        }),
        removeButton,
      ),
    );
    const onKey = (ev) => {
      if (ev.key === 'Escape') close();
    };
    const close = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      modal.remove();
    };
    modal.addEventListener('click', (ev) => {
      const act =
        ev.target &&
        ev.target.getAttribute &&
        ev.target.getAttribute('data-act');
      if (act === 'cancel') close();
      if (act === 'remove') {
        close();
        removeUnavailable(removable, overviewListId);
      }
    });
    overlay.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    document.body.appendChild(modal);
    setTimeout(() => modal.querySelector('[data-act="cancel"]')?.focus(), 0);
  };

  // Produce a detailed duration summary in the diagnostic log.
  const runStats = async () => {
    const adapter = detectAdapter();
    if (!adapter) {
      showLog();
      log('❌ Stats failed: no playlist detected on this page.');
      return;
    }
    const run = new SortRun(adapter, settings); // reuse loading engine (and its stop flag)
    if (!claimTask('stats run', run)) return;
    try {
      showLog();
      log('📊 Analyzing playlist…');
      const entries =
        settings.scope === 'all'
          ? await loadAll(adapter, run, adapter.reportedCount())
          : adapter.collect();
      const durations = entries.map((e) => e.durSec).filter((d) => d !== null);
      const unavailable = entries.length - durations.length;
      if (durations.length === 0) {
        log('❌ No videos with parseable durations found.');
        return;
      }
      const total = durations.reduce((a, b) => a + b, 0);
      log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      log('📊 PLAYLIST ANALYSIS');
      log(
        `📹 Videos analyzed: ${durations.length}${unavailable ? `  (⚠️ ${unavailable} unavailable/live)` : ''}`,
      );
      log(`⏱️ Total duration: ${fmtLong(total)}`);
      log(
        `   Average length: ${fmtLong(Math.floor(total / durations.length))}`,
      );
      log(
        `   Shortest: ${fmtDuration(Math.min(...durations))}   Longest: ${fmtDuration(Math.max(...durations))}`,
      );
      log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    } finally {
      activeTask = null;
      stoppableRun = null;
    }
  };

  // Download the currently collected playlist order as a UTF-8 CSV file.
  const runExport = async () => {
    const adapter = detectAdapter();
    if (!adapter) {
      showLog();
      log('❌ Export failed: no playlist detected on this page.');
      return;
    }
    const run = new SortRun(adapter, settings);
    if (!claimTask('export run', run)) return;
    try {
      showLog();
      log('📤 Exporting playlist…');
      const entries =
        settings.scope === 'all'
          ? await loadAll(adapter, run, adapter.reportedCount())
          : adapter.collect();
      if (entries.length === 0) {
        log('❌ Export failed: 0 videos found.');
        return;
      }
      let csv = 'Position,Title,Duration,URL\n';
      entries.forEach((e, i) => {
        const title = '"' + (e.title || 'Unknown').replace(/"/g, '""') + '"';
        const dur =
          e.durSec === null
            ? 'N/A'
            : `${String(Math.floor(e.durSec / 3600)).padStart(2, '0')}:${String(Math.floor((e.durSec % 3600) / 60)).padStart(2, '0')}:${String(e.durSec % 60).padStart(2, '0')}`;
        const idm = (e.url || '').match(/[?&]v=([A-Za-z0-9_-]+)/);
        const url = idm ? `https://www.youtube.com/watch?v=${idm[1]}` : '';
        csv += `${i + 1},${title},${dur},${url}\n`;
      });
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      const listm = location.search.match(/list=([^&]+)/);
      const d = new Date();
      a.href = URL.createObjectURL(blob);
      a.download = `youtube_playlist_${listm ? listm[1] : 'export'}_${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.csv`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      log(`✅ Exported ${entries.length} videos to ${a.download}`);
    } finally {
      activeTask = null;
      stoppableRun = null;
    }
  };

  // ======================================================================== sort entry point
  let sortButton = null;
  let stopButton = null;
  // Keep mutation controls and the Stop button synchronized with task ownership.
  const setRunningUi = (running) => {
    if (sortButton) {
      sortButton.disabled = running;
      sortButton.style.opacity = running ? '0.5' : '1';
    }
    if (cleanupButton) {
      cleanupButton.disabled =
        running ||
        (overviewItems !== null && !overviewItems.some((it) => it.unavailable));
      cleanupButton.style.display = running ? 'none' : '';
    }
    if (stopButton) stopButton.style.display = running ? '' : 'none';
  };

  // Validate the current page, claim the task slot, and execute one guarded sort.
  const startSort = async () => {
    if (activeRun) {
      log('⚠️ A sort is already running - ignoring the extra click.');
      return;
    }
    const adapter = detectAdapter();
    if (!adapter) {
      log('Cannot sort: no playlist detected on this page.');
      setStatus('No playlist found');
      return;
    }

    activeRun = new SortRun(adapter, settings);
    if (!claimTask('sort', activeRun)) {
      activeRun = null;
      return;
    }
    setRunningUi(true);
    setStatus('Sorting…');
    try {
      await activeRun.execute();
    } catch (e) {
      log(
        `❌ Sort failed: unexpected error - ${e && e.message ? e.message : e}`,
      );
      console.error('[YTSort]', e);
      showLog();
      setStatus('Could not finish · details below');
    } finally {
      activeRun = null;
      activeTask = null;
      stoppableRun = null;
      setRunningUi(false);
    }
  };

  // ======================================================================== UI
  // Theme-aware: the panel and modals carry a `yts-light`/`yts-dark` class and read colors from
  // CSS variables set per theme, so they match YouTube's own light/dark surfaces natively (solid
  // backgrounds - no translucent ambient bleed) and follow the theme when the user toggles it.
  const CSS = `
    .sort-playlist-wrapper, .yts-modal {
      --s-text:#f1f1f1; --s-text2:#aaa; --s-surface:#212121; --s-border:rgba(255,255,255,.15);
      --s-btn:rgba(255,255,255,.1); --s-btn-hover:rgba(255,255,255,.2); --s-link:#3ea6ff;
      --s-log-bg:#0f0f0f; --s-log-text:#f1f1f1; --s-scheme:dark;
    }
    .sort-playlist-wrapper.yts-light, .yts-modal.yts-light {
      --s-text:#0f0f0f; --s-text2:#606060; --s-surface:#ffffff; --s-border:rgba(0,0,0,.12);
      --s-btn:rgba(0,0,0,.05); --s-btn-hover:rgba(0,0,0,.1); --s-link:#065fd4;
      --s-log-bg:#f8f8f8; --s-log-text:#0f0f0f; --s-scheme:light;
    }
    .sort-playlist-wrapper { margin-top: 12px; font-family: Roboto, Arial, sans-serif; }
    .sort-playlist-details { border: 1px solid var(--s-border); border-radius: 14px; background: var(--s-surface); color: var(--s-text); overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
    .sort-playlist-summary { list-style: none; padding: 13px 16px; font-weight: 600; cursor: pointer; display: flex; align-items:center; justify-content: space-between; user-select: none; font-size: 14px; color: var(--s-text); }
    .sort-playlist-summary::-webkit-details-marker { display: none; }
    .sort-playlist-summary::after { content:'⌃'; color:var(--s-text2); font-size:12px; transition:transform .15s ease; }
    .sort-playlist-details:not([open]) .sort-playlist-summary::after { transform:rotate(180deg); }
    .sort-playlist-content { padding: 0 16px 14px; color: var(--s-text); }
    .yts-overview { display:grid; grid-template-columns: 80px minmax(130px,1fr); gap:8px; margin:0 0 14px; }
    .yts-stat { border-radius:10px; padding:10px 12px; background:var(--s-btn); min-width:0; }
    .yts-stat-value { display:block; font-size:16px; line-height:1.25; font-weight:650; color:var(--s-text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .yts-stat-label { display:block; margin-top:3px; color:var(--s-text2); font-size:11px; line-height:1.3; }
    .yts-control-label { display:block; margin:0 0 6px; color:var(--s-text2); font-size:11px; font-weight:600; }
    .sort-playlist-button { display: flex; flex-direction:column; gap: 8px; margin:10px 0 8px; }
    .yts-btn { border: 1px solid var(--s-border); border-radius: 18px; padding: 8px 14px; cursor: pointer; font-size: 13px; font-weight: 500; background: var(--s-btn); color: var(--s-text); transition: background .15s ease, opacity .15s ease; }
    .yts-btn:hover { background: var(--s-btn-hover); }
    .yts-btn:disabled { cursor: default; opacity: .5; }
    .yts-primary { font-weight: 600; background:#f2f2f2; color:#0f0f0f; border-color:transparent; }
    .yts-light .yts-primary { background:#0f0f0f; color:#fff; }
    .yts-danger { color:#fff !important; background:#c5221f !important; border-color:#c5221f !important; font-weight:600; }
    .yts-selects { display: flex; gap: 8px; margin-bottom: 8px; }
    /* color-scheme makes the NATIVE dropdown (option list) render in the right theme instead of
       white-on-white in dark mode; option colors are a belt-and-suspenders fallback. */
    .yts-select { width:100%; border: 1px solid var(--s-border); border-radius: 9px; padding: 8px 10px; font-size: 13px; background: var(--s-btn); color: var(--s-text); color-scheme: var(--s-scheme); }
    .yts-select option { background: var(--s-surface); color: var(--s-text); }
    .yts-status { font-size: 12px; color: var(--s-text2); margin: 7px 1px 0; min-height: 15px; }
    .yts-log { padding: 10px; border-radius: 8px; background: var(--s-log-bg); color: var(--s-log-text); border: 1px solid var(--s-border); font: 11.5px/1.5 ui-monospace, Menlo, Consolas, monospace; max-height: 220px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }
    .yts-tools { margin-top:12px; border-top:1px solid var(--s-border); padding-top:9px; }
    .yts-tools summary { cursor:pointer; color:var(--s-text2); font-size:11px; user-select:none; }
    .yts-tools-body { margin-top:8px; }
    .yts-tools-actions { display:flex; gap:6px; margin-top:7px; }
    .yts-tools-actions .yts-btn { padding:5px 10px; font-size:11px; }
    .yts-stop { color:#e85d5d; }
    .yts-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 99998; }
    .yts-modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%); background: var(--s-surface); color: var(--s-text); border: 1px solid var(--s-border); border-radius: 12px; padding: 20px; z-index: 99999; max-width: 760px; width: 92%; max-height: 82vh; overflow-y: auto; font-size: 13px; font-family: Roboto, Arial, sans-serif; }
    .yts-modal h3 { margin: 0 0 10px; } .yts-modal h4 { margin: 8px 0 6px; }
    .yts-modal-copy { color:var(--s-text2); line-height:1.45; margin:0 0 12px; }
    .yts-modal .yts-btn { background: var(--s-btn); color: var(--s-text); border: 1px solid var(--s-border); }
    .yts-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; max-height: 46vh; overflow-y: auto; border: 1px solid var(--s-border); border-radius: 8px; padding: 8px; }
    .yts-row { padding: 3px 4px; border-bottom: 1px solid var(--s-border); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .yts-row span { color: var(--s-text2); }
    .yts-list-more { padding:8px 4px; color:var(--s-text2); font-size:11px; }
    .yts-cleanup-list { max-height:300px; overflow:auto; border:1px solid var(--s-border); border-radius:9px; }
    .yts-cleanup-item { display:flex; justify-content:space-between; gap:12px; padding:9px 10px; border-bottom:1px solid var(--s-border); }
    .yts-cleanup-item:last-child { border-bottom:none; }
    .yts-cleanup-item span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .yts-cleanup-item small { flex:none; color:var(--s-text2); }
    .yts-warning { margin-top:10px; color:#e85d5d; font-size:12px; }
    .yts-btns { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 16px; }
    .yts-btns-right { display: flex; gap: 8px; }
    .yts-modal.yts-modal-narrow { max-width: 430px; }
    .yts-sec { font-size: 11px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; color: var(--s-text2); margin: 16px 0 6px; padding-top: 12px; border-top: 1px solid var(--s-border); }
    .yts-sec.yts-sec-first { border-top: none; padding-top: 2px; margin-top: 6px; }
    .yts-settings-row { display: flex; justify-content: space-between; align-items: center; margin: 7px 0; gap: 16px; }
    .yts-settings-row label { color: var(--s-text); flex: 1; min-width: 0; }
    .yts-settings-row input[type=number] { width: 92px; flex: none; background: var(--s-btn); color: var(--s-text); border: 1px solid var(--s-border); border-radius: 6px; padding: 4px 6px; }
    .yts-settings-row input:disabled { cursor: not-allowed; }
    .yts-settings-row.yts-dependent label { padding-left: 16px; position: relative; }
    .yts-settings-row.yts-dependent label::before { content: '↳'; position: absolute; left: 2px; color: var(--s-text2); }
    .yts-settings-row.yts-off { opacity: .42; }
    @media (max-width:520px) { .yts-cols { grid-template-columns:1fr; } }
  `;

  // Inject the extension stylesheet once per YouTube document.
  const injectCss = () => {
    if (document.getElementById('yts-style')) return;
    const el = document.createElement('style');
    el.id = 'yts-style';
    el.textContent = CSS;
    document.head.appendChild(el);
  };

  // ---- theme detection (YouTube's own light/dark) ----
  let panelWrapper = null;
  // Prefer YouTube's theme markers, then inspect opaque backgrounds, then use the OS preference.
  const isDarkTheme = () => {
    // 1. YouTube's authoritative signal: a `dark` attribute on <html> (or ytd-app)
    if (document.documentElement.hasAttribute('dark')) return true;
    const app = document.querySelector('ytd-app');
    if (app && app.hasAttribute('dark')) return true;
    // 2. luminance of the first OPAQUE surface background (a transparent rgba(0,0,0,0) is NOT dark)
    for (const node of [document.documentElement, document.body, app]) {
      if (!node) continue;
      const m = (getComputedStyle(node).backgroundColor || '').match(
        /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?/,
      );
      if (m && (m[4] === undefined || parseFloat(m[4]) > 0.1)) {
        return 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3] < 128;
      }
    }
    // 3. last resort: OS/browser preference
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  };
  // Return the CSS class applied to panels and dialogs for the detected theme.
  const themeClass = () => (isDarkTheme() ? 'yts-dark' : 'yts-light');
  // Update an already mounted panel after YouTube changes theme.
  const applyPanelTheme = () => {
    if (!panelWrapper) return;
    const d = isDarkTheme();
    panelWrapper.classList.toggle('yts-dark', d);
    panelWrapper.classList.toggle('yts-light', !d);
  };
  let themeWatchSet = false;
  // Watch both YouTube and operating-system theme signals without installing duplicate observers.
  const watchTheme = () => {
    // re-detect shortly after mount: YouTube's theme/background can settle a beat after the panel
    // renders (background is briefly transparent during load)
    setTimeout(applyPanelTheme, 500);
    setTimeout(applyPanelTheme, 1500);
    if (themeWatchSet) return;
    themeWatchSet = true;
    try {
      // watch YouTube's own dark toggle (html[dark] / ytd-app[dark]) and OS preference changes
      new MutationObserver(applyPanelTheme).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['dark'],
      });
      const app = document.querySelector('ytd-app');
      if (app)
        new MutationObserver(applyPanelTheme).observe(app, {
          attributes: true,
          attributeFilter: ['dark'],
        });
      window
        .matchMedia('(prefers-color-scheme: dark)')
        .addEventListener('change', applyPanelTheme);
    } catch {
      /* observers unavailable */
    }
  };

  // `offsetParent` is null for descendants of YouTube's fixed immersive playlist
  // header, even while they are visibly rendered. Use layout boxes instead so
  // Watch Later and ordinary playlists share the same visibility test.
  const isVisible = (el) => {
    if (!el || !el.isConnected || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  // Return the first rendered match because YouTube often keeps hidden duplicate headers.
  const firstVisible = (selector) =>
    [...document.querySelectorAll(selector)].find(isVisible);
  // Choose a stable visible location in either the current or legacy playlist header.
  const findMountPoint = () => {
    // NEW arch: insert after the VISIBLE actions row. YouTube renders hidden duplicate headers,
    // so we must NOT fall back to a hidden row (the panel would render inside a display:none header).
    // If a row exists but isn't visible yet, return null so the observer retries once it is.
    const rows = [
      ...document.querySelectorAll('.ytFlexibleActionsViewModelActionRow'),
    ];
    if (rows.length) {
      const visRow = rows.find(isVisible);
      if (visRow) return { el: visRow, mode: 'after' };
    }
    // Legacy/immersive header. Watch Later has no flexible actions row. Its
    // generic `#container` belongs to the dynamic TITLE component; appending
    // the panel there makes it overflow across the title and Play/Shuffle
    // controls. Mount after the real play/actions row instead.
    const afterCandidates = [
      firstVisible('ytd-playlist-header-renderer .play-menu.wide-screen-form'),
      firstVisible('ytd-playlist-header-renderer .metadata-action-bar'),
      firstVisible('ytd-playlist-header-renderer #actions'),
      firstVisible('ytd-playlist-sidebar-primary-info-renderer #menu'),
    ];
    const afterTarget = afterCandidates.find(isVisible);
    if (afterTarget) return { el: afterTarget, mode: 'after' };

    // Last-resort containers are deliberately specific. Never use the first
    // `#container` or the header root: both can be fixed-size internal nodes.
    const appendCandidates = [
      firstVisible('ytd-playlist-header-renderer .metadata-wrapper'),
      firstVisible('ytd-playlist-sidebar-primary-info-renderer'),
    ];
    const appendTarget = appendCandidates.find(isVisible);
    if (appendTarget) return { el: appendTarget, mode: 'append' };
    return null;
  };

  // Assemble the complete sorter panel and connect each control to its handler.
  const buildPanel = () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'sort-playlist-wrapper ' + themeClass();
    panelWrapper = wrapper;
    watchTheme();
    const details = document.createElement('details');
    details.className = 'sort-playlist-details';
    details.open = true;
    details.appendChild(
      elt(
        'summary',
        { class: 'sort-playlist-summary' },
        elt('span', { text: 'Sort playlist by duration' }),
      ),
    );
    const content = document.createElement('div');
    content.className = 'sort-playlist-content';

    const overview = elt('div', { class: 'yts-overview' });
    overviewCountEl = elt('strong', { class: 'yts-stat-value', text: '…' });
    overviewDurationEl = elt('strong', {
      class: 'yts-stat-value',
      text: 'Calculating…',
    });
    overviewAverageEl = elt('span', {
      class: 'yts-stat-label',
      text: 'Entire playlist',
    });
    overview.appendChild(
      elt(
        'div',
        { class: 'yts-stat' },
        overviewCountEl,
        elt('span', { class: 'yts-stat-label', text: 'Videos' }),
      ),
    );
    overview.appendChild(
      elt('div', { class: 'yts-stat' }, overviewDurationEl, overviewAverageEl),
    );
    content.appendChild(overview);

    // Always operate on the complete playlist to avoid accidentally sorting a partial list.
    settings.scope = 'all';
    saveSettings(settings);
    content.appendChild(
      elt('label', { class: 'yts-control-label', text: 'Sort order' }),
    );
    const selects = document.createElement('div');
    selects.className = 'yts-selects';
    const modeSel = elt(
      'select',
      { class: 'yts-select' },
      elt('option', { value: 'asc', text: 'Shortest first' }),
      elt('option', { value: 'desc', text: 'Longest first' }),
    );
    modeSel.value = settings.sortMode;
    modeSel.onchange = () => {
      settings.sortMode = modeSel.value === 'desc' ? 'desc' : 'asc';
      saveSettings(settings);
    };
    selects.appendChild(modeSel);
    content.appendChild(selects);

    const btnRow = document.createElement('div');
    btnRow.className = 'sort-playlist-button';
    // Create buttons through one error boundary so rejected async handlers reach the log.
    const mkBtn = (label, cls, fn, title, parent = btnRow) => {
      const b = document.createElement('button');
      b.className = 'yts-btn' + (cls ? ' ' + cls : '');
      b.innerText = label;
      if (title) {
        b.title = title;
        b.setAttribute('aria-label', title);
      }
      b.onclick = () => {
        Promise.resolve()
          .then(fn)
          .catch((e) => {
            log('❌ ' + (e && e.message ? e.message : e));
            console.error('[YTSort]', e);
          });
      };
      parent.appendChild(b);
      return b;
    };
    sortButton = mkBtn('Sort playlist', 'yts-primary', () => startSort());
    stopButton = mkBtn(
      'Stop',
      'yts-stop',
      () => {
        if (stoppableRun) {
          stoppableRun.stop();
          setStatus('Stopping…');
        }
      },
      'Stop the current operation',
    );
    stopButton.style.display = 'none';
    cleanupButton = mkBtn('Checking unavailable videos…', '', () =>
      overviewItems ? showCleanupPreview() : refreshPlaylistOverview(),
    );
    cleanupButton.disabled = true;
    content.appendChild(btnRow);

    statusEl = document.createElement('div');
    statusEl.className = 'yts-status';
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');
    statusEl.textContent = 'Ready';
    content.appendChild(statusEl);

    const tools = elt(
      'details',
      { class: 'yts-tools' },
      elt('summary', { text: 'More' }),
    );
    const toolsBody = elt('div', { class: 'yts-tools-body' });
    logEl = document.createElement('div');
    logEl.className = 'yts-log';
    logEl.style.display = 'block';
    logEl.textContent = '[Ready]';
    toolsBody.appendChild(logEl);
    renderLog();
    const toolsActions = elt('div', { class: 'yts-tools-actions' });
    mkBtn('Export CSV', '', runExport, 'Download the video list', toolsActions);
    mkBtn('Settings', '', showSettingsModal, 'Settings', toolsActions);
    mkBtn(
      'Copy log',
      '',
      async () => {
        await navigator.clipboard.writeText(
          logEntries.map((e) => e.line).join('\n'),
        );
        log('✅ Log copied to clipboard.');
      },
      'Copy log',
      toolsActions,
    );
    toolsBody.appendChild(toolsActions);
    tools.appendChild(toolsBody);
    content.appendChild(tools);

    details.appendChild(content);
    wrapper.appendChild(details);
    return wrapper;
  };

  // Build the settings dialog and commit changes only when the user selects Save.
  const showSettingsModal = () => {
    const overlay = elt('div', { class: 'yts-overlay' });
    const modal = elt('div', {
      class: 'yts-modal yts-modal-narrow ' + themeClass(),
      role: 'dialog',
      'aria-modal': 'true',
    });
    const row = (label, input, cls) =>
      elt(
        'div',
        { class: 'yts-settings-row' + (cls ? ' ' + cls : '') },
        elt('label', { text: label }),
        input,
      );
    const sec = (title, first) =>
      elt('div', {
        class: 'yts-sec' + (first ? ' yts-sec-first' : ''),
        text: title,
      });
    const g = (id) => modal.querySelector('#' + id);
    modal.appendChild(elt('h3', { text: 'Settings' }));

    // --- Sorting: what to sort and what happens when it finishes ---
    modal.appendChild(sec('Behavior', true));
    modal.appendChild(
      row(
        'Refresh the page after sorting',
        elt('input', {
          type: 'checkbox',
          id: 'yts-reload',
          checked: settings.reloadAfterSort,
        }),
      ),
    );
    modal.appendChild(
      row(
        'Only sort videos within a duration range',
        elt('input', {
          type: 'checkbox',
          id: 'yts-filt',
          checked: settings.filterEnabled,
        }),
      ),
    );
    modal.appendChild(
      row(
        'Minimum duration, minutes',
        elt('input', {
          type: 'number',
          id: 'yts-fmin',
          min: 0,
          step: 1,
          value: Math.floor(settings.filterMinSec / 60),
        }),
        'yts-dependent',
      ),
    );
    modal.appendChild(
      row(
        'Maximum duration, minutes',
        elt('input', {
          type: 'number',
          id: 'yts-fmax',
          min: 0,
          step: 1,
          value: Math.floor(settings.filterMaxSec / 60),
        }),
        'yts-dependent',
      ),
    );

    // --- Advanced: performance + technical knobs most people never touch ---
    modal.appendChild(sec('Diagnostics'));
    modal.appendChild(
      row(
        'Delay between actions, ms',
        elt('input', {
          type: 'number',
          id: 'yts-pacing',
          min: 100,
          max: 5000,
          step: 50,
          value: settings.pacing,
        }),
      ),
    );
    modal.appendChild(
      row(
        'Actions per request',
        elt('input', {
          type: 'number',
          id: 'yts-batch',
          min: 1,
          max: 100,
          step: 1,
          value: settings.apiBatchSize,
        }),
      ),
    );
    modal.appendChild(
      row(
        'Missing-video tolerance, %',
        elt('input', {
          type: 'number',
          id: 'yts-tol',
          min: 0,
          max: 100,
          step: 1,
          value: settings.tolerancePct,
        }),
      ),
    );

    modal.appendChild(
      elt(
        'div',
        { class: 'yts-btns' },
        elt('button', {
          class: 'yts-btn',
          'data-act': 'reset',
          text: 'Reset',
        }),
        elt(
          'div',
          { class: 'yts-btns-right' },
          elt('button', {
            class: 'yts-btn',
            'data-act': 'cancel',
            text: 'Cancel',
          }),
          elt('button', {
            class: 'yts-btn yts-primary',
            'data-act': 'save',
            text: 'Save',
          }),
        ),
      ),
    );

    // Duration inputs only matter when the range filter is enabled.
    const syncDependents = () => {
      const on = !!g('yts-filt').checked;
      ['yts-fmin', 'yts-fmax'].forEach((id) => {
        const el = g(id);
        if (el) el.disabled = !on;
      });
      modal
        .querySelectorAll('.yts-dependent')
        .forEach((r) => r.classList.toggle('yts-off', !on));
    };
    g('yts-filt').addEventListener('change', syncDependents);
    syncDependents();

    const onKey = (ev) => {
      if (ev.key === 'Escape') close();
    };
    const close = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      modal.remove();
    };
    modal.addEventListener('click', (ev) => {
      const act =
        ev.target &&
        ev.target.getAttribute &&
        ev.target.getAttribute('data-act');
      if (act === 'cancel') close();
      if (act === 'reset') {
        // repopulate the form with defaults; not persisted until Save (so Cancel still backs out)
        const set = (id, v) => {
          const el = g(id);
          if (!el) return;
          if (el.type === 'checkbox') el.checked = v;
          else el.value = v;
        };
        set('yts-reload', DEFAULTS.reloadAfterSort);
        set('yts-filt', DEFAULTS.filterEnabled);
        set('yts-fmin', Math.floor(DEFAULTS.filterMinSec / 60));
        set('yts-fmax', Math.floor(DEFAULTS.filterMaxSec / 60));
        set('yts-pacing', DEFAULTS.pacing);
        set('yts-batch', DEFAULTS.apiBatchSize);
        set('yts-tol', DEFAULTS.tolerancePct);
        syncDependents();
      }
      if (act === 'save') {
        settings = validateSettings({
          ...settings,
          pacing: g('yts-pacing').value,
          apiBatchSize: g('yts-batch').value,
          tolerancePct: g('yts-tol').value,
          filterEnabled: g('yts-filt').checked,
          filterMinSec: (parseInt(g('yts-fmin').value, 10) || 0) * 60,
          filterMaxSec: (parseInt(g('yts-fmax').value, 10) || 600) * 60,
          reloadAfterSort: g('yts-reload').checked,
          logVisible: false,
        });
        saveSettings(settings);
        setStatus('Settings saved');
        close();
      }
    });
    overlay.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    document.body.appendChild(modal);
    setTimeout(() => modal.querySelector('[data-act="cancel"]')?.focus(), 0);
  };

  // ======================================================================== lifecycle
  // A single shared observer waits for YouTube's asynchronously rendered header.
  let mountObserver = null;

  // Limit the extension UI to canonical playlist routes with a list identifier.
  const isPlaylistPage = () =>
    location.pathname === '/playlist' &&
    new URLSearchParams(location.search).has('list');

  // ?ytsort=1 on a playlist URL → auto-run the sort ONCE, headless (no button click), after an
  // auth check. This optional URL trigger works only in a browser signed in to YouTube because
  // InnerTube writes require the current session. The parameter is removed immediately so a reload
  // or in-app remount cannot start the same operation twice.
  const AUTOSORT_PARAM = 'ytsort';
  let autoSortPending = false;
  const maybeAutoSort = () => {
    const params = new URLSearchParams(location.search);
    if (!params.get(AUTOSORT_PARAM) || autoSortPending) return;
    autoSortPending = true;
    params.delete(AUTOSORT_PARAM);
    const qs = params.toString();
    history.replaceState(
      null,
      '',
      location.pathname + (qs ? '?' + qs : '') + location.hash,
    );
    (async () => {
      try {
        const authed = YtApi.available() && !!(await YtApi.sapisidHash());
        if (!authed) {
          showLog();
          log(
            '❌ Auto-sort needs you signed in to YouTube — no account session was found on this page. Sign in, then open the link again.',
          );
          setStatus('Not signed in');
          return;
        }
        log('▶ Auto-sort requested by the link — sorting this playlist now…');
        // Let the playlist finish its first paint so the adapter/engine act on a live page, then
        // A URL trigger means "do it"; sorting always runs immediately.
        await new Promise((r) => setTimeout(r, 700));
        await startSort();
      } finally {
        autoSortPending = false;
      }
    })();
  };

  // Wait for a late-rendered header; instance-local capture prevents an old timeout from
  // disconnecting a newer observer.
  const waitForMountPoint = () => {
    if (mountObserver) return;
    const obs = new MutationObserver(() => {
      if (!isPlaylistPage()) return;
      if (findMountPoint()) {
        obs.disconnect();
        if (mountObserver === obs) mountObserver = null;
        mountIfPlaylist();
      }
    });
    mountObserver = obs;
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      obs.disconnect();
      if (mountObserver === obs) mountObserver = null;
    }, 60000);
  };

  // Insert a fresh panel at the selected mount point and restore active-run state if needed.
  const mountPanel = (mount) => {
    injectCss();
    const panel = buildPanel();
    if (mount.mode === 'after')
      mount.el.insertAdjacentElement('afterend', panel);
    else mount.el.appendChild(panel);
    if (activeRun) {
      // a remount mid-run must reflect the run, not reset to idle
      setRunningUi(true);
      setStatus(`Sorting… moved ${activeRun.moves}`);
    }
    console.log(
      `[YTSort] v${VERSION} ready (${detectAdapter() ? detectAdapter().name : 'no'} layout).`,
    ); // console only - not user-facing panel noise
    setTimeout(refreshPlaylistOverview, 500);
    maybeAutoSort(); // fire the URL-triggered auto-sort now that the panel + playlist are live
  };

  // Mount once on playlist pages, or arrange a retry when the header is not ready yet.
  const mountIfPlaylist = () => {
    try {
      if (!isPlaylistPage()) return;
      const existing = document.querySelector('.sort-playlist-wrapper');
      if (existing && existing.isConnected) return; // already mounted
      const mount = findMountPoint();
      if (!mount) {
        waitForMountPoint();
        return;
      }
      mountPanel(mount);
    } catch (e) {
      console.error('[YTSort] mount failed:', e);
    }
  };

  restoreLog(); // bring back this tab's earlier log (it survives the post-sort auto-refresh)
  hookNetwork();
  mountIfPlaylist();

  // Listen to both YouTube's route event and browser navigation so every SPA transition is covered.
  // A navigation away from the run's playlist also stops the active sort immediately
  // (the run's own per-iteration identity check is the backstop).
  // Stop work that belongs to the old playlist and remount after YouTube SPA navigation.
  const onNavigate = () => {
    if (activeRun && currentListId() !== activeRun.listId) activeRun.stop();
    mountIfPlaylist();
  };
  document.addEventListener('yt-navigate-finish', () =>
    setTimeout(onNavigate, 300),
  );
  if (
    window.navigation &&
    typeof window.navigation.addEventListener === 'function'
  ) {
    window.navigation.addEventListener('navigate', () =>
      setTimeout(onNavigate, 800),
    );
  }
  window.addEventListener('popstate', () => setTimeout(onNavigate, 800));
})();
