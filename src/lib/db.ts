import path from "path";

const TTL_MS = 15 * 60 * 1000; // 15 minutes

export interface CacheEntry<T = unknown> {
  data: T;
  cachedAt: number;
  isStale: boolean;
}

// In-memory fallback cache (used when SQLite is unavailable e.g. Vercel serverless)
const memCache = new Map<string, { data: unknown; cachedAt: number }>();

// Try to load better-sqlite3 — won't work on Vercel (native module / read-only fs)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqliteDb: any = null;
try {
  const Database = require("better-sqlite3");
  const DB_PATH = process.env.VERCEL ? "/tmp/cache.db" : path.join(process.cwd(), "cache.db");
  sqliteDb = new Database(DB_PATH);
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key       TEXT    PRIMARY KEY,
      data      TEXT    NOT NULL,
      cached_at INTEGER NOT NULL
    )
  `);
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS search_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      input       TEXT    NOT NULL,
      ticker      TEXT    NOT NULL,
      market_data TEXT    NOT NULL,
      social_data TEXT    NOT NULL,
      summary     TEXT    NOT NULL,
      sources     TEXT    NOT NULL,
      searched_at INTEGER NOT NULL
    )
  `);
  sqliteDb.prepare("DELETE FROM cache WHERE cached_at < ?").run(Date.now() - TTL_MS);
} catch {
  sqliteDb = null;
}

/** Returns fresh entry, or null if missing / expired. Defaults to 15-min TTL. */
export function getCached<T = unknown>(key: string, ttlMs: number = TTL_MS): CacheEntry<T> | null {
  try {
    if (sqliteDb) {
      const row = sqliteDb
        .prepare("SELECT data, cached_at FROM cache WHERE key = ?")
        .get(key) as { data: string; cached_at: number } | undefined;
      if (!row) return null;
      if (Date.now() - row.cached_at > ttlMs) return null;
      return { data: JSON.parse(row.data) as T, cachedAt: row.cached_at, isStale: false };
    }
  } catch {}

  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > ttlMs) return null;
  return { data: entry.data as T, cachedAt: entry.cachedAt, isStale: false };
}

export function getStale<T = unknown>(key: string): CacheEntry<T> | null {
  try {
    if (sqliteDb) {
      const row = sqliteDb
        .prepare("SELECT data, cached_at FROM cache WHERE key = ?")
        .get(key) as { data: string; cached_at: number } | undefined;
      if (!row) return null;
      const isStale = Date.now() - row.cached_at > TTL_MS;
      return { data: JSON.parse(row.data) as T, cachedAt: row.cached_at, isStale };
    }
  } catch {}

  const entry = memCache.get(key);
  if (!entry) return null;
  const isStale = Date.now() - entry.cachedAt > TTL_MS;
  return { data: entry.data as T, cachedAt: entry.cachedAt, isStale };
}

export interface HistoryItem {
  id?: number;
  input: string;
  ticker: string;
  marketData: unknown;
  socialData: unknown;
  summary: string;
  sources: string[];
  searchedAt: number;
}

const searchHistoryMem: HistoryItem[] = [];

export function saveSearchHistory(item: Omit<HistoryItem, "id">): void {
  const dedupeWindow = Date.now() - 5 * 60 * 1000; // skip if same search within 5 min
  try {
    if (sqliteDb) {
      const existing = sqliteDb
        .prepare(`SELECT id FROM search_history WHERE input = ? AND ticker = ? AND searched_at > ? LIMIT 1`)
        .get(item.input.toLowerCase(), item.ticker, dedupeWindow);
      if (existing) return;
      sqliteDb
        .prepare(
          `INSERT INTO search_history (input, ticker, market_data, social_data, summary, sources, searched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          item.input.toLowerCase(),
          item.ticker,
          JSON.stringify(item.marketData),
          JSON.stringify(item.socialData),
          item.summary,
          JSON.stringify(item.sources),
          item.searchedAt
        );
      return;
    }
  } catch {}
  const recentDupe = searchHistoryMem.find(
    (e) => e.input === item.input.toLowerCase() && e.ticker === item.ticker && e.searchedAt > dedupeWindow
  );
  if (recentDupe) return;
  searchHistoryMem.push({ ...item, input: item.input.toLowerCase() });
  if (searchHistoryMem.length > 200) searchHistoryMem.shift();
}

export function getGlobalHistory(limitHours = 8): HistoryItem[] {
  const cutoff = Date.now() - limitHours * 60 * 60 * 1000;
  try {
    if (sqliteDb) {
      const rows = sqliteDb
        .prepare(
          `SELECT * FROM search_history WHERE searched_at > ? ORDER BY searched_at DESC LIMIT 20`
        )
        .all(cutoff) as any[];
      return rows.map((row: any) => ({
        id: row.id,
        input: row.input,
        ticker: row.ticker,
        marketData: JSON.parse(row.market_data),
        socialData: JSON.parse(row.social_data),
        summary: row.summary,
        sources: JSON.parse(row.sources),
        searchedAt: row.searched_at,
      }));
    }
  } catch {}
  return [...searchHistoryMem].filter((e) => e.searchedAt > cutoff).reverse().slice(0, 20);
}

export function setCached(key: string, data: unknown): number {
  const now = Date.now();
  try {
    if (sqliteDb) {
      sqliteDb
        .prepare("INSERT OR REPLACE INTO cache (key, data, cached_at) VALUES (?, ?, ?)")
        .run(key, JSON.stringify(data), now);
      return now;
    }
  } catch {}

  memCache.set(key, { data, cachedAt: now });
  return now;
}
