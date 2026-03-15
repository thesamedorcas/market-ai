import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "cache.db");
const TTL_MS = 15 * 60 * 1000; // 15 minutes

declare global {

  var __cacheDb: InstanceType<typeof Database> | undefined;
}

function getDb() {
  if (!global.__cacheDb) {
    global.__cacheDb = new Database(DB_PATH);
    global.__cacheDb.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        key       TEXT    PRIMARY KEY,
        data      TEXT    NOT NULL,
        cached_at INTEGER NOT NULL
      )
    `);
    global.__cacheDb.prepare("DELETE FROM cache WHERE cached_at < ?").run(Date.now() - TTL_MS);
  }
  return global.__cacheDb;
}

export interface CacheEntry<T = unknown> {
  data: T;
  cachedAt: number;
  isStale: boolean;
}

/** Returns fresh entry, or null if missing / expired (>15 min). */
export function getCached<T = unknown>(key: string): CacheEntry<T> | null {
  const row = getDb()
    .prepare("SELECT data, cached_at FROM cache WHERE key = ?")
    .get(key) as { data: string; cached_at: number } | undefined;

  if (!row) return null;
  if (Date.now() - row.cached_at > TTL_MS) return null;

  return { data: JSON.parse(row.data) as T, cachedAt: row.cached_at, isStale: false };
}

export function getStale<T = unknown>(key: string): CacheEntry<T> | null {
  const row = getDb()
    .prepare("SELECT data, cached_at FROM cache WHERE key = ?")
    .get(key) as { data: string; cached_at: number } | undefined;

  if (!row) return null;
  const isStale = Date.now() - row.cached_at > TTL_MS;
  return { data: JSON.parse(row.data) as T, cachedAt: row.cached_at, isStale };
}


export function setCached(key: string, data: unknown): number {
  const now = Date.now();
  getDb()
    .prepare("INSERT OR REPLACE INTO cache (key, data, cached_at) VALUES (?, ?, ?)")
    .run(key, JSON.stringify(data), now);
  return now;
}
