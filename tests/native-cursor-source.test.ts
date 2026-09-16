import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAppAuthCookieHeader,
  cursorConfigCookiePath,
  decodeCursorJwtPayload,
  readAppDatabaseCookie,
  readStateDbValue,
  resolveCursorCredential,
} from "../src/main/vellum-command/usage/cursor-auth";
import {
  buildCursorQuota,
  buildCursorSnapshot,
  computePrimaryPercent,
  probeCursorUsage,
  reconcileEventPages,
  redactSecrets,
  summarizeEventCosts,
  type CursorEventsPageData,
  type FetchLike,
} from "../src/main/vellum-command/usage/cursor-source";

const FETCHED = "2026-08-17T12:00:00.000Z";
const SECRET_COOKIE = "WorkosCursorSessionToken=abc123SECRET%3A%3Aey.jwt.token";

// ---------------------------------------------------------------------------
// Fixtures modeled on the real cursor.com response shapes.
// ---------------------------------------------------------------------------

const SUMMARY_FIXTURE = {
  billingCycleStart: "2026-08-01T00:00:00.000Z",
  billingCycleEnd: "2026-09-01T00:00:00.000Z",
  membershipType: "pro",
  individualUsage: {
    plan: {
      enabled: true,
      used: 1500, // cents
      limit: 2000, // cents
      remaining: 500,
      autoPercentUsed: 40,
      apiPercentUsed: 60,
      totalPercentUsed: 55.5,
    },
    onDemand: { enabled: true, used: 7384, limit: 10000, remaining: 2616 },
  },
};

const ME_FIXTURE = {
  email: "dev@example.com",
  email_verified: true,
  name: "Dev Coder",
  sub: "auth0|64fabc123",
};

const SAND_FIXTURE = {
  currentPeriodStart: "2026-08-10T00:00:00.000Z",
  nextResetTimestampUtc: "2026-08-17T00:00:00.000Z",
  usagePercent: 25,
  hasAvailableUsage: true,
  hasNonZeroIncludedLimit: true,
};

const eventOf = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  timestamp: 1_755_000_000_000,
  model: "claude-4-sonnet",
  tokenUsage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalCents: 100 },
  chargedCents: 50,
  ...overrides,
});

const pageOf = (rows: Array<Record<string, unknown>>, total?: number): CursorEventsPageData => ({
  usageEventsDisplay: rows,
  ...(total !== undefined ? { totalUsageEventsCount: total } : {}),
});

// ---------------------------------------------------------------------------
// Minimal SQLite fixture builder (hand-built bytes, no sqlite dependency).
// ---------------------------------------------------------------------------

const be16 = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff];
const be32 = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >> 16) & 0xff,
  (value >> 8) & 0xff,
  value & 0xff,
];

const varintBytes = (value: number): number[] => {
  if (value === 0) return [0];
  const groups: number[] = [];
  let rest = value;
  while (rest > 0) {
    groups.unshift(rest % 128);
    rest = Math.floor(rest / 128);
  }
  return groups.map((g, i) => (i === groups.length - 1 ? g : g | 0x80));
};

type Column = string | number;

const recordBytes = (columns: ReadonlyArray<Column>): Buffer => {
  const serials: number[] = [];
  const bodies: Buffer[] = [];
  for (const column of columns) {
    if (typeof column === "number") {
      serials.push(4); // 32-bit int
      const bytes = be32(column);
      bodies.push(Buffer.from(column < 0 ? bytes.map((b) => b) : bytes));
    } else {
      const body = Buffer.from(column, "utf8");
      serials.push(13 + 2 * body.length);
      bodies.push(body);
    }
  }
  const serialPayload = Buffer.from(serials.flatMap((s) => varintBytes(s)));
  const headerLen = serialPayload.length + 1;
  return Buffer.concat([Buffer.from(varintBytes(headerLen)), serialPayload, ...bodies]);
};

interface FixtureRow {
  readonly rowid: number;
  readonly payload: Buffer;
  readonly overflowPage?: number;
}

