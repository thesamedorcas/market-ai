import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { getCached, setCached } from "@/lib/db";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "dummy_key" });

// maps plain english to ticker symbols
// using ETFs for commodities (GLD, SLV) rather than futures (GC=F, SI=F) — futures
const TICKER_ALIASES: Record<string, string> = {
  // Commodities → liquid ETFs
  gold: "GLD", silver: "SLV", copper: "CPER",
  oil: "USO", "crude oil": "USO", crude: "USO",
  "natural gas": "UNG", gas: "UNG",
  wheat: "WEAT", corn: "CORN", soybeans: "SOYB",
  // Crypto
  bitcoin: "BTC-USD", btc: "BTC-USD",
  ethereum: "ETH-USD", eth: "ETH-USD",
  solana: "SOL-USD", sol: "SOL-USD",
  dogecoin: "DOGE-USD", doge: "DOGE-USD",
  xrp: "XRP-USD", ripple: "XRP-USD",
  cardano: "ADA-USD", ada: "ADA-USD",
  // Big-cap stocks
  apple: "AAPL", google: "GOOGL", alphabet: "GOOGL",
  microsoft: "MSFT", amazon: "AMZN", meta: "META",
  facebook: "META", tesla: "TSLA", nvidia: "NVDA",
  netflix: "NFLX", spotify: "SPOT",
  // Indices / ETFs
  "s&p": "SPY", "s&p 500": "SPY", sp500: "SPY",
  nasdaq: "QQQ", "dow jones": "DIA", dow: "DIA",
};

// rough check if it already looks like a ticker don't bother resolving it
function looksLikeTicker(s: string): boolean {
  return /^[A-Z0-9\^]{1,6}([-=.][A-Z0-9]+)*$/.test(s);
}

async function resolveTickerSymbol(input: string): Promise<string> {
  const upper = input.toUpperCase();

  const alias = TICKER_ALIASES[input.toLowerCase()];
  if (alias) return alias;

  // already a ticker, nothing to do
  if (looksLikeTicker(upper)) return upper;


  const cacheKey = `resolve:${input.toLowerCase()}`;
  const cached = getCached<string>(cacheKey);
  if (cached) return cached.data;

  try {
    const searchRes = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(input)}&quotesCount=1&newsCount=0`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000) }
    );
    if (searchRes.ok) {
      const searchJson = await searchRes.json();
      const symbol: string | undefined = searchJson?.quotes?.[0]?.symbol;
      if (symbol && looksLikeTicker(symbol)) {
        setCached(cacheKey, symbol);
        return symbol;
      }
    }
  } catch {
    // fall through
  }

  return upper;
}

function buildTechnicalContext(marketData: any): string {
  const price = marketData.regularMarketPrice;
  const high52 = marketData.fiftyTwoWeekHigh;
  const low52 = marketData.fiftyTwoWeekLow;
  const hist: { close: number }[] = marketData.historical || [];

  const pctFromHigh = high52 ? (((price - high52) / high52) * 100).toFixed(1) : null;
  const pctFromLow = low52 ? (((price - low52) / low52) * 100).toFixed(1) : null;

  let trendStr = "";
  if (hist.length >= 5) {
    const earliest = hist[0].close;
    const latest = hist[hist.length - 1].close;
    const trendPct = (((latest - earliest) / earliest) * 100).toFixed(1);
    trendStr = `30-day trend: ${Number(trendPct) >= 0 ? "+" : ""}${trendPct}% (from ${earliest.toFixed(2)} to ${latest.toFixed(2)})`;
  }

  return [
    pctFromHigh ? `${pctFromHigh}% from 52W high` : "",
    pctFromLow ? `+${pctFromLow}% from 52W low` : "",
    trendStr,
  ].filter(Boolean).join(" | ");
}

async function agentAnalysis(ticker: string, marketData: any, socialData: any[]) {
  if (!process.env.OPENAI_API_KEY) {
    return `Simulated analysis for ${ticker}: currently trading at ${marketData.currency} ${marketData.regularMarketPrice}. Based on aggregated social sentiment across Reddit, r/wallstreetbets, StockTwits, and financial news, there appears to be cautious optimism. (Set OPENAI_API_KEY for live analysis.)`;
  }

  const technicalContext = buildTechnicalContext(marketData);
  const sentimentSummary = socialData.slice(0, 12).map(
    (p: any) => `[${p.source}${p.sentiment ? ` · ${p.sentiment}` : ""}] ${p.title}`
  ).join("\n");

  const prompt = `You are a senior financial analyst providing forward-looking intelligence.

Asset: ${ticker}
Current Price: ${marketData.regularMarketPrice} ${marketData.currency}
Daily Change: ${marketData.regularMarketChangePercent?.toFixed(2)}%
Technical Position: ${technicalContext || "N/A"}
52W Range: ${marketData.fiftyTwoWeekLow} – ${marketData.fiftyTwoWeekHigh}

Social & News Signals (Reddit, r/wallstreetbets, StockTwits, Twitter/X, Yahoo Finance):
${sentimentSummary || "No recent social sentiment available."}

Write a 3-paragraph forward-looking analysis:
1. CURRENT SITUATION — what's driving today's price and sentiment
2. NEAR-TERM OUTLOOK (1–4 weeks) — likely direction with a bull and bear case, reference specific price levels
3. KEY CATALYSTS TO WATCH — upcoming events, macro factors, or sentiment shifts that could change the thesis

Be specific and opinionated. Avoid vague hedging. End with a one-sentence directional verdict.`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.65,
    max_tokens: 600,
  });

  return completion.choices[0].message.content || "";
}

export async function GET(request: NextRequest) {
  const rawTicker = request.nextUrl.searchParams.get("ticker");

  if (!rawTicker) {
    return NextResponse.json({ error: "Ticker is required" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const emit = (event: string, data: unknown) =>
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  const origin = new URL(request.url).origin;

  (async () => {
    try {
      await emit("status", { message: "Resolving ticker symbol…" });
      const ticker = await resolveTickerSymbol(rawTicker);

      if (ticker !== rawTicker.toUpperCase()) {
        await emit("status", { message: `Resolved to ${ticker}` });
      }

      await emit("status", { message: "Fetching market data & news sentiment…" });
      const [marketRes, socialRes] = await Promise.all([
        fetch(`${origin}/api/market-data?ticker=${encodeURIComponent(ticker)}`),
        fetch(`${origin}/api/news?q=${encodeURIComponent(ticker)}&ticker=${encodeURIComponent(ticker)}`),
      ]);

      if (!marketRes.ok) {
        const err = await marketRes.json().catch(() => ({}));
        throw new Error((err as any).error || "Market data agent failed");
      }

      const [marketData, newsData] = await Promise.all([
        marketRes.json(),
        socialRes.ok ? socialRes.json() : Promise.resolve({ social: [] }),
      ]);

      const socialData = newsData.social || [];

      await emit("status", { message: "Running AI market analysis…" });
      const summary = await agentAnalysis(ticker, marketData, socialData);

      const lastUpdated = Math.min(
        marketData.cachedAt ?? Date.now(),
        newsData.cachedAt ?? Date.now()
      );

      await emit("result", { marketData, social: socialData, summary, lastUpdated, resolvedTicker: ticker });
    } catch (error: any) {
      console.error("Multi-agent orchestration error:", error);
      await emit("error", { error: error.message || "Multi-agent orchestration failed" });
    } finally {
      writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
