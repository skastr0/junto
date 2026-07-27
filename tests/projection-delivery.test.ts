import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer, ManagedRuntime } from "effect";
import {
  assessStationDoctor,
  decodeStationStatusDocument,
  projectionRecordFromResult,
  type StationProjectionRecord,
} from "../src/shared/station-status";
import {
  applyLocalProjectionForTest,
  compileProjectionSnapshot,
  deliverProjectionToHosts,
  documentsFromCanvasDocs,
  reduceProjectionDelivery,
  scheduleHostSync,
  REMOTE_PROJECTION_BRIDGE_RESIDUAL_DETAIL,
} from "../src/main/vellum/projection/delivery";
import {
  loadStationProjectionSnapshot,
} from "../src/main/vellum/projection/station-store";
import {
  makeStationStatusLive,
  readStationStatus,
  recordStationProjection,
  StationStatusService,
} from "../src/main/vellum/station-status-store";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import type { CanvasDoc } from "../src/shared/canvas";

const WITNESS_A = "a".repeat(64);
const WITNESS_B = "b".repeat(64);

const emptyDoc = (): CanvasDoc => ({ nodes: [], edges: [] });

const makeStatusRuntime = (databasePath: string) => {
  const engine = makeStateEngineLive(databasePath);
  return ManagedRuntime.make(
    Layer.provideMerge(makeStationStatusLive(), engine),
  );
};

describe("projection delivery status machine", () => {
  it("schedules to pending from unset", () => {
    const next = reduceProjectionDelivery(undefined, { type: "schedule" });
    expect(next).toEqual({
      ok: true,
      status: "pending",
      terminal: false,
      detail: "projection delivery scheduled",
    });
  });

  it("transitions pending → applied", () => {
    const next = reduceProjectionDelivery("pending", {
      type: "applied",
      detail: "installed generation 1",
    });
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.status).toBe("applied");
      expect(next.terminal).toBe(true);
      expect(next.detail).toBe("installed generation 1");
    }
  });

  it("transitions pending → rejected", () => {
    const next = reduceProjectionDelivery("pending", {
      type: "rejected",
      detail: "conflict",
    });
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.status).toBe("rejected");
      expect(next.terminal).toBe(true);
    }
  });

  it("transitions pending → unreachable", () => {
    const next = reduceProjectionDelivery("pending", {
      type: "unreachable",
      detail: "remote down",
    });
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.status).toBe("unreachable");
    }
  });

  it("transitions pending → staged", () => {
    const next = reduceProjectionDelivery("pending", {
      type: "staged",
      detail: "frame staged at /home/x/.vellum/projections/incoming.frame",
    });
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.status).toBe("staged");
      expect(next.terminal).toBe(true);
    }
  });

  it("promotes staged → applied after matching ack", () => {
    const next = reduceProjectionDelivery("staged", {
      type: "applied",
      detail: "remote ack confirms generation 3",
    });
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.status).toBe("applied");
      expect(next.terminal).toBe(true);
    }
  });

  it("refuses outcome events outside pending (except staged→applied ack)", () => {
    for (const status of ["applied", "rejected", "unreachable"] as const) {
      const next = reduceProjectionDelivery(status, {
        type: "applied",
        detail: "nope",
      });
      expect(next.ok).toBe(false);
      if (!next.ok) {
        expect(next.error).toMatch(/cannot apply event applied/);
      }
    }
    // staged + rejected still refused
    const rejectedFromStaged = reduceProjectionDelivery("staged", {
      type: "rejected",
      detail: "nope",
    });
    expect(rejectedFromStaged.ok).toBe(false);
  });

  it("allows schedule from a terminal status (new attempt)", () => {
    const next = reduceProjectionDelivery("applied", { type: "schedule" });
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.status).toBe("pending");
  });
});

