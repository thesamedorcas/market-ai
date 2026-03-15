"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import "./page.css";

export default function AssetDashboard({ params }: { params: Promise<{ ticker: string }> }) {
  const router = useRouter();
  const { ticker } = use(params);
  const decodedTicker = decodeURIComponent(ticker).toUpperCase();

  const [marketData, setMarketData] = useState<any>(null);
  const [newsData, setNewsData] = useState<any>(null);
  const [aiSummary, setAiSummary] = useState<string>("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState("Starting up…");
  const [error, setError] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);
  const [nextRefreshIn, setNextRefreshIn] = useState(300);

  const REFRESH_INTERVAL = 300; // 5 minutes

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        setError("");
        setStatusMessage("Starting up…");

        const res = await fetch(`/api/multi-agent?ticker=${decodedTicker}`);
        if (!res.ok) throw new Error("Failed to fetch market data");

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          let event = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              event = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              const payload = JSON.parse(line.slice(6));
              if (event === "status") {
                setStatusMessage(payload.message);
              } else if (event === "result") {
                const json = payload;
                if (json.resolvedTicker && json.resolvedTicker !== decodedTicker) {
                  router.replace(`/asset/${encodeURIComponent(json.resolvedTicker)}`);
                  return;
                }
                setMarketData(json.marketData);
                setNewsData({ social: json.social || [] });
                setAiSummary(json.summary || "No summary available.");
                if (json.lastUpdated) setLastUpdated(new Date(json.lastUpdated));
              } else if (event === "error") {
                throw new Error(payload.error);
              }
              event = "";
            }
          }
        }
      } catch (err: any) {
        console.error(err);
        setError(err.message || "An error occurred fetching data.");
      } finally {
        setLoading(false);
        setNextRefreshIn(REFRESH_INTERVAL);
      }
    }

    fetchData();

    // auto-refresh every 5 minutes
    const refreshTimer = setInterval(() => {
      setRefreshTick((t) => t + 1);
      fetchData();
    }, REFRESH_INTERVAL * 1000);

    return () => clearInterval(refreshTimer);
  }, [decodedTicker]);

  // countdown ticker
  useEffect(() => {
    if (loading) return;
    const countdown = setInterval(() => {
      setNextRefreshIn((s) => (s <= 1 ? REFRESH_INTERVAL : s - 1));
    }, 1000);
    return () => clearInterval(countdown);
  }, [loading]);

  if (loading) {
    return (
      <div className="dashboard-container">
        <div className="loader-container">
          <div className="spinner"></div>
          <div className="loader-text">{statusMessage}</div>
        </div>
      </div>
    );
  }

  if (error || !marketData) {
    return (
      <div className="dashboard-container">
        <div className="error-container">
          <h1 className="error-title">Not Found</h1>
          <p className="error-message">{error || "Could not retrieve data for this asset."}</p>
          <button onClick={() => router.push("/")} className="back-btn">Go Back</button>
        </div>
      </div>
    );
  }

  const isPositive = marketData.regularMarketChange >= 0;
  const lineColor = isPositive ? "#1a6b3a" : "#b83232";

  const chartData = marketData.historical?.map((d: any) => ({
    date: new Date(d.date).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    price: d.close,
  })) || [];

  const fmt = (val: number) =>
    val?.toLocaleString(undefined, { style: "currency", currency: marketData.currency || "USD" });

  return (
    <div className="dashboard-container">
      <nav className="dashboard-nav">
        <span className="dashboard-nav-logo" onClick={() => router.push("/")}>Market AI</span>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          {lastUpdated && (
            <span style={{ fontSize: "0.78rem", color: "var(--muted)" }}>
              Updated {Math.floor((Date.now() - lastUpdated.getTime()) / 60000) < 1
                ? "just now"
                : `${Math.floor((Date.now() - lastUpdated.getTime()) / 60000)}m ago`}
              {" · "}refreshes in {Math.floor(nextRefreshIn / 60)}:{String(nextRefreshIn % 60).padStart(2, "0")}
            </span>
          )}
          <button onClick={() => router.push("/")} className="back-btn">← Back</button>
        </div>
      </nav>

      <div className="dashboard-header">
        <div className="asset-info">
          <h1>
            {marketData.shortName}
            <span className="asset-symbol">{marketData.symbol}</span>
          </h1>
        </div>
        <div className="asset-price-block">
          <p className="asset-price">{fmt(marketData.regularMarketPrice)}</p>
          <span className={`price-change ${isPositive ? "change-positive" : "change-negative"}`}>
            {marketData.regularMarketChange > 0 ? "+" : ""}
            {marketData.regularMarketChange?.toFixed(2)}&nbsp;
            ({marketData.regularMarketChangePercent?.toFixed(2)}%)
          </span>
        </div>
      </div>

      <div className="dashboard-body">
        {(marketData.fiftyTwoWeekHigh || marketData.fiftyTwoWeekLow || marketData.marketCap) && (
          <div className="stats-row">
            {marketData.fiftyTwoWeekHigh && (
              <div className="stat-item">
                <span className="stat-label">52W High</span>
                <span className="stat-value">{fmt(marketData.fiftyTwoWeekHigh)}</span>
              </div>
            )}
            {marketData.fiftyTwoWeekLow && (
              <div className="stat-item">
                <span className="stat-label">52W Low</span>
                <span className="stat-value">{fmt(marketData.fiftyTwoWeekLow)}</span>
              </div>
            )}
            {marketData.marketCap && (
              <div className="stat-item">
                <span className="stat-label">Market Cap</span>
                <span className="stat-value">
                  {(marketData.marketCap / 1e9).toFixed(1)}B
                </span>
              </div>
            )}
            <div className="stat-item">
              <span className="stat-label">Currency</span>
              <span className="stat-value">{marketData.currency || "USD"}</span>
            </div>
          </div>
        )}

        <div className="dashboard-grid">
          <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
            <div className="card">
              <h2>30-Day Price Trend</h2>
              <div className="chart-container">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <XAxis
                      dataKey="date"
                      stroke="#b0ada6"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      domain={["auto", "auto"]}
                      stroke="#b0ada6"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(val) => `$${val.toLocaleString()}`}
                      width={70}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#ffffff",
                        border: "1px solid #dddbd5",
                        borderRadius: "4px",
                        fontSize: "0.85rem",
                        color: "#1a1a1a",
                      }}
                      formatter={(val) => [fmt(Number(val)), "Price"]}
                    />
                    <Line
                      type="monotone"
                      dataKey="price"
                      stroke={lineColor}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: lineColor, stroke: "#fff", strokeWidth: 2 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="card">
              <h2>AI Market Analysis</h2>
              <div className="ai-summary">
                {aiSummary.split("\n").map((paragraph, idx) => {
                  const trimmed = paragraph.trim();
                  if (!trimmed) return <p key={idx} style={{ margin: "0" }} />;
                  const headingMatch = trimmed.match(/^#{1,3}\s+(.+)/);
                  if (headingMatch) {
                    return <p key={idx} style={{ margin: "0 0 0.4rem 0", fontWeight: 700 }}>{headingMatch[1]}</p>;
                  }
                  const parts = trimmed.split(/\*\*(.+?)\*\*/g);
                  return (
                    <p key={idx} style={{ margin: "0 0 0.85rem 0" }}>
                      {parts.map((part, i) => i % 2 === 1 ? <strong key={i}>{part}</strong> : part)}
                    </p>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="card">
            <h2>Recent News &amp; Sentiment</h2>
            <div className="news-list">
              {newsData?.social?.length > 0 ? (
                newsData.social.map((post: any, idx: number) => (
                  <a href={post.url} target="_blank" rel="noopener noreferrer" key={idx} className="news-item">
                    <div className="news-item-header">
                      <div className="news-source">{post.source}</div>
                    </div>
                    <div className="news-title">{post.title}</div>
                    <div className="news-snippet">{post.text}</div>
                  </a>
                ))
              ) : (
                <p style={{ color: "var(--muted)", fontSize: "0.9rem" }}>No recent news found.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
