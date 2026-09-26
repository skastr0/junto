/**
 * junto-companion/1 schema: the doc's golden examples decode, every op's
 * arguments and results round-trip, frames are bounded both ways, and the
 * errors that close a channel say so.
 */
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  COMPANION_MAX_INBOUND_BYTES,
  COMPANION_MAX_OUTBOUND_BYTES,
  COMPANION_OPS,
  COMPANION_PROTOCOL,
  CompanionArgs,
  CompanionHello,
  CompanionPairingPayload,
  CompanionResults,
  companionConnectionErrorLine,
  companionEvent,
  companionFail,
  companionOk,
  companionError,
  companionPairingUrl,
  decodeCompanionOutboundLine,
  decodeCompanionPairingUrl,
  decodeCompanionRequestLine,
  encodeCompanionFrame,
  type CompanionOutboundFrame,
} from "../src/shared/companion-protocol";
import type { AgentSignal } from "../src/shared/agent-signals";
import type { OperatorFeed } from "../src/shared/operator-feed";

const V = COMPANION_PROTOCOL;
const DEVICE = "dev_01J9Z3K4M5N6P7Q8R9S0T1V2W3";

const signal: AgentSignal = {
  signalId: "sig_123",
  canvasName: "main",
  nodeId: "planner",
  kind: "blocked",
  text: "Need the staging credentials.",
  createdAt: 1_790_000_000_000,
  state: "open",
};

const feed: OperatorFeed = {
  version: 1,
  canvasName: "main",
  generatedAt: 1_790_000_000_000,
  count: 1,
  sections: [
    {
      region: { regionId: "r1", label: "Backend", path: ["Backend"], color: "4" },
      worstUrgency: 5,
      items: [
        {
          itemId: "signal:sig_123",
          kind: "blocked",
          urgency: 5,
          canvasName: "main",
          seat: { nodeId: "planner", name: "Planner", portraitIdentity: "planner", harness: "claude" },
          region: { regionId: "r1", label: "Backend", path: ["Backend"], color: "4" },
          text: "Need the staging credentials.",
          since: 1_790_000_000_000,
          ageMs: 0,
          signalId: "sig_123",
          signalKind: "blocked",
        },
      ],
    },
  ],
};

const decodeLine = (value: unknown) => decodeCompanionRequestLine(JSON.stringify(value));

describe("golden examples from docs/companion-protocol.md", () => {
  it("decodes the request example", () => {
    const decoded = decodeLine({ v: V, type: "request", id: "r1", op: "feed.get", args: {} });
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) expect(decoded.success.op).toBe("feed.get");
  });

  it("decodes the error response example", () => {
    const line = JSON.stringify({
      v: V,
      type: "response",
      id: "r1",
      ok: false,
      error: { code: "not-found", message: "No signal sig_123." },
    });
    expect(Result.isSuccess(decodeCompanionOutboundLine(line))).toBe(true);
  });

  it("decodes the hello example", () => {
    const hello = {
      appVersion: "0.3.4",
      deviceId: "dev_01J...",
      deviceName: "Guilherme's iPhone",
      station: "Guilherme's MacBook Pro",
      serverTime: 1790000000000,
    };
    expect(Result.isSuccess(Schema.decodeUnknownResult(CompanionHello)(hello))).toBe(true);
    const line = encodeCompanionFrame(companionEvent("hello", hello));
    const decoded = decodeCompanionOutboundLine(line);
    expect(Result.isSuccess(decoded) && decoded.success.type === "event" && decoded.success.event).toBe("hello");
  });

  it("round-trips the pairing QR payload through its URL", () => {
    const payload = {
      v: V,
      deviceId: DEVICE,
      station: "Guilherme's MacBook Pro",
      hosts: ["guilhermes-mbp.tail1234.ts.net", "100.101.102.103", "guilhermes-mbp.local"],
      port: 22,
      user: "guilhermecastro",
      hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForTests",
      pairingKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
      expiresAt: 1790000600000,
    };
    expect(Result.isSuccess(Schema.decodeUnknownResult(CompanionPairingPayload)(payload))).toBe(true);
    const url = companionPairingUrl(payload);
    expect(url.startsWith("junto-companion://pair?d=")).toBe(true);
    expect(url.slice("junto-companion://pair?d=".length)).not.toMatch(/[+/=]/u);
    const back = decodeCompanionPairingUrl(url);
    expect(Result.isSuccess(back) && back.success).toEqual(payload);
  });
});

