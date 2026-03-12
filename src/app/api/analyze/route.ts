import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "dummy_key", 
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { ticker, marketData, socialData } = body;

    if (!ticker || !marketData) {
      return NextResponse.json({ error: "Ticker and marketData are required" }, { status: 400 });
    }

    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({
        summary: `This is a simulated AI analysis for ${ticker}. Currently, the asset is trading at ${marketData.currency} ${marketData.regularMarketPrice}. Based on recent sentiment and market trends, there appears to be cautious optimism. However, due to missing OpenAI API key, this is a placeholder response.`
      });
    }

    const prompt = `You are an expert financial analyst. Analyze the following data for ${ticker}:
    
    Market Data:
    Current Price: ${marketData.regularMarketPrice} ${marketData.currency}
    Daily Change: ${marketData.regularMarketChangePercent}%
    52 Week High: ${marketData.fiftyTwoWeekHigh}
    52 Week Low: ${marketData.fiftyTwoWeekLow}
    
    Recent Social Media Context:
    ${socialData ? JSON.stringify(socialData) : "No recent social sentiment available."}
    
    Please provide a concise, 2-3 paragraph summary of the current market sentiment and potential future trends based strictly on this information. Avoid regurgitating numbers verbatim; focus on the "why" and "what's next".`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 400
    });

    const summary = completion.choices[0].message.content;

    return NextResponse.json({ summary });
  } catch (error) {
    console.error("Error generating analysis:", error);
    return NextResponse.json({ error: "Failed to generate AI analysis" }, { status: 500 });
  }
}
