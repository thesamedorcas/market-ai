import { NextRequest, NextResponse } from "next/server";
import { getCached, getStale, setCached } from "@/lib/db";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const YF_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Map Yahoo Finance exchange suffixes → Stooq exchange codes
const EXCHANGE_MAP: Record<string, string> = {
  "=F": ".f",    // Futures (CL=F → cl.f, GC=F → gc.f)
  ".L":  ".uk",  // London Stock Exchange
  ".DE": ".de",  // Frankfurt / XETRA
  ".PA": ".fr",  // Paris (Euronext)
  ".AS": ".nl",  // Amsterdam
  ".T":  ".jp",  // Tokyo
  ".TO": ".ca",  // Toronto
  ".AX": ".au",  // ASX
  ".HK": ".hk",  // Hong Kong
};

function toStooqSymbol(ticker: string): string {
  const upper = ticker.toUpperCase();
  for (const [yahooSuffix, stooqExchange] of Object.entries(EXCHANGE_MAP)) {
    if (upper.endsWith(yahooSuffix)) {
      return ticker.slice(0, -yahooSuffix.length).toLowerCase() + stooqExchange;
    }
  }
  return `${ticker.toLowerCase()}.us`;
}

// Stooq can't handle crypto (BTC-USD), indices (^GSPC), or anything non-standard
function stooqSupports(ticker: string): boolean {
  const upper = ticker.toUpperCase();
  if (upper.includes("-")) return false; // crypto like BTC-USD
  if (upper.startsWith("^")) return false; // indices
  return true;
}

// ─── Stooq: free EOD CSV, no API key ──────────────────────────────────────────
async function fetchStooq(ticker: string) {
  const symbol = toStooqSymbol(ticker);
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Stooq HTTP ${res.status}`);

  const csv = await res.text();
  if (!csv || csv.toLowerCase().includes("no data")) {
    throw new Error(`No data for ticker "${ticker}"`);
  }

  const lines = csv.trim().split("\n").slice(1);
  const rows = lines
    .map((line) => {
      const [date, , , , close] = line.split(",");
      return { date: date?.trim(), close: parseFloat(close) };
    })
    .filter((r) => r.date && !isNaN(r.close))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (rows.length === 0) throw new Error(`No valid rows for "${ticker}"`);

  const historical = rows.slice(-30);
  const latest = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const currentPrice = latest.close;
  const prevClose = prev?.close ?? currentPrice;
  const change = currentPrice - prevClose;
  const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
  const yearRows = rows.slice(-252);
  const closes = yearRows.map((r) => r.close);

  return {
    symbol: ticker.toUpperCase(),
    shortName: ticker.toUpperCase(),
    regularMarketPrice: currentPrice,
    regularMarketChange: change,
    regularMarketChangePercent: changePct,
    currency: "USD",
    marketCap: null,
    fiftyTwoWeekHigh: Math.max(...closes),
    fiftyTwoWeekLow: Math.min(...closes),
    historical,
  };
}

// Yahoo Finance v8 chart API 
async function fetchYahooChart(ticker: string) {
  const path = `/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=6mo`;
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

  let res: Response | undefined;
  for (const host of hosts) {
    res = await fetch(`https://${host}${path}`, {
      headers: { "User-Agent": YF_UA, "Accept": "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500));
      res = await fetch(`https://${host}${path}`, {
        headers: { "User-Agent": YF_UA, "Accept": "application/json" },
        signal: AbortSignal.timeout(12000),
      });
    }
    if (res.ok) break;
  }

  if (!res || !res.ok) throw new Error(`Yahoo Finance HTTP ${res?.status} for "${ticker}"`);

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`No Yahoo Finance data for "${ticker}"`);

  const meta = result.meta;
  const timestamps: number[] = result.timestamp || [];
  const closes: number[] = result.indicators?.quote?.[0]?.close || [];

  const allRows = timestamps
    .map((ts: number, i: number) => ({
      date: new Date(ts * 1000).toISOString().split("T")[0],
      close: closes[i],
    }))
    .filter((r) => r.date && r.close != null);

  if (allRows.length === 0) throw new Error(`No chart rows for "${ticker}"`);

  const historical = allRows.slice(-30);
  const latest = allRows[allRows.length - 1];
  const prev = allRows[allRows.length - 2];
  const currentPrice = latest.close;
  const prevClose = prev?.close ?? (meta.chartPreviousClose as number) ?? currentPrice;
  const change = currentPrice - prevClose;
  const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
  const yearRows = allRows.slice(-252);
  const yearCloses = yearRows.map((r) => r.close);

  return {
    symbol: (meta.symbol as string) ?? ticker.toUpperCase(),
    shortName: (meta.shortName as string) || (meta.symbol as string) || ticker.toUpperCase(),
    regularMarketPrice: currentPrice,
    regularMarketChange: change,
    regularMarketChangePercent: changePct,
    currency: (meta.currency as string) || "USD",
    marketCap: null,
    fiftyTwoWeekHigh: Math.max(...yearCloses),
    fiftyTwoWeekLow: Math.min(...yearCloses),
    historical,
  };
}

