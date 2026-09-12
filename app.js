/**
 * Pixel Stocks — Apple Stocks–style PWA (light theme)
 * Primary: Finnhub free quote API when user pastes a key (localStorage only).
 * Fallback: Yahoo Finance chart API via CORS proxies (best-effort / may be delayed).
 */
(() => {
  'use strict';

  const DEFAULT_TICKERS = ['TSLA', 'SPCX', 'AMZN', 'OPEN', 'SOFI', 'CLOV'];
  const STORAGE_KEY = 'pixel-stocks-watchlist';
  const CACHE_KEY = 'pixel-stocks-quote-cache';
  const FINNHUB_KEY_STORAGE = 'pixel-stocks-finnhub-key';
  const CACHE_TTL_MS = 45_000;
  const REFRESH_MS_FINNHUB = 45_000;
  const REFRESH_MS_YAHOO = 90_000;

  const LABEL_FINNHUB = 'Near real-time (Finnhub)';
  const LABEL_YAHOO = 'Yahoo (best-effort / may be delayed)';

  const YAHOO_CHART = (symbol, range, interval) =>
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;

  const FINNHUB_QUOTE = (symbol, token) =>
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}`;

  const FINNHUB_CANDLE = (symbol, resolution, from, to, token) =>
    `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${encodeURIComponent(resolution)}&from=${from}&to=${to}&token=${encodeURIComponent(token)}`;

  const FINNHUB_PROFILE = (symbol, token) =>
    `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}`;

  const PROXIES = [
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  ];

  // —— State ——
  let watchlist = loadWatchlist();
  let quotes = {};
  let editing = false;
  let currentSymbol = null;
  let currentRange = { range: '1d', interval: '5m', fhRes: '5', fhSpan: '1d' };
  let refreshTimer = null;
  let dataSource = 'yahoo'; // 'finnhub' | 'yahoo'
  const profileCache = {};

  // —— DOM ——
  const $ = (id) => document.getElementById(id);
  const listEl = $('watchlist');
  const bannerEl = $('banner');
  const updatedEl = $('updated-at');
  const delayBadge = $('delay-badge');
  const listView = $('list-view');
  const detailView = $('detail-view');
  const overlay = $('add-overlay');
  const settingsOverlay = $('settings-overlay');
  const symbolInput = $('symbol-input');
  const chartCanvas = $('chart');
  const chartStatus = $('chart-status');
  const finnhubKeyInput = $('finnhub-key');
  const settingsStatus = $('settings-status');

  // —— Storage ——
  function loadWatchlist() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) {
          return [...new Set(arr.map((s) => String(s).toUpperCase().trim()).filter(Boolean))];
        }
      }
    } catch (_) { /* ignore */ }
    return [...DEFAULT_TICKERS];
  }

  function saveWatchlist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(watchlist));
  }

  function getFinnhubKey() {
    try {
      return (localStorage.getItem(FINNHUB_KEY_STORAGE) || '').trim();
    } catch (_) {
      return '';
    }
  }

  function setFinnhubKey(key) {
    const k = (key || '').trim();
    if (k) localStorage.setItem(FINNHUB_KEY_STORAGE, k);
    else localStorage.removeItem(FINNHUB_KEY_STORAGE);
  }

  function loadDiskCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function saveDiskCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
    } catch (_) { /* quota */ }
  }

  function updateSourceBadge() {
    const key = getFinnhubKey();
    dataSource = key ? 'finnhub' : 'yahoo';
    delayBadge.textContent = key ? LABEL_FINNHUB : LABEL_YAHOO;
    delayBadge.className = `badge ${key ? 'live' : 'delayed'}`;
    const footer = $('detail-footer');
    if (footer) {
      footer.textContent = key
        ? 'Quotes: Finnhub (near real-time for US stocks on free tier). Charts: Finnhub candles when available, else Yahoo. Not financial advice.'
        : 'Quotes & charts: Yahoo Finance via CORS proxy (best-effort / may be delayed). Add a free Finnhub key in Settings for fresher US quotes. Not financial advice.';
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    const ms = getFinnhubKey() ? REFRESH_MS_FINNHUB : REFRESH_MS_YAHOO;
    refreshTimer = setInterval(() => refreshQuotes(), ms);
  }

  // —— Networking ——
  async function fetchJsonDirect(url, { timeoutMs = 12000 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(t);
      if (res.status === 429) {
        const err = new Error('Rate limited (429). Wait a minute and try again.');
        err.code = 429;
        throw err;
      }
      if (res.status === 401 || res.status === 403) {
        const err = new Error('Finnhub key rejected or endpoint not on free plan.');
        err.code = res.status;
        throw err;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(t);
      throw e;
    }
  }

  let preferredProxyIdx = 0;

  async function fetchViaProxy(url, { timeoutMs = 8000 } = {}) {
    let lastErr;
    const order = [preferredProxyIdx, ...PROXIES.map((_, i) => i).filter((i) => i !== preferredProxyIdx)];
    for (const idx of order) {
      const make = PROXIES[idx];
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(make(url), {
          signal: ctrl.signal,
          headers: { Accept: 'application/json' },
        });
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!text || text.trim().startsWith('<')) {
          throw new Error('Proxy returned non-JSON');
        }
        preferredProxyIdx = idx;
        return JSON.parse(text);
      } catch (e) {
        clearTimeout(t);
        lastErr = e;
      }
    }
    throw lastErr || new Error('All proxies failed');
  }

  function parseChartPayload(json, symbol) {
    const result = json?.chart?.result?.[0];
    if (!result) {
      const err = json?.chart?.error?.description || 'No data';
      throw new Error(err);
    }
    const meta = result.meta || {};
    const quotesArr = result.indicators?.quote?.[0] || {};
    const closes = quotesArr.close || [];
    const timestamps = result.timestamp || [];
    const points = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c == null || Number.isNaN(c)) continue;
      points.push({ t: timestamps[i] * 1000, c });
    }

    const price = meta.regularMarketPrice ?? meta.postMarketPrice ?? meta.previousClose;
    const prev = meta.chartPreviousClose ?? meta.previousClose;
    let change = null;
    let changePct = null;
    if (price != null && prev != null && prev !== 0) {
      change = price - prev;
      changePct = (change / prev) * 100;
    }

    if ((changePct == null || Number.isNaN(changePct)) && points.length >= 2) {
      const a = points[points.length - 2].c;
      const b = points[points.length - 1].c;
      change = b - a;
      changePct = a ? (change / a) * 100 : 0;
    }

    return {
      symbol: (meta.symbol || symbol).toUpperCase(),
      name: meta.longName || meta.shortName || meta.symbol || symbol,
      price: price != null ? Number(price) : null,
      prevClose: prev != null ? Number(prev) : null,
      change: change != null ? Number(change) : null,
      changePct: changePct != null ? Number(changePct) : null,
      currency: meta.currency || 'USD',
      exchange: meta.exchangeName || meta.fullExchangeName || '',
      marketState: meta.marketState || '',
      points,
      open: meta.regularMarketOpen ?? null,
      high: meta.regularMarketDayHigh ?? null,
      low: meta.regularMarketDayLow ?? null,
      volume: meta.regularMarketVolume ?? null,
      fiftyTwoHigh: meta.fiftyTwoWeekHigh ?? null,
      fiftyTwoLow: meta.fiftyTwoWeekLow ?? null,
      source: 'yahoo',
      fetchedAt: Date.now(),
    };
  }

  function parseFinnhubQuote(json, symbol, name) {
    if (!json || typeof json.c !== 'number' || json.c === 0 && json.t === 0) {
      throw new Error('No quote data (invalid symbol or unsupported ticker)');
    }
    const price = Number(json.c);
    const prev = json.pc != null ? Number(json.pc) : null;
    const change = json.d != null ? Number(json.d) : (prev != null ? price - prev : null);
    const changePct = json.dp != null ? Number(json.dp) : (prev ? (change / prev) * 100 : null);
    return {
      symbol: String(symbol).toUpperCase(),
      name: name || symbol,
      price,
      prevClose: prev,
      change,
      changePct,
      currency: 'USD',
      exchange: '',
      marketState: '',
      points: [],
      open: json.o != null ? Number(json.o) : null,
      high: json.h != null ? Number(json.h) : null,
      low: json.l != null ? Number(json.l) : null,
      volume: null,
      fiftyTwoHigh: null,
      fiftyTwoLow: null,
      source: 'finnhub',
      fetchedAt: Date.now(),
    };
  }

  function parseFinnhubCandle(json, symbol) {
    if (!json || json.s === 'no_data') {
      throw new Error('No candle data');
    }
    if (json.s !== 'ok' || !Array.isArray(json.c) || !json.c.length) {
      throw new Error(json.error || 'Candle unavailable on free plan');
    }
    const points = [];
    for (let i = 0; i < json.c.length; i++) {
      const c = json.c[i];
      const t = json.t?.[i];
      if (c == null || t == null || Number.isNaN(c)) continue;
      points.push({ t: t * 1000, c: Number(c) });
    }
    if (!points.length) throw new Error('Empty candle series');
    return {
      symbol: String(symbol).toUpperCase(),
      points,
      source: 'finnhub',
      fetchedAt: Date.now(),
    };
  }

  function spanToUnixRange(span) {
    const to = Math.floor(Date.now() / 1000);
    const day = 86400;
    let from = to - 30 * day;
    switch (span) {
      case '1d': from = to - 1 * day; break;
      case '5d': from = to - 5 * day; break;
      case '1mo': from = to - 31 * day; break;
      case '3mo': from = to - 93 * day; break;
      case '1y': from = to - 365 * day; break;
      default: break;
    }
    return { from, to };
  }

  async function fetchFinnhubProfile(symbol, token) {
    if (profileCache[symbol]) return profileCache[symbol];
    try {
      const json = await fetchJsonDirect(FINNHUB_PROFILE(symbol, token), { timeoutMs: 8000 });
      const name = json?.name || json?.ticker || symbol;
      profileCache[symbol] = name;
      return name;
    } catch (_) {
      return symbol;
    }
  }

  async function fetchQuoteFinnhub(symbol) {
    const token = getFinnhubKey();
    if (!token) throw new Error('No Finnhub key');
    // Quote only — skip profile + candle here (they serial-blocked the list and candles are often paid).
    const json = await fetchJsonDirect(FINNHUB_QUOTE(symbol, token), { timeoutMs: 8000 });
    const name = profileCache[symbol] || symbol;
    const q = parseFinnhubQuote(json, symbol, name);
    // Resolve display name in background (non-blocking)
    if (!profileCache[symbol]) {
      fetchFinnhubProfile(symbol, token).then((n) => {
        if (n && quotes[symbol]) {
          quotes[symbol] = { ...quotes[symbol], name: n };
          renderList();
        }
      }).catch(() => {});
    }
    return q;
  }

  async function fetchQuoteYahoo(symbol, range = '1d', interval = '5m') {
    const url = YAHOO_CHART(symbol, range, interval);
    const json = await fetchViaProxy(url);
    return parseChartPayload(json, symbol);
  }

  async function fetchQuote(symbol) {
    const token = getFinnhubKey();
    if (token) {
      try {
        return await fetchQuoteFinnhub(symbol);
      } catch (e) {
        if (e.code === 429) throw e;
        // Fall back to Yahoo for this symbol (e.g. SPCX missing on Finnhub)
        console.warn('Finnhub quote failed, trying Yahoo', symbol, e);
        try {
          const q = await fetchQuoteYahoo(symbol);
          q.note = `Finnhub miss → Yahoo: ${e.message}`;
          return q;
        } catch (e2) {
          throw e; // prefer original Finnhub error message
        }
      }
    }
    return fetchQuoteYahoo(symbol);
  }

  async function fetchChart(symbol, rangeCfg) {
    const token = getFinnhubKey();
    if (token) {
      try {
        const { from, to } = spanToUnixRange(rangeCfg.fhSpan || '1mo');
        const res = rangeCfg.fhRes || 'D';
        const json = await fetchJsonDirect(FINNHUB_CANDLE(symbol, res, from, to, token));
        const candle = parseFinnhubCandle(json, symbol);
        // Merge with latest quote stats if we have them
        const base = quotes[symbol] ? { ...quotes[symbol] } : { symbol };
        return { ...base, points: candle.points, source: 'finnhub', fetchedAt: Date.now() };
      } catch (e) {
        console.warn('Finnhub candle failed, Yahoo chart fallback', e);
      }
    }
    const url = YAHOO_CHART(symbol, rangeCfg.range, rangeCfg.interval);
    const json = await fetchViaProxy(url);
    return parseChartPayload(json, symbol);
  }

  // —— Formatting ——
  function fmtPrice(n) {
    if (n == null || Number.isNaN(n)) return '—';
    const abs = Math.abs(n);
    const digits = abs >= 1000 ? 2 : abs >= 1 ? 2 : 4;
    return n.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: digits,
    });
  }

  function fmtPct(n) {
    if (n == null || Number.isNaN(n)) return '—';
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(2)}%`;
  }

  function fmtChange(n) {
    if (n == null || Number.isNaN(n)) return '—';
    const sign = n > 0 ? '+' : '';
    return `${sign}${fmtPrice(n)}`;
  }

  function dirClass(pct) {
    if (pct == null || Number.isNaN(pct) || Math.abs(pct) < 0.0005) return 'flat';
    return pct > 0 ? 'up' : 'down';
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 10) return 'Just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  // —— Sparkline ——
  function drawSparkline(canvas, points, up) {
    if (!canvas || !points?.length) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 72;
    const h = canvas.clientHeight || 36;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const vals = points.map((p) => p.c);
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const pad = 2;
    const color = up ? '#34c759' : '#ff3b30';

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    vals.forEach((v, i) => {
      const x = pad + (i / (vals.length - 1 || 1)) * (w - pad * 2);
      const y = pad + (1 - (v - min) / (max - min)) * (h - pad * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // —— Main chart (light background) ——
  function drawChart(points, up) {
    const canvas = chartCanvas;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    if (!points?.length) {
      chartStatus.textContent = 'No chart data';
      chartStatus.className = 'chart-error';
      chartStatus.style.display = 'flex';
      return;
    }

    chartStatus.style.display = 'none';
    const vals = points.map((p) => p.c);
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    const padY = (max - min) * 0.08 || 1;
    min -= padY;
    max += padY;
    const left = 8;
    const right = 8;
    const top = 12;
    const bottom = 20;
    const color = up ? '#34c759' : '#ff3b30';
    const fill = up ? 'rgba(52,199,89,0.14)' : 'rgba(255,59,48,0.12)';

    const base = vals[0];
    const baseY = top + (1 - (base - min) / (max - min)) * (h - top - bottom);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#d1d1d6';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, baseY);
    ctx.lineTo(w - right, baseY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    vals.forEach((v, i) => {
      const x = left + (i / (vals.length - 1 || 1)) * (w - left - right);
      const y = top + (1 - (v - min) / (max - min)) * (h - top - bottom);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    const lastX = left + (w - left - right);
    ctx.lineTo(lastX, h - bottom);
    ctx.lineTo(left, h - bottom);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    vals.forEach((v, i) => {
      const x = left + (i / (vals.length - 1 || 1)) * (w - left - right);
      const y = top + (1 - (v - min) / (max - min)) * (h - top - bottom);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    const last = vals[vals.length - 1];
    const lx = left + (w - left - right);
    const ly = top + (1 - (last - min) / (max - min)) * (h - top - bottom);
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // —— UI: banner ——
  function showBanner(msg, type = 'info') {
    if (!msg) {
      bannerEl.className = 'banner';
      bannerEl.textContent = '';
      return;
    }
    bannerEl.textContent = msg;
    bannerEl.className = `banner visible ${type}`;
  }

  // —— UI: watchlist ——
  function renderList() {
    listEl.classList.toggle('edit-mode', editing);
    if (!watchlist.length) {
      listEl.innerHTML = `<li class="empty-state">No symbols yet. Tap + to add a ticker.</li>`;
      return;
    }

    listEl.innerHTML = watchlist
      .map((sym) => {
        const q = quotes[sym];
        const loading = !q;
        const dir = dirClass(q?.changePct);
        const name = q?.name && q.name !== sym ? q.name : '';
        return `
        <li class="watchlist-item ${loading ? 'skeleton' : ''}" data-symbol="${sym}" role="button" tabindex="0">
          <button type="button" class="delete-x" data-remove="${sym}" aria-label="Remove ${sym}">×</button>
          <div class="symbol-block">
            <div class="symbol">${sym}</div>
            <div class="symbol-name">${name || (loading ? 'Loading' : '—')}</div>
          </div>
          <canvas class="sparkline" data-spark="${sym}" width="72" height="36" aria-hidden="true"></canvas>
          <div class="price-block">
            <div class="price">${loading ? '0.00' : fmtPrice(q.price)}</div>
            <div class="change ${dir}">${loading ? '0.00%' : fmtPct(q.changePct)}</div>
          </div>
        </li>`;
      })
      .join('');

    watchlist.forEach((sym) => {
      const q = quotes[sym];
      if (!q?.points?.length) return;
      const canvas = listEl.querySelector(`canvas[data-spark="${sym}"]`);
      if (canvas) drawSparkline(canvas, q.points.slice(-40), dirClass(q.changePct) !== 'down');
    });
  }

  function renderDetailHero(q) {
    $('d-symbol').textContent = q?.symbol || currentSymbol || '—';
    $('d-name').textContent = q?.name && q.name !== q.symbol ? q.name : (q?.exchange || '');
    $('d-price').textContent = fmtPrice(q?.price);
    const ch = $('d-change');
    ch.className = `detail-change ${dirClass(q?.changePct)}`;
    ch.textContent =
      q?.changePct == null
        ? '—'
        : `${fmtChange(q.change)} (${fmtPct(q.changePct)})`;

    const stats = [];
    if (q?.open != null) stats.push(['Open', fmtPrice(q.open)]);
    if (q?.high != null) stats.push(['Day High', fmtPrice(q.high)]);
    if (q?.low != null) stats.push(['Day Low', fmtPrice(q.low)]);
    if (q?.prevClose != null) stats.push(['Prev Close', fmtPrice(q.prevClose)]);
    if (q?.volume != null) stats.push(['Volume', Number(q.volume).toLocaleString('en-US')]);
    if (q?.fiftyTwoHigh != null) stats.push(['52W High', fmtPrice(q.fiftyTwoHigh)]);
    if (q?.fiftyTwoLow != null) stats.push(['52W Low', fmtPrice(q.fiftyTwoLow)]);
    $('detail-stats').innerHTML = stats
      .map(
        ([l, v]) =>
          `<div class="stat-row"><span class="stat-label">${l}</span><span class="stat-value">${v}</span></div>`
      )
      .join('');
  }

  // —— Data refresh ——
  async function refreshQuotes({ force = false } = {}) {
    if (!watchlist.length) {
      renderList();
      return;
    }

    updateSourceBadge();

    const disk = loadDiskCache();
    if (disk?.data) {
      Object.assign(quotes, disk.data);
      renderList();
      updatedEl.textContent = `Cached ${timeAgo(disk.at)}`;
      if (!force && Date.now() - (disk.at || 0) < CACHE_TTL_MS) {
        // still refresh in background
      }
    }

    showBanner('');
    updatedEl.textContent = 'Updating…';
    const failed = [];
    const yahooFallback = [];
    const next = { ...quotes };
    const token = getFinnhubKey();
    // Parallel quotes (was serial + sleep — main lag). Modest concurrency for proxies / Finnhub free tier.
    const concurrency = token ? 4 : 3;
    let rateLimited = false;

    async function mapPool(items, limit, fn) {
      let i = 0;
      const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length && !rateLimited) {
          const idx = i++;
          await fn(items[idx], idx);
        }
      });
      await Promise.all(workers);
    }

    await mapPool(watchlist, concurrency, async (sym) => {
      if (rateLimited) return;
      try {
        const q = await fetchQuote(sym);
        next[sym] = q;
        quotes = { ...next };
        renderList();
        if (token && q.source === 'yahoo') yahooFallback.push(sym);
      } catch (e) {
        failed.push(sym);
        console.warn('quote failed', sym, e);
        if (e.code === 429) {
          rateLimited = true;
          showBanner(e.message, 'error');
        }
      }
    });

    quotes = next;
    saveDiskCache(quotes);
    renderList();
    updateSourceBadge();

    const latest = Math.max(0, ...Object.values(quotes).map((q) => q.fetchedAt || 0));
    updatedEl.textContent = latest ? `Updated ${timeAgo(latest)}` : 'Update failed';

    if (failed.length === watchlist.length) {
      showBanner(
        token
          ? 'Could not reach Finnhub (rate limit, bad key, or network). Cached prices shown if available.'
          : 'Could not reach market data (CORS proxy or Yahoo rate limit). Showing cached prices if available. Try again in a minute.',
        'error'
      );
    } else if (failed.length) {
      showBanner(
        `No data for: ${failed.join(', ')}. Symbol may be invalid, delisted, or unsupported on the current source.`,
        'warn'
      );
    } else if (yahooFallback.length) {
      showBanner(
        `Finnhub had no quote for ${yahooFallback.join(', ')}; used Yahoo (may be delayed) for those.`,
        'info'
      );
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function loadDetailChart() {
    if (!currentSymbol) return;
    chartStatus.style.display = 'flex';
    chartStatus.className = 'chart-loading';
    chartStatus.textContent = 'Loading chart…';

    try {
      const q = await fetchChart(currentSymbol, currentRange);
      quotes[currentSymbol] = { ...quotes[currentSymbol], ...q, points: q.points };
      renderDetailHero(quotes[currentSymbol]);
      const up = dirClass(q.changePct) !== 'down';
      const seriesUp =
        q.points.length >= 2 ? q.points[q.points.length - 1].c >= q.points[0].c : up;
      drawChart(q.points, seriesUp);
    } catch (e) {
      console.warn(e);
      chartStatus.className = 'chart-error';
      chartStatus.textContent = e.message || 'Chart unavailable';
      chartStatus.style.display = 'flex';
      const cached = quotes[currentSymbol];
      if (cached?.points?.length) {
        drawChart(cached.points, dirClass(cached.changePct) !== 'down');
      }
    }
  }

  // —— Navigation ——
  function showList() {
    currentSymbol = null;
    detailView.classList.remove('active');
    listView.classList.add('active');
  }

  function showDetail(symbol) {
    currentSymbol = symbol;
    listView.classList.remove('active');
    detailView.classList.add('active');
    renderDetailHero(quotes[symbol] || { symbol });
    loadDetailChart();
  }

  // —— Events ——
  listEl.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      e.stopPropagation();
      removeSymbol(rm.getAttribute('data-remove'));
      return;
    }
    const row = e.target.closest('.watchlist-item');
    if (!row || editing) return;
    showDetail(row.getAttribute('data-symbol'));
  });

  listEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.watchlist-item');
    if (!row || editing) return;
    e.preventDefault();
    showDetail(row.getAttribute('data-symbol'));
  });

  $('back-btn').addEventListener('click', showList);

  $('remove-btn').addEventListener('click', () => {
    if (currentSymbol) {
      removeSymbol(currentSymbol);
      showList();
    }
  });

  $('edit-btn').addEventListener('click', () => {
    editing = !editing;
    $('edit-btn').textContent = editing ? 'Done' : 'Edit';
    renderList();
  });

  $('add-btn').addEventListener('click', () => {
    overlay.classList.add('open');
    symbolInput.value = '';
    setTimeout(() => symbolInput.focus(), 100);
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('open');
  });

  $('settings-btn').addEventListener('click', () => {
    finnhubKeyInput.value = getFinnhubKey();
    settingsStatus.textContent = getFinnhubKey()
      ? 'Key saved in this browser (localStorage).'
      : 'No key — using Yahoo fallback.';
    settingsStatus.className = 'sheet-status';
    settingsOverlay.classList.add('open');
    setTimeout(() => finnhubKeyInput.focus(), 100);
  });

  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) settingsOverlay.classList.remove('open');
  });

  $('save-key-btn').addEventListener('click', () => {
    const key = finnhubKeyInput.value.trim();
    setFinnhubKey(key);
    updateSourceBadge();
    scheduleRefresh();
    settingsStatus.textContent = key
      ? 'Saved. Refreshing with Finnhub…'
      : 'Cleared. Using Yahoo fallback.';
    settingsStatus.className = 'sheet-status ok';
    settingsOverlay.classList.remove('open');
    refreshQuotes({ force: true });
  });

  $('clear-key-btn').addEventListener('click', () => {
    finnhubKeyInput.value = '';
    setFinnhubKey('');
    updateSourceBadge();
    scheduleRefresh();
    settingsStatus.textContent = 'Key cleared. Using Yahoo (may be delayed).';
    settingsStatus.className = 'sheet-status';
    refreshQuotes({ force: true });
  });

  $('test-key-btn').addEventListener('click', async () => {
    const key = finnhubKeyInput.value.trim() || getFinnhubKey();
    if (!key) {
      settingsStatus.textContent = 'Paste a key first.';
      settingsStatus.className = 'sheet-status err';
      return;
    }
    settingsStatus.textContent = 'Testing…';
    settingsStatus.className = 'sheet-status';
    try {
      const json = await fetchJsonDirect(FINNHUB_QUOTE('AAPL', key), { timeoutMs: 10000 });
      if (typeof json.c !== 'number') throw new Error('Unexpected response');
      settingsStatus.textContent = `OK — AAPL ≈ ${fmtPrice(json.c)} (near real-time on free US quotes).`;
      settingsStatus.className = 'sheet-status ok';
    } catch (e) {
      settingsStatus.textContent = e.message || 'Test failed';
      settingsStatus.className = 'sheet-status err';
    }
  });

  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const sym = symbolInput.value.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '');
    if (!sym) return;
    if (watchlist.includes(sym)) {
      overlay.classList.remove('open');
      showDetail(sym);
      return;
    }
    const btn = $('add-submit');
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const q = await fetchQuote(sym);
      watchlist.push(sym);
      saveWatchlist();
      quotes[sym] = q;
      saveDiskCache(quotes);
      overlay.classList.remove('open');
      renderList();
      showBanner('');
    } catch (err) {
      showBanner(`Could not add ${sym}: ${err.message || 'not found / rate limited'}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Add';
    }
  });

  $('range-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.range-tab');
    if (!tab) return;
    $('range-tabs').querySelectorAll('.range-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    currentRange = {
      range: tab.dataset.range,
      interval: tab.dataset.interval,
      fhRes: tab.dataset.fhRes,
      fhSpan: tab.dataset.fhSpan,
    };
    loadDetailChart();
  });

  function removeSymbol(sym) {
    watchlist = watchlist.filter((s) => s !== sym);
    delete quotes[sym];
    saveWatchlist();
    saveDiskCache(quotes);
    renderList();
  }

  // —— PWA ——
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW failed', e));
    });
  }

  // —— Boot ——
  updateSourceBadge();
  renderList();
  refreshQuotes({ force: true });
  scheduleRefresh();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshQuotes();
  });
})();
