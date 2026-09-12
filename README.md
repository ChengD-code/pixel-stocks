# Pixel Stocks

A simple **Apple Stocks–style** Progressive Web App: dark, minimal watchlist with prices, % change, sparklines, and a detail chart. Display-only — no login, no brokerage.

**Live (GitHub Pages):** https://chengd-code.github.io/pixel-stocks/

## Default watchlist

`TSLA`, `SPCX`, `AMZN`, `OPEN`, `SOFI`, `CLOV`

Add or remove symbols in the app; the list is stored in `localStorage`.

## Market data

| Item | Detail |
|------|--------|
| **Source** | [Yahoo Finance](https://finance.yahoo.com) unofficial chart API (`query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}`) |
| **CORS** | Browsers block direct Yahoo calls. Requests go through free public proxies tried in order: [AllOrigins](https://allorigins.win) (`api.allorigins.win/raw?url=…`), then [corsproxy.io](https://corsproxy.io) |
| **Cost / keys** | Free only — no paid APIs, no secrets |
| **Freshness** | Quotes are typically **delayed ~15 minutes**. The UI badge says **Delayed ~15m** — not live brokerage prices |
| **Rate limits** | Symbols are fetched **sequentially** with a short delay. On failure we keep the last good snapshot in `localStorage` and show a clear banner. If a ticker is invalid/delisted (e.g. some SPACs), that row may stay empty or warn |

**Caveat — SPCX:** This ticker may be thinly traded, renamed, or unavailable on Yahoo. If it fails, remove it and add a valid symbol.

This is **not** financial advice. Data can be wrong, delayed, or missing.

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

- `index.html` / `styles.css` / `app.js` — UI & logic  
- `manifest.json` + `sw.js` + `icons/` — PWA install & offline shell  
- Quotes/charts: Yahoo chart endpoint via CORS proxy (see `app.js`)

## License

Personal / demo use. Yahoo Finance terms apply to their data; proxies have their own limits.
