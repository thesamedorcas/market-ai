import { NextRequest } from "next/server";

jest.mock("@/lib/db", () => ({
  getCached: jest.fn().mockReturnValue(null),
  getStale: jest.fn().mockReturnValue(null),
  setCached: jest.fn().mockReturnValue(Date.now()),
}));

jest.mock("openai", () =>
  jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{ message: { content: "Bullish outlook for the next 4 weeks." } }],
        }),
      },
    },
  }))
);

const mockFetch = jest.fn();
global.fetch = mockFetch;

function makeRequest(ticker?: string) {
  const url = ticker
    ? `http://localhost/api/multi-agent?ticker=${ticker}`
    : "http://localhost/api/multi-agent";
  return new NextRequest(url);
}

function mockMarketData(price = 150) {
  return {
    ok: true,
    json: async () => ({
      symbol: "AAPL",
      shortName: "Apple Inc.",
      regularMarketPrice: price,
      regularMarketChange: 1.5,
      regularMarketChangePercent: 1.01,
      currency: "USD",
      fiftyTwoWeekHigh: 200,
      fiftyTwoWeekLow: 120,
      historicalData: [{ date: "2024-01-01", close: price }],
      cachedAt: Date.now(),
    }),
  };
}

function mockNewsData(posts: any[] = []) {
  return {
    ok: true,
    json: async () => ({ social: posts, cachedAt: Date.now() }),
  };
}

/** Reads the full SSE stream and returns parsed events */
async function readSSE(res: Response): Promise<{ event: string; data: any }[]> {
  const text = await res.text();
  const events: { event: string; data: any }[] = [];
  const blocks = text.split("\n\n").filter(Boolean);
  for (const block of blocks) {
    const lines = block.split("\n");
    const eventLine = lines.find((l) => l.startsWith("event:"));
    const dataLine = lines.find((l) => l.startsWith("data:"));
    if (eventLine && dataLine) {
      events.push({
        event: eventLine.replace("event:", "").trim(),
        data: JSON.parse(dataLine.replace("data:", "").trim()),
      });
    }
  }
  return events;
}

describe("GET /api/multi-agent", () => {
  let GET: (req: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    ({ GET } = await import("@/app/api/multi-agent/route"));
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns 400 when ticker param is missing", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/ticker is required/i);
  });

  it("streams SSE with Content-Type text/event-stream", async () => {
    mockFetch.mockResolvedValue(mockMarketData());
    mockFetch.mockResolvedValueOnce(mockMarketData()); // market-data
    mockFetch.mockResolvedValueOnce(mockNewsData());   // news

    const res = await GET(makeRequest("AAPL"));
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });

  it("resolves ticker alias: 'bitcoin' → 'BTC-USD'", async () => {
    // Yahoo autocomplete not needed — alias map handles it
    mockFetch.mockResolvedValueOnce(mockMarketData(60000)); // market-data
    mockFetch.mockResolvedValueOnce(mockNewsData());         // news

    const res = await GET(makeRequest("bitcoin"));
    const events = await readSSE(res);
    const statusMessages = events.filter((e) => e.event === "status").map((e) => e.data.message);
    expect(statusMessages.some((m: string) => m.includes("BTC-USD"))).toBe(true);
  });

  it("emits a result event with marketData and summary", async () => {
    mockFetch.mockResolvedValueOnce(mockMarketData(175));
    mockFetch.mockResolvedValueOnce(mockNewsData([{ title: "AAPL soars", source: "Reddit" }]));

    const res = await GET(makeRequest("AAPL"));
    const events = await readSSE(res);

    const result = events.find((e) => e.event === "result");
    expect(result).toBeDefined();
    expect(result!.data.marketData.regularMarketPrice).toBe(175);
    expect(typeof result!.data.summary).toBe("string");
    expect(result!.data.summary.length).toBeGreaterThan(0);
  });

  it("emits an error event when market data fetch fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: "failed" }) });
    mockFetch.mockResolvedValueOnce(mockNewsData());

    const res = await GET(makeRequest("AAPL"));
    const events = await readSSE(res);

    const errorEvent = events.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();
  });

  it("includes resolved ticker in result even when input was lowercase", async () => {
    mockFetch.mockResolvedValueOnce(mockMarketData());
    mockFetch.mockResolvedValueOnce(mockNewsData());

    const res = await GET(makeRequest("gold"));
    const events = await readSSE(res);
    const result = events.find((e) => e.event === "result");
    expect(result!.data.resolvedTicker).toBe("GLD");
  });
});