const leafCell = (db: { usableSize: number }, row: FixtureRow): Buffer => {
  const P = row.payload.length;
  const X = db.usableSize - 35;
  if (P <= X) {
    return Buffer.concat([Buffer.from(varintBytes(P)), Buffer.from(varintBytes(row.rowid)), row.payload]);
  }
  const M = Math.floor(((db.usableSize - 12) * 32) / 255) - 23;
  const K = M + ((P - M) % (db.usableSize - 4));
  const local = K <= X ? K : M;
  return Buffer.concat([
    Buffer.from(varintBytes(P)),
    Buffer.from(varintBytes(row.rowid)),
    row.payload.subarray(0, local),
    Buffer.from(be32(row.overflowPage ?? 0)),
  ]);
};

/**
 * Build a tiny valid SQLite database: page 1 holds the schema leaf with one
 * ItemTable row; page 2 is the ItemTable leaf; overflow pages follow.
 */
const buildStateDb = (keyValueRows: ReadonlyArray<readonly [string, string]>, pageSize = 512): Buffer => {
  const reserved = 0;
  const usableSize = pageSize - reserved;
  const db = { usableSize };

  const schemaRow: FixtureRow = {
    rowid: 1,
    payload: recordBytes(["table", "ItemTable", "ItemTable", 2, "CREATE TABLE ItemTable (key TEXT, value BLOB)"]),
  };
  const dataRows: FixtureRow[] = keyValueRows.map(([key, value], index) => ({
    rowid: index + 1,
    payload: recordBytes([key, value]),
  }));

  // Reserve pages: 1 schema, 2 data, then one overflow page per spilling row.
  let nextPage = 3;
  for (const row of dataRows) {
    const X = usableSize - 35;
    if (row.payload.length > X) {
      (row as { overflowPage?: number }).overflowPage = nextPage;
      nextPage += 1;
    }
  }

  const makeLeafPage = (pageNumber: number, rows: ReadonlyArray<FixtureRow>, headerOffset: number): Buffer => {
    const cells = rows.map((row) => ({ offset: 0, bytes: leafCell(db, row) }));
    const pointerArraySize = cells.length * 2;
    const headerSize = 8;
    let contentEnd = pageSize;
    const cellOffsets: number[] = [];
    for (let i = cells.length - 1; i >= 0; i -= 1) {
      contentEnd -= cells[i].bytes.length;
      cellOffsets[i] = contentEnd;
    }
    const page = Buffer.alloc(pageSize, 0);
    page[headerOffset] = 13; // leaf table
    page.writeUInt16BE(0, headerOffset + 1); // first freeblock
    page.writeUInt16BE(cells.length, headerOffset + 3);
    page.writeUInt16BE(contentEnd === pageSize ? 0 : contentEnd, headerOffset + 5);
    page[headerOffset + 7] = 0; // fragmented bytes
    cells.forEach((cell, i) => {
      page.writeUInt16BE(cellOffsets[i], headerOffset + headerSize + i * 2);
      cell.bytes.copy(page, cellOffsets[i]);
    });
    void pageNumber;
    return page;
  };

  const page1 = makeLeafPage(1, [schemaRow], 100);
  const header = Buffer.alloc(100, 0);
  Buffer.from("SQLite format 3\u0000", "latin1").copy(header, 0);
  header.writeUInt16BE(pageSize === 65536 ? 1 : pageSize, 16);
  header[18] = 1;
  header[19] = 1;
  header[20] = reserved;
  header.writeUInt32BE(nextPage - 1, 28); // page count
  header.writeUInt32BE(4, 44); // schema format
  header.writeUInt32BE(1, 56); // UTF-8
  header.copy(page1, 0);

  const page2 = makeLeafPage(2, dataRows, 0);

  const overflowPages: Buffer[] = [];
  for (const row of dataRows) {
    const overflowPage = row.overflowPage;
    if (overflowPage === undefined) continue;
    const X = usableSize - 35;
    const M = Math.floor(((usableSize - 12) * 32) / 255) - 23;
    const K = M + ((row.payload.length - M) % (usableSize - 4));
    const local = K <= X ? K : M;
    const spill = row.payload.subarray(local);
    const chunk = spill.subarray(0, usableSize - 4);
    const page = Buffer.alloc(pageSize, 0);
    page.writeUInt32BE(0, 0);
    chunk.copy(page, 4);
    overflowPages.push(page);
  }

  return Buffer.concat([page1, page2, ...overflowPages]);
};

