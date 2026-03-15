import Database from "better-sqlite3";

// Use an in-memory DB so tests never touch cache.db
jest.mock("better-sqlite3", () => {
  const DB = jest.requireActual("better-sqlite3");
  return jest.fn(() => new DB(":memory:"));
});

// Re-import after mock is in place
let getCached: typeof import("@/lib/db").getCached;
let getStale: typeof import("@/lib/db").getStale;
let setCached: typeof import("@/lib/db").setCached;

beforeAll(async () => {
  // Reset module so getDb() re-initialises with the in-memory mock
  jest.resetModules();
  const db = await import("@/lib/db");
  getCached = db.getCached;
  getStale = db.getStale;
  setCached = db.setCached;
});

beforeEach(() => {
  // Clear the singleton so each test starts with a fresh DB
  (global as any).__cacheDb = undefined;
});

describe("setCached / getCached", () => {
  it("stores data and returns a timestamp", () => {
    const before = Date.now();
    const ts = setCached("test:key", { value: 42 });
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it("getCached returns the stored data for a fresh entry", () => {
    setCached("test:fresh", { price: 100 });
    const result = getCached<{ price: number }>("test:fresh");
    expect(result).not.toBeNull();
    expect(result!.data.price).toBe(100);
    expect(result!.isStale).toBe(false);
  });

  it("getCached returns null for a missing key", () => {
    expect(getCached("test:nonexistent")).toBeNull();
  });

  it("getCached returns null for an expired entry", () => {
    const TTL_MS = 15 * 60 * 1000;
    // Write a row with a cached_at 16 minutes ago
    const db = (global as any).__cacheDb;
    if (!db) {
      // Trigger init by calling getCached once
      getCached("__init__");
    }
    const expiredAt = Date.now() - TTL_MS - 1000;
    (global as any).__cacheDb
      ?.prepare("INSERT OR REPLACE INTO cache (key, data, cached_at) VALUES (?, ?, ?)")
      .run("test:expired", JSON.stringify({ x: 1 }), expiredAt);

    expect(getCached("test:expired")).toBeNull();
  });
});

describe("getStale", () => {
  it("returns null for a missing key", () => {
    expect(getStale("test:missing")).toBeNull();
  });

  it("returns fresh entry with isStale = false", () => {
    setCached("test:stale-fresh", { val: 7 });
    const result = getStale("test:stale-fresh");
    expect(result).not.toBeNull();
    expect(result!.isStale).toBe(false);
  });

  it("returns expired entry with isStale = true", () => {
    const TTL_MS = 15 * 60 * 1000;
    getCached("__init2__"); // ensure DB initialised
    const expiredAt = Date.now() - TTL_MS - 1000;
    (global as any).__cacheDb
      ?.prepare("INSERT OR REPLACE INTO cache (key, data, cached_at) VALUES (?, ?, ?)")
      .run("test:stale-old", JSON.stringify({ old: true }), expiredAt);

    const result = getStale<{ old: boolean }>("test:stale-old");
    expect(result).not.toBeNull();
    expect(result!.isStale).toBe(true);
    expect(result!.data.old).toBe(true);
  });
});
