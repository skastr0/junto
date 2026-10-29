/**
 * The demo's answers to the phone's artifact reads: its Artifacts nodes with
 * counts and colours and the Inbox, and `inbox.set`. Over the fixture, with no
 * Mac.
 */
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DEMO_CANVAS, demoRequest, makeDemoHost } from "../src/shared/companion-demo";
import { CompanionResults, decodeCompanionRequestLine, type CompanionRequestFrame } from "../src/shared/companion-protocol";
import { DEMO_ARTIFACTS, DEMO_RESOURCE_NODES } from "../src/shared/wire/companion-demo-fixture";
import { THIS_MACHINE } from "./support/machines";

const frameOf = (id: string, op: CompanionRequestFrame["op"], args: object): CompanionRequestFrame => {
  const decoded = decodeCompanionRequestLine(demoRequest(id, op, args));
  if (!Result.isSuccess(decoded)) throw new Error(`not a request: ${JSON.stringify(decoded.failure)}`);
  return decoded.success;
};

const demo = () => {
  const host = makeDemoHost({ appVersion: "test", machineName: THIS_MACHINE });
  return (op: CompanionRequestFrame["op"], args: object) => host.call(frameOf("t1", op, args)) as Promise<Record<string, any>>;
};

describe("the demo's artifact nodes", () => {
  it("lists every Artifacts node with its counts and colours, and the Inbox", async () => {
    const reply = await demo()("artifacts.nodes", { canvasName: DEMO_CANVAS });
    expect(reply.ok).toBe(true);
    expect(Result.isSuccess(Schema.decodeUnknownResult(CompanionResults["artifacts.nodes"])(reply.result))).toBe(true);
    const { nodes, inboxNodeId } = reply.result;
    const artifactNodes = DEMO_RESOURCE_NODES.filter((node) => node.kind === "artifacts");
    expect(nodes.map((node: { nodeId: string }) => node.nodeId).sort()).toEqual(artifactNodes.map((node) => node.id).sort());
    expect(inboxNodeId).toBe("art-inbox");
    const live = nodes.reduce((sum: number, node: { live: number }) => sum + node.live, 0);
    const archived = nodes.reduce((sum: number, node: { archived: number }) => sum + node.archived, 0);
    expect(live + archived).toBe(DEMO_ARTIFACTS.length);
    expect(archived).toBeGreaterThan(0);
    expect(nodes.some((node: { labelColours: object }) => Object.keys(node.labelColours).length > 0)).toBe(true);
  });

  it("sets the Inbox to an Artifacts node, and refuses a node of another kind", async () => {
    const call = demo();
    const set = await call("inbox.set", { canvasName: DEMO_CANVAS, nodeId: "art-launch" });
    expect(set.result).toEqual({ inboxNodeId: "art-launch" });
    expect((await call("artifacts.nodes", { canvasName: DEMO_CANVAS })).result.inboxNodeId).toBe("art-launch");
    const refused = await call("inbox.set", { canvasName: DEMO_CANVAS, nodeId: "task-roadmap" });
    expect(refused.error.code).toBe("invalid");
    expect((await call("artifacts.nodes", { canvasName: DEMO_CANVAS })).result.inboxNodeId).toBe("art-launch");
    expect((await call("artifacts.nodes", { canvasName: "nowhere" })).error.code).toBe("not-found");
  });

  it("lists a node's live artifacts newest first, filters by type, label and archive, and pages", async () => {
    const call = demo();
    const all = (await call("artifacts.list", { canvasName: DEMO_CANVAS })).result;
    expect(Result.isSuccess(Schema.decodeUnknownResult(CompanionResults["artifacts.list"])(all))).toBe(true);
    const live = DEMO_ARTIFACTS.filter((artifact) => !artifact.head.archived);
    expect(all.artifacts).toHaveLength(live.length);
    expect(all.more).toBe(false);
    const times = all.artifacts.map((row: { updatedAt: number }) => row.updatedAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(all.artifacts.every((row: { snippet?: string }) => typeof row.snippet === "string")).toBe(true);

    const archived = (await call("artifacts.list", { canvasName: DEMO_CANVAS, archived: true })).result;
    expect(archived.artifacts).toHaveLength(DEMO_ARTIFACTS.length - live.length);

    const docs = (await call("artifacts.list", { canvasName: DEMO_CANVAS, type: "document" })).result;
    expect(docs.artifacts.length).toBeGreaterThan(0);
    expect(docs.artifacts.every((row: { type: string }) => row.type === "document")).toBe(true);

    const labelled = (await call("artifacts.list", { canvasName: DEMO_CANVAS, labels: ["launch"] })).result;
    expect(labelled.artifacts.every((row: { labels: string[] }) => row.labels.some((label) => label === "launch" || label.startsWith("launch/")))).toBe(true);

    const first = (await call("artifacts.list", { canvasName: DEMO_CANVAS, limit: 2 })).result;
    expect(first.artifacts).toHaveLength(2);
    expect(first.more).toBe(true);
    const second = (await call("artifacts.list", { canvasName: DEMO_CANVAS, limit: 2, before: first.next })).result;
    expect(second.artifacts[0].artifactId).toBe(all.artifacts[2].artifactId);

    expect((await call("artifacts.list", { canvasName: DEMO_CANVAS, before: "garbage" })).error.code).toBe("invalid");
    expect((await call("artifacts.list", { canvasName: DEMO_CANVAS, nodeId: "task-roadmap" })).error.code).toBe("not-found");
  });

  it("finds an artifact by a word in its title, labels or text", async () => {
    const call = demo();
    const first = DEMO_ARTIFACTS.find((artifact) => !artifact.head.archived)!;
    const word = first.head.title.split(" ")[0]!.toLowerCase();
    const found = (await call("artifacts.list", { canvasName: DEMO_CANVAS, query: word })).result;
    expect(found.artifacts.map((row: { artifactId: string }) => row.artifactId)).toContain(first.head.artifactId);
    expect((await call("artifacts.list", { canvasName: DEMO_CANVAS, query: "zzzzzz-nothing" })).result.artifacts).toEqual([]);
  });

  it("serves an artifact whole, an older version of it, and refuses what it does not hold", async () => {
    const call = demo();
    const edited = DEMO_ARTIFACTS.find((artifact) => artifact.versions.length > 1)!;
    const id = edited.head.artifactId;
    const head = (await call("artifact.get", { canvasName: DEMO_CANVAS, artifactId: id })).result;
    expect(Result.isSuccess(Schema.decodeUnknownResult(CompanionResults["artifact.get"])(head))).toBe(true);
    expect(head.version).toBe(edited.head.version);
    expect(head.body).toEqual(edited.body);
    expect(head.bodyRef.sha256).toMatch(/^[0-9a-f]{64}$/u);
    const first = (await call("artifact.get", { canvasName: DEMO_CANVAS, artifactId: id, version: 1 })).result;
    expect(first.version).toBe(1);
    expect(first.body).toEqual(edited.versions[0]!.body);
    expect(first.bodyRef.sha256).not.toBe(head.bodyRef.sha256);
    expect((await call("artifact.get", { canvasName: DEMO_CANVAS, artifactId: id, version: 99 })).error.code).toBe("not-found");
    expect((await call("artifact.get", { canvasName: DEMO_CANVAS, artifactId: "01J9DEM0ART999999999999999" })).error.code).toBe("not-found");
  });

  it("pages an artifact's versions newest first, with their authors and what each did", async () => {
    const call = demo();
    const edited = DEMO_ARTIFACTS.find((artifact) => artifact.versions.length > 2)!;
    const id = edited.head.artifactId;
    const all = (await call("artifact.history", { canvasName: DEMO_CANVAS, artifactId: id })).result;
    expect(Result.isSuccess(Schema.decodeUnknownResult(CompanionResults["artifact.history"])(all))).toBe(true);
    expect(all.versions.map((row: { version: number }) => row.version)).toEqual(edited.versions.map((record) => record.version).reverse());
    expect(all.versions.at(-1).change).toBe("create");
    expect(all.more).toBe(false);
    const first = (await call("artifact.history", { canvasName: DEMO_CANVAS, artifactId: id, limit: 1 })).result;
    expect(first.versions).toHaveLength(1);
    expect(first.more).toBe(true);
    const next = (await call("artifact.history", { canvasName: DEMO_CANVAS, artifactId: id, limit: 1, before: first.versions[0].version })).result;
    expect(next.versions[0].version).toBe(first.versions[0].version - 1);
    expect((await call("artifact.history", { canvasName: DEMO_CANVAS, artifactId: "01J9DEM0ART999999999999999" })).error.code).toBe("not-found");
  });

  it("queues no writes, and warns about a move that changes who reaches the artifact", async () => {
    const call = demo();
    expect((await call("artifact.pending", { canvasName: DEMO_CANVAS, nodeId: "art-inbox" })).result).toEqual({ writes: [] });
    expect((await call("artifact.pending", { canvasName: DEMO_CANVAS, nodeId: "task-roadmap" })).error.code).toBe("not-found");
    const inInbox = DEMO_ARTIFACTS.find((artifact) => artifact.head.nodeId === "art-inbox")!.head.artifactId;
    const warned = (await call("artifact.moveCheck", { canvasName: DEMO_CANVAS, artifactIds: [inInbox], to: "art-launch" })).result;
    expect(Result.isSuccess(Schema.decodeUnknownResult(CompanionResults["artifact.moveCheck"])(warned))).toBe(true);
    expect(warned.warning).toContain("Launch");
    expect((await call("artifact.moveCheck", { canvasName: DEMO_CANVAS, artifactIds: [inInbox], to: "art-notes" })).result).toEqual({});
    expect((await call("artifact.moveCheck", { canvasName: DEMO_CANVAS, artifactIds: [inInbox], to: "task-roadmap" })).error.code).toBe("not-found");
  });

  it("reads an artifact's body, and a file's content, through content.get", async () => {
    const call = demo();
    const document = DEMO_ARTIFACTS.find((artifact) => artifact.body.type === "document")!;
    const got = (await call("artifact.get", { canvasName: DEMO_CANVAS, artifactId: document.head.artifactId })).result;
    const piece = (await call("content.get", { sha256: got.bodyRef.sha256, offset: 0, length: 262_144 })).result;
    expect(piece.byteLength).toBe(got.bodyRef.byteLength);
    expect(JSON.parse(Buffer.from(piece.data, "base64").toString("utf8"))).toEqual(document.body);

    const file = DEMO_ARTIFACTS.find((artifact) => artifact.body.type === "file")!;
    const content = (file.body as { content: { sha256: string; byteLength: number } }).content;
    const bytes = (await call("content.get", { sha256: content.sha256, offset: 0, length: 262_144 })).result;
    expect(bytes.byteLength).toBe(content.byteLength);

    expect((await call("content.get", { sha256: "f".repeat(64), offset: 0, length: 16 })).error.code).toBe("not-found");
  });
});
