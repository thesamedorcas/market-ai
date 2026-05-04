"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import "./page.css";

interface HistoryItem {
  id: number;
  input: string;
  ticker: string;
  marketData: any;
  sources: string[];
  searchedAt: number;
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function SourceChain({ sources }: { sources: string[] }) {
  if (!sources.length) return null;
  return (
    <span className="source-chain">
      {sources.map((s, i) => {
        const ok = s.includes("✓");
        const name = s.replace(/\s*[✓✗]/, "");
        return (
          <span key={i} className="chain-step">
            {i > 0 && <span className="chain-arrow">→</span>}
            <span className={ok ? "chain-hit" : "chain-miss"}>
              {name}{ok ? " ✓" : ""}
            </span>
          </span>
        );
      })}
    </span>
  );
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const router = useRouter();

  useEffect(() => {
    fetch("/api/history")
      .then((r) => r.json())
      .then((data) => setHistory(data.history || []))
      .catch(() => {});
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      router.push(`/asset/${encodeURIComponent(query.trim())}`);
    }
  };

  return (
    <main className="home-container">
      <nav className="home-nav">
        <span className="home-nav-logo">Market AI</span>
        <span className="home-nav-meta">Stocks · Crypto · Commodities</span>
      </nav>

      <div className="home-content">
        <p className="home-eyebrow">Market Intelligence</p>
        <h1 className="home-title">
          Financial data<br />
          <span className="highlight">without the noise.</span>
        </h1>
        <p className="home-subtitle">
          Search any stock, crypto, or commodity to get real-time prices,
          30-day charts, and AI-generated analysis.
        </p>
        <form className="search-form" onSubmit={handleSearch}>
          <div className="search-bar-wrapper">
            <input
              type="text"
              className="search-input"
              placeholder="AAPL, BTC-USD, GC=F..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit" className="search-button">
              Search
            </button>
          </div>
        </form>

        {history.length > 0 && (
          <div className="activity-feed">
            <p className="activity-label">Global Activity · last 8 hrs</p>
            {history.map((item) => {
              const price = item.marketData?.regularMarketPrice;
              const pct = item.marketData?.regularMarketChangePercent;
              const currency = item.marketData?.currency ?? "USD";
              const up = pct != null && pct >= 0;
              return (
                <button
                  key={item.id}
                  className="activity-item"
                  onClick={() => router.push(`/asset/${encodeURIComponent(item.input)}`)}
                >
                  <span className="activity-dot" />
                  <span className="activity-body">
                    <span className="activity-row">
                      <span className="activity-query">
                        typed <strong>&ldquo;{item.input}&rdquo;</strong>
                        {item.input !== item.ticker.toLowerCase() && (
                          <> → <code>{item.ticker}</code></>
                        )}
                      </span>
                      {price != null && (
                        <span className="activity-price">
                          {currency} {price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          {pct != null && (
                            <span className={up ? "pct-up" : "pct-down"}>
                              {" "}{up ? "▲" : "▼"}{Math.abs(pct).toFixed(2)}%
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                    <span className="activity-row activity-meta">
                      <SourceChain sources={item.sources} />
                      <span className="activity-time">{timeAgo(item.searchedAt)}</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <footer className="home-footer">
        <span className="home-footer-tag"><span>Data</span> Yahoo Finance</span>
        <span className="home-footer-tag"><span>Analysis</span> OpenAI</span>
        <span className="home-footer-tag"><span>Updated</span> Every 5 min</span>
      </footer>
    </main>
  );
}
