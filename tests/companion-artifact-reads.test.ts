/**
 * The phone's artifact reads (0.11.3): the Artifacts nodes of a canvas with
 * their counts, colours and Inbox, and `inbox.set`. The Mac's reader is driven
 * through its ports, so the order of a write and the push to the windows is
 * checked without the app's runtime. The demo's answers are in
 * companion-demo-artifacts.test.ts.
 */
import { Result } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  COMPANION_CLOSED_ARGS_OPS,
  COMPANION_PROTOCOL,
  COMPANION_WRITE_OPS,
  decodeCompanionRequestLine,
} from "../src/shared/companion-protocol";
import { makeArtifactReadBackend, type ArtifactReadPorts } from "../src/main/junto/companion/artifact-reads";
import { captureRowsOf } from "../src/renderer/components/capture/capture-list";
import type { Artifact, ArtifactBody } from "../src/shared/wire/artifact";
import { COMPANION_ARTIFACT_GET_BUDGET_BYTES } from "../src/shared/wire/companion-artifact-reads";
import { COMPANION_MAX_OUTBOUND_BYTES } from "../src/shared/companion-protocol";
import { asNodeId, type Canvas } from "../src/shared/model";
import type { JuntoViewStateApi } from "../src/shared/ipc";
import type { ViewStateEvent, ViewStateSnapshot } from "../src/shared/view-state";
import { createMainViewState } from "../src/renderer/lib/view-state-main";
import { publishViewStateChange, subscribeViewStateChanges } from "../src/main/junto/view-state/changes";

const line = (id: string, op: string, args: object): string => JSON.stringify({ v: COMPANION_PROTOCOL, type: "request", id, op, args });

describe("the artifact reads in the protocol", () => {
  it("counts inbox.set against the write limit, and closes both ops' args", () => {
    expect(COMPANION_WRITE_OPS.has("inbox.set")).toBe(true);
    expect(COMPANION_WRITE_OPS.has("artifacts.nodes")).toBe(false);
    for (const op of ["artifacts.nodes", "inbox.set"] as const) expect(COMPANION_CLOSED_ARGS_OPS.has(op)).toBe(true);
    const extra = decodeCompanionRequestLine(line("x", "artifacts.nodes", { canvasName: "main", nodeId: "art-inbox" }));
    expect(Result.isFailure(extra)).toBe(true);
    expect(Result.isFailure(decodeCompanionRequestLine(line("y", "inbox.set", { canvasName: "main" })))).toBe(true);
  });
});

const canvasOf = (nodes: ReadonlyArray<Record<string, unknown> & { id: string }>): Canvas =>
  ({ nodes: new Map(nodes.map((node) => [asNodeId(node.id), node])) }) as unknown as Canvas;

const canvasWith = (...nodes: Array<{ id: string; kind: string; label?: string }>): Canvas =>
  ({ nodes: new Map(nodes.map((node) => [asNodeId(node.id), { ...node, x: 0, y: 0, width: 10, height: 10, z: 1 }])) }) as unknown as Canvas;

const portsOver = (over: Partial<ArtifactReadPorts> = {}): ArtifactReadPorts => ({
  canvas: async () => canvasWith({ id: "a", kind: "artifacts", label: "Notes" }, { id: "b", kind: "artifacts", label: "Inbox" }, { id: "t", kind: "task" }),
  counts: async () => new Map([["a", { live: 2, archived: 1 }]]),
  colours: async () => new Map([["a", { launch: "green" as const }]]),
  inbox: async () => "b",
  setInbox: async () => true,
  publish: () => undefined,
  headers: async () => [],
  bodies: async () => new Map(),
  pending: async () => new Set(),
  artifact: async () => "none",
  contentOwners: async () => [],
  holds: async () => true,
  history: async () => "none",
  pendingWrites: async () => [],
  nodesOf: async () => new Map(),
  ...over,
});

