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

  it("applies a staged frame, materializes canvases, consumes drop", async () => {
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

    const admitted: string[][] = [];
    const result = await applyIncomingProjectionFrame({
      dropRoot,
      storeRoot,
      replaceLiveAuthority: async (names) => {
        admitted.push([...names]);
      },
    });

    expect(result.status).toBe("applied");
    if (result.status === "applied") {
      expect(result.generation).toBe("3");
      expect(result.names).toEqual(["portfolio"]);
    }
    expect(admitted).toEqual([["portfolio"]]);

    const snap = await loadStationProjectionSnapshot(storeRoot);
    expect(snap?.pointer.generation).toBe("3");

    const canvasPath = join(canvasesRoot, "portfolio.canvas");
    const onDisk = readFileSync(canvasPath, "utf8");
    expect(onDisk).toContain('"nodes"');

    // Drop consumed
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
});
