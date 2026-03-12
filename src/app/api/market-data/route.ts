import { NextRequest, NextResponse } from "next/server";
import YahooFinance from "yahoo-finance2";

const yf = new YahooFinance();

// Simple in-memory cache to avoid hitting Yahoo Finance too frequently
const cache = new Map<string, { data: unknown; ts: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const ticker = searchParams.get("ticker");

  if (!ticker) {
    return NextResponse.json({ error: "Ticker is required" }, { status: 400 });
  }

  const cached = cache.get(ticker);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.data);
  }

  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [quote, chart] = await Promise.all([
      yf.quote(ticker),
      yf.chart(ticker, { period1: thirtyDaysAgo, interval: "1d" }),
    ]);

    const historical = (chart.quotes ?? [])
      .filter((q: { close: number | null }) => q.close != null)
      .map((q: { date: Date; close: number | null }) => ({
        date: new Date(q.date).toISOString().split("T")[0],
        close: q.close,
      }));

    const marketData = {
      symbol: quote.symbol,
      shortName: quote.shortName || quote.longName,
      regularMarketPrice: quote.regularMarketPrice,
      regularMarketChange: quote.regularMarketChange,
      regularMarketChangePercent: quote.regularMarketChangePercent,
      currency: quote.currency,
      marketCap: quote.marketCap ?? null,
      fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
      historical,
    };

    cache.set(ticker, { data: marketData, ts: Date.now() });
    return NextResponse.json(marketData);
  } catch (error) {
    console.error("Error fetching market data:", error);
    return NextResponse.json({ error: "Failed to fetch market data" }, { status: 500 });
  }
}