describe("the Mac's artifact reads", () => {
  it("lists the Artifacts nodes only, with counts, colours and a live Inbox", async () => {
    const reply = await makeArtifactReadBackend(portsOver()).artifactNodes("main");
    expect(reply).toMatchObject({ ok: true });
    if (!reply.ok) return;
    expect(reply.value.nodes.map((node) => [node.nodeId, node.live, node.archived])).toEqual([["a", 2, 1], ["b", 0, 0]]);
    expect(reply.value.nodes[0]!.labelColours).toEqual({ launch: "green" });
    expect(reply.value.inboxNodeId).toBe("b");
  });

  it("leaves the Inbox out when its node is gone, and says not-found for a missing canvas", async () => {
    const gone = await makeArtifactReadBackend(portsOver({ inbox: async () => "deleted" })).artifactNodes("main");
    expect(gone.ok && gone.value.inboxNodeId).toBeFalsy();
    const none = await makeArtifactReadBackend(portsOver({ canvas: async () => undefined })).artifactNodes("main");
    expect(none).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("writes the Inbox first and tells the windows only after the row is kept", async () => {
    const order: string[] = [];
    const ports = portsOver({
      setInbox: async (canvasName, nodeId) => {
        order.push(`write ${canvasName} ${nodeId}`);
        return true;
      },
      publish: () => order.push("publish"),
    });
    const reply = await makeArtifactReadBackend(ports).inboxSet("main", "a");
    expect(reply).toMatchObject({ ok: true, value: { inboxNodeId: "a" } });
    expect(order).toEqual(["write main a", "publish"]);
  });

  it("refuses a node the store will not keep, and tells no window", async () => {
    const publish = vi.fn();
    const reply = await makeArtifactReadBackend(portsOver({ setInbox: async () => false, publish })).inboxSet("main", "t");
    expect(reply).toMatchObject({ ok: false, error: { code: "invalid" } });
    const failed = await makeArtifactReadBackend(portsOver({ setInbox: async () => undefined, publish })).inboxSet("main", "a");
    expect(failed).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("an Inbox the phone sets reaches the desktop's quick capture", () => {
  const snapshotWith = (captureInboxes: Record<string, string>): ViewStateSnapshot =>
    ({ commandGroups: {}, nodes: {}, focusSizes: {}, sections: {}, captureInboxes });

  it("is what the window's next capture reads once the reload push lands", async () => {
    // Main: the store holds the phone's choice and the change bus is the one the IPC forwards as a reload.
    let stored = snapshotWith({ main: "notes" });
    const listeners = new Set<(event: ViewStateEvent) => void>();
    const api: JuntoViewStateApi = {
      snapshot: async () => stored,
      apply: async () => ({ ok: true }),
      onChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const unsubscribe = subscribeViewStateChanges(() => {
      for (const listener of listeners) listener({ area: "reload" });
    });
    const tick = () => new Promise<void>((done) => setTimeout(done, 0));
    const state = createMainViewState(api);
    await tick();
    expect(state.nodeView.captureInbox("main")).toBe("notes");

    const backend = makeArtifactReadBackend(
      portsOver({
        setInbox: async (canvasName, nodeId) => {
          stored = snapshotWith({ [canvasName]: nodeId });
          return true;
        },
        publish: () => publishViewStateChange(),
      }),
    );
    await backend.inboxSet("main", "inbox-two");
    await tick();
    await tick();
    expect(state.nodeView.captureInbox("main")).toBe("inbox-two");
    unsubscribe();
  });
});

const artifact = (n: number, over: Partial<Artifact> = {}): Artifact =>
  ({
    artifactId: `01J9ART${String(n).padStart(19, "0")}`,
    nodeId: "a",
    type: "document",
    title: `Artifact ${String(n)}`,
    version: 1,
    createdBy: { kind: "operator" },
    updatedAt: 1_000 - n,
    archived: false,
    taskIds: [],
    labels: [],
    ...over,
  }) as unknown as Artifact;

const doc = (markdown: string): ArtifactBody => ({ type: "document", markdown }) as unknown as ArtifactBody;

describe("the Mac's artifact list", () => {
  const listOver = (rows: ReadonlyArray<Artifact>, bodies: Record<string, ArtifactBody> = {}, over: Partial<ArtifactReadPorts> = {}) =>
    makeArtifactReadBackend(
      portsOver({
        headers: async () => rows,
        bodies: async (_canvas, ids) => new Map(ids.map((id) => [id, bodies[id] ?? null] as const)),
        ...over,
      }),
    );

  it("pages newest first by a cursor that survives a row landing above it", async () => {
    const rows = [1, 2, 3, 4, 5].map((n) => artifact(n));
    const backend = listOver(rows);
    const first = await backend.artifactList({ canvasName: "main", limit: 2 });
    expect(first.ok && first.value.artifacts.map((row) => row.title)).toEqual(["Artifact 1", "Artifact 2"]);
    if (!first.ok) return;
    expect(first.value.more).toBe(true);
    const newer = [artifact(0, { updatedAt: 5_000 }), ...rows];
    const second = await listOver(newer).artifactList({ canvasName: "main", limit: 2, before: first.value.next });
    expect(second.ok && second.value.artifacts.map((row) => row.title)).toEqual(["Artifact 3", "Artifact 4"]);
    const last = await listOver(newer).artifactList({ canvasName: "main", limit: 5, before: second.ok ? second.value.next : undefined });
    expect(last.ok && last.value).toMatchObject({ more: false });
    expect(last.ok && last.value.artifacts.map((row) => row.title)).toEqual(["Artifact 5"]);
  });

  it("refuses a cursor it did not give, and a node that is not an Artifacts node", async () => {
    const backend = listOver([artifact(1)]);
    expect(await backend.artifactList({ canvasName: "main", before: "nonsense" })).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(await backend.artifactList({ canvasName: "main", nodeId: asNodeId("t") })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("asks the store for the node, type, labels and archive it was given, and the whole canvas otherwise", async () => {
    const asked: unknown[] = [];
    const backend = listOver([], {}, { headers: async (_canvas, query) => (asked.push(query), []) });
    await backend.artifactList({ canvasName: "main", nodeId: asNodeId("a"), type: "pad", labels: ["launch" as never], archived: true });
    await backend.artifactList({ canvasName: "main" });
    expect(asked).toEqual([
      { nodeIds: ["a"], archived: true, type: "pad", labels: ["launch"] },
      { nodeIds: ["a", "b"], archived: false },
    ]);
  });

  it("carries a snippet of the text and the pending mark", async () => {
    const rows = [artifact(1), artifact(2), artifact(3, { type: "pad" })];
    const backend = listOver(rows, { [rows[0]!.artifactId]: doc("x".repeat(500)) }, { pending: async () => new Set([rows[1]!.artifactId]) });
    const reply = await backend.artifactList({ canvasName: "main" });
    if (!reply.ok) throw new Error("not ok");
    const [one, two, three] = reply.value.artifacts;
    expect(one!.snippet).toHaveLength(200);
    expect(one!.pending).toBeUndefined();
    expect(two!.snippet).toBeUndefined();
    expect(two!.pending).toBe(true);
    expect(three!.snippet).toBeUndefined();
  });

  it("ranks a search exactly as the desktop's quick capture does", async () => {
    const rows = [
      artifact(1, { title: "Pricing page", labels: ["launch" as never] }),
      artifact(2, { title: "Roadmap", labels: ["pricing" as never] }),
      artifact(3, { title: "Notes" }),
      artifact(4, { title: "Prices and plans", type: "sheet" }),
      artifact(5, { title: "Standup", updatedAt: 2_000 }),
    ];
    const bodies = { [rows[2]!.artifactId]: doc("The pricing review is Friday."), [rows[4]!.artifactId]: doc("nothing relevant") };
    for (const query of ["pricing", "pri", "sheet", "friday", "zzz", "Pricing page"]) {
      const heads = rows.map((row) => ({ artifact: row, body: bodies[row.artifactId] ?? null, bodyRef: undefined as never }));
      const wanted = captureRowsOf(heads, undefined, query).map((row) => row.artifactId);
      const reply = await listOver(rows, bodies).artifactList({ canvasName: "main", query });
      expect(reply.ok && reply.value.artifacts.map((row) => row.artifactId), `query ${query}`).toEqual(wanted);
    }
  });

  it("cuts a page at the byte budget and resumes after the last row it sent", async () => {
    const rows = Array.from({ length: 12 }, (_, n) => artifact(n, { title: `${String(n).padStart(3, "0")} ${"t".repeat(190)}` }));
    const bodies = Object.fromEntries(rows.map((row) => [row.artifactId, doc("w".repeat(500))]));
    const budget = 2_500;
    const backend = makeArtifactReadBackend(
      portsOver({ headers: async () => rows, bodies: async (_canvas, ids) => new Map(ids.map((id) => [id, bodies[id] ?? null] as const)) }),
      budget,
    );
    const seen: string[] = [];
    const sizes: number[] = [];
    let before: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const reply = await backend.artifactList({ canvasName: "main", limit: 12, ...(before === undefined ? {} : { before }) });
      if (!reply.ok) throw new Error("not ok");
      sizes.push(reply.value.artifacts.length);
      seen.push(...reply.value.artifacts.map((row) => row.artifactId));
      if (!reply.value.more) break;
      expect(reply.value.next).toBeDefined();
      before = reply.value.next;
    }
    // Every page was cut short of the twelve asked for, none is empty, and together they are the whole list once.
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.every((size) => size >= 1 && size < 12)).toBe(true);
    expect(seen).toEqual(rows.map((row) => row.artifactId));
  });
});

describe("the Mac's artifact.get", () => {
  const ref = { sha256: "a".repeat(64), byteLength: 10, mediaType: "text/markdown" } as never;
  const head = artifact(7, { labels: ["launch" as never, "plain" as never] });
  const getOver = (body: ArtifactBody | null, over: Partial<ArtifactReadPorts> = {}) =>
    makeArtifactReadBackend(
      portsOver({
        artifact: async () => ({ artifact: head, version: 1 as never, body, bodyRef: ref }),
        colours: async () => new Map([["a", { launch: "green" as const, other: "red" as const }]]),
        ...over,
      }),
    );
  const args = { canvasName: "main", artifactId: head.artifactId } as never;
  const encoded = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

  it("keeps the budget below the frame", () => {
    expect(COMPANION_ARTIFACT_GET_BUDGET_BYTES).toBeLessThan(COMPANION_MAX_OUTBOUND_BYTES);
  });

  it("sends a small body inline with the colours of its own labels only", async () => {
    const reply = await getOver(doc("hello")).artifactGet(args);
    if (!reply.ok) throw new Error("not ok");
    expect(reply.value.body).toEqual(doc("hello"));
    expect(reply.value.labelColours).toEqual({ launch: "green" });
    expect(reply.value.bodyRef).toEqual(ref);
  });

  it("inlines a body exactly up to the budget in encoded bytes, and sends only the ref one byte past it", async () => {
    const base = await getOver(doc("")).artifactGet(args);
    if (!base.ok) throw new Error("not ok");
    const room = COMPANION_ARTIFACT_GET_BUDGET_BYTES - encoded(base.value);
    const at = await getOver(doc("x".repeat(room))).artifactGet(args);
    const past = await getOver(doc("x".repeat(room + 1))).artifactGet(args);
    if (!at.ok || !past.ok) throw new Error("not ok");
    expect(encoded(at.value)).toBe(COMPANION_ARTIFACT_GET_BUDGET_BYTES);
    expect(at.value.body).toBeDefined();
    expect(past.value.body).toBeUndefined();
    expect(past.value.bodyRef).toEqual(ref);
  });

  it("counts bytes, not characters: 300,000 quotes escape past the frame, 300,000 letters do not", async () => {
    const quotes = await getOver(doc('"'.repeat(300_000))).artifactGet(args);
    const letters = await getOver(doc("a".repeat(300_000))).artifactGet(args);
    if (!quotes.ok || !letters.ok) throw new Error("not ok");
    expect(quotes.value.body).toBeUndefined();
    expect(letters.value.body).toBeDefined();
    // The same under the document cap in characters: only the bytes tell them apart.
    expect(300_000).toBeLessThan(512_000);
  });

  it("says a body still on its way is unavailable, and an unknown artifact or version is not-found", async () => {
    expect(await getOver(null).artifactGet(args)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await getOver(doc("x"), { artifact: async () => "none" }).artifactGet(args)).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(await getOver(doc("x"), { artifact: async () => "no-version" }).artifactGet(args)).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(await getOver(doc("x"), { artifact: async () => undefined }).artifactGet(args)).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  it("marks an artifact one of this Mac's queued writes touches", async () => {
    const reply = await getOver(doc("x"), { pending: async () => new Set([head.artifactId]) }).artifactGet(args);
    expect(reply.ok && reply.value.pending).toBe(true);
  });
});

describe("the Mac's artifact history, pending writes and move check", () => {
  const id = (n: number) => artifact(n).artifactId;

  it("hands back the store's versions and moves, capping the moves at the newest 200", async () => {
    const moves = Array.from({ length: 205 }, (_, n) => ({ from: asNodeId("a"), to: asNodeId("b"), by: { kind: "operator" as const }, at: n }));
    const versions = [{ version: 2 as never, author: { kind: "operator" as const }, at: 20, change: "patch" as const }];
    const asked: unknown[] = [];
    const backend = makeArtifactReadBackend(
      portsOver({ history: async (_canvas, _id, page) => (asked.push(page), { versions, more: true, moves }) }),
    );
    const reply = await backend.artifactHistory({ canvasName: "main", artifactId: id(1) as never, before: 5 as never, limit: 10 });
    if (!reply.ok) throw new Error("not ok");
    expect(asked).toEqual([{ limit: 10, before: 5 }]);
    expect(reply.value.more).toBe(true);
    expect(reply.value.moves).toHaveLength(200);
    expect(reply.value.moves[0]!.at).toBe(5);
    expect(await makeArtifactReadBackend(portsOver()).artifactHistory({ canvasName: "main", artifactId: id(1) as never })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("lists the node's queued writes, and only for an Artifacts node of the canvas", async () => {
    const write = { opId: "01J9OP00000000000000000001" as never, artifactId: id(1) as never, op: { op: "archive" } as never, wouldRefuse: "It is archived." };
    const backend = makeArtifactReadBackend(portsOver({ pendingWrites: async (_canvas, node) => (node === "a" ? [write] : []) }));
    expect(await backend.artifactPending({ canvasName: "main", nodeId: asNodeId("a") })).toMatchObject({ ok: true, value: { writes: [write] } });
    expect(await backend.artifactPending({ canvasName: "main", nodeId: asNodeId("t") })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("warns, as the desktop does, when a move changes which regions' seats reach the artifacts", async () => {
    const frame = (x: number) => ({ x, y: 0, width: 100, height: 100, z: 1 });
    const regions = canvasOf([
      { id: "r1", kind: "region", label: "Alpha", ...frame(0) },
      { id: "r2", kind: "region", label: "Beta", ...frame(300) },
      { id: "a", kind: "artifacts", label: "Notes", x: 10, y: 10, width: 20, height: 20, z: 2 },
      { id: "b", kind: "artifacts", label: "Launch", x: 310, y: 10, width: 20, height: 20, z: 2 },
    ]);
    const backend = makeArtifactReadBackend(portsOver({ canvas: async () => regions, nodesOf: async (_c, ids) => new Map(ids.map((one) => [one, "a"] as const)) }));
    const reply = await backend.artifactMoveCheck({ canvasName: "main", artifactIds: [id(1), id(2)] as never, to: asNodeId("b") });
    if (!reply.ok) throw new Error("not ok");
    expect(reply.value.warning).toContain("Alpha");
    expect(reply.value.warning).toContain("Beta");
    expect(reply.value.warning).toContain("these");
    const same = await backend.artifactMoveCheck({ canvasName: "main", artifactIds: [id(1)] as never, to: asNodeId("a") });
    expect(same).toMatchObject({ ok: true, value: {} });
    expect(same.ok && same.value.warning).toBeUndefined();
  });

  it("refuses a target that is not an Artifacts node and an artifact the canvas does not hold", async () => {
    const backend = makeArtifactReadBackend(portsOver({ nodesOf: async () => new Map() }));
    expect(await backend.artifactMoveCheck({ canvasName: "main", artifactIds: [id(1)] as never, to: asNodeId("t") })).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(await backend.artifactMoveCheck({ canvasName: "main", artifactIds: [id(1)] as never, to: asNodeId("a") })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});

describe("content.get beyond feeds and mail", () => {
  const ref = (sha: string, byteLength = 10) => ({ sha256: sha, byteLength, mediaType: "image/png" }) as never;

  it("answers the store's ref for a digest an artifact still holds, and no other owner's", async () => {
    const owned = [
      { ref: ref("a".repeat(64), 42), canvasName: "gone", artifactId: "x" },
      { ref: ref("a".repeat(64), 42), canvasName: "main", artifactId: "kept" },
    ];
    const backend = makeArtifactReadBackend(
      portsOver({ contentOwners: async () => owned, holds: async (canvasName, id) => canvasName === "main" && id === "kept" }),
    );
    expect(await backend.artifactContentRef("a".repeat(64))).toEqual(owned[1]!.ref);
  });

  it("answers nothing when no artifact holds the digest, or the store cannot be read", async () => {
    expect(await makeArtifactReadBackend(portsOver()).artifactContentRef("b".repeat(64))).toBeUndefined();
    expect(await makeArtifactReadBackend(portsOver({ contentOwners: async () => undefined })).artifactContentRef("b".repeat(64))).toBeUndefined();
    const lost = makeArtifactReadBackend(
      portsOver({ contentOwners: async () => [{ ref: ref("c".repeat(64)), canvasName: "main", artifactId: "deleted" }], holds: async () => false }),
    );
    expect(await lost.artifactContentRef("c".repeat(64))).toBeUndefined();
  });
});
