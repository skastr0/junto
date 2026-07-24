import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileStationProjection } from "../src/main/vellum/projection/compiler";
import {
  applyIncomingProjectionFrame,
  incomingProjectionFramePath,
} from "../src/main/vellum/projection/incoming";
import { loadStationProjectionSnapshot } from "../src/main/vellum/projection/station-store";
import { serializeCanvas, type CanvasDoc } from "../src/shared/canvas";

const WITNESS_A = "a".repeat(64);
const WITNESS_B = "b".repeat(64);

const emptyDoc = (): CanvasDoc => ({ nodes: [], edges: [] });

describe("applyIncomingProjectionFrame", () => {
  let dropRoot = "";
  let storeRoot = "";
  let canvasesRoot = "";
  let prevCanvases: string | undefined;
  let prevDrop: string | undefined;
  let prevStore: string | undefined;

  const setup = () => {
    dropRoot = mkdtempSync(join(tmpdir(), "vellum-incoming-drop-"));
    storeRoot = mkdtempSync(join(tmpdir(), "vellum-incoming-store-"));
    canvasesRoot = mkdtempSync(join(tmpdir(), "vellum-incoming-canvases-"));
    prevCanvases = process.env.VELLUM_CANVASES_DIR;
    prevDrop = process.env.VELLUM_PROJECTION_DROP_DIR;
    prevStore = process.env.VELLUM_STATION_PROJECTION_DIR;
    process.env.VELLUM_CANVASES_DIR = canvasesRoot;
    process.env.VELLUM_PROJECTION_DROP_DIR = dropRoot;
    process.env.VELLUM_STATION_PROJECTION_DIR = storeRoot;
  };

  afterEach(() => {
    if (prevCanvases === undefined) delete process.env.VELLUM_CANVASES_DIR;
    else process.env.VELLUM_CANVASES_DIR = prevCanvases;
    if (prevDrop === undefined) delete process.env.VELLUM_PROJECTION_DROP_DIR;
    else process.env.VELLUM_PROJECTION_DROP_DIR = prevDrop;
    if (prevStore === undefined) delete process.env.VELLUM_STATION_PROJECTION_DIR;
    else process.env.VELLUM_STATION_PROJECTION_DIR = prevStore;
    if (dropRoot) rmSync(dropRoot, { recursive: true, force: true });
    if (storeRoot) rmSync(storeRoot, { recursive: true, force: true });
    if (canvasesRoot) rmSync(canvasesRoot, { recursive: true, force: true });
    dropRoot = "";
    storeRoot = "";
    canvasesRoot = "";
  });

  it("returns absent when no drop file exists", async () => {
    setup();
    const result = await applyIncomingProjectionFrame({
      dropRoot,
      storeRoot,
    });
    expect(result.status).toBe("absent");
  });

  it("applies a staged frame, admits documents to live authority, consumes drop", async () => {
    setup();
    const body = serializeCanvas(emptyDoc());
    const compiled = compileStationProjection({
      generation: "3",
      createdAt: "2026-07-24T00:00:00.000Z",
      commandCenterWitness: WITNESS_A,
      targetWitness: WITNESS_B,
      documents: new Map([["portfolio", new TextEncoder().encode(body)]]),
    });

    mkdirSync(dropRoot, { recursive: true });
    writeFileSync(incomingProjectionFramePath(dropRoot), compiled.frame, {
      mode: 0o600,
    });

    const admitted: Array<ReadonlyMap<string, CanvasDoc>> = [];
    const result = await applyIncomingProjectionFrame({
      dropRoot,
      storeRoot,
      replaceLiveAuthorityDocuments: async (documents) => {
        admitted.push(documents);
      },
    });

    expect(result.status).toBe("applied");
    if (result.status === "applied") {
      expect(result.generation).toBe("3");
      expect(result.names).toEqual(["portfolio"]);
    }
    expect(admitted).toHaveLength(1);
    expect([...admitted[0]!.keys()]).toEqual(["portfolio"]);
    expect(admitted[0]!.get("portfolio")).toEqual(emptyDoc());

    const snap = await loadStationProjectionSnapshot(storeRoot);
    expect(snap?.pointer.generation).toBe("3");

    // Drop consumed — no .canvas materialize required for admit
    expect(() =>
      readFileSync(incomingProjectionFramePath(dropRoot)),
    ).toThrow();
  });

  it("rejects corrupt frames without consuming the drop", async () => {
    setup();
    mkdirSync(dropRoot, { recursive: true });
    const path = incomingProjectionFramePath(dropRoot);
    writeFileSync(path, "not-a-frame", { mode: 0o600 });

    const result = await applyIncomingProjectionFrame({
      dropRoot,
      storeRoot,
    });
    expect(result.status).toBe("rejected");
    // Drop retained for re-push / inspection
    expect(readFileSync(path, "utf8")).toBe("not-a-frame");
  });

  it("rejects wrong targetWitness without mutating authority or drop", async () => {
    setup();
    const body = serializeCanvas(emptyDoc());
    const compiled = compileStationProjection({
      generation: "4",
      createdAt: "2026-07-24T00:00:00.000Z",
      commandCenterWitness: WITNESS_A,
      targetWitness: WITNESS_B,
      documents: new Map([["portfolio", new TextEncoder().encode(body)]]),
    });
    mkdirSync(dropRoot, { recursive: true });
    const path = incomingProjectionFramePath(dropRoot);
    writeFileSync(path, compiled.frame, { mode: 0o600 });

    let admitCalls = 0;
    const result = await applyIncomingProjectionFrame({
      dropRoot,
      storeRoot,
      localStationRole: "remote",
      localStationWitness: "c".repeat(64),
      replaceLiveAuthorityDocuments: async () => {
        admitCalls += 1;
      },
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.detail).toMatch(/targetWitness does not match/i);
    }
    expect(admitCalls).toBe(0);
    expect(readFileSync(path).byteLength).toBe(compiled.frame.byteLength);
    const snap = await loadStationProjectionSnapshot(storeRoot);
    expect(snap).toBeUndefined();
  });

  it("rejects non-Remote local role without mutating authority", async () => {
    setup();
    const body = serializeCanvas(emptyDoc());
    const compiled = compileStationProjection({
      generation: "5",
      createdAt: "2026-07-24T00:00:00.000Z",
      commandCenterWitness: WITNESS_A,
      targetWitness: WITNESS_B,
      documents: new Map([["portfolio", new TextEncoder().encode(body)]]),
    });
    mkdirSync(dropRoot, { recursive: true });
    writeFileSync(incomingProjectionFramePath(dropRoot), compiled.frame, {
      mode: 0o600,
    });

    let admitCalls = 0;
    const result = await applyIncomingProjectionFrame({
      dropRoot,
      storeRoot,
      localStationRole: "command-center",
      localStationWitness: WITNESS_B,
      replaceLiveAuthorityDocuments: async () => {
        admitCalls += 1;
      },
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.detail).toMatch(/requires Remote station role/i);
    }
    expect(admitCalls).toBe(0);
  });

  it("applies when role is remote and targetWitness matches", async () => {
    setup();
    const body = serializeCanvas(emptyDoc());
    const compiled = compileStationProjection({
      generation: "6",
      createdAt: "2026-07-24T00:00:00.000Z",
      commandCenterWitness: WITNESS_A,
      targetWitness: WITNESS_B,
      documents: new Map([["portfolio", new TextEncoder().encode(body)]]),
    });
    mkdirSync(dropRoot, { recursive: true });
    writeFileSync(incomingProjectionFramePath(dropRoot), compiled.frame, {
      mode: 0o600,
    });

    const result = await applyIncomingProjectionFrame({
      dropRoot,
      storeRoot,
      localStationRole: "remote",
      localStationWitness: WITNESS_B,
      replaceLiveAuthorityDocuments: async () => undefined,
    });
    expect(result.status).toBe("applied");
  });
});
