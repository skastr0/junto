import { describe, expect, it } from "vitest";
import {
  decodeGrokAuthPayload,
  isGrokCredentialExpired,
} from "../src/main/junto/usage/grok-auth";
import {
  grpcWebDataFrames,
  grpcWebTrailerFields,
  grokPrimaryTitle,
  normalizeGrokPlanName,
  parseGrokGrpcWebBilling,
  parseGrokProxyBilling,
  parseGrokSettingsTier,
  redactSecret,
} from "../src/main/junto/usage/grok-billing";
import {
  assembleGrokSnapshot,
  grokAuthRejectedError,
} from "../src/main/junto/usage/grok-source";

const FETCHED = "2026-08-01T12:00:00.000Z";
const NOW_MS = Date.parse(FETCHED);
const FAKE_TOKEN = "xai-super-secret-bearer-token-abc123";

const okQuota = (overrides: Record<string, unknown> = {}) => ({
  kind: "ok" as const,
  quota: {
    provider: "grok",
    source: "cli-proxy",
    status: "ok" as const,
    windows: [
      {
        label: "primary" as const,
        usedPercent: 42.5,
      },
    ],
    updatedAt: FETCHED,
    ...overrides,
  },
});

const unavailable = (
  reason: "cli-missing" | "cli-error" | "parse-error" | "source-missing",
  error: string,
  extra: Record<string, unknown> = {},
) => ({ kind: "unavailable" as const, reason, error, ...extra });

// ---------------------------------------------------------------------------
// Proxy billing decode
// ---------------------------------------------------------------------------