// CoinGecko ID map for common crypto symbols
const COINGECKO_IDS: Record<string, string> = {
  "BTC-USD": "bitcoin", "ETH-USD": "ethereum", "SOL-USD": "solana",
  "DOGE-USD": "dogecoin", "XRP-USD": "ripple", "ADA-USD": "cardano",
  "AVAX-USD": "avalanche-2", "MATIC-USD": "matic-network", "DOT-USD": "polkadot",
  "LINK-USD": "chainlink", "LTC-USD": "litecoin", "BNB-USD": "binancecoin",
  "UNI-USD": "uniswap", "ATOM-USD": "cosmos", "SHIB-USD": "shiba-inu",
};

function isCrypto(ticker: string): boolean {
  return ticker.toUpperCase().endsWith("-USD") && ticker.toUpperCase() in COINGECKO_IDS;
}

// CoinGecko: free, no API key needed
async function fetchCoinGecko(ticker: string) {
  const id = COINGECKO_IDS[ticker.toUpperCase()];
  if (!id) throw new Error(`No CoinGecko ID for "${ticker}"`);

  const [marketRes, histRes] = await Promise.all([
    fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${id}`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10000),
    }),
    fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=30&interval=daily`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10000),
    }),
  ]);

  if (!marketRes.ok) throw new Error(`CoinGecko HTTP ${marketRes.status}`);
  const marketJson = await marketRes.json();
  const coin = marketJson[0];
  if (!coin) throw new Error(`No CoinGecko data for "${ticker}"`);

  let historical: { date: string; close: number }[] = [];
  if (histRes.ok) {
    const histJson = await histRes.json();
    historical = (histJson.prices || []).slice(-30).map(([ts, price]: [number, number]) => ({
      date: new Date(ts).toISOString().split("T")[0],
      close: price,
    }));
  }

  return {
    symbol: ticker.toUpperCase(),
    shortName: coin.name,
    regularMarketPrice: coin.current_price,
    regularMarketChange: coin.price_change_24h,
    regularMarketChangePercent: coin.price_change_percentage_24h,
    currency: "USD",
    marketCap: coin.market_cap,
    fiftyTwoWeekHigh: coin.ath ?? coin.high_24h,
    fiftyTwoWeekLow: coin.atl ?? coin.low_24h,
    historical,
  };
}

// CoinCap — cloud-IP friendly, no key, no aggressive rate limits
const COINCAP_IDS: Record<string, string> = {
  "BTC-USD": "bitcoin", "ETH-USD": "ethereum", "SOL-USD": "solana",
  "DOGE-USD": "dogecoin", "XRP-USD": "ripple", "ADA-USD": "cardano",
  "AVAX-USD": "avalanche", "MATIC-USD": "polygon", "DOT-USD": "polkadot",
  "LINK-USD": "chainlink", "LTC-USD": "litecoin", "BNB-USD": "binance-coin",
  "UNI-USD": "uniswap", "ATOM-USD": "cosmos", "SHIB-USD": "shiba-inu",
};

