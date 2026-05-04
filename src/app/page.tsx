"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import "./page.css";

interface HistoryItem {
  id: number;
  input: string;
  ticker: string;
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
            {history.map((item) => (
              <button
                key={item.id}
                className="activity-item"
                onClick={() => router.push(`/asset/${encodeURIComponent(item.input)}`)}
              >
                <span className="activity-dot" />
                <span className="activity-body">
                  <span className="activity-query">
                    typed <strong>&ldquo;{item.input}&rdquo;</strong>
                    {item.input.toUpperCase() !== item.ticker && (
                      <> → <code>{item.ticker}</code></>
                    )}
                  </span>
                  {item.sources.length > 0 && (
                    <span className="activity-sources">{item.sources.join(" · ")}</span>
                  )}
                </span>
                <span className="activity-time">{timeAgo(item.searchedAt)}</span>
              </button>
            ))}
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
