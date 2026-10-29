/**
 * `artifact.apply` through the request core and the demo: every ArtifactOp
 * ruled, a replayed opId answering the first ruling, stale and
 * rebase_conflict crossing as `conflict` with the head, the rest `invalid`,
 * and the write budget of its own (docs/artifacts-proposal.md sections 3 and
 * 5). The demo stands in for the Mac: same rulings, no machine.
 */
import { describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import { makeDemoBackend, demoRequest } from "../src/shared/companion-demo";
import {
  handleCompanionRequest,
  makeCompanionGates,
  makeWriteLimiter,
  outcomeOk,
  type CompanionBackend,
} from "../src/shared/companion-core";
import { decodeCompanionRequestLine, type CompanionOpName, type CompanionRequestFrame } from "../src/shared/companion-protocol";
import type { ItemId, NodeId } from "../src/shared/wire/ids";
import { COMPANION_ARTIFACT_WRITE_LIMIT } from "../src/shared/wire/companion-artifact-writes";
import { CompanionResults } from "../src/shared/wire/companion-protocol";
import { DEMO_ARTIFACTS, DEMO_CANVAS } from "../src/shared/wire/companion-demo-fixture";

const frame = (op: CompanionOpName, args: object, id = "a1"): CompanionRequestFrame => {
  const decoded = decodeCompanionRequestLine(demoRequest(id, op, args));
  if (!Result.isSuccess(decoded)) throw new Error(`the test's own frame did not decode: ${op}`);
  return decoded.success;
};

const callOp = (backend: CompanionBackend, op: CompanionOpName, args: object, allowArtifactWrite: () => boolean = () => true) =>
  handleCompanionRequest(frame(op, args), {
    backend,
    device: { deviceId: "dev", state: "paired" },
    allowWrite: () => true,
    allowArtifactWrite,
    gates: makeCompanionGates(),
  });

const call = (backend: CompanionBackend, args: object, allowArtifactWrite: () => boolean = () => true) =>
  callOp(backend, "artifact.apply", args, allowArtifactWrite);

const demo = () => makeDemoBackend("apply-test");

const document = () => DEMO_ARTIFACTS.find((a) => a.head.type === "document" && !a.head.archived)!;
const sheet = () => DEMO_ARTIFACTS.find((a) => a.head.type === "sheet")!;

describe("artifact.apply through the demo", () => {
  it("applies every ArtifactOp and answers the head", async () => {
    const backend = demo();
    let seq = 0;
    const apply = (args: object) => call(backend, args, () => true);
    const opId = () => `01J9DEM0TST${String(++seq).padStart(15, "0")}`;

    const doc = document();
    const target = { canvasName: DEMO_CANVAS, nodeId: doc.head.nodeId, artifactId: doc.head.artifactId };

    const retitled = await apply({ ...target, opId: opId(), op: { op: "retitle", title: "Renamed" } });
    expect(retitled).toMatchObject({ ok: true, result: { disposition: "applied", artifact: { title: "Renamed" }, version: doc.head.version } });

    const labelled = await apply({ ...target, opId: opId(), op: { op: "labels", labels: ["Launch", "launch/pricing"] } });
    expect(labelled).toMatchObject({ ok: true, result: { disposition: "applied", artifact: { labels: ["launch", "launch/pricing"] } } });

    const tasked = await apply({ ...target, opId: opId(), op: { op: "tasks", taskIds: ["01J9DEM0TSK000000000000002"] } });
    expect(tasked).toMatchObject({ ok: true, result: { disposition: "applied", artifact: { taskIds: ["01J9DEM0TSK000000000000002"] } } });

    const moved = await apply({ ...target, opId: opId(), op: { op: "move", to: "art-launch" } });
    expect(moved).toMatchObject({ ok: true, result: { disposition: "applied", artifact: { nodeId: "art-launch" } } });
    // A move moves the target: the next op names where it now is.
    target.nodeId = "art-launch" as NodeId;

    const docVersion = doc.head.version;
    const edited = await apply({
      ...target,
      opId: opId(),
      op: { op: "edit", edit: { kind: "patch", type: "document", baseVersion: docVersion, patches: [{ op: "splice", at: 0, remove: 0, insert: "note " }] } },
    });
    expect(edited).toMatchObject({ ok: true, result: { disposition: "applied", version: docVersion + 1 } });

    const archived = await apply({ ...target, opId: opId(), op: { op: "archive" } });
    expect(archived).toMatchObject({ ok: true, result: { disposition: "applied", artifact: { archived: true } } });
    const restored = await apply({ ...target, opId: opId(), op: { op: "restore" } });
    expect(restored).toMatchObject({ ok: true, result: { disposition: "applied", artifact: { archived: false } } });

    const coloured = await apply({ canvasName: DEMO_CANVAS, nodeId: "art-launch", opId: opId(), op: { op: "labelColour", label: "launch", colour: "pink" } });
    expect(coloured).toMatchObject({ ok: true, result: { disposition: "applied" } });
    if (!coloured.ok) expect.unreachable();
    expect("artifact" in coloured.result).toBe(false);

    const created = await apply({
      canvasName: DEMO_CANVAS,
      nodeId: "art-inbox",
      artifactId: "01J9DEM0ART000000000000099",
      opId: opId(),
      op: { op: "create", title: "Phone note", body: { type: "document", markdown: "hi" }, labels: ["Launch"] },
    });
    expect(created).toMatchObject({ ok: true, result: { disposition: "applied", artifact: { artifactId: "01J9DEM0ART000000000000099", version: 1, labels: ["launch"] }, version: 1 } });
    // The reads see the write: the same world the phone lists and gets.
    const got = await backend.artifactGet({ canvasName: DEMO_CANVAS, artifactId: "01J9DEM0ART000000000000099" as ItemId });
    expect(got.ok && got.value.artifact.title).toBe("Phone note");
  });

  it("answers a resend with the first ruling, never a second write", async () => {
    const backend = demo();
    const doc = document();
    const args = {
      canvasName: DEMO_CANVAS,
      nodeId: doc.head.nodeId,
      artifactId: doc.head.artifactId,
      opId: "01J9DEM0TST000000000000001",
      op: { op: "retitle", title: "First title" },
    };
    const first = await call(backend, args);
    const again = await call(backend, { ...args, op: { op: "retitle", title: "A different title" } });
    expect(first).toMatchObject({ ok: true, result: { artifact: { title: "First title" } } });
    expect(again).toMatchObject({ ok: true, result: { artifact: { title: "First title" } } });
  });

  it("refuses an edit behind the head as conflict stale with the head", async () => {
    const backend = demo();
    const doc = document();
    const stale = await call(backend, {
      canvasName: DEMO_CANVAS,
      nodeId: doc.head.nodeId,
      artifactId: doc.head.artifactId,
      opId: "01J9DEM0TST000000000000002",
      op: { op: "edit", edit: { kind: "patch", type: "document", baseVersion: 1, patches: [{ op: "splice", at: 0, remove: 0, insert: "x" }] } },
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "conflict", reason: "stale", artifact: { artifactId: doc.head.artifactId, version: doc.head.version } } });
  });

  it("refuses two patches on one cell as rebase_conflict, and rebases a disjoint one", async () => {
    const backend = demo();
    const grid = sheet();
    const cell = (rowId: string, columnId: string, value: string) => ({ op: "cell" as const, rowId, columnId, value });
    const base = grid.head.version;
    // One session edit lands: v_base -> v_base+1.
    const first = await call(backend, {
      canvasName: DEMO_CANVAS, nodeId: grid.head.nodeId, artifactId: grid.head.artifactId, opId: "01J9DEM0TST000000000000003",
      op: { op: "edit", edit: { kind: "patch", type: "sheet", baseVersion: base, patches: [cell("r2", "c2", "14")] } },
    });
    expect(first).toMatchObject({ ok: true, result: { disposition: "applied", version: base + 1 } });
    // A second at the same base on the same cell: the Mac's rebase refuses it.
    const clash = await call(backend, {
      canvasName: DEMO_CANVAS, nodeId: grid.head.nodeId, artifactId: grid.head.artifactId, opId: "01J9DEM0TST000000000000004",
      op: { op: "edit", edit: { kind: "patch", type: "sheet", baseVersion: base, patches: [cell("r2", "c2", "16")] } },
    });
    expect(clash).toMatchObject({ ok: false, error: { code: "conflict", reason: "rebase_conflict", artifact: { version: base + 1 } } });
    // The same base on a different cell rebases onto it.
    const rebased = await call(backend, {
      canvasName: DEMO_CANVAS, nodeId: grid.head.nodeId, artifactId: grid.head.artifactId, opId: "01J9DEM0TST000000000000005",
      op: { op: "edit", edit: { kind: "patch", type: "sheet", baseVersion: base, patches: [cell("r1", "c1", "Free tier")] } },
    });
    expect(rebased).toMatchObject({ ok: true, result: { disposition: "applied", version: base + 2 } });
  });

  it("refuses what the ruler cannot read as invalid with its sentence", async () => {
    const backend = demo();
    const doc = document();
    const badLabel = await call(backend, {
      canvasName: DEMO_CANVAS, nodeId: doc.head.nodeId, artifactId: doc.head.artifactId, opId: "01J9DEM0TST000000000000006",
      op: { op: "labels", labels: ["Not A Label!!"] },
    });
    expect(badLabel).toMatchObject({ ok: false, error: { code: "invalid" } });
    const missing = await call(backend, {
      canvasName: DEMO_CANVAS, nodeId: doc.head.nodeId, artifactId: "01J9DEM0ART999999999999999", opId: "01J9DEM0TST000000000000007",
      op: { op: "retitle", title: "ghost" },
    });
    expect(missing).toMatchObject({ ok: false, error: { code: "not-found" } });
    const noItem = await call(backend, {
      canvasName: DEMO_CANVAS, nodeId: doc.head.nodeId, opId: "01J9DEM0TST000000000000008",
      op: { op: "retitle", title: "no target" },
    });
    expect(noItem).toMatchObject({ ok: false, error: { code: "invalid" } });
    const wrongCanvas = await call(backend, {
      canvasName: "elsewhere", nodeId: doc.head.nodeId, artifactId: doc.head.artifactId, opId: "01J9DEM0TST000000000000009",
      op: { op: "retitle", title: "x" },
    });
    expect(wrongCanvas).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("budgets artifact writes apart from mail's: the 61st in a window is rate-limited while writes keep passing", async () => {
    const backend = demo();
    const allowArtifactWrite = makeWriteLimiter(COMPANION_ARTIFACT_WRITE_LIMIT);
    const doc = document();
    const args = { canvasName: DEMO_CANVAS, nodeId: doc.head.nodeId, artifactId: doc.head.artifactId, op: { op: "retitle", title: "x" } };
    for (let i = 0; i < COMPANION_ARTIFACT_WRITE_LIMIT; i += 1) {
      const response = await call(backend, { ...args, opId: `01J9DEM0B60${String(i).padStart(15, "0")}` }, allowArtifactWrite);
      expect(response.ok).toBe(true);
    }
    const limited = await call(backend, { ...args, opId: "01J9DEM0B60000000000000999" }, allowArtifactWrite);
    expect(limited).toMatchObject({ ok: false, error: { code: "rate-limited" } });
    // The shared 20-write budget did not notice the 60 applies.
    const mail = await handleCompanionRequest(
      frame("mail.send", { canvasName: DEMO_CANVAS, nodeId: "atlas", text: "still works" }),
      { backend, device: { deviceId: "dev", state: "paired" }, allowWrite: () => true, allowArtifactWrite, gates: makeCompanionGates() },
    );
    expect(mail.ok).toBe(true);
  });

  it("carries the queued disposition through unchanged", async () => {
    const backend = {
      artifactApply: async () => outcomeOk({ disposition: "queued" as const, opId: "01J9DEM0TST000000000000010" }),
    } as unknown as CompanionBackend;
    const response = await call(backend, {
      canvasName: DEMO_CANVAS, nodeId: "art-notes", artifactId: "01J9DEM0ART000000000000001", opId: "01J9DEM0TST000000000000010",
      op: { op: "retitle", title: "later" },
    });
    expect(response).toMatchObject({ ok: true, result: { disposition: "queued", opId: "01J9DEM0TST000000000000010" } });
  });

  it("claims bytes staged for the artifact, once, and serves them by ref", async () => {
    const backend = demo();
    const bytes = Buffer.from("one,two\n1,2\n", "utf-8");
    const sha256 = "ab".repeat(32);
    const stage = (args: object) => callOp(backend, "content.stage", args);
    const piece = { canvasName: DEMO_CANVAS, sha256, byteLength: bytes.length, mediaType: "text/csv", displayName: "phone.csv", purpose: { for: "artifact", canvasName: DEMO_CANVAS }, offset: 0, data: bytes.toString("base64") };

    const staged = await stage(piece);
    expect(staged).toMatchObject({ ok: true, result: { ref: { sha256, byteLength: bytes.length } } });
    if (!staged.ok || !("ref" in staged.result)) expect.unreachable();
    const ref = staged.result.ref;

    const create = (artifactId: string, opId: string) =>
      call(backend, {
        canvasName: DEMO_CANVAS, nodeId: "art-inbox", artifactId, opId,
        op: { op: "create", title: "Phone file", body: { type: "file", content: ref } },
      });
    const created = await create("01J9DEM0ART000000000000091", "01J9DEM0TST000000000000021");
    expect(created).toMatchObject({ ok: true, result: { disposition: "applied", version: 1 } });

    // The claim: content.get reads the staged bytes back through the artifact's own ref.
    const got = await callOp(backend, "content.get", { sha256, offset: 0, length: bytes.length });
    expect(got).toMatchObject({ ok: true, result: { sha256, length: bytes.length, data: bytes.toString("base64") } });

    // A second apply naming the same ref claims nothing — the first claim took it — and still lands.
    const second = await create("01J9DEM0ART000000000000092", "01J9DEM0TST000000000000022");
    expect(second).toMatchObject({ ok: true, result: { disposition: "applied" } });
    const again = await callOp(backend, "content.get", { sha256, offset: 0, length: 4 });
    expect(again).toMatchObject({ ok: true });
  });

  it("stages only for an artifact on that canvas", async () => {
    const backend = demo();
    const piece = { canvasName: DEMO_CANVAS, sha256: "cd".repeat(32), byteLength: 3, mediaType: "text/plain", offset: 0, data: Buffer.from("abc").toString("base64") };
    // Mail purpose has no claim path in the demo, as on the Mac it lands under a seat nothing claims.
    const noPurpose = await callOp(backend, "content.stage", piece);
    expect(noPurpose).toMatchObject({ ok: false, error: { code: "invalid" } });
    const wrongCanvas = await callOp(backend, "content.stage", { ...piece, purpose: { for: "artifact", canvasName: "elsewhere" } });
    expect(wrongCanvas).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("decodes on the wire: the result the demo sends is the schema's", async () => {
    const backend = demo();
    const doc = document();
    const response = await call(backend, {
      canvasName: DEMO_CANVAS, nodeId: doc.head.nodeId, artifactId: doc.head.artifactId, opId: "01J9DEM0TST000000000000011",
      op: { op: "retitle", title: "Wire check" },
    });
    expect(response.ok).toBe(true);
    const decoded = Schema.decodeUnknownResult(CompanionResults["artifact.apply"])((response as { result: unknown }).result);
    expect(decoded._tag).toBe("Success");
  });
});
