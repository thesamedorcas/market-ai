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

// Openclaw Fallback
async function fetchOpenclawMarketData(ticker: string) {
  console.log(`Spawning Openclaw agent to fetch market data for ${ticker}...`);
  // Use npx openclaw agent to fetch real-time data
  const prompt = `Search the live web or a reliable financial site for the current price of ${ticker}. Return ONLY valid JSON in this exact structure, with no markdown formatting or other text: {"symbol":"${ticker}","shortName":"${ticker}","regularMarketPrice":123.45,"regularMarketChange":1.23,"regularMarketChangePercent":1.05,"currency":"USD","fiftyTwoWeekHigh":150.00,"fiftyTwoWeekLow":100.00,"historical":[]}`;

  try {
    const { stdout } = await execAsync(`npx openclaw agent --local --json --to dummy --message '${prompt}' --thinking low`, {
      timeout: 30000,
      env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY }
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

    // Try Stooq first for plain stocks (fast, no auth)
    if (stooqSupports(ticker)) {
      try {
        marketData = await fetchStooq(ticker);
      } catch (stooqErr: any) {
        console.warn(`Stooq failed for "${ticker}" (${stooqErr.message}), trying Yahoo Finance…`);
      }
    }

    // CoinGecko for crypto (free, no auth, no rate limits)
    if (!marketData && isCrypto(ticker)) {
      try {
        marketData = await fetchCoinGecko(ticker);
      } catch (cgErr: any) {
        console.warn(`CoinGecko failed for "${ticker}" (${cgErr.message}), trying Yahoo Finance…`);
      }
    }

    // Yahoo Finance v8 chart API handles everything: stocks, crypto, ETFs, futures
    if (!marketData) {
      try {
        marketData = await fetchYahooChart(ticker);
      } catch (yfErr: any) {
        console.warn(`Yahoo Finance failed for "${ticker}" (${yfErr.message}), falling back to Openclaw Agent…`);
        marketData = await fetchOpenclawMarketData(ticker);
      }
    }

    const cachedAt = setCached(cacheKey, marketData);
    return NextResponse.json({ ...marketData, cachedAt });
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