describe("request decoding", () => {
  const validArgs: { readonly [Op in (typeof COMPANION_OPS)[number]]: unknown } = {
    "pair.complete": { publicKey: "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY=", deviceName: "My iPhone" },
    ping: {},
    "canvases.list": {},
    "feed.get": { canvasName: "main" },
    "feed.subscribe": {},
    "feed.unsubscribe": {},
    "seats.list": { canvasName: "main" },
    "signal.answer": { signalId: "sig_1", text: "Use the staging vault." },
    "signal.dismiss": { signalId: "sig_1" },
    "mail.list": { canvasName: "main", nodeId: "planner", limit: 20 },
    "mail.send": { canvasName: "main", nodeId: "planner", text: "Ship it." },
    "quickReplies.get": {},
    "portrait.get": { portraitIdentity: "planner", size: 96, theme: "dark" },
  };

  it("accepts every op with valid arguments", () => {
    for (const op of COMPANION_OPS) {
      const decoded = decodeLine({ v: V, type: "request", id: `r-${op}`, op, args: validArgs[op] });
      expect(Result.isSuccess(decoded), op).toBe(true);
      expect(Result.isSuccess(Schema.decodeUnknownResult(CompanionArgs[op])(validArgs[op])), op).toBe(true);
    }
  });

  it("treats missing args as empty and ignores unknown fields (additive-only)", () => {
    expect(Result.isSuccess(decodeLine({ v: V, type: "request", id: "a", op: "ping" }))).toBe(true);
    const future = decodeLine({ v: V, type: "request", id: "b", op: "feed.get", args: { later: 1 }, extra: true });
    expect(Result.isSuccess(future)).toBe(true);
  });

  it("refuses another protocol version and closes, keeping the id", () => {
    const decoded = decodeLine({ v: "junto-companion/2", type: "request", id: "r9", op: "ping", args: {} });
    expect(Result.isFailure(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      expect(decoded.failure).toMatchObject({ id: "r9", close: true, error: { code: "unsupported-version" } });
    }
  });

  it("answers invalid arguments with the request id and never echoes the input", () => {
    const secret = "x".repeat(9_000);
    const decoded = decodeLine({ v: V, type: "request", id: "r2", op: "signal.answer", args: { signalId: "s", text: secret } });
    expect(Result.isFailure(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      expect(decoded.failure.id).toBe("r2");
      expect(decoded.failure.error.code).toBe("invalid");
      expect(decoded.failure.close).toBe(false);
      expect(JSON.stringify(decoded.failure)).not.toContain("xxxx");
    }
    const unknownOp = decodeLine({ v: V, type: "request", id: "r3", op: "seats.delete", args: {} });
    expect(Result.isFailure(unknownOp) && unknownOp.failure).toMatchObject({ id: "r3", error: { code: "invalid" } });
    expect(Result.isFailure(decodeCompanionRequestLine("{not json"))).toBe(true);
  });

  it("bounds inbound frames at 16 KiB and closes", () => {
    const text = "y".repeat(COMPANION_MAX_INBOUND_BYTES);
    const decoded = decodeLine({ v: V, type: "request", id: "big", op: "mail.send", args: { canvasName: "m", nodeId: "n", text } });
    expect(Result.isFailure(decoded) && decoded.failure).toMatchObject({ close: true, error: { code: "too-large" } });
  });

  it("keeps a public key from smuggling authorized_keys options", () => {
    const bad = [
      'command="sh" ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY=',
      "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY= comment",
      "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY=\nssh-rsa AAAA",
      "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ==",
    ];
    for (const publicKey of bad) {
      const decoded = decodeLine({ v: V, type: "request", id: "p", op: "pair.complete", args: { publicKey, deviceName: "x" } });
      expect(Result.isFailure(decoded), publicKey).toBe(true);
    }
  });
});

describe("outbound frames", () => {
  it("round-trips a result for every op shape it carries", () => {
    const results: ReadonlyArray<CompanionOutboundFrame> = [
      companionOk("1", "ping", { serverTime: 1 }),
      companionOk("2", "feed.get", { feeds: [feed] }),
      companionOk("3", "signal.answer", { signal: { ...signal, state: "answered", response: { text: "ok", at: 2 }, closedAt: 2 } }),
      companionOk("4", "quickReplies.get", { replies: ["yes", "no"] }),
      companionOk("5", "mail.send", {
        message: {
          messageId: "m1",
          canvasName: "main",
          nodeId: "planner",
          direction: "to_seat",
          from: { kind: "operator" },
          text: "Ship it.",
          at: 3,
          delivery: "waiting_for_seat",
        },
      }),
      companionFail("6", companionError("conflict", "That signal was already answered.", { ...signal, state: "answered" })),
      companionEvent("feed.changed", { feed }),
      companionEvent("signal.changed", { signal }),
    ];
    for (const frame of results) {
      const line = encodeCompanionFrame(frame);
      expect(line.endsWith("\n")).toBe(true);
      const decoded = decodeCompanionOutboundLine(line);
      expect(Result.isSuccess(decoded) && decoded.success).toEqual(frame);
    }
    for (const op of COMPANION_OPS) expect(CompanionResults[op]).toBeDefined();
  });

  it("refuses to send a shape the contract does not have", () => {
    const wrong = companionOk("7", "ping", { serverTime: "soon" } as never);
    const decoded = decodeCompanionOutboundLine(encodeCompanionFrame(wrong));
    expect(Result.isSuccess(decoded) && decoded.success).toMatchObject({ id: "7", ok: false, error: { code: "internal" } });
  });

  it("replaces a frame over 512 KiB with an error for the same request", () => {
    const huge = companionOk("8", "portrait.get", { svg: "z".repeat(COMPANION_MAX_OUTBOUND_BYTES) });
    const line = encodeCompanionFrame(huge);
    expect(new TextEncoder().encode(line).byteLength).toBeLessThan(COMPANION_MAX_OUTBOUND_BYTES);
    expect(JSON.parse(line)).toMatchObject({ id: "8", ok: false, error: { code: "internal" } });
  });

  it("writes connection errors with an empty id", () => {
    expect(JSON.parse(companionConnectionErrorLine("revoked"))).toEqual({
      v: V,
      type: "response",
      id: "",
      ok: false,
      error: { code: "revoked", message: "This phone was removed from Junto." },
    });
  });
});
