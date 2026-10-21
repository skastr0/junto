/**
 * A seat's signal file pulled by the editing machine from the seat's machine
 * over two real link sessions (plan 02). The seat's machine serves it by its
 * own store: the signal open there, the seat there, the asker editing the
 * canvas. The editing machine keeps it under the signal and records it as
 * its bytes say it is, and asks nothing it may not, or cannot hold.
 */
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeContentChannel, type PulledOwner } from "../src/main/junto/content/pull";
import { signalFileEntitled } from "../src/main/junto/content/signal-entitlement";
import { ingestContentBytes } from "../src/main/junto/content/store";
import { statContentForTransfer } from "../src/main/junto/content/transfer-local";
import { LinkHelloSchema } from "../src/main/junto/link/protocol";
import { makeLinkSession } from "../src/main/junto/link/session";
import type { LinkSession } from "../src/main/junto/link/types";
import { pullSignalFile, type SignalFilePullDeps } from "../src/main/junto/signals/file-pull";
import { AgentSignalRepository, AgentSignalRepositoryLive } from "../src/main/junto/signals/repository";
import { takenSignalAttachments } from "../src/main/junto/signals/taken-attachments";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import type { AgentSignal } from "../src/shared/agent-signals";
import type { ContentPullRequest } from "../src/shared/content-pull";
import { InstallationId } from "../src/shared/installation-id";
import type { ContentRef } from "../src/shared/wire/content-ref";
import type { CanvasPlacement } from "../src/shared/work-exchange";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook-install");
const MINI = id("mini-install");
const THIRD = id("third-install");
const hello = (machineName: string, installationId: InstallationId) =>
  Schema.decodeUnknownSync(LinkHelloSchema)({ build: "a".repeat(64), installationId, machineName });
const placementOf = (editor: InstallationId, seatHome: InstallationId): CanvasPlacement => ({
  canvasId: "canvas-factory",
  editor,
  holds: (machine) => [EDITOR, MINI, THIRD].includes(machine),
  seatOf: (nodeId) => (nodeId === "peer" ? { seatId: `seat_${"2".repeat(64)}` as never, machine: seatHome } : undefined),
});

const words = Buffer.from("plain words a seat attached, said to be a picture\n");
const dirs: string[] = [];
const sessions: LinkSession[] = [];
let seatRuntime: ManagedRuntime.ManagedRuntime<AgentSignalRepository, unknown>;

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  await seatRuntime?.dispose();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const setUp = async (options: { seatHomeOnSeatMachine?: InstallationId; editorPlacement?: CanvasPlacement; freeBytes?: number } = {}) => {
  const seatRoot = await mkdtemp(join(tmpdir(), "junto-signal-seat-"));
  const editorRoot = await mkdtemp(join(tmpdir(), "junto-signal-editor-"));
  dirs.push(seatRoot, editorRoot);
  seatRuntime = ManagedRuntime.make(AgentSignalRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(seatRoot, "junto.db")))));
  const ingested = await ingestContentBytes({ root: seatRoot, source: words, mediaType: "image/png", displayName: "shot.png" });
  const stated = { ...ingested.ref, mediaType: "image/png", displayName: "shot.png" } as ContentRef;
  // The seat's machine raised it; the editing machine took it as it crossed.
  const raised = await seatRuntime.runPromise(Effect.flatMap(AgentSignalRepository, (signals) =>
    signals.raise({ canvasName: "factory", nodeId: "peer", kind: "blocked", text: "look", signalId: "sig-1", attachments: [{ ref: stated }] })));
  const taken = { ...raised, attachments: takenSignalAttachments(raised.attachments ?? []) } as AgentSignal;
  const ref = (taken.attachments![0] as { ref: ContentRef }).ref;
  const served: number[] = [];
  const seatChannel = makeContentChannel({
    root: seatRoot,
    canvas: (_canvasName, peer) => Effect.succeed({ edits: false, peerLinked: peer === EDITOR }),
    verified: (asked) => Effect.sync(() => statContentForTransfer(seatRoot, asked).state === "verified"),
    // Judged by the seat's machine's own signal store.
    owners: (sha256, canvasName, peer) =>
      Effect.promise(() => seatRuntime.runPromise(Effect.flatMap(AgentSignalRepository, (signals) =>
        signalFileEntitled(signals, {
          owner: { canvasName, nodeId: "peer", recordId: "sig-1" },
          sha256,
          machine: peer,
          self: MINI,
          placement: placementOf(EDITOR, options.seatHomeOnSeatMachine ?? MINI),
        })))).pipe(Effect.map((rowEntitled) => [{ kind: "signal", canvasName, rowEntitled }])),
  });
  const counted = { ...seatChannel, handleRequest: (context: never, payload: unknown) => { served.push((payload as ContentPullRequest).offset); return seatChannel.handleRequest!(context, payload); } };
  const ab = new PassThrough();
  const ba = new PassThrough();
  const seatEnd = makeLinkSession({ readable: ba, writable: ab, self: hello("mini", MINI), admit: async () => {}, channels: { content: counted as never }, run: Effect.runPromise });
  const editorEnd = makeLinkSession({ readable: ab, writable: ba, self: hello("macbook", EDITOR), admit: async () => {}, channels: { content: seatChannel }, run: Effect.runPromise });
  sessions.push(seatEnd, editorEnd);
  await Promise.all([seatEnd.ready, editorEnd.ready]);
  const kept: Array<{ ref: ContentRef; owner: PulledOwner }> = [];
  const judged: Array<{ signalId: string; mediaType: string }> = [];
  const asked: string[] = [];
  const deps: SignalFilePullDeps = {
    self: EDITOR,
    placement: () => Effect.succeed(options.editorPlacement ?? placementOf(EDITOR, MINI)),
    machineName: (machine) => Effect.succeed(machine === MINI ? "mini" : undefined),
    ask: (machineName, request) => {
      asked.push(machineName);
      return Effect.tryPromise({ try: () => editorEnd.request("content", request), catch: (cause) => cause });
    },
    root: editorRoot,
    keep: (keptRef, owner) => Effect.sync(() => void kept.push({ ref: keptRef, owner })),
    judged: (signalId, _object, mediaType) => Effect.sync(() => void judged.push({ signalId, mediaType })),
    ...(options.freeBytes === undefined ? {} : { freeBytes: options.freeBytes }),
  };
  const dismiss = () => seatRuntime.runPromise(Effect.flatMap(AgentSignalRepository, (signals) => signals.dismiss("sig-1")));
  return { taken, ref, served, kept, judged, asked, deps, editorRoot, dismiss };
};