async function fetchCoinCap(ticker: string) {
  const id = COINCAP_IDS[ticker.toUpperCase()];
  if (!id) throw new Error(`No CoinCap ID for "${ticker}"`);

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const [assetRes, histRes] = await Promise.all([
    fetch(`https://api.coincap.io/v2/assets/${id}`, { signal: AbortSignal.timeout(10000) }),
    fetch(`https://api.coincap.io/v2/assets/${id}/history?interval=d1&start=${thirtyDaysAgo}&end=${Date.now()}`, {
      signal: AbortSignal.timeout(10000),
    }),
  ]);

  if (!assetRes.ok) throw new Error(`CoinCap HTTP ${assetRes.status}`);
  const { data: coin } = await assetRes.json();
  if (!coin) throw new Error(`No CoinCap data for "${ticker}"`);

  const currentPrice = parseFloat(coin.priceUsd);
  const changePct = parseFloat(coin.changePercent24Hr);
  const change = currentPrice * (changePct / 100);

  let historical: { date: string; close: number }[] = [];
  if (histRes.ok) {
    const { data: hist } = await histRes.json();
    historical = (hist || []).slice(-30).map((h: any) => ({
      date: new Date(h.time).toISOString().split("T")[0],
      close: parseFloat(h.priceUsd),
    }));
  }

  const closes = historical.map((r) => r.close);
  return {
    symbol: ticker.toUpperCase(),
    shortName: coin.name,
    regularMarketPrice: currentPrice,
    regularMarketChange: change,
    regularMarketChangePercent: changePct,
    currency: "USD",
    marketCap: parseFloat(coin.marketCapUsd) || null,
    fiftyTwoWeekHigh: closes.length ? Math.max(...closes) : currentPrice,
    fiftyTwoWeekLow: closes.length ? Math.min(...closes) : currentPrice,
    historical,
  };
}

// Yahoo Finance v7 quote — different endpoint, separate rate-limit bucket from v8
async function fetchYahooQuote(ticker: string) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": YF_UA, "Accept": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Yahoo v7 HTTP ${res.status} for "${ticker}"`);

  const json = await res.json();
  const quote = json?.quoteResponse?.result?.[0];
  if (!quote) throw new Error(`No Yahoo v7 data for "${ticker}"`);

  return {
    symbol: (quote.symbol as string) ?? ticker.toUpperCase(),
    shortName: (quote.shortName as string) || (quote.longName as string) || ticker.toUpperCase(),
    regularMarketPrice: quote.regularMarketPrice as number,
    regularMarketChange: quote.regularMarketChange as number,
    regularMarketChangePercent: quote.regularMarketChangePercent as number,
    currency: (quote.currency as string) || "USD",
    marketCap: (quote.marketCap as number) || null,
    fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh as number,
    fiftyTwoWeekLow: quote.fiftyTwoWeekLow as number,
    historical: [],
  };
}

// Binance public API — no key, generous rate limits, crypto only
function toBinanceSymbol(ticker: string): string | null {
  const upper = ticker.toUpperCase();
  if (!upper.endsWith("-USD")) return null;
  return upper.replace(/-USD$/, "USDT");
}

async function fetchBinance(ticker: string) {
  const symbol = toBinanceSymbol(ticker);
  if (!symbol) throw new Error(`No Binance symbol for "${ticker}"`);

  const [tickerRes, klinesRes] = await Promise.all([
    fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`, {
      signal: AbortSignal.timeout(10000),
    }),
    fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=31`, {
      signal: AbortSignal.timeout(10000),
    }),
  ]);

  if (!tickerRes.ok) throw new Error(`Binance HTTP ${tickerRes.status}`);
  const tickerData = await tickerRes.json();

  const currentPrice = parseFloat(tickerData.lastPrice);
  const change = parseFloat(tickerData.priceChange);
  const changePct = parseFloat(tickerData.priceChangePercent);

  let historical: { date: string; close: number }[] = [];
  let fiftyTwoWeekHigh = parseFloat(tickerData.highPrice);
  let fiftyTwoWeekLow = parseFloat(tickerData.lowPrice);

  if (klinesRes.ok) {
    const klines = await klinesRes.json();
    historical = klines.slice(0, -1).map((k: any[]) => ({
      date: new Date(k[0]).toISOString().split("T")[0],
      close: parseFloat(k[4]),
    }));
    const closes = historical.map((r) => r.close);
    if (closes.length > 0) {
      fiftyTwoWeekHigh = Math.max(...closes);
      fiftyTwoWeekLow = Math.min(...closes);
    }
  }

  return {
    symbol: ticker.toUpperCase(),
    shortName: ticker.toUpperCase(),
    regularMarketPrice: currentPrice,
    regularMarketChange: change,
    regularMarketChangePercent: changePct,
    currency: "USD",
    marketCap: null,
    fiftyTwoWeekHigh,
    fiftyTwoWeekLow,
    historical,
  };
}

