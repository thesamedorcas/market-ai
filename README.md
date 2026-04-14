# Market AI

> Financial data without the noise, real-time stock, crypto, and commodity analysis powered by a multi-agent AI pipeline.

The system regularly extracts and summarises public financial data and social sentiment, analyses future trends across stocks, Bitcoin, gold, and more, and presents everything through a clean streaming dashboard.

---

## What It Does

Search any asset — ticker symbol, crypto pair, commodity, or index — and get back:

- **Live price** with daily change and 52-week range
- **30-day price chart** rendered in the browser
- **Forward-looking AI analysis** — current situation, near-term outlook with bull/bear cases, and key catalysts to watch
- **Multi-source news and sentiment feed** (Yahoo Finance, Reddit, r/wallstreetbets, StockTwits, Twitter/X, TikTok)
- **Auto-refresh every 5 minutes** with a live countdown in the nav bar

All of this streams in real-time via Server-Sent Events so you see results as each agent finishes — no waiting for a single slow response.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router), React 19 |
| AI analysis | OpenAI GPT-4o-mini |
| AI fallback scraping | OpenClaw (powered by Anthropic Claude) |
| Market data | Stooq → CoinGecko (crypto) / Yahoo Finance v8 → OpenClaw (cascading fallback) |
| News & sentiment | Yahoo Finance RSS, Reddit JSON API, StockTwits (via OpenAI web search), OpenClaw |
| Caching | better-sqlite3 (local SQLite, 15-min TTL) |
| Charts | Recharts |
| Streaming | Server-Sent Events (SSE) |

---

## Multi-Agent Architecture

The `/api/multi-agent` route is the orchestrator. It coordinates four specialised agents that run in a structured sequence with internal parallelism:

```
User query
    │
    ▼
[1] Ticker Resolution Agent
    Converts "gold", "bitcoin", "Apple" → canonical ticker symbols
    (static alias map → Yahoo Finance autocomplete → uppercase fallback)
    │
    ├─────────────────────┐
    ▼                     ▼
[2] Market Data Agent    [3] News & Sentiment Agent   ← run in parallel
    Stooq                    Yahoo Finance RSS
    → CoinGecko (crypto)     Reddit (r/all + r/wallstreetbets)
    → Yahoo Finance v8       StockTwits (via GPT-4o-mini web search)
    → OpenClaw fallback      OpenClaw social sentinel (Twitter/X, TikTok)
    → Stale cache
    │                     │
    └─────────────────────┘
                │
                ▼
        [4] AI Analysis Agent
            GPT-4o-mini synthesises price action, technical position,
            and social signals into a 3-paragraph forward-looking report
                │
                ▼
        SSE stream → browser
```

Results are streamed as they arrive. `status` events give the UI live progress updates ("Resolving ticker…", "Fetching market data…"); the final `result` event carries the complete payload.

---

## AI Analysis

The AI Analysis Agent uses GPT-4o-mini with a structured prompt that produces a three-paragraph forward-looking report:

1. **Current Situation** — what's driving today's price and sentiment
2. **Near-Term Outlook (1–4 weeks)** — likely direction with a bull and bear case, referencing specific price levels
3. **Key Catalysts to Watch** — upcoming events, macro factors, or sentiment shifts that could change the thesis

The prompt is enriched with technical context computed from the market data:
- Distance from 52-week high and low (as percentages)
- 30-day price trend (start vs end price and direction)
- Sentiment labels from each social source

The model ends with a single-sentence directional verdict.

---

## Scheduled Data Refresh

### Server-side (cron)

`/api/cron/refresh` refreshes a hardcoded watchlist of 10 popular tickers in parallel:

```
BTC-USD  ETH-USD  GLD  SPY  QQQ  AAPL  TSLA  NVDA  MSFT  USO
```

On Vercel (free tier) this route runs once daily via `vercel.json`; the full 5-minute schedule runs in self-hosted environments:

```json
{
  "crons": [{ "path": "/api/cron/refresh", "schedule": "0 9 * * *" }]
}
```

Secure it with an optional `CRON_SECRET` environment variable — requests without a matching `x-cron-secret` header are rejected.

### Client-side (auto-refresh)

The asset dashboard also auto-refreshes every 5 minutes client-side via `setInterval`. A live countdown (`refreshes in 4:57`) is displayed in the nav bar so users can see when the next update will arrive.

---

## OpenClaw

