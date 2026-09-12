# Pixel Stocks

A simple **Apple Stocks–style** Progressive Web App: **light / white** watchlist with prices, % change, sparklines, and a detail chart. Display-only — no login, no brokerage.

**Live (GitHub Pages):** https://chengd-code.github.io/pixel-stocks/

## Default watchlist

`TSLA`, `SPCX`, `AMZN`, `OPEN`, `SOFI`, `CLOV`

Add or remove symbols in the app; the list is stored in `localStorage`.

## Market data

| Mode | When | Source | Freshness (honest) |
|------|------|--------|--------------------|
| **Primary** | User pastes a free Finnhub API key in **Settings (⚙)** | [Finnhub](https://finnhub.io) `GET /api/v1/quote` (and candles when allowed) | **Near real-time** for US stocks on the free plan — UI badge: **Near real-time (Finnhub)** |
| **Fallback** | No key, or Finnhub miss / candle blocked | [Yahoo Finance](https://finance.yahoo.com) unofficial chart API via free CORS proxies ([AllOrigins](https://allorigins.win), [corsproxy.io](https://corsproxy.io)) | **Best-effort / may be delayed** (~15m typical) — UI badge: **Yahoo (best-effort / may be delayed)** |

### Finnhub free key (recommended for fresher quotes)

1. Register at **https://finnhub.io/register** (free tier).
2. Copy your API key from the Finnhub dashboard.
3. Open the app → **⚙ Settings** → paste key → **Save** (or **Test** with AAPL first).
4. The key is stored **only in this browser’s `localStorage`**. It is never committed to the repo or uploaded to our servers.

**Limits (free tier):** ~60 API calls/minute. Quotes for US stocks are near real-time. **`/stock/candle` may be restricted on free** (Finnhub has treated candles as paid); if candles fail, charts automatically fall back to Yahoo history. Sequential fetches + short delays reduce rate-limit risk; clear errors on 429 / bad key.

**No paid APIs** are used or required.

### Caveats

- **SPCX** and other thin / niche tickers may be missing on Finnhub; the app falls back to Yahoo for that symbol when possible.
- CORS proxies for Yahoo can fail or rate-limit; last good snapshot is kept in `localStorage`.
- This is **not** financial advice. Data can be wrong, delayed, or missing. We never claim exchange “true real-time” unless the active source actually provides near real-time quotes (Finnhub free US quotes).

## Theme

Clean **light** UI (white / off-white background, dark text, green up / red down), Apple Stocks–inspired, minimal chrome. Detail chart uses light-friendly greens/reds and a subtle baseline.

## Run locally

No build step. From this folder:

```bash
# any static server (needed for service worker; file:// works for basic UI but SW/PWA install needs HTTP)
python3 -m http.server 8080
# then open http://localhost:8080
```

Or open `index.html` directly for a quick look (installability and SW require serving over HTTP/HTTPS).

## Install on Pixel / Android (Add to Home Screen)

1. Open the **HTTPS** Pages URL in **Chrome**.
2. Wait for the watchlist to load (so the service worker can register).
3. Tap the Chrome **⋮** menu → **Install app** or **Add to Home Screen** / **Install page as app**.
4. Confirm — Pixel Stocks opens fullscreen like a native app.
5. (Optional) Long-press the home icon → **App info** to uninstall later.

On desktop Chrome: address-bar install icon, or Menu → **Install Pixel Stocks…**.

## Files

- `index.html` / `styles.css` / `app.js` — UI & logic (Finnhub + Yahoo, Settings, light theme)
- `manifest.json` + `sw.js` + `icons/` — PWA install & offline shell

## License

Personal / demo use. Finnhub and Yahoo Finance terms apply to their data; proxies have their own limits.