// Twelve Data — optional fallback (set TWELVE_DATA_API_KEY env var to enable)
// NOTE: free tier is 800 calls/day — results are cached for 30 min to protect that limit
const TD_TTL_MS = 30 * 60 * 1000;

async function fetchTwelveData(ticker: string) {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) throw new Error("TWELVE_DATA_API_KEY not set");

  // 30-min cache specifically for Twelve Data to protect API quota
  const tdKey = `td:market:${ticker.toUpperCase()}`;
  const cached = getCached(tdKey, TD_TTL_MS);
  if (cached) {
    console.log(`Twelve Data 30-min cache hit for "${ticker}"`);
    return cached.data;
  }

  const base = "https://api.twelvedata.com";
  const sym = encodeURIComponent(ticker);

  const [quoteRes, tsRes] = await Promise.all([
    fetch(`${base}/quote?symbol=${sym}&apikey=${apiKey}`, { signal: AbortSignal.timeout(10000) }),
    fetch(`${base}/time_series?symbol=${sym}&interval=1day&outputsize=30&apikey=${apiKey}`, {
      signal: AbortSignal.timeout(10000),
    }),
  ]);

  if (!quoteRes.ok) throw new Error(`Twelve Data HTTP ${quoteRes.status}`);
  const quote = await quoteRes.json();
  if (quote.status === "error") throw new Error(`Twelve Data: ${quote.message}`);

  const currentPrice = parseFloat(quote.close);
  const prevClose = parseFloat(quote.previous_close);
  const change = parseFloat(quote.change);
  const changePct = parseFloat(quote.percent_change);

  let historical: { date: string; close: number }[] = [];
  if (tsRes.ok) {
    const ts = await tsRes.json();
    if (ts.status !== "error" && Array.isArray(ts.values)) {
      historical = ts.values
        .map((v: any) => ({ date: v.datetime, close: parseFloat(v.close) }))
        .filter((r: any) => !isNaN(r.close))
        .reverse(); // Twelve Data returns newest-first
    }
  }

  const closes = historical.map((r) => r.close);
  const result = {
    symbol: (quote.symbol as string) ?? ticker.toUpperCase(),
    shortName: (quote.name as string) || ticker.toUpperCase(),
    regularMarketPrice: currentPrice,
    regularMarketChange: change,
    regularMarketChangePercent: changePct,
    currency: (quote.currency as string) || "USD",
    marketCap: null,
    fiftyTwoWeekHigh: parseFloat(quote.fifty_two_week?.high) || (closes.length ? Math.max(...closes) : currentPrice),
    fiftyTwoWeekLow: parseFloat(quote.fifty_two_week?.low) || (closes.length ? Math.min(...closes) : currentPrice),
    historical,
  };

  setCached(tdKey, result);
  return result;
}

