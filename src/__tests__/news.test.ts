import { NextRequest } from "next/server";

jest.mock("@/lib/db", () => ({
  getCached: jest.fn().mockReturnValue(null),
  getStale: jest.fn().mockReturnValue(null),
  setCached: jest.fn().mockReturnValue(Date.now()),
}));

jest.mock("openai", () => {
  return jest.fn().mockImplementation(() => ({
    responses: {
      create: jest.fn().mockResolvedValue({ output_text: "[]" }),
    },
  }));
});

jest.mock("child_process", () => ({ exec: jest.fn() }));
jest.mock("util", () => ({ promisify: (fn: any) => fn }));

const mockFetch = jest.fn();
global.fetch = mockFetch;

function makeRequest(q?: string, ticker?: string) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (ticker) params.set("ticker", ticker);
  return new NextRequest(`http://localhost/api/news?${params}`);
}

const yahooRss = `<?xml version="1.0"?>
<rss><channel>
  <item><title><![CDATA[Apple hits record high]]></title><link>https://finance.yahoo.com/1</link><description><![CDATA[Apple stock rose today.]]></description></item>
</channel></rss>`;

const redditJson = {
  data: {
    children: [
      { data: { title: "AAPL to the moon", selftext: "Strong earnings", permalink: "/r/stocks/1", score: 500 } },
    ],
  },
};

describe("GET /api/news", () => {
  let GET: (req: NextRequest) => Promise<Response>;
  const { getCached } = require("@/lib/db");

  beforeAll(async () => {
    ({ GET } = await import("@/app/api/news/route"));
  });

  beforeEach(() => {
    mockFetch.mockReset();
    getCached.mockReturnValue(null);
  });

  it("returns 400 when query param is missing", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/query is required/i);
  });

  it("returns cached data without calling fetch", async () => {
    getCached.mockReturnValue({
      data: { social: [{ title: "cached post", source: "Reddit" }] },
      cachedAt: Date.now(),
    });

    const res = await GET(makeRequest("AAPL", "AAPL"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.social[0].title).toBe("cached post");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("aggregates Yahoo Finance RSS results", async () => {
    // Yahoo RSS
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => yahooRss });
    // Reddit general
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => redditJson });
    // Reddit WSB
    mockFetch.mockResolvedValueOnce({ ok: false });

    const res = await GET(makeRequest("AAPL", "AAPL"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const sources = body.social.map((s: any) => s.source);
    expect(sources).toContain("Yahoo Finance");
  });

  it("includes Reddit posts in the social array", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, text: async () => "" }); // Yahoo fails
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => redditJson }); // Reddit general
    mockFetch.mockResolvedValueOnce({ ok: false }); // Reddit WSB fails

    const res = await GET(makeRequest("AAPL", "AAPL"));
    const body = await res.json();
    const redditPost = body.social.find((s: any) => s.source === "Reddit");
    expect(redditPost).toBeDefined();
    expect(redditPost.title).toBe("AAPL to the moon");
  });

  it("returns empty social array when all sources fail", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));

    const res = await GET(makeRequest("AAPL", "AAPL"));
    // Should still succeed (each source failure is caught individually)
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.social)).toBe(true);
  });

  it("returns 500 when an unexpected top-level error occurs and no stale cache", async () => {
    const { setCached } = require("@/lib/db");
    setCached.mockImplementationOnce(() => { throw new Error("db write failed"); });
    mockFetch.mockResolvedValue({ ok: false });

    const res = await GET(makeRequest("AAPL", "AAPL"));
    expect(res.status).toBe(500);
  });
});
