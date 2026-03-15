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
  const DB_PATH = path.join(process.cwd(), "cache.db");
  sqliteDb = new Database(DB_PATH);
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key       TEXT    PRIMARY KEY,
      data      TEXT    NOT NULL,
      cached_at INTEGER NOT NULL
    )
  `);
  sqliteDb.prepare("DELETE FROM cache WHERE cached_at < ?").run(Date.now() - TTL_MS);
} catch {
  sqliteDb = null;
}

/** Returns fresh entry, or null if missing / expired (>15 min). */
export function getCached<T = unknown>(key: string): CacheEntry<T> | null {
  try {
    if (sqliteDb) {
      const row = sqliteDb
        .prepare("SELECT data, cached_at FROM cache WHERE key = ?")
        .get(key) as { data: string; cached_at: number } | undefined;
      if (!row) return null;
      if (Date.now() - row.cached_at > TTL_MS) return null;
      return { data: JSON.parse(row.data) as T, cachedAt: row.cached_at, isStale: false };
    }
  } catch {}

  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > TTL_MS) return null;
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