// Openclaw Fallback
async function fetchOpenclawMarketData(ticker: string) {
  console.log(`Spawning Openclaw agent to fetch market data for ${ticker}...`);
  // Use npx openclaw agent to fetch real-time data
  const prompt = `Search the live web or a reliable financial site for the current price of ${ticker}. Return ONLY valid JSON in this exact structure, with no markdown formatting or other text: {"symbol":"${ticker}","shortName":"${ticker}","regularMarketPrice":123.45,"regularMarketChange":1.23,"regularMarketChangePercent":1.05,"currency":"USD","fiftyTwoWeekHigh":150.00,"fiftyTwoWeekLow":100.00,"historical":[]}`;

  try {
    const safePrompt = prompt.replace(/'/g, `'\\''`);
    const { stdout } = await execAsync(`./node_modules/.bin/openclaw agent --local --json --message '${safePrompt}' --thinking low`, {
      timeout: 8000,
      env: { ...process.env, HOME: "/tmp", OPENAI_API_KEY: process.env.OPENAI_API_KEY }
    });

    // Parse the outer Openclaw API wrapper
    const outer = JSON.parse(stdout);
    const agentText = outer.payloads?.[0]?.text || "";

    // Attempt to extract the strict inner JSON
    const match = agentText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in Openclaw text: " + agentText);

    const parsed = JSON.parse(match[0]);
    if (!parsed.regularMarketPrice) throw new Error("Invalid schema from Openclaw: " + JSON.stringify(parsed));

    return parsed;
  } catch (error: any) {
    throw new Error(`Openclaw failed: ${error.message}`);
  }
}

export async function GET(request: NextRequest) {
  const ticker = request.nextUrl.searchParams.get("ticker");
  if (!ticker) {
    return NextResponse.json({ error: "Ticker is required" }, { status: 400 });
  }

  const cacheKey = `market:${ticker.toUpperCase()}`;

  const cached = getCached(cacheKey);
  if (cached) {
    return NextResponse.json({ ...(cached.data as object), cachedAt: cached.cachedAt });
  }

  try {
    let marketData;
    const sources: string[] = [];

    // Try Stooq first for plain stocks (fast, no auth)
    if (stooqSupports(ticker)) {
      try {
        marketData = await fetchStooq(ticker);
        sources.push("Stooq ✓");
      } catch (stooqErr: any) {
        sources.push("Stooq ✗");
        console.warn(`Stooq failed for "${ticker}" (${stooqErr.message}), trying Yahoo Finance…`);
      }
    }

    // CoinGecko for crypto, then Binance, then CoinCap as backup
    if (!marketData && isCrypto(ticker)) {
      try {
        marketData = await fetchCoinGecko(ticker);
        sources.push("CoinGecko ✓");
      } catch (cgErr: any) {
        sources.push("CoinGecko ✗");
        console.warn(`CoinGecko failed for "${ticker}" (${cgErr.message}), trying Binance…`);
        try {
          marketData = await fetchBinance(ticker);
          sources.push("Binance ✓");
        } catch (binErr: any) {
          sources.push("Binance ✗");
          console.warn(`Binance failed for "${ticker}" (${binErr.message}), trying CoinCap…`);
          try {
            marketData = await fetchCoinCap(ticker);
            sources.push("CoinCap ✓");
          } catch (ccErr: any) {
            sources.push("CoinCap ✗");
            console.warn(`CoinCap failed for "${ticker}" (${ccErr.message}), trying Yahoo Finance…`);
          }
        }
      }
    }

    // Yahoo Finance v8 chart API handles everything: stocks, crypto, ETFs, futures
    if (!marketData) {
      try {
        marketData = await fetchYahooChart(ticker);
        sources.push("Yahoo Finance ✓");
      } catch (yfErr: any) {
        sources.push("Yahoo Finance v8 ✗");
        console.warn(`Yahoo Finance v8 failed for "${ticker}" (${yfErr.message}), trying Yahoo v7 quote…`);
        try {
          marketData = await fetchYahooQuote(ticker);
          sources.push("Yahoo Finance v7 ✓");
        } catch (yf7Err: any) {
          sources.push("Yahoo Finance v7 ✗");
          console.warn(`Yahoo Finance v7 failed for "${ticker}" (${yf7Err.message}), trying Twelve Data…`);
          try {
            marketData = await fetchTwelveData(ticker);
            sources.push("Twelve Data ✓");
          } catch (tdErr: any) {
            sources.push("Twelve Data ✗");
            console.warn(`Twelve Data failed for "${ticker}" (${tdErr.message}), falling back to Openclaw Agent…`);
            marketData = await fetchOpenclawMarketData(ticker);
            sources.push("Openclaw ✓");
          }
        }
      }
    }

    const cachedAt = setCached(cacheKey, { ...marketData, sourcesAttempted: sources });
    return NextResponse.json({ ...marketData, sourcesAttempted: sources, cachedAt });
  } catch (error: any) {
    console.error("Error fetching market data:", error.message);
    const stale = getStale(cacheKey);
    if (stale) {
      console.warn("Serving stale cache for", ticker);
      return NextResponse.json({ ...(stale.data as object), cachedAt: stale.cachedAt });
    }
    return NextResponse.json({ error: `No data found for "${ticker}"` }, { status: 500 });
  }
}
