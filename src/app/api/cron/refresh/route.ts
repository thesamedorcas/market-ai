import { NextRequest, NextResponse } from "next/server";

// Popular tickers to keep warm in cache
const WATCHLIST = [
  "BTC-USD",   // Bitcoin
  "ETH-USD",   // Ethereum
  "GLD",       // Gold ETF
  "SPY",       // S&P 500
  "QQQ",       // Nasdaq
  "AAPL",      // Apple
  "TSLA",      // Tesla
  "NVDA",      // Nvidia
  "MSFT",      // Microsoft
  "USO",       // Oil ETF
];

export async function GET(request: NextRequest) {
  const secret = request.headers.get("x-cron-secret");
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const origin = new URL(request.url).origin;
  const results: Record<string, string> = {};

  await Promise.allSettled(
    WATCHLIST.map(async (ticker) => {
      try {
        const [marketRes, newsRes] = await Promise.allSettled([
          fetch(`${origin}/api/market-data?ticker=${encodeURIComponent(ticker)}`, {
            signal: AbortSignal.timeout(20000),
          }),
          fetch(`${origin}/api/news?q=${encodeURIComponent(ticker)}&ticker=${encodeURIComponent(ticker)}`, {
            signal: AbortSignal.timeout(25000),
          }),
        ]);
        const marketOk = marketRes.status === "fulfilled" && marketRes.value.ok;
        const newsOk = newsRes.status === "fulfilled" && newsRes.value.ok;
        results[ticker] = marketOk && newsOk ? "ok" : marketOk ? "market-only" : "failed";
      } catch {
        results[ticker] = "error";
      }
    })
  );

  return NextResponse.json({
    refreshed: Object.keys(results).length,
    results,
    timestamp: new Date().toISOString(),
  });
}