const makeJwt = (payload: Record<string, unknown>): string => {
  const head = Buffer.from('{"alg":"RS256","typ":"JWT"}').toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${head}.${body}.signature`;
};

// ---------------------------------------------------------------------------
// Window decoding
// ---------------------------------------------------------------------------

describe("computePrimaryPercent precedence", () => {
  it("prefers plan.totalPercentUsed", () => {
    expect(computePrimaryPercent(SUMMARY_FIXTURE)).toBe(55.5);
  });

  it("averages auto and api lanes when totalPercentUsed is absent", () => {
    const summary = {
      individualUsage: { plan: { used: 10, limit: 100, autoPercentUsed: 30, apiPercentUsed: 70 } },
    };
    expect(computePrimaryPercent(summary)).toBe(50);
  });

  it("falls back to either lane alone", () => {
    expect(
      computePrimaryPercent({ individualUsage: { plan: { used: 10, limit: 100, autoPercentUsed: 33 } } }),
    ).toBe(33);
  });

  it("falls back to plan cents ratio, then overall cap, then team pool", () => {
    expect(computePrimaryPercent({ individualUsage: { plan: { used: 250, limit: 1000 } } })).toBe(25);
    expect(
      computePrimaryPercent({ individualUsage: { overall: { used: 7384, limit: 10000 } } }),
    ).toBeCloseTo(73.84);
    expect(computePrimaryPercent({ teamUsage: { pooled: { used: 5000, limit: 10000 } } })).toBe(50);
    expect(computePrimaryPercent({})).toBe(0);
  });

  it("clamps runaway percentages into 0..100", () => {
    expect(computePrimaryPercent({ individualUsage: { plan: { totalPercentUsed: 183 } } })).toBe(100);
    expect(computePrimaryPercent({ individualUsage: { plan: { autoPercentUsed: -5 } } })).toBe(0);
  });
});

describe("buildCursorQuota", () => {
  it("maps summary + identity into labeled windows with cycle fields", () => {
    const quota = buildCursorQuota(
      { summary: SUMMARY_FIXTURE, userInfo: ME_FIXTURE },
      undefined,
      FETCHED,
    );
    expect(quota.provider).toBe("cursor");
    expect(quota.source).toBe("web");
    expect(quota.status).toBe("ok");
    expect(quota.account).toBe("dev@example.com");
    expect(quota.plan).toBe("Cursor Pro");
    expect(quota.updatedAt).toBe(FETCHED);
    const [primary, secondary, tertiary] = quota.windows;
    expect(primary.label).toBe("primary");
    expect(primary.usedPercent).toBe(55.5);
    expect(primary.windowMinutes).toBe(31 * 24 * 60);
    expect(primary.resetsAt).toBe("2026-09-01T00:00:00.000Z");
    expect(primary.resetDescription).toMatch(/^Resets (Aug 31|Sep 1) at \d{1,2}:\d{2}(AM|PM)$/);
    expect(secondary?.label).toBe("secondary");
    expect(secondary?.title).toBe("Auto");
    expect(secondary?.usedPercent).toBe(40);
    expect(tertiary?.label).toBe("tertiary");
    expect(tertiary?.title).toBe("API");
    expect(tertiary?.usedPercent).toBe(60);
    expect(quota.extras?.onDemand).toMatchObject({ enabled: true, usedCents: 7384, limitCents: 10000 });
    expect(quota.extras?.costs).toBeUndefined();
  });

  it("appends the Grok Bot weekly extra window only with a nonzero included limit", () => {
    const withSand = buildCursorQuota(
      { summary: SUMMARY_FIXTURE, sandUsage: SAND_FIXTURE },
      undefined,
      FETCHED,
    );
    const extra = withSand.windows.find((w) => w.label === "extra");
    expect(extra?.id).toBe("cursor-grok-bot");
    expect(extra?.title).toBe("Grok Bot");
    expect(extra?.usedPercent).toBe(25);
    expect(extra?.windowMinutes).toBe(7 * 24 * 60);

    const withoutLimit = buildCursorQuota(
      { summary: SUMMARY_FIXTURE, sandUsage: { ...SAND_FIXTURE, hasNonZeroIncludedLimit: false } },
      undefined,
      FETCHED,
    );
    expect(withoutLimit.windows.find((w) => w.label === "extra")).toBeUndefined();
    const withoutPercent = buildCursorQuota(
      { summary: SUMMARY_FIXTURE, sandUsage: { hasNonZeroIncludedLimit: true } },
      undefined,
      FETCHED,
    );
    expect(withoutPercent.windows.find((w) => w.label === "extra")).toBeUndefined();
  });

  it("renders legacy request plans as a request-quota primary and hides Auto/API lanes", () => {
    const quota = buildCursorQuota(
      {
        summary: SUMMARY_FIXTURE,
        requestUsage: { "gpt-4": { numRequestsTotal: 120, maxRequestUsage: 500 } },
      },
      undefined,
      FETCHED,
    );
    const primary = quota.windows[0];
    expect(primary.usedPercent).toBe(24);
    expect(primary.resetDescription).toBe("120 / 500 requests");
    expect(quota.windows.find((w) => w.title === "Auto")).toBeUndefined();
    expect(quota.windows.find((w) => w.title === "API")).toBeUndefined();
  });

  it("carries cost extras without ever merging the two provenances", () => {
    const costs = summarizeEventCosts(
      [eventOf({}), eventOf({ model: "gpt-5", tokenUsage: { inputTokens: 1, outputTokens: 1, totalCents: 41 }, chargedCents: 9 })],
      true,
    );
    const quota = buildCursorQuota({ summary: SUMMARY_FIXTURE }, costs, FETCHED);
    const costsExtras = quota.extras?.costs as Record<string, Record<string, unknown>>;
    expect(costsExtras.listPriceEstimate).toEqual({ provenance: "listPriceEstimate", totalCents: 141 });
    expect(costsExtras.vendorMetered).toEqual({ provenance: "vendorMetered", totalCents: 59 });
  });
});

// ---------------------------------------------------------------------------
// Events pagination reconciliation
// ---------------------------------------------------------------------------

describe("reconcileEventPages", () => {
  it("completes on a short final page and preserves order", () => {
    const pages = [pageOf(Array.from({ length: 3 }, () => eventOf({})), 5), pageOf(Array.from({ length: 2 }, () => eventOf({})), 5)];
    const result = reconcileEventPages(pages, 3, 200); // page size 3 makes page one full
    expect(result.complete).toBe(true);
    expect(result.events).toHaveLength(5);
  });

  it("completes on an empty page", () => {
    const result = reconcileEventPages([pageOf(Array.from({ length: 2 }, () => eventOf({}))), pageOf([])]);
    expect(result.complete).toBe(true);
    expect(result.events).toHaveLength(2);
  });

  it("removes boundary duplicates only up to the proven surplus count", () => {
    // Two identical events straddle the page boundary; the reported total of
    // 3 proves exactly one duplicate row must go. Page size 2 makes both
    // data pages full; the trailing empty page proves completion.
    const dupA = eventOf({ timestamp: 111 });
    const dupB = eventOf({ timestamp: 222 });
    const unique = eventOf({ timestamp: 333 });
    const result = reconcileEventPages(
      [pageOf([dupA, dupB], 3), pageOf([dupB, unique], 3), pageOf([], 3)],
      2,
    );
    expect(result.complete).toBe(true);
    expect(result.events).toHaveLength(3);
    expect(result.events.map((e) => e.timestamp)).toEqual([111, 222, 333]);
  });

  it("degrades to partial when reported totals disagree across pages", () => {
    const pages = [pageOf(Array.from({ length: 2 }, () => eventOf({})), 4), pageOf([eventOf({})], 9)];
    const result = reconcileEventPages(pages, 1000, 200);
    expect(result.complete).toBe(false);
  });

  it("treats a full final page at the safety cap as incomplete", () => {
    const pages = Array.from({ length: 2 }, () => pageOf(Array.from({ length: 2 }, () => eventOf({}))));
    const result = reconcileEventPages(pages, 2, 2);
    expect(result.complete).toBe(false);
    expect(result.events).toHaveLength(4);
  });
});

describe("summarizeEventCosts", () => {
  it("sums list-price and metered cents separately over valid events", () => {
    const costs = summarizeEventCosts(
      [eventOf({}), eventOf({ chargedCents: 25, tokenUsage: { totalCents: 30 } })],
      true,
    );
    expect(costs.listPriceCents).toBe(130);
    expect(costs.meteredCents).toBe(75);
  });

  it("never publishes metered totals when any valid event lacks chargedCents", () => {
    const costs = summarizeEventCosts([eventOf({}), eventOf({ chargedCents: undefined })], true);
    expect(costs.listPriceCents).toBeGreaterThan(0);
    expect(costs.meteredCents).toBeUndefined();
  });

  it("withholds metered spend entirely under partial pagination", () => {
    const costs = summarizeEventCosts([eventOf({})], false);
    expect(costs.meteredCents).toBeUndefined();
    expect(costs.listPriceCents).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Envelopes + redaction
// ---------------------------------------------------------------------------

describe("envelopes and redaction", () => {
  it("auth-failure envelope names the status and carries no secret material", () => {
    const snapshot = buildCursorSnapshot(FETCHED, {
      kind: "unavailable",
      reason: "cli-error",
      error: redactSecrets(
        `cursor.com rejected credentials (401) near ${SECRET_COOKIE}`,
        [SECRET_COOKIE],
      ),
    });
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("cli-error");
    expect(snapshot.error).toContain("(401)");
    expect(snapshot.error).not.toContain("abc123SECRET");
    expect(snapshot.error).toContain("[redacted]");
    expect(snapshot.quotas).toEqual([]);
  });

  it("redactSecrets scrubs every occurrence of long secrets but ignores short noise", () => {
    const text = `token=${SECRET_COOKIE} token=${SECRET_COOKIE} ok`;
    expect(redactSecrets(text, [SECRET_COOKIE])).toBe("token=[redacted] token=[redacted] ok");
    expect(redactSecrets("abc", ["abc"])).toBe("abc"); // too short to scrub safely
  });

  it("missing credentials fold into a source-missing envelope", () => {
    const emptyHome = mkdtempSync(join(tmpdir(), "cursor-missing-"));
    try {
      const outcome = resolveCursorCredential({
        env: {},
        home: emptyHome,
        configPath: join(emptyHome, "absent-cookie"),
        appDbPath: join(emptyHome, "absent.vscdb"),
      });
      expect(outcome.kind).toBe("missing");
      const snapshot = buildCursorSnapshot(FETCHED, {
        kind: "unavailable",
        reason: "source-missing",
        error: outcome.kind === "missing" ? outcome.error : "",
      });
      expect(snapshot.ok).toBe(false);
      expect(snapshot.reason).toBe("source-missing");
      expect(snapshot.error).toContain("CURSOR_COOKIE");
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Credential discovery
// ---------------------------------------------------------------------------

describe("resolveCursorCredential", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    while (cleanup.length > 0) {
      const dir = cleanup.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers the env cookie over the config file", () => {
    const home = mkdtempSync(join(tmpdir(), "cursor-env-"));
    cleanup.push(home);
    mkdirSync(join(home, ".junto", "config"), { recursive: true });
    writeFileSync(cursorConfigCookiePath(home), "next-auth.session-token=config-file-value");
    const outcome = resolveCursorCredential({
      env: { CURSOR_COOKIE: "env-cookie-value" },
      home,
      appDbPath: join(home, "absent.vscdb"),
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.credential.cookieHeader).toBe("env-cookie-value");
      expect(outcome.credential.origin).toBe("env");
    }
  });

  it("discovers the config-file cookie and skips blank files", () => {
    const home = mkdtempSync(join(tmpdir(), "cursor-cfg-"));
    cleanup.push(home);
    mkdirSync(join(home, ".junto", "config"), { recursive: true });
    writeFileSync(cursorConfigCookiePath(home), "  \n");
    expect(resolveCursorCredential({ env: {}, home, appDbPath: join(home, "a.vscdb") }).kind).toBe("missing");
    writeFileSync(cursorConfigCookiePath(home), "wos-session=file-value");
    const outcome = resolveCursorCredential({ env: {}, home, appDbPath: join(home, "a.vscdb") });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.credential.origin).toBe("config-file");
      expect(outcome.credential.cookieHeader).toBe("wos-session=file-value");
    }
  });

  it("reads the Cursor app session DB and rebuilds the Workos cookie", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const jwt = makeJwt({ sub: "auth0|user42", email: "app@example.com", exp: nowSeconds + 3600 });
    const home = mkdtempSync(join(tmpdir(), "cursor-db-"));
    cleanup.push(home);
    const dbPath = join(home, "state.vscdb");
    const bigValue = "y".repeat(700); // spills past the inline-payload threshold
    writeFileSync(
      dbPath,
      buildStateDb([
        ["other/key", "noise"],
        ["cursorAuth/accessToken", jwt],
        ["other/big", bigValue],
      ]),
    );

    expect(readStateDbValue(dbPath, "cursorAuth/accessToken")).toBe(jwt);
    expect(readStateDbValue(dbPath, "other/big")).toBe(bigValue);
    const outcome = resolveCursorCredential({ env: {}, home, configPath: join(home, "none"), appDbPath: dbPath });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.credential.origin).toBe("app-database");
      expect(outcome.credential.cookieHeader.startsWith("WorkosCursorSessionToken=user42%3A%3A")).toBe(true);
    }
  });

  it("rejects an expired app-database token instead of shipping stale auth", () => {
    const expired = makeJwt({ sub: "auth0|user42", exp: Math.floor(Date.now() / 1000) - 10_000 });
    const home = mkdtempSync(join(tmpdir(), "cursor-exp-"));
    cleanup.push(home);
    const dbPath = join(home, "state.vscdb");
    writeFileSync(dbPath, buildStateDb([["cursorAuth/accessToken", expired]]));
    const outcome = resolveCursorCredential({ env: {}, home, configPath: join(home, "none"), appDbPath: dbPath });
    expect(outcome.kind).toBe("missing");
  });

  it("decodes JWT identities and refuses non-JWT tokens", () => {
    const jwt = makeJwt({ sub: "auth0|user42", email: "x@example.com", exp: 1_900_000_000 });
    expect(decodeCursorJwtPayload(jwt)).toMatchObject({ sub: "auth0|user42", email: "x@example.com" });
    expect(decodeCursorJwtPayload("garbage")).toBeUndefined();
    expect(buildAppAuthCookieHeader("not-a-jwt")).toBeUndefined();
    const cookie = buildAppAuthCookieHeader(jwt);
    expect(cookie).toContain("user42%3A%3A");
    expect(cookie?.includes("user42::")).toBe(false); // separator stays percent-encoded
  });
});

// ---------------------------------------------------------------------------
// Live probe against an injected transport (no network)
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly url: string;
  readonly init?: RequestInit;
}

const transportFor = (
  routes: ReadonlyArray<{ readonly match: RegExp; readonly status: number; readonly body?: unknown }>,
  recorded: RecordedCall[],
): FetchLike => {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    recorded.push({ url, init });
    const route = routes.find((candidate) => candidate.match.test(url));
    if (route === undefined) throw new Error(`unexpected URL ${url}`);
    if (route.status >= 400) {
      return new Response(route.body === undefined ? "nope" : JSON.stringify(route.body), { status: route.status });
    }
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status,
      headers: { "Content-Type": "application/json" },
    });
  };
};

describe("probeCursorUsage", () => {
  it("fans out concurrently and builds a live snapshot from all four endpoints", async () => {
    const recorded: RecordedCall[] = [];
    const fetch = transportFor(
      [
        { match: /\/api\/usage-summary$/, status: 200, body: SUMMARY_FIXTURE },
        { match: /\/api\/auth\/me$/, status: 200, body: ME_FIXTURE },
        { match: /get-sand-usage-status$/, status: 200, body: SAND_FIXTURE },
        {
          match: /get-filtered-usage-events$/,
          status: 200,
          body: { usageEventsDisplay: [eventOf({}), eventOf({ chargedCents: 25, tokenUsage: { totalCents: 30 } })], totalUsageEventsCount: 2 },
        },
      ],
      recorded,
    );
    const snapshot = await probeCursorUsage(SECRET_COOKIE, { fetch });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.source).toBe("cursor");
    expect(snapshot.dataConfidence).toBe("live");
    const quota = snapshot.quotas[0];
    expect(quota?.account).toBe("dev@example.com");
    expect(quota?.plan).toBe("Cursor Pro");
    expect(quota?.windows.map((w) => w.label)).toEqual(["primary", "secondary", "tertiary", "extra"]);
    const costsExtras = quota?.extras?.costs as Record<string, Record<string, unknown>>;
    expect(costsExtras.listPriceEstimate).toEqual({ provenance: "listPriceEstimate", totalCents: 130 });
    expect(costsExtras.vendorMetered).toEqual({ provenance: "vendorMetered", totalCents: 75 });
    // POST endpoints carry the CSRF Origin header.
    const posts = recorded.filter((call) => call.init?.method === "POST");
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      const headers = new Headers(post.init?.headers);
      expect(headers.get("Origin")).toBe("https://cursor.com");
      expect(headers.get("Cookie")).toBe(SECRET_COOKIE);
    }
    expect(recorded.some((call) => call.url.includes("/api/auth/me"))).toBe(true);
  });

  it("folds a 401 into an auth-failure envelope with the credential redacted", async () => {
    const fetch = transportFor([{ match: /\/api\/usage-summary$/, status: 401 }], []);
    const snapshot = await probeCursorUsage(SECRET_COOKIE, { fetch });
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("cli-error");
    expect(snapshot.error).toContain("(401)");
    expect(snapshot.error).not.toContain("abc123SECRET");
    expect(snapshot.error).not.toContain(SECRET_COOKIE);
    expect(snapshot.quotas).toEqual([]);
  });

  it("keeps the quota alive when optional endpoints fail or cost pagination dies", async () => {
    const recorded: RecordedCall[] = [];
    const fetch = transportFor(
      [
        { match: /\/api\/usage-summary$/, status: 200, body: SUMMARY_FIXTURE },
        { match: /\/api\/auth\/me$/, status: 500, body: {} },
        { match: /get-sand-usage-status$/, status: 500, body: {} },
        { match: /get-filtered-usage-events$/, status: 500, body: {} },
      ],
      recorded,
    );
    const snapshot = await probeCursorUsage(SECRET_COOKIE, { fetch });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.dataConfidence).toBe("live");
    const quota = snapshot.quotas[0];
    expect(quota?.windows.map((w) => w.label)).toEqual(["primary", "secondary", "tertiary"]);
    expect(quota?.extras?.costs).toBeUndefined();
  });

  it("marks list-price costs partial when pagination cannot finish", async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => eventOf({ timestamp: 1_755_000_000_000 + i }));
    const fetch = transportFor(
      [
        { match: /\/api\/usage-summary$/, status: 200, body: SUMMARY_FIXTURE },
        { match: /get-filtered-usage-events$/, status: 200, body: { usageEventsDisplay: fullPage, totalUsageEventsCount: 999_999 } },
      ],
      [],
    );
    const snapshot = await probeCursorUsage(SECRET_COOKIE, { fetch });
    expect(snapshot.ok).toBe(true);
    const costsExtras = snapshot.quotas[0]?.extras?.costs as Record<string, Record<string, unknown>>;
    expect(costsExtras.listPriceEstimate.partial).toBe(true);
    expect(costsExtras.vendorMetered).toBeUndefined();
  });
});
