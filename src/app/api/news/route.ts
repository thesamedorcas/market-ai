import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get("q");

  if (!query) {
    return NextResponse.json({ error: "Query is required" }, { status: 400 });
  }

  try {
    const redditUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=hot&limit=5`;
    
    const redditRes = await fetch(redditUrl, {
      headers: { 'User-Agent': 'FinancialDataApp/1.0.0' }
    });
    
    const redditData = await redditRes.json();
    
    const socialPosts = (redditData.data?.children || []).map((post: any) => ({
      title: post.data.title,
      text: post.data.selftext?.substring(0, 200) + "...",
      url: `https://www.reddit.com${post.data.permalink}`,
      score: post.data.score,
      source: "Reddit"
    }));

    return NextResponse.json({
      news: [], 
      social: socialPosts
    });
  } catch (error) {
    console.error("Error fetching news:", error);
    return NextResponse.json({ error: "Failed to fetch news" }, { status: 500 });
  }
}
