import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { getCached, getStale, setCached } from "@/lib/db";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "dummy_key" });
const HEADERS = { "User-Agent": "FinancialDataApp/1.0.0" };

async function fetchYahooNews(ticker: string): Promise<any[]> {
  try {
    const res = await fetch(
      `https://finance.yahoo.com/rss/headline?s=${encodeURIComponent(ticker)}`,
      { headers: HEADERS, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return [];
    const xml = await res.text();
    const items: any[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < 6) {
      const block = match[1];
      const title =
        (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(block) ||
          /<title>(.*?)<\/title>/.exec(block))?.[1] || "";
      const link = (/<link>(.*?)<\/link>/.exec(block))?.[1] || "";
      const description =
        (/<description><!\[CDATA\[(.*?)\]\]><\/description>/.exec(block) ||
          /<description>(.*?)<\/description>/.exec(block))?.[1] || "";
      if (title)
        items.push({
          title,
          text: description.replace(/<[^>]+>/g, "").substring(0, 200) + "...",
          url: link,
          score: null,
          source: "Yahoo Finance",
          sentiment: null,
        });
    }
    return items;
  } catch {
    return [];
  }
}


async function fetchReddit(query: string): Promise<any[]> {
  try {
    const [generalRes, wsbRes] = await Promise.all([
      fetch(
        `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=hot&limit=4`,
        { headers: HEADERS, signal: AbortSignal.timeout(5000) }
      ),
      fetch(
        `https://www.reddit.com/r/wallstreetbets/search.json?q=${encodeURIComponent(query)}&sort=hot&restrict_sr=1&limit=3`,
        { headers: HEADERS, signal: AbortSignal.timeout(5000) }
      ),
    ]);

    const mapPosts = (data: any, source: string) =>
      (data?.data?.children || []).map((post: any) => ({
        title: post.data.title,
        text: (post.data.selftext?.substring(0, 200) || post.data.title) + "...",
        url: `https://www.reddit.com${post.data.permalink}`,
        score: post.data.score,
        source,
        sentiment: null,
      }));

    const [generalData, wsbData] = await Promise.all([
      generalRes.ok ? generalRes.json().catch(() => ({})) : {},
      wsbRes.ok ? wsbRes.json().catch(() => ({})) : {},
    ]);

    return [...mapPosts(generalData, "Reddit"), ...mapPosts(wsbData, "r/wallstreetbets")];
  } catch {
    return [];
  }
}

async function fetchStockTwits(ticker: string): Promise<any[]> {
  if (!process.env.OPENAI_API_KEY) return [];
  try {
    const response = await (openai as any).responses.create({
      model: "gpt-4o-mini-search-preview",
      tools: [{ type: "web_search_preview" }],
      input: `Search StockTwits for the 4 most recent posts about $${ticker} stock. Return ONLY a JSON array, no markdown, no explanation. Each item must have: { "title": string (the post text, max 100 chars), "text": string (full post, max 200 chars), "url": string (stocktwits.com link if available, else "https://stocktwits.com/symbol/${ticker}"), "source": "StockTwits", "sentiment": "Bullish" | "Bearish" | "Neutral" }`,
    });
    const raw: string = response.output_text?.trim() || "[]";
    const parsed = JSON.parse(raw.replace(/^```json\n?/, "").replace(/\n?```$/, ""));
    return Array.isArray(parsed)
      ? parsed.map((item: any) => ({ ...item, score: null }))
      : [];
  } catch {
    return [];
  }
}

async function fetchOpenclawSocial(ticker: string): Promise<any[]> {
  console.log(`Spawning Openclaw Agent to scrape social sentiment for ${ticker}...`);
  const prompt = `Search Twitter/X or TikTok or other financial web sources for the latest 3 posts/news regarding the stock/crypto $${ticker}. Return ONLY valid JSON in this exact structure, with no markdown or explanation: [{"title":"Summary of post","text":"Full text of post","url":"https://example.com","source":"Twitter","sentiment":"Bullish"}]`;

  try {
    const { stdout } = await execAsync(`npx openclaw agent --local --json --to dummy --message '${prompt}' --thinking low`, {
      timeout: 30000,
      env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY }
    });
    const outer = JSON.parse(stdout);
    const agentText = outer.payloads?.[0]?.text || "";

    const match = agentText.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error: any) {
    console.warn("Openclaw social scraper failed:", error.message);
    return [];
  }
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get("q");
  const ticker = (searchParams.get("ticker") || query || "").toUpperCase();

  if (!query) {
    return NextResponse.json({ error: "Query is required" }, { status: 400 });
  }

  const cacheKey = `news:${ticker}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return NextResponse.json({ ...(cached.data as object), cachedAt: cached.cachedAt });
  }

  try {
    const [yahooNews, redditPosts, stocktwitsPosts, openclawPosts] = await Promise.all([
      fetchYahooNews(ticker),
      fetchReddit(query),
      fetchStockTwits(ticker),
      fetchOpenclawSocial(ticker),
    ]);

    const social = [...yahooNews, ...redditPosts, ...stocktwitsPosts, ...openclawPosts];
    const cachedAt = setCached(cacheKey, { social });

    return NextResponse.json({ news: [], social, cachedAt });
  } catch (error) {
    console.error("Error fetching news:", error);
    const stale = getStale(cacheKey);
    if (stale) {
      console.warn("Serving stale news cache for", ticker);
      return NextResponse.json({ ...(stale.data as object), cachedAt: stale.cachedAt });
    }
    return NextResponse.json({ error: "Failed to fetch news" }, { status: 500 });
  }
}