[OpenClaw](https://openclaw.dev) is an AI-powered web-browsing agent backed by Anthropic Claude. Market AI uses it in two places:

### 1. Market data fallback

If Stooq, CoinGecko, and Yahoo Finance all fail (rate-limited, blocked, or the ticker is unusual), the Market Data Agent falls back to OpenClaw:

```
prompt: "Search the live web for the current price of {TICKER}.
         Return JSON: { symbol, shortName, regularMarketPrice, regularMarketChange,
                        regularMarketChangePercent, currency, fiftyTwoWeekHigh,
                        fiftyTwoWeekLow, historical }"
```

OpenClaw browses live financial sites, extracts the numbers, and returns structured JSON.

### 2. Social sentiment scraping

Direct Twitter/X and TikTok APIs are either paywalled or Cloudflare-protected. OpenClaw bypasses this by browsing them as a real user would:

```
prompt: "Search Twitter/X or TikTok for the latest 3 posts about {TICKER}.
         Return JSON array: [{ title, text, url, source, sentiment }]"
```

### How it's called

OpenClaw runs as a subprocess via `npx openclaw agent`:

```typescript
const { stdout } = await execAsync(
  `npx openclaw agent --local --json --message '${prompt}' --thinking low`,
  { timeout: 30_000, env: { OPENAI_API_KEY } }
);
// stdout is a JSON envelope; the agent's reply is in payloads[0].text
```

The 30-second timeout prevents the agent from blocking the rest of the pipeline. If it times out or errors, the system continues with whatever data it already has.

### Syncing API keys

OpenClaw needs both your OpenAI and Anthropic keys in its own config. Run this once after setting up `.env.local`:

```bash
node sync-key.js
```

This writes both keys to `~/.openclaw/agents/main/agent/auth-profiles.json`. Requires `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` in `.env.local`.

---

## Caching & Result Persistence

All external data is cached locally in a SQLite database (`cache.db`) managed by `src/lib/db.ts`.

### TTL

15 minutes. Requests within that window are served from cache with zero network calls.

### Cache keys

| Key pattern | What's stored |
|---|---|
| `market:{TICKER}` | Price, change, 52W range, 30-day history |
| `news:{TICKER}` | All social/news posts |
| `resolve:{INPUT}` | Resolved ticker (e.g. "gold" → "GLD") |

### Stale-on-error

If a fresh fetch fails (network error, rate limit, etc.) and a stale cache entry exists, the system serves the stale data rather than returning an error. The response is flagged `isStale: true` so the UI can surface a warning if needed.

### Schema

```sql
CREATE TABLE cache (
  key       TEXT PRIMARY KEY,
  data      TEXT NOT NULL,
  cached_at INTEGER NOT NULL
)
```

Expired entries are deleted automatically on startup.

---

## Search Accuracy & Edge Case Handling

### Ticker resolution

Natural-language queries go through a layered resolution process:

1. **Static alias map** — common names map directly:
   - `gold` → `GLD`, `silver` → `SLV`
   - `bitcoin` / `btc` → `BTC-USD`, `ethereum` / `eth` → `ETH-USD`
   - `oil` / `crude oil` → `USO`, `natural gas` → `UNG`
   - `s&p` / `s&p 500` / `sp500` → `SPY`, `nasdaq` → `QQQ`, `dow` → `DIA`
   - `apple` → `AAPL`, `google` → `GOOGL`, `nvidia` → `NVDA`, etc.
2. **Yahoo Finance autocomplete** — queries `https://query1.finance.yahoo.com/v1/finance/search` and uses the first returned symbol
3. **Uppercase passthrough** — if resolution fails, the raw input is uppercased and used as-is

Resolved symbols are cached for 15 minutes so repeated searches for the same asset don't re-query.

### Ticker format support

The pipeline handles the full range of Yahoo Finance symbol conventions:

| Format | Example | Asset type |
|---|---|---|
| Plain | `AAPL`, `TSLA` | US equities |
| Crypto pair | `BTC-USD`, `ETH-USD` | Cryptocurrency |
| Index | `^GSPC`, `^DJI` | Market indices |
| Futures | `GC=F` (gold), `CL=F` (oil) | Commodities |
| ETF | `GLD`, `SPY`, `USO` | Exchange-traded funds |
| International | `HSBA.L`, `SAP.DE`, `7203.T` | Non-US exchanges |

### Stooq compatibility check

Before hitting Stooq, a `stooqSupports()` guard filters out tickers it can't handle:
- Rejects crypto (contains `-`)
- Rejects indices (starts with `^`)
- Converts exchange suffixes to Stooq format: `.L` → `.uk`, `.DE` → `.de`, `=F` → `.f`, etc.

### Yahoo Finance rate limits

- Both `query1` and `query2` hosts are tried in sequence
- If a host returns 429, the system waits 1.5 s and retries the same host
- Each fetch has a 12-second `AbortSignal` timeout so a hung request doesn't block the pipeline

### Fallback chain (market data)

```
Cache (fresh, <15 min)
  └─ miss → Stooq (stocks only — fast, no auth)
               └─ fail/unsupported → CoinGecko (crypto only — free, no auth)
                                       └─ miss/fail → Yahoo Finance v8 (host 1 → host 2)
                                                         └─ fail → OpenClaw live scrape (Claude-powered)
                                                                     └─ fail → Stale cache
                                                                                 └─ miss → 500 error
```

For news, all four sources (Yahoo RSS, Reddit, StockTwits, OpenClaw) run concurrently and each can fail independently without affecting the others.

### Data validation

- JSON from external APIs is parsed inside try/catch; malformed responses fall back to empty arrays
- Sentiment labels are constrained to `Bullish | Bearish | Neutral` via prompt instructions
- Market prices are checked for `NaN`/`null` before being included in the response

---

## Project Structure

```
src/
├── app/
│   ├── page.tsx                    # Home search page
│   ├── asset/[ticker]/
│   │   ├── page.tsx                # Asset dashboard (SSE client, auto-refresh)
│   │   └── page.css
│   └── api/
│       ├── multi-agent/route.ts    # Orchestrator — SSE stream
│       ├── market-data/route.ts    # Market data + OpenClaw fallback
│       ├── news/route.ts           # News & sentiment aggregation
│       ├── analyze/route.ts        # Standalone AI analysis endpoint
│       └── cron/refresh/route.ts   # Scheduled watchlist refresh
└── lib/
    └── db.ts                       # SQLite cache layer

src/__tests__/                      # Jest test suite
vercel.json                         # Cron schedule (every 5 min)
sync-key.js                         # One-time OpenClaw auth setup
cache.db                            # SQLite cache (auto-created)
```

---

## Setup

```bash
# Install dependencies
npm install

# Configure environment
cp .env.local.example .env.local
# Add your API keys to .env.local:
# OPENAI_API_KEY=sk-...          (required — powers AI analysis)
# ANTHROPIC_API_KEY=sk-ant-...   (required — powers OpenClaw fallback scraping)
# Optional: CRON_SECRET=your-secret   (protects /api/cron/refresh)

# Sync keys to OpenClaw
node sync-key.js

# Run locally
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000) and search for any asset.

---

## Deployment

Deployed on **BytePlus Elastic Compute Service (ECS)** — Jakarta region.

- **Live URL:** http://market-ai.mooo.com
- **IP:** 163.7.8.209
- **Server:** Ubuntu 22.04, Node.js 20, served via nginx + PM2

---

## API Reference

### `GET /api/multi-agent?ticker=AAPL`

Server-Sent Events stream. Events:

| Event | Payload |
|---|---|
| `status` | `{ message: string }` |
| `result` | `{ marketData, social, summary, lastUpdated, resolvedTicker }` |
| `error` | `{ error: string }` |

### `GET /api/market-data?ticker=AAPL`

Returns cached or fresh market data JSON.

### `GET /api/news?ticker=AAPL&q=AAPL`

Returns aggregated news and social sentiment JSON: `{ social: [...], cachedAt }`.

### `GET /api/cron/refresh`

Refreshes the watchlist cache. Requires `x-cron-secret` header if `CRON_SECRET` is set.

### `POST /api/analyze`

Body: `{ ticker, marketData, socialData }`. Returns `{ summary }`.

---

## Assignment Context

Requirements met:

- **OpenClaw** — used as a web-scraping fallback for both market data and social sentiment (Twitter/X, TikTok), powered by Anthropic Claude
- **Claude API** — Anthropic `claude-haiku` via OpenClaw drives the last-resort web scraping agent
- **Non-Claude AI model** — OpenAI GPT-4o-mini powers the financial analysis and StockTwits web search
- **CoinGecko** — free crypto price API used as the primary source for all crypto pairs (BTC-USD, ETH-USD, etc.), bypassing Yahoo Finance rate limits
- **Multi-agent pipeline** — four specialised agents running concurrently with SSE streaming
- **Regular data extraction** — server-side cron refreshes a 10-ticker watchlist every 5 minutes; client-side auto-refresh keeps the dashboard live
- **Future trend analysis** — AI output is structured as a forward-looking report: current situation, 1–4 week outlook with bull/bear cases, and key catalysts
- **Social media coverage** — Reddit, r/wallstreetbets, StockTwits, Twitter/X, and TikTok
- **Engineering robustness** — cascading fallbacks, rate-limit handling, stale cache recovery, input normalisation, and timeout guards throughout

---

## Acknowledgements

Thank you to [afraid.org](https://freedns.afraid.org/) for providing the free domain name used to host this project. If this project has been useful to you, please consider supporting free software, it makes projects like this possible.
