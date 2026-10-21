/**
 * A seat's signal attachments cross as references (plan 02). The raise
 * carries them to the machine that edits the canvas, which keeps a file as
 * one of no stated kind until its bytes arrive and are judged; only the
 * seat's machine serves those bytes, to the editing machine, while the
 * signal is open there.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signalFileEntitled } from "../src/main/junto/content/signal-entitlement";
import { receiveContentTransfer } from "../src/main/junto/content/transfer-local";
import { judgeArrivedSignalFile } from "../src/main/junto/signals/file-puller";
import { AgentSignalRepository, AgentSignalRepositoryLive } from "../src/main/junto/signals/repository";
import { signalFileRefs, takenSignalAttachments } from "../src/main/junto/signals/taken-attachments";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import type { AgentSignal, AgentSignalAttachment } from "../src/shared/agent-signals";
import { InstallationId } from "../src/shared/installation-id";
import type { ContentRef } from "../src/shared/wire/content-ref";
import { EXCHANGE_MAX_SIGNAL_FILE_BYTES, decodeExchangeFrame, signalStatedTo, type CanvasPlacement, type ExchangeSignal } from "../src/shared/work-exchange";
import { Result } from "effect";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook");
const MINI = id("mini");
const THIRD = id("third-mini");

const refOf = (text: string, mediaType: string, displayName: string): ContentRef =>
  ({ sha256: createHash("sha256").update(text).digest("hex"), byteLength: Buffer.byteLength(text), mediaType, displayName }) as ContentRef;
const NOTES = refOf("plain words, not a picture\n", "image/png", "../../shot.png");
const BEFORE = refOf("one\n", "text/plain", "a.txt");
const AFTER = refOf("two\n", "text/plain", "a.txt");

const placementWith = (seatHome: InstallationId): CanvasPlacement => ({
  canvasId: "canvas-factory",
  editor: EDITOR,
  holds: (machine) => [EDITOR, MINI, THIRD].includes(machine),
  seatOf: (nodeId) => (nodeId === "peer" ? { seatId: `seat_${"2".repeat(64)}` as never, machine: seatHome } : undefined),
});

describe("what a raise keeps of what crossed", () => {
  const stated: ReadonlyArray<AgentSignalAttachment> = [
    { ref: NOTES, caption: "the shot" },
    { kind: "compare", before: BEFORE, after: AFTER },
    { kind: "commit", sha: "a".repeat(40) },
    { kind: "commit", sha: "not-a-commit" },
    { kind: "link", url: "https://example.com/a" },
    { kind: "link", url: "javascript:alert(1)" },
  ] as never;

  it("keeps a file without the type it states, under a cleaned name, and admits commits and links again", () => {
    const taken = takenSignalAttachments(stated);
    expect(taken).toHaveLength(4);
    expect(taken[0]).toEqual({ ref: { sha256: NOTES.sha256, byteLength: NOTES.byteLength, mediaType: "application/octet-stream", displayName: "shot.png" }, caption: "the shot" });
    expect(taken[1]).toMatchObject({ kind: "compare", before: { mediaType: "application/octet-stream" }, after: { mediaType: "application/octet-stream" } });
    expect(taken.map((attachment) => ("kind" in attachment ? attachment.kind : "file"))).toEqual(["file", "compare", "commit", "link"]);
    expect(signalFileRefs(taken).map((ref) => ref.sha256)).toEqual([NOTES.sha256, BEFORE.sha256, AFTER.sha256]);
  });

  it("refuses at decode a crossing signal that names a file over the crossing cap", () => {
    const frame = (byteLength: number) => ({
      kind: "signals",
      canvasName: "factory",
      canvasId: "canvas-factory",
      signals: [{ signalId: "sig-1", nodeId: "peer", kind: "blocked", text: "look", createdAt: 1, attachments: [{ ref: { ...NOTES, byteLength } }] }],
    });
    expect(Result.isSuccess(decodeExchangeFrame(frame(EXCHANGE_MAX_SIGNAL_FILE_BYTES)))).toBe(true);
    expect(Result.isFailure(decodeExchangeFrame(frame(EXCHANGE_MAX_SIGNAL_FILE_BYTES + 1)))).toBe(true);
    expect(Result.isFailure(decodeExchangeFrame(frame(4 * 1024 ** 4)))).toBe(true);
    const compare = { ...frame(4), signals: [{ ...frame(4).signals[0], attachments: [{ kind: "compare", before: BEFORE, after: { ...AFTER, byteLength: EXCHANGE_MAX_SIGNAL_FILE_BYTES + 1 } }] }] };
    expect(Result.isFailure(decodeExchangeFrame(compare))).toBe(true);
  });

  it("crosses with the raise to the editing machine, and never back with the operator's closing", () => {
    const signal = { signalId: "sig-1", nodeId: "peer", kind: "blocked", text: "look", createdAt: 1, attachments: [{ ref: NOTES }] } as ExchangeSignal;
    expect(signalStatedTo(MINI, EDITOR, signal, placementWith(MINI))?.attachments).toEqual([{ ref: NOTES }]);
    const answered = { ...signal, closing: { state: "dismissed", closedAt: 2 } } as ExchangeSignal;
    expect(signalStatedTo(EDITOR, MINI, answered, placementWith(MINI))).not.toHaveProperty("attachments");
  });
});

describe("judging a file that arrived", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "junto-signal-file-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const arrive = (ref: ContentRef, text: string) => receiveContentTransfer({ root, ref, source: Buffer.from(text), expectedOffset: 0 });

  it("reads what the bytes are, never the type the reference stated", async () => {
    await arrive(NOTES, "plain words, not a picture\n");
    expect(judgeArrivedSignalFile(root, { ...NOTES, displayName: "notes" } as ContentRef, { attachments: [{ ref: NOTES }] })).toEqual({ mediaType: "text/plain" });
  });

  it("keeps no side of a compare that is not text", async () => {
    const binary = refOf("\u0000\u0001\u0002", "text/plain", "a.txt");
    await arrive(binary, "\u0000\u0001\u0002");
    expect(judgeArrivedSignalFile(root, binary, { attachments: [{ kind: "compare", before: binary, after: AFTER }] as never })).toEqual({ refused: "a side of a compare is not text" });
  });

  it("judges nothing that is not here", () => {
    expect(judgeArrivedSignalFile(root, AFTER, { attachments: [] })).toEqual({ refused: "the file is not in this machine's store" });
  });
});

describe("who the seat's machine serves a signal's file to", () => {
  let root: string;
  let runtime: ManagedRuntime.ManagedRuntime<AgentSignalRepository, unknown>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "junto-signal-serve-"));
    runtime = ManagedRuntime.make(AgentSignalRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(root, "junto.db")))));
  });
  afterEach(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const raise = (signalId: string) =>
    runtime.runPromise(Effect.flatMap(AgentSignalRepository, (signals) =>
      signals.raise({ canvasName: "factory", nodeId: "peer", kind: "blocked", text: "look", signalId, attachments: [{ ref: NOTES }] })));
  const serves = (signalId: string, machine: InstallationId, seatHome = MINI, sha256 = NOTES.sha256) =>
    runtime.runPromise(Effect.flatMap(AgentSignalRepository, (signals) =>
      signalFileEntitled(signals, { owner: { canvasName: "factory", nodeId: "peer", recordId: signalId }, sha256, machine, self: MINI, placement: placementWith(seatHome) })));

  it("serves the editing machine while the signal is open, and no other machine", async () => {
    await raise("sig-open");
    expect(await serves("sig-open", EDITOR)).toBe(true);
    expect(await serves("sig-open", THIRD)).toBe(false);
  });

  it("serves nothing once the seat left this machine, for bytes the signal does not name, or for a signal not held here", async () => {
    await raise("sig-moved");
    expect(await serves("sig-moved", EDITOR, THIRD)).toBe(false);
    expect(await serves("sig-moved", EDITOR, MINI, AFTER.sha256)).toBe(false);
    expect(await serves("sig-missing", EDITOR)).toBe(false);
  });

  it("serves nothing for a closed signal", async () => {
    await raise("sig-closed");
    await runtime.runPromise(Effect.flatMap(AgentSignalRepository, (signals) => signals.dismiss("sig-closed")));
    expect(await serves("sig-closed", EDITOR)).toBe(false);
  });
});

describe("a raise taken from the seat's machine", () => {
  let root: string;
  let runtime: ManagedRuntime.ManagedRuntime<AgentSignalRepository, unknown>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "junto-signal-take-"));
    runtime = ManagedRuntime.make(AgentSignalRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(root, "junto.db")))));
  });
  afterEach(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps what it attached in order, ahead of its suggestions, and records a file as its bytes are judged", async () => {
    const got = await runtime.runPromise(Effect.gen(function* () {
      const signals = yield* AgentSignalRepository;
      yield* signals.take({
        canvasName: "factory", nodeId: "peer", signalId: "sig-taken", kind: "blocked", text: "look", createdAt: 1, raises: true,
        suggestions: ["Ship it"],
        attachments: takenSignalAttachments([{ ref: NOTES }, { kind: "compare", before: BEFORE, after: NOTES }] as never),
      });
      const judged = yield* signals.judgeFile("sig-taken", NOTES, "text/plain");
      const again = yield* signals.judgeFile("sig-taken", NOTES, "text/plain");
      return { judged, again, read: yield* signals.get("sig-taken") };
    }));
    const read = got.read as AgentSignal;
    expect(read.suggestions).toEqual(["Ship it"]);
    expect(read.attachments?.[0]).toEqual({ ref: { ...NOTES, mediaType: "text/plain", displayName: "shot.png" } });
    expect(read.attachments?.[1]).toMatchObject({ kind: "compare", before: { mediaType: "application/octet-stream" }, after: { mediaType: "text/plain" } });
    expect(got.judged).toBeDefined();
    expect(got.again).toBeUndefined();
  });
});