describe("projection delivery compile + local apply", () => {
  let root = "";

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  it("compiles from CanvasDoc via serializeCanvas", () => {
    const docs = documentsFromCanvasDocs([
      { name: "zeta", doc: emptyDoc() },
      { name: "alpha", doc: { nodes: [{ id: "n1", type: "text", x: 0, y: 0, width: 1, height: 1, text: "hi" }], edges: [] } },
    ]);
    expect([...docs.keys()].sort()).toEqual(["alpha", "zeta"]);

    const compiled = compileProjectionSnapshot({
      generation: "1",
      createdAt: "2026-07-24T00:00:00.000Z",
      commandCenterWitness: WITNESS_A,
      targetWitness: WITNESS_B,
      documents: [
        { name: "solo", doc: emptyDoc() },
      ],
    });
    expect(compiled.manifest.generation).toBe("1");
    expect(compiled.manifest.documents).toHaveLength(1);
    expect(compiled.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("applyLocalProjectionForTest installs into the station store", async () => {
    root = mkdtempSync(join(tmpdir(), "vellum-proj-delivery-"));
    const compiled = compileProjectionSnapshot({
      generation: "4",
      createdAt: "2026-07-24T00:00:00.000Z",
      commandCenterWitness: WITNESS_A,
      targetWitness: WITNESS_B,
      documents: new Map([
        ["alpha", new TextEncoder().encode('{"nodes":[],"edges":[]}\n')],
      ]),
    });

    const result = await applyLocalProjectionForTest(compiled, root);
    expect(result.status).toBe("applied");
    expect(result.generation).toBe("4");

    const snap = await loadStationProjectionSnapshot(root);
    expect(snap?.pointer.generation).toBe("4");
    expect(snap?.pointer.manifestSha256).toBe(compiled.manifestSha256);
  });

  it("applyLocalProjectionForTest rejects stale generations", async () => {
    root = mkdtempSync(join(tmpdir(), "vellum-proj-delivery-"));
    const gen10 = compileProjectionSnapshot({
      generation: "10",
      createdAt: "2026-07-24T00:00:00.000Z",
      commandCenterWitness: WITNESS_A,
      targetWitness: WITNESS_B,
      documents: new Map([
        ["a", new TextEncoder().encode("1")],
      ]),
    });
    await applyLocalProjectionForTest(gen10, root);

    const gen9 = compileProjectionSnapshot({
      generation: "9",
      createdAt: "2026-07-24T00:00:00.000Z",
      commandCenterWitness: WITNESS_A,
      targetWitness: WITNESS_B,
      documents: new Map([
        ["a", new TextEncoder().encode("1")],
      ]),
    });
    const rejected = await applyLocalProjectionForTest(gen9, root);
    expect(rejected.status).toBe("rejected");
    expect(rejected.detail).toMatch(/refused generation|stale/i);
  });
});

describe("scheduleHostSync status recording", () => {
  let statusRoot = "";
  let storeRoot = "";
  let clock = 0;
  let statusRuntime: ReturnType<typeof makeStatusRuntime>;

  beforeEach(async () => {
    statusRoot = mkdtempSync(join(tmpdir(), "vellum-proj-status-"));
    storeRoot = mkdtempSync(join(tmpdir(), "vellum-proj-store-"));
    statusRuntime = makeStatusRuntime(
      join(statusRoot, "vellum.db"),
    );
    await statusRuntime.runPromise(StationStatusService);
    clock = 0;
  });

  afterEach(async () => {
    await statusRuntime.dispose();
    rmSync(statusRoot, { recursive: true, force: true });
    rmSync(storeRoot, { recursive: true, force: true });
  });

  const now = () => {
    clock += 1;
    return `2026-07-24T00:00:0${clock}.000Z`;
  };

  const compile = (generation: string) =>
    compileProjectionSnapshot({
      generation,
      createdAt: "2026-07-24T00:00:00.000Z",
      commandCenterWitness: WITNESS_A,
      targetWitness: WITNESS_B,
      documents: new Map([
        ["portfolio", new TextEncoder().encode('{"nodes":[],"edges":[]}\n')],
      ]),
    });

  it("local mode: pending then applied, durable lastProjection", async () => {
    const compiled = compile("1");
    const seen: StationProjectionRecord[] = [];

    const result = await scheduleHostSync(
      compiled,
      [{ hostId: "local", mode: "local" }],
      {
        localStoreRoot: storeRoot,
        now,
        record: async (row) => {
          seen.push(row);
          await recordStationProjection(row);
        },
      },
    );

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]!.record.status).toBe("applied");
    expect(result.outcomes[0]!.record.ok).toBe(true);
    expect(seen.map((r) => r.status)).toEqual(["pending", "applied"]);

    const status = await readStationStatus();
    expect(status.lastProjection?.status).toBe("applied");
    expect(status.lastProjection?.generation).toBe("1");
    expect(status.lastProjection?.manifestSha256).toBe(compiled.manifestSha256);
    expect(status.projections?.local?.status).toBe("applied");

    const snap = await loadStationProjectionSnapshot(storeRoot);
    expect(snap?.pointer.generation).toBe("1");
  });

  it("local mode: pending then rejected on store conflict", async () => {
    const first = compile("5");
    await applyLocalProjectionForTest(first, storeRoot);

    // Same generation, different frame body → conflict → rejected
    const conflict = compileProjectionSnapshot({
      generation: "5",
      createdAt: "2026-07-24T00:00:00.000Z",
      commandCenterWitness: WITNESS_A,
      targetWitness: WITNESS_B,
      documents: new Map([
        ["portfolio", new TextEncoder().encode('{"nodes":[{"id":"x"}],"edges":[]}\n')],
      ]),
    });

    const result = await scheduleHostSync(
      conflict,
      [{ hostId: "local", mode: "local" }],
      { localStoreRoot: storeRoot, now, record: recordStationProjection },
    );

    expect(result.outcomes[0]!.record.status).toBe("rejected");
    expect(result.outcomes[0]!.record.ok).toBe(false);

    const status = await readStationStatus();
    expect(status.lastProjection?.status).toBe("rejected");
  });

  it("remote mode without transport: pending then unreachable residual", async () => {
    const compiled = compile("2");
    const result = await scheduleHostSync(
      compiled,
      [{ hostId: "studio", endpoint: "studio-box", mode: "remote" }],
      { now, record: recordStationProjection },
    );

    expect(result.outcomes[0]!.record.status).toBe("unreachable");
    expect(result.outcomes[0]!.record.detail).toBe(
      REMOTE_PROJECTION_BRIDGE_RESIDUAL_DETAIL,
    );

    const status = await readStationStatus();
    expect(status.lastProjection?.status).toBe("unreachable");
    expect(status.projections?.studio?.endpoint).toBe("studio-box");
  });

  it("remote mode with transport: pending then staged (not applied)", async () => {
    const compiled = compile("3");
    const result = await scheduleHostSync(
      compiled,
      [{ hostId: "studio", endpoint: "studio-box", mode: "remote" }],
      {
        now,
        record: recordStationProjection,
        transport: {
          deliver: async () => ({ ok: true, detail: "bridge ok" }),
        },
      },
    );
    expect(result.outcomes[0]!.record.status).toBe("staged");
    expect(result.outcomes[0]!.record.ok).toBe(true);
    expect(result.outcomes[0]!.record.detail).toBe("bridge ok");
  });

  it("remote transport rejection: pending → rejected", async () => {
    const compiled = compile("6");
    const result = await scheduleHostSync(
      compiled,
      [{ hostId: "studio", endpoint: "studio-box", mode: "remote" }],
      {
        now,
        record: recordStationProjection,
        transport: {
          deliver: async () => ({
            ok: false,
            status: "rejected",
            detail: "remote refused generation",
          }),
        },
      },
    );
    expect(result.outcomes[0]!.record.status).toBe("rejected");
  });

  it("remote mode with product-shaped transport: pending then staged", async () => {
    const compiled = compile("8");
    const seen: Array<{ hostId: string; endpoint: string; gen: string }> = [];
    const result = await scheduleHostSync(
      compiled,
      [{ hostId: "studio", endpoint: "studio-box", mode: "remote" }],
      {
        now,
        record: recordStationProjection,
        transport: {
          deliver: async (input) => {
            seen.push({
              hostId: input.hostId,
              endpoint: input.endpoint,
              gen: input.compiled.manifest.generation,
            });
            return {
              ok: true,
              detail: "projection frame staged at /home/x/.vellum/projections/incoming.frame",
            };
          },
        },
      },
    );
    expect(result.outcomes[0]!.record.status).toBe("staged");
    expect(seen).toEqual([
      { hostId: "studio", endpoint: "studio-box", gen: "8" },
    ]);
  });


  it("deliverProjectionToHosts compiles and syncs in one call", async () => {
    const result = await deliverProjectionToHosts(
      {
        generation: "7",
        createdAt: "2026-07-24T00:00:00.000Z",
        commandCenterWitness: WITNESS_A,
        targetWitness: WITNESS_B,
        documents: new Map([
          ["a", new TextEncoder().encode("{}")],
        ]),
        targets: [{ hostId: "local", mode: "local" }],
      },
      { localStoreRoot: storeRoot, now, record: recordStationProjection },
    );
    expect(result.generation).toBe("7");
    expect(result.outcomes[0]!.record.status).toBe("applied");
  });
});

describe("station-status projection decode + doctor", () => {
  it("decodes lastProjection and projections map", () => {
    const row = projectionRecordFromResult({
      hostId: "studio",
      endpoint: "studio-box",
      generation: "12",
      manifestSha256: WITNESS_A,
      frameSha256: WITNESS_B,
      status: "applied",
      detail: "installed",
      at: "2026-07-24T12:00:00.000Z",
    });
    const decoded = decodeStationStatusDocument({
      version: 1,
      lastProjection: row,
      projections: { studio: row },
    });
    expect(decoded?.lastProjection).toEqual(row);
    expect(decoded?.projections?.studio).toEqual(row);
  });

  it("decodes staged projection status as delivery-ok", () => {
    const row = projectionRecordFromResult({
      hostId: "studio",
      generation: "1",
      manifestSha256: WITNESS_A,
      status: "staged",
      detail: "frame staged",
      at: "2026-07-24T12:00:00.000Z",
    });
    expect(row.ok).toBe(true);
    expect(row.status).toBe("staged");
    const decoded = decodeStationStatusDocument({
      version: 1,
      lastProjection: row,
    });
    expect(decoded?.lastProjection?.status).toBe("staged");
  });

  it("rejects corrupt projection fields", () => {
    expect(
      decodeStationStatusDocument({
        version: 1,
        lastProjection: {
          at: "x",
          hostId: "h",
          generation: "1",
          manifestSha256: "not-a-hash",
          status: "applied",
          ok: true,
          detail: "x",
        },
      }),
    ).toBeUndefined();
  });

  it("surfaces lastProjection in doctor detail + metadata", () => {
    const check = assessStationDoctor({
      role: "command-center",
      hostId: "local",
      commandCenterRef: "",
      supervisedPreferred: false,
      supervisedInstalled: "absent",
      status: {
        version: 1,
        lastProjection: projectionRecordFromResult({
          hostId: "studio",
          generation: "9",
          manifestSha256: WITNESS_A,
          status: "unreachable",
          detail: REMOTE_PROJECTION_BRIDGE_RESIDUAL_DETAIL,
          at: "2026-07-24T12:00:00.000Z",
        }),
      },
      workControlReady: true,
    });
    expect(check.status).toBe("warning");
    expect(check.detail).toMatch(/last projection unreachable/);
    expect(check.metadata?.lastProjectionStatus).toBe("unreachable");
    expect(check.metadata?.lastProjectionGeneration).toBe("9");
    expect(check.metadata?.lastProjectionHostId).toBe("studio");
  });
});

describe("projection generation binds to authority generation", () => {
  it("authority generation stamps projection frames (not wall-clock)", () => {
    const authorityGeneration = "42";
    const compiled = compileProjectionSnapshot({
      generation: authorityGeneration,
      createdAt: "2026-07-24T00:00:00.000Z",
      commandCenterWitness: WITNESS_A,
      targetWitness: WITNESS_B,
      documents: new Map([
        ["portfolio", new TextEncoder().encode('{"nodes":[],"edges":[]}\n')],
      ]),
    });
    expect(compiled.manifest.generation).toBe("42");
    // Wall-clock would be 13+ digits; authority gens are small monotonic decimals.
    expect(compiled.manifest.generation.length).toBeLessThanOrEqual(32);
    expect(/^(0|[1-9][0-9]*)$/.test(compiled.manifest.generation)).toBe(true);
  });
});
