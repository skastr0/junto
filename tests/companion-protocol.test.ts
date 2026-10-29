/**
 * junto-companion/1 schema: the doc's golden examples decode, every op's
 * arguments and results round-trip, frames are bounded both ways, and the
 * errors that close a channel say so.
 */
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  COMPANION_FEATURES,
  COMPANION_MAX_INBOUND_BYTES,
  COMPANION_MAX_REQUEST_BYTES,
  COMPANION_STAGE_CHUNK_MAX,
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
  base64UrlDecode,
  base64UrlEncode,
  decodeCompanionOutboundLine,
  decodeCompanionPairingUrl,
  decodeCompanionRequestLine,
  encodeCompanionFrame,
  type CompanionOutboundFrame,
} from "../src/shared/companion-protocol";
import {
  SIGNAL_RAISED_VALUE_MAX_LENGTH,
  SIGNAL_RAISED_VALUES_MAX_TOTAL_LENGTH,
  type AgentSignal,
} from "../src/shared/agent-signals";
import { feedItemRank, type OperatorFeed } from "../src/shared/operator-feed";

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
  version: 4,
  canvasName: "main",
  generatedAt: 1_790_000_000_000,
  count: 1,
  sections: [
    {
      region: { regionId: "r1", label: "Backend", path: ["Backend"], color: "4" },
      worstUrgency: feedItemRank("blocked"),
      items: [
        {
          itemId: "signal:sig_123",
          kind: "blocked",
          urgency: feedItemRank("blocked"),
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

  it("decodes the hello's features and refuses a malformed one", () => {
    const base = { appVersion: "t", deviceId: "d", deviceName: "p", station: "s", serverTime: 1 };
    const decodes = (hello: unknown) => Result.isSuccess(Schema.decodeUnknownResult(CompanionHello)(hello));
    expect(decodes({ ...base, features: COMPANION_FEATURES })).toBe(true);
    expect(COMPANION_FEATURES).toContain("artifacts/1");
    expect(decodes({ ...base, features: ["artifacts"] })).toBe(false);
    expect(decodes({ ...base, features: Array.from({ length: 17 }, (_, i) => `f/${String(i)}`) })).toBe(false);
  });

  it("encodes base64url without a platform encoder, including non-ASCII text", () => {
    for (const text of ["", "a", "ab", "abc", "Guilherme's MacBook Pro", "Jo\u00e3o \u2014 \ud83d\udcf1"]) {
      expect(base64UrlDecode(base64UrlEncode(text))).toBe(text);
      expect(base64UrlEncode(text)).toBe(Buffer.from(text, "utf8").toString("base64url"));
    }
    expect(() => base64UrlDecode("a")).toThrow();
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
    "seat.get": { canvasName: "main", nodeId: "planner" },
    "signal.answer": { signalId: "sig_1", text: "Use the staging vault." },
    "signal.dismiss": { signalId: "sig_1" },
    "mail.list": { canvasName: "main", nodeId: "planner", limit: 20 },
    "mail.send": { canvasName: "main", nodeId: "planner", text: "Ship it." },
    "quickReplies.get": {},
    "portrait.get": { portraitIdentity: "planner", size: 96, theme: "dark" },
    "content.get": { sha256: "9165917e794ecf12afe96968051d9e450272e632486a9be839646fd1449bb95e", offset: 0, length: 4096 },
    "content.stage": {
      canvasName: "main",
      sha256: "9165917e794ecf12afe96968051d9e450272e632486a9be839646fd1449bb95e",
      byteLength: 3,
      mediaType: "image/png",
      displayName: "shot.png",
      offset: 0,
      data: "AAAA",
    },
    "machines.list": {},
    "machine.get": { name: "mini", minLevel: "warn" },
    "tailnet.peers": {},
    "threads.list": { canvasName: "main", nodeId: "planner" },
    "thread.get": { canvasName: "main", nodeId: "planner", threadId: "01KAZ3Q8X4V6W2N5R7T9Y1B3D5" },
    "threads.read": { canvasName: "main", nodeId: "planner", threadId: "01KAZ3Q8X4V6W2N5R7T9Y1B3D5", through: "01KAZ3Q8X4V6W2N5R7T9Y1B3D6" },
    "canvas.open": { canvasName: "main" },
    "canvas.close": { canvasName: "main" },
    "artifacts.nodes": { canvasName: "main" },
    "artifacts.list": { canvasName: "main", nodeId: "art-notes", labels: ["launch"], query: "pricing", limit: 20 },
    "artifact.get": { canvasName: "main", artifactId: "01KAZ3Q8X4V6W2N5R7T9Y1B3D5", version: 2 },
    "artifact.history": { canvasName: "main", artifactId: "01KAZ3Q8X4V6W2N5R7T9Y1B3D5", before: 5, limit: 20 },
    "artifact.pending": { canvasName: "main", nodeId: "art-notes" },
    "artifact.moveCheck": { canvasName: "main", artifactIds: ["01KAZ3Q8X4V6W2N5R7T9Y1B3D5"], to: "art-launch" },
    "inbox.set": { canvasName: "main", nodeId: "art-notes" },
    "comments.list": { canvasName: "main", subject: { kind: "artifact", nodeId: "art-notes", artifactId: "01KAZ3Q8X4V6W2N5R7T9Y1B3D5" } },
    "mentions.candidates": { canvasName: "main", from: "planner", trigger: "@", query: "at" },
    "comment.post": {
      canvasName: "main",
      subject: { kind: "artifact", nodeId: "art-notes", artifactId: "01KAZ3Q8X4V6W2N5R7T9Y1B3D5" },
      opId: "01KAZ3Q8X4V6W2N5R7T9Y1B3D6",
      text: "Is the discount before or after launch?",
      threadId: "01KAZ3Q8X4V6W2N5R7T9Y1B3D5",
    },
  };

  it("accepts every op with valid arguments", () => {
    for (const op of COMPANION_OPS) {
      const decoded = decodeLine({ v: V, type: "request", id: `r-${op}`, op, args: validArgs[op] });
      expect(Result.isSuccess(decoded), op).toBe(true);
      expect(Result.isSuccess(Schema.decodeUnknownResult(CompanionArgs[op])(validArgs[op])), op).toBe(true);
    }
  });

  it("takes a quiet answer with empty text, and a loud one only with text", () => {
    const answer = Schema.decodeUnknownResult(CompanionArgs["signal.answer"]);
    const quiet = answer({ signalId: "s", text: "", quiet: true });
    expect(Result.isSuccess(quiet) && quiet.success).toEqual({ signalId: "s", text: "", quiet: true });
    const noted = answer({ signalId: "s", text: "Good", quiet: true });
    expect(Result.isSuccess(noted) && noted.success).toEqual({ signalId: "s", text: "Good", quiet: true });
    expect(Result.isFailure(answer({ signalId: "s", text: "" }))).toBe(true);
    expect(Result.isFailure(answer({ signalId: "s", text: "x".repeat(8_001), quiet: true }))).toBe(true);
    const loud = answer({ signalId: "s", text: "Ship it." });
    expect(Result.isSuccess(loud) && loud.success).toEqual({ signalId: "s", text: "Ship it." });
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
    const text = "y".repeat(COMPANION_MAX_REQUEST_BYTES);
    const decoded = decodeLine({ v: V, type: "request", id: "big", op: "mail.send", args: { canvasName: "m", nodeId: "n", text } });
    expect(Result.isFailure(decoded) && decoded.failure).toMatchObject({ id: "", close: true, error: { code: "too-large" } });
    const huge = decodeLine({ v: V, type: "request", id: "huge", op: "ping", args: { pad: "y".repeat(COMPANION_MAX_INBOUND_BYTES) } });
    expect(Result.isFailure(huge) && huge.failure).toMatchObject({ close: true, error: { code: "too-large" } });
  });

  it("lets only a content.stage piece use the larger frame", () => {
    const data = Buffer.alloc(COMPANION_STAGE_CHUNK_MAX, 7).toString("base64");
    const piece = { canvasName: "m", sha256: "a".repeat(64), byteLength: COMPANION_STAGE_CHUNK_MAX * 2, mediaType: "image/png", offset: 0, data };
    expect(Result.isSuccess(decodeLine({ v: V, type: "request", id: "s", op: "content.stage", args: piece }))).toBe(true);
    const over = { ...piece, data: Buffer.alloc(COMPANION_STAGE_CHUNK_MAX + 3, 7).toString("base64") };
    expect(Result.isFailure(decodeLine({ v: V, type: "request", id: "s2", op: "content.stage", args: over }))).toBe(true);
    // Closed: a key it does not name is refused.
    expect(Result.isFailure(decodeLine({ v: V, type: "request", id: "s3", op: "content.stage", args: { ...piece, path: "/etc" } }))).toBe(true);
    const tooBig = { ...piece, byteLength: 25 * 1024 * 1024 + 1 };
    expect(Result.isFailure(decodeLine({ v: V, type: "request", id: "s4", op: "content.stage", args: tooBig }))).toBe(true);
  });

  it("takes files on mail and answers, with text, files or both, never neither", () => {
    const ref = { sha256: "b".repeat(64), byteLength: 10, mediaType: "image/png" };
    const mail = Schema.decodeUnknownResult(CompanionArgs["mail.send"]);
    expect(Result.isSuccess(mail({ canvasName: "m", nodeId: "n", text: "", attachments: [ref] }))).toBe(true);
    expect(Result.isFailure(mail({ canvasName: "m", nodeId: "n", text: "" }))).toBe(true);
    expect(Result.isFailure(mail({ canvasName: "m", nodeId: "n", text: "", attachments: [] }))).toBe(true);
    expect(Result.isFailure(mail({ canvasName: "m", nodeId: "n", text: "x", attachments: Array(11).fill(ref) }))).toBe(true);
    const answer = Schema.decodeUnknownResult(CompanionArgs["signal.answer"]);
    const loud = answer({ signalId: "s", text: "", attachments: [ref] });
    expect(Result.isSuccess(loud) && loud.success).toEqual({ signalId: "s", text: "", attachments: [ref] });
    const quiet = answer({ signalId: "s", text: "", quiet: true, attachments: [ref] });
    expect(Result.isSuccess(quiet) && quiet.success).toEqual({ signalId: "s", text: "", quiet: true, attachments: [ref] });
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

  it("drops an automation signal's step from every frame, so a seat of 50 at the largest still opens", () => {
    // 32,000 characters that JSON escapes to six bytes each: the largest step a signal can carry.
    const raised = Object.fromEntries(
      Array.from({ length: SIGNAL_RAISED_VALUES_MAX_TOTAL_LENGTH / SIGNAL_RAISED_VALUE_MAX_LENGTH }, (_, i) => [
        `v${String(i)}`,
        "\u0001".repeat(SIGNAL_RAISED_VALUE_MAX_LENGTH),
      ]),
    );
    const source = { kind: "automation", automationId: "01M62Q58WDSXMG4YBXNKR2RB92", nodeId: "daily", firingId: "01M62Q58WDSXMG4YBXNKR2RB93" } as const;
    const raisedSignal = (i: number): AgentSignal => ({
      ...signal,
      signalId: `sig_${String(i)}`,
      source: { ...source, step: { index: 63, id: "pages", raised } },
    });
    const signals = Array.from({ length: 50 }, (_, i) => raisedSignal(i));
    expect(new TextEncoder().encode(JSON.stringify(signals.slice(0, 3))).byteLength).toBeGreaterThan(COMPANION_MAX_OUTBOUND_BYTES);

    const seat = {
      nodeId: "planner",
      name: "Planner",
      portraitIdentity: "planner",
      region: { regionId: "r1", label: "Backend", path: ["Backend"], color: "4" },
      state: "blocked",
      line: "Waiting",
      preambles: [],
      signals,
      activity: [],
    } as const;
    const line = encodeCompanionFrame(companionOk("9", "seat.get", { seat }));
    expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(COMPANION_MAX_OUTBOUND_BYTES);
    const opened = decodeCompanionOutboundLine(line);
    expect(Result.isSuccess(opened) && opened.success).toMatchObject({ id: "9", ok: true });
    const sent = (JSON.parse(line) as { result: { seat: { signals: AgentSignal[] } } }).result.seat.signals;
    expect(sent).toHaveLength(50);
    expect(sent.every((s) => JSON.stringify(s.source) === JSON.stringify(source))).toBe(true);

    const stepless = (frame: CompanionOutboundFrame) => {
      const text = encodeCompanionFrame(frame);
      expect(JSON.parse(text)).not.toMatchObject({ ok: false, error: { code: "internal" } });
      expect(text).not.toContain('"step"');
      expect(text).toContain(source.firingId);
    };
    const item = feed.sections[0]!.items[0]!;
    const raisedFeed: OperatorFeed = {
      ...feed,
      sections: [{ ...feed.sections[0]!, items: [{ ...item, source: raisedSignal(0).source }] }],
    };
    stepless(companionOk("10", "feed.get", { feeds: [raisedFeed] }));
    stepless(companionOk("11", "feed.subscribe", { feeds: [raisedFeed] }));
    stepless(companionOk("12", "signal.answer", { signal: raisedSignal(1) }));
    stepless(companionOk("13", "signal.dismiss", { signal: raisedSignal(2) }));
    stepless(companionFail("14", companionError("conflict", "That changed on the Mac.", raisedSignal(3))));
    stepless(companionEvent("signal.changed", { signal: raisedSignal(4) }));
    stepless(companionEvent("feed.changed", { feed: raisedFeed }));
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
