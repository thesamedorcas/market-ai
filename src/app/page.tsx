"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import "./page.css";

export default function Home() {
  const [query, setQuery] = useState("");
  const router = useRouter();

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
      </div>

      <footer className="home-footer">
        <span className="home-footer-tag"><span>Data</span> Yahoo Finance</span>
        <span className="home-footer-tag"><span>Analysis</span> OpenAI</span>
        <span className="home-footer-tag"><span>Updated</span> Every 5 min</span>
      </footer>
    </main>
  );
}