describe("parseGrokProxyBilling", () => {
  it("decodes creditUsagePercent, period end, and tier", () => {
    const snapshot = parseGrokProxyBilling({
      config: {
        creditUsagePercent: 137.5,
        currentPeriod: { end: "2026-08-08T00:00:00Z" },
        subscriptionTier: "supergrok",
      },
    });
    expect(snapshot).toEqual({
      usedPercent: 100,
      resetsAt: "2026-08-08T00:00:00.000Z",
      subscriptionTier: "SuperGrok",
    });
  });

  it("derives percent from onDemandUsed / onDemandCap cents", () => {
    const snapshot = parseGrokProxyBilling({
      config: {
        onDemandCap: { val: 10_000 },
        onDemandUsed: { val: 2_500 },
        billingPeriodEnd: "2026-09-01T00:00:00Z",
      },
    });
    expect(snapshot?.usedPercent).toBeCloseTo(25);
    expect(snapshot?.resetsAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("returns undefined without a config object", () => {
    expect(parseGrokProxyBilling({ subscriptionTier: "supergrok" })).toBeUndefined();
    expect(parseGrokProxyBilling("nope")).toBeUndefined();
  });
});

describe("plan name normalization", () => {
  it("maps heavy variants to SuperGrok Heavy", () => {
    expect(normalizeGrokPlanName("supergrok_heavy")).toBe("SuperGrok Heavy");
    expect(normalizeGrokPlanName("Heavy")).toBe("SuperGrok Heavy");
  });

  it("passes unknown tiers through untouched", () => {
    expect(normalizeGrokPlanName("Team Plan X")).toBe("Team Plan X");
    expect(normalizeGrokPlanName("  ")).toBeUndefined();
  });

  it("reads subscription_tier_display from /v1/settings", () => {
    expect(parseGrokSettingsTier({ subscription_tier_display: "superGrok heavy" })).toBe(
      "SuperGrok Heavy",
    );
    expect(parseGrokSettingsTier({})).toBeUndefined();
  });
});

describe("grokPrimaryTitle (weekly/monthly heuristic)", () => {
  it("reads 7 days as Weekly and 30 days as Monthly", () => {
    expect(grokPrimaryTitle(7 * 24 * 60, undefined, NOW_MS)).toBe("Weekly");
    expect(grokPrimaryTitle(30 * 24 * 60, undefined, NOW_MS)).toBe("Monthly");
  });

  it("keeps Weekly for untyped windows near reset", () => {
    expect(grokPrimaryTitle(undefined, NOW_MS + 3 * 24 * 60 * 60 * 1000, NOW_MS)).toBe("Weekly");
    expect(grokPrimaryTitle(undefined, NOW_MS - 1000, NOW_MS)).toBe("Weekly");
  });

  it("yields nothing without duration or reset", () => {
    expect(grokPrimaryTitle(undefined, undefined, NOW_MS)).toBeUndefined();
    expect(grokPrimaryTitle(2 * 24 * 60, undefined, NOW_MS)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// gRPC-web protobuf parsing
// ---------------------------------------------------------------------------

const varintBytes = (value: number): number[] => {
  const out: number[] = [];
  let v = value;
  for (;;) {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
    if (v === 0) break;
  }
  return out;
};

const tag = (field: number, wireType: number): number => (field << 3) | wireType;

const lenDelim = (field: number, bytes: number[]): number[] => [
  tag(field, 2),
  bytes.length,
  ...bytes,
];

const fixed32Field = (field: number, value: number): number[] => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return [tag(field, 5), ...Array.from(new Uint8Array(view.buffer))];
};

const varintField = (field: number, value: number): number[] => [
  tag(field, 0),
  ...varintBytes(value),
];

const frame = (payload: number[]): Uint8Array =>
  Uint8Array.from([
    0x00,
    (payload.length >> 24) & 0xff,
    (payload.length >> 16) & 0xff,
    (payload.length >> 8) & 0xff,
    payload.length & 0xff,
    ...payload,
  ]);

const RESET_EPOCH = Math.floor(NOW_MS / 1000) + 3 * 24 * 60 * 60; // future reset

const creditsFrame = (): Uint8Array => {
  // field 1 (message) containing: fixed32 percent at [1,1], nested message
  // field 7 carrying a deeper in-range decoy at [1,7,1], and field 5 message
  // whose field 1 is the preferred reset epoch.
  const inner = [
    ...fixed32Field(1, 37.5),
    ...lenDelim(7, fixed32Field(1, 90)),
    ...lenDelim(5, varintField(1, RESET_EPOCH)),
    ...varintField(2, 7), // usage-period marker under [1,6]-style path family
  ];
  return frame(lenDelim(1, inner));
};

describe("grpc-web frame helpers", () => {
  it("splits data frames and skips trailer frames", () => {
    const data = new Uint8Array([0x00, 0, 0, 0, 2, 1, 2, 0x80, 0, 0, 0, 3, 9, 9, 9]);
    const frames = grpcWebDataFrames(data);
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0]!)).toEqual([1, 2]);
  });

  it("parses percent-decoded trailer fields", () => {
    const text = new TextEncoder().encode("grpc-status: 16\r\ngrpc-message: no%20personal%20team");
    const data = new Uint8Array([0x80, 0, 0, 0, text.length, ...text]);
    const fields = grpcWebTrailerFields(data);
    expect(fields["grpc-status"]).toBe("16");
    expect(fields["grpc-message"]).toBe("no personal team");
  });
});

describe("parseGrokGrpcWebBilling", () => {
  it("finds the shallowest in-range percent and the preferred reset path", () => {
    const outcome = parseGrokGrpcWebBilling(creditsFrame(), NOW_MS);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.snapshot.usedPercent).toBeCloseTo(37.5);
    expect(outcome.snapshot.wirePublished).toBe(true);
    expect(outcome.snapshot.resetsAt).toBe(new Date(RESET_EPOCH * 1000).toISOString());
  });

  it("fabricates a flagged zero for a no-usage-yet period frame", () => {
    const payload = lenDelim(1, [
      ...lenDelim(5, varintField(1, RESET_EPOCH)),
      ...varintField(6, 1),
    ]);
    const outcome = parseGrokGrpcWebBilling(frame(payload), NOW_MS);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.snapshot.usedPercent).toBe(0);
    expect(outcome.snapshot.wirePublished).toBe(false);
  });

  it("surfaces non-zero grpc-status trailers as errors", () => {
    const text = new TextEncoder().encode("grpc-status: 16\r\ngrpc-message: no-credentials");
    const outcome = parseGrokGrpcWebBilling(new Uint8Array([0x80, 0, 0, 0, text.length, ...text]), NOW_MS);
    expect(outcome.kind).toBe("error");
  });

  it("errors on garbage bodies instead of throwing", () => {
    expect(parseGrokGrpcWebBilling(new Uint8Array([1, 2, 3]), NOW_MS).kind).toBe("error");
    expect(parseGrokGrpcWebBilling(new Uint8Array(), NOW_MS).kind).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Auth decode + redaction
// ---------------------------------------------------------------------------

describe("decodeGrokAuthPayload", () => {
  const oidcEntry = {
    key: FAKE_TOKEN,
    auth_mode: "oidc",
    email: "ops@example.com",
    expires_at: "2030-01-01T00:00:00.000Z",
  };

  it("prefers the OIDC scope over the legacy sign-in scope", () => {
    const outcome = decodeGrokAuthPayload({
      "https://accounts.x.ai/sign-in": { key: "legacy-token-value-0001" },
      "https://auth.x.ai::supergrok": oidcEntry,
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.credentials.accessToken).toBe(FAKE_TOKEN);
    expect(outcome.credentials.email).toBe("ops@example.com");
  });

  it("skips stale entries without a usable key", () => {
    const outcome = decodeGrokAuthPayload({
      "https://auth.x.ai::supergrok": { email: "ghost@example.com" },
      "https://accounts.x.ai/sign-in": { key: "legacy-token-value-0001" },
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.credentials.scope).toBe("https://accounts.x.ai/sign-in");
  });

  it("rejects payloads with no keyed entry", () => {
    expect(decodeGrokAuthPayload({}).kind).toBe("invalid");
    expect(decodeGrokAuthPayload("junk").kind).toBe("invalid");
  });

  it("flags expired credentials", () => {
    const outcome = decodeGrokAuthPayload({ "https://auth.x.ai::s": { key: FAKE_TOKEN, expires_at: "2020-01-01T00:00:00Z" } });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(isGrokCredentialExpired(outcome.credentials, NOW_MS)).toBe(true);
  });
});

describe("redactSecret", () => {
  it("strips token material from upstream error text", () => {
    const text = `request failed for ${FAKE_TOKEN} upstream`;
    expect(redactSecret(text, FAKE_TOKEN)).not.toContain(FAKE_TOKEN);
    expect(redactSecret(text, FAKE_TOKEN)).toContain("[redacted]");
  });

  it("builds the auth-rejection envelope copy without token material", () => {
    const message = grokAuthRejectedError(401, FAKE_TOKEN);
    expect(message).toContain("(401)");
    expect(message).not.toContain(FAKE_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Snapshot assembly tiers
// ---------------------------------------------------------------------------

describe("assembleGrokSnapshot", () => {
  it("prefers the first live network tier", () => {
    const snapshot = assembleGrokSnapshot(FETCHED, {
      credentialsMissing: false,
      outcomes: [okQuota()],
      sessionsAvailable: true,
    });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.dataConfidence).toBe("live");
    expect(snapshot.quotas[0]?.source).toBe("cli-proxy");
  });

  it("falls through proxy failure to the gRPC tier", () => {
    const snapshot = assembleGrokSnapshot(FETCHED, {
      credentialsMissing: false,
      outcomes: [
        unavailable("parse-error", "proxy returned no usable usage percent"),
        okQuota({ source: "grpc-web" }),
      ],
      sessionsAvailable: true,
    });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.dataConfidence).toBe("live");
    expect(snapshot.quotas[0]?.source).toBe("grpc-web");
  });

  it("degrades to derived session tokens when every network tier fails", () => {
    const sessionsQuota = {
      provider: "grok",
      source: "updates.jsonl",
      status: "ok" as const,
      windows: [],
      updatedAt: FETCHED,
      extras: { partial: true, totalTokens: 1050 },
    };
    const snapshot = assembleGrokSnapshot(FETCHED, {
      credentialsMissing: true,
      outcomes: [unavailable("cli-error", "credits proxy request failed with HTTP 503")],
      sessionsQuota,
      sessionsAvailable: true,
    });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.dataConfidence).toBe("derived");
    expect(snapshot.quotas[0]?.extras?.totalTokens).toBe(1050);
  });

  it("reports source-missing when credentials and sessions are absent", () => {
    const snapshot = assembleGrokSnapshot(FETCHED, {
      credentialsMissing: true,
      outcomes: [],
      sessionsAvailable: false,
    });
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("source-missing");
  });

  it("folds an auth rejection into a redacted cli-error envelope", () => {
    const snapshot = assembleGrokSnapshot(FETCHED, {
      credentialsMissing: false,
      outcomes: [unavailable("cli-error", grokAuthRejectedError(401, FAKE_TOKEN), { authRejected: true })],
      sessionsAvailable: false,
    });
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("cli-error");
    expect(JSON.stringify(snapshot)).not.toContain(FAKE_TOKEN);
  });

  it("keeps parse-error when all live tiers decoded badly but sessions had nothing recent", () => {
    const snapshot = assembleGrokSnapshot(FETCHED, {
      credentialsMissing: false,
      outcomes: [
        unavailable("parse-error", "proxy returned no usable usage percent"),
        unavailable("parse-error", "could not parse grok.com billing usage"),
      ],
      sessionsAvailable: true,
    });
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("parse-error");
  });
});
