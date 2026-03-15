import { NextRequest } from "next/server";

// ── Mocks ──────────────────────────────────────────────────────────────────────
jest.mock("@/lib/db", () => ({
  getCached: jest.fn().mockReturnValue(null),
  getStale: jest.fn().mockReturnValue(null),
  setCached: jest.fn().mockReturnValue(Date.now()),
}));

jest.mock("child_process", () => ({ exec: jest.fn() }));
jest.mock("util", () => ({ promisify: (fn: any) => fn }));

const mockFetch = jest.fn();
global.fetch = mockFetch;

// ── Helpers ────────────────────────────────────────────────────────────────────
function makeRequest(ticker?: string) {
  const url = ticker
    ? `http://localhost/api/market-data?ticker=${ticker}`
    : "http://localhost/api/market-data";
  return new NextRequest(url);
}

function yahooChartResponse(price = 150, symbol = "AAPL") {
  const now = Math.floor(Date.now() / 1000);
  return {
    ok: true,
    status: 200,
    json: async () => ({
      chart: {
        result: [
          {
            meta: { symbol, currency: "USD", shortName: symbol },
            timestamp: [now - 86400 * 2, now - 86400, now],
            indicators: { quote: [{ close: [148, 149, price] }] },
          },
        ],
      },
    }),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────
describe("GET /api/market-data", () => {
  let GET: (req: NextRequest) => Promise<Response>;
  const { getCached, getStale } = require("@/lib/db");

  beforeEach(() => {
    jest.resetModules();
    mockFetch.mockReset();
    getCached.mockReturnValue(null);
    getStale.mockReturnValue(null);
  });

  beforeAll(async () => {
    ({ GET } = await import("@/app/api/market-data/route"));
  });

  it("returns 400 when ticker is missing", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/ticker is required/i);
  });

  it("returns cached data without calling fetch", async () => {
    getCached.mockReturnValue({ data: { regularMarketPrice: 123 }, cachedAt: Date.now() });
    const res = await GET(makeRequest("AAPL"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.regularMarketPrice).toBe(123);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fetches from Stooq for plain stocks and returns price data", async () => {
    // Stooq returns CSV
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        "Date,Open,High,Low,Close,Volume\n2024-01-01,148,152,147,150,1000000\n2024-01-02,150,153,149,151,900000\n",
    });

    const res = await GET(makeRequest("AAPL"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.regularMarketPrice).toBe(151);
    expect(body.symbol).toBe("AAPL");
  });

  it("falls back to Yahoo Finance if Stooq returns no data", async () => {
    // Stooq: returns "no data"
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "no data" });
    // Yahoo Finance
    mockFetch.mockResolvedValueOnce(yahooChartResponse(200, "AAPL"));

    const res = await GET(makeRequest("AAPL"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.regularMarketPrice).toBe(200);
  });

  it("skips Stooq for crypto and uses Yahoo Finance directly", async () => {
    mockFetch.mockResolvedValueOnce(yahooChartResponse(60000, "BTC-USD"));

    const res = await GET(makeRequest("BTC-USD"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.regularMarketPrice).toBe(60000);
    // Only one fetch call (Yahoo Finance, no Stooq attempt)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("skips Stooq for index tickers (^GSPC)", async () => {
    mockFetch.mockResolvedValueOnce(yahooChartResponse(5000, "^GSPC"));

    const res = await GET(makeRequest("^GSPC"));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((await res.json()).regularMarketPrice).toBe(5000);
  });

  it("serves stale cache when all fetches fail", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));
    getStale.mockReturnValue({
      data: { regularMarketPrice: 99, symbol: "AAPL" },
      cachedAt: Date.now() - 999999,
    });

    const res = await GET(makeRequest("AAPL"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.regularMarketPrice).toBe(99);
  });

  it("returns 500 when all sources fail and no stale cache exists", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));
    const res = await GET(makeRequest("AAPL"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});