describe("the editing machine pulls a seat's signal file", () => {
  it("keeps it under the signal, by the seat's node and the signal's id, as its bytes say it is", async () => {
    const { taken, ref, served, kept, judged, deps, editorRoot } = await setUp();
    await Effect.runPromise(pullSignalFile(deps, { signal: taken, ref }));
    expect(served).toEqual([0]);
    expect(statContentForTransfer(editorRoot, ref).state).toBe("verified");
    expect(kept).toEqual([{ ref: { ...ref, mediaType: "text/plain" }, owner: { kind: "signal", canvasName: "factory", nodeId: "peer", recordId: "sig-1" } }]);
    expect(judged).toEqual([{ signalId: "sig-1", mediaType: "text/plain" }]);
  });

  it("gets not-editor from the seat's machine once the signal is closed there, and keeps nothing", async () => {
    const { taken, ref, kept, deps, editorRoot, dismiss } = await setUp();
    await dismiss();
    expect(await Effect.runPromise(Effect.flip(pullSignalFile(deps, { signal: taken, ref })))).toMatchObject({ _tag: "ContentPullRefused", reason: "not-editor" });
    expect(statContentForTransfer(editorRoot, ref).state).not.toBe("verified");
    expect(kept).toEqual([]);
  });

  it("gets not-editor from a machine the seat has left", async () => {
    const { taken, ref, kept, deps } = await setUp({ seatHomeOnSeatMachine: THIRD });
    expect(await Effect.runPromise(Effect.flip(pullSignalFile(deps, { signal: taken, ref })))).toMatchObject({ _tag: "ContentPullRefused", reason: "not-editor" });
    expect(kept).toEqual([]);
  });

  it("asks nothing when the file would leave the disk under its floor, when it does not edit the canvas, or for a file the signal does not name", async () => {
    const low = await setUp({ freeBytes: 1024 });
    expect(await Effect.runPromise(Effect.flip(pullSignalFile(low.deps, { signal: low.taken, ref: low.ref })))).toMatchObject({ message: "the file would leave this machine's disk under its free floor" });
    expect(low.served).toEqual([]);
    for (const session of sessions.splice(0)) await session.close();
    await seatRuntime.dispose();
    const away = await setUp({ editorPlacement: placementOf(THIRD, MINI) });
    expect(await Effect.runPromise(Effect.flip(pullSignalFile(away.deps, { signal: away.taken, ref: away.ref })))).toMatchObject({ message: "only the machine that edits the canvas pulls a seat's file" });
    const stray = { ...away.ref, sha256: "f".repeat(64) } as ContentRef;
    expect(await Effect.runPromise(Effect.flip(pullSignalFile({ ...away.deps, placement: () => Effect.succeed(placementOf(EDITOR, MINI)) }, { signal: away.taken, ref: stray })))).toMatchObject({ message: "the signal attached no such file" });
    expect(away.asked).toEqual([]);
    expect(away.served).toEqual([]);
  });

  it("pulls nothing on the seat's own machine: its files are there", async () => {
    const { taken, ref, asked, deps } = await setUp();
    await Effect.runPromise(pullSignalFile({ ...deps, placement: () => Effect.succeed(placementOf(EDITOR, EDITOR)) }, { signal: taken, ref }));
    expect(asked).toEqual([]);
  });
});

it("starts a pull only from the operator's preview: no other source names the puller", () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [join(dir, entry.name)] : []);
  const naming = sources("src").filter((file) => /SignalFilePuller|pullSignalFile/u.test(readFileSync(file, "utf8")));
  expect(naming.sort()).toEqual([
    "src/main/core-runtime.ts",
    "src/main/junto/ipc.ts",
    "src/main/junto/signals/file-pull.ts",
    "src/main/junto/signals/file-puller.ts",
  ]);
  // In the trusted IPC, only the preview read asks for one: every use past the import is inside it.
  const ipc = readFileSync("src/main/junto/ipc.ts", "utf8");
  const preview = ipc.indexOf("IPC_CHANNELS.previewRead");
  const next = ipc.indexOf("privilegedIpc.handle(", preview + 1);
  const uses = [...ipc.matchAll(/SignalFilePuller/gu)].map((match) => match.index!).filter((at) => !ipc.slice(ipc.lastIndexOf("\n", at) + 1, at).startsWith("import"));
  expect(uses.length).toBeGreaterThan(0);
  expect(uses.every((at) => at > preview && at < next)).toBe(true);
});
