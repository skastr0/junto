import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ackMatchesStagedFrame,
  decodeProjectionAppliedAck,
  parseProjectionAppliedAckText,
  writeProjectionAppliedAck,
  appliedProjectionAckPath,
} from "../src/main/vellum/projection/ack";
import { compileStationProjection } from "../src/main/vellum/projection/compiler";
import {
  applyIncomingProjectionFrame,
  incomingProjectionFramePath,
} from "../src/main/vellum/projection/incoming";
import { startProjectionInboxPoll } from "../src/main/vellum/projection/inbox";
import {
  decideAckPromotion,
  needsProjectionRepush,
} from "../src/main/vellum/projection/reconcile";
import { reduceProjectionDelivery } from "../src/main/vellum/projection/delivery";
import {
  projectionRecordFromResult,
} from "../src/shared/station-status";
import { serializeCanvas, type CanvasDoc } from "../src/shared/canvas";

const WITNESS_A = "a".repeat(64);
const WITNESS_B = "b".repeat(64);
const emptyDoc = (): CanvasDoc => ({ nodes: [], edges: [] });

describe("projection applied.ack", () => {
  let dropRoot = "";

  afterEach(() => {
    if (dropRoot) rmSync(dropRoot, { recursive: true, force: true });
    dropRoot = "";
  });

  it("writes owner-only ack with required shape", async () => {
    dropRoot = mkdtempSync(join(tmpdir(), "vellum-ack-"));
    const ack = await writeProjectionAppliedAck({
      stationHostId: "studio",
      stationWitness: WITNESS_B,
      generation: "7",
      frameSha256: WITNESS_A,
      manifestSha256: "c".repeat(64),
      intentSha256: "d".repeat(64),
      appliedAt: "2026-07-24T00:00:00.000Z",
      dropRoot,
    });
    expect(ack.generation).toBe("7");
    const raw = readFileSync(appliedProjectionAckPath(dropRoot), "utf8");
    const decoded = parseProjectionAppliedAckText(raw);
    expect(decoded).toEqual(ack);
    expect(decodeProjectionAppliedAck({ ...ack, frameSha256: "bad" })).toBeUndefined();
  });

  it("ackMatchesStagedFrame requires generation + hashes", () => {
    const ack = {
      stationHostId: "studio",
      stationWitness: WITNESS_B,
      generation: "3",
      frameSha256: WITNESS_A,
      manifestSha256: "c".repeat(64),
      intentSha256: "d".repeat(64),
      appliedAt: "2026-07-24T00:00:00.000Z",
    };
    expect(
      ackMatchesStagedFrame(ack, {
        generation: "3",
        frameSha256: WITNESS_A,
        manifestSha256: "c".repeat(64),
      }),
    ).toBe(true);
    expect(
      ackMatchesStagedFrame(ack, {
        generation: "4",
        frameSha256: WITNESS_A,
        manifestSha256: "c".repeat(64),
      }),
    ).toBe(false);
  });

  it("applyIncoming writes applied.ack on success when writeAck set", async () => {
    dropRoot = mkdtempSync(join(tmpdir(), "vellum-ack-apply-"));
    const storeRoot = mkdtempSync(join(tmpdir(), "vellum-ack-store-"));
    try {
      const body = serializeCanvas(emptyDoc());
      const compiled = compileStationProjection({
        generation: "2",
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
        stationHostId: "studio",
        writeAck: true,
        replaceLiveAuthorityDocuments: async () => undefined,
      });
      expect(result.status).toBe("applied");
      const ack = parseProjectionAppliedAckText(
        readFileSync(appliedProjectionAckPath(dropRoot), "utf8"),
      );
      expect(ack?.generation).toBe("2");
      expect(ack?.stationHostId).toBe("studio");
      expect(ack?.frameSha256).toBe(compiled.frameSha256);
      expect(ack?.manifestSha256).toBe(compiled.manifestSha256);
      expect(ack?.intentSha256).toBe(compiled.manifest.intentSha256);
    } finally {
      rmSync(storeRoot, { recursive: true, force: true });
    }
  });
});

describe("projection delivery staged → applied via ack", () => {
  it("reduceProjectionDelivery promotes staged → applied", () => {
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

  it("decideAckPromotion only when hashes match staged receipt", () => {
    const staged = projectionRecordFromResult({
      hostId: "studio",
      endpoint: "studio-box",
      generation: "5",
      manifestSha256: "c".repeat(64),
      frameSha256: WITNESS_A,
      status: "staged",
      detail: "staged",
    });
    const match = decideAckPromotion(staged, {
      stationHostId: "studio",
      stationWitness: WITNESS_B,
      generation: "5",
      frameSha256: WITNESS_A,
      manifestSha256: "c".repeat(64),
      intentSha256: "d".repeat(64),
      appliedAt: "2026-07-24T00:00:00.000Z",
    });
    expect(match.promote).toBe(true);

    const mismatch = decideAckPromotion(staged, {
      stationHostId: "studio",
      stationWitness: WITNESS_B,
      generation: "4",
      frameSha256: WITNESS_A,
      manifestSha256: "c".repeat(64),
      intentSha256: "d".repeat(64),
      appliedAt: "2026-07-24T00:00:00.000Z",
    });
    expect(mismatch.promote).toBe(false);
  });

  it("needsProjectionRepush when ack gen lags desired", () => {
    expect(needsProjectionRepush("10", { generation: "9", status: "applied" })).toBe(
      true,
    );
    expect(needsProjectionRepush("10", { generation: "10", status: "applied" })).toBe(
      false,
    );
    expect(needsProjectionRepush("10", { generation: "10", status: "staged" })).toBe(
      false,
    );
    expect(needsProjectionRepush("10", { generation: "10", status: "unreachable" })).toBe(
      true,
    );
    expect(needsProjectionRepush("10", null)).toBe(true);
    expect(needsProjectionRepush("10", { generation: "10", status: "applied" }, "9")).toBe(
      true,
    );
  });
});

describe("projection inbox serialization", () => {
  let dropRoot = "";
  let storeRoot = "";

  afterEach(() => {
    if (dropRoot) rmSync(dropRoot, { recursive: true, force: true });
    if (storeRoot) rmSync(storeRoot, { recursive: true, force: true });
    dropRoot = "";
    storeRoot = "";
  });

  it("serializes applies (mutex) and never overlaps concurrent ticks", async () => {
    dropRoot = mkdtempSync(join(tmpdir(), "vellum-inbox-drop-"));
    storeRoot = mkdtempSync(join(tmpdir(), "vellum-inbox-store-"));
    let concurrent = 0;
    let maxConcurrent = 0;
    const admits: number[] = [];

    const body = serializeCanvas(emptyDoc());
    const compiled = compileStationProjection({
      generation: "1",
      createdAt: "2026-07-24T00:00:00.000Z",
      commandCenterWitness: WITNESS_A,
      targetWitness: WITNESS_B,
      documents: new Map([["portfolio", new TextEncoder().encode(body)]]),
    });
    mkdirSync(dropRoot, { recursive: true });
    writeFileSync(incomingProjectionFramePath(dropRoot), compiled.frame, {
      mode: 0o600,
    });

    const inbox = startProjectionInboxPoll({
      dropRoot,
      storeRoot,
      stationHostId: "studio",
      stationWitness: WITNESS_B,
      localStationRole: "remote",
      intervalMs: 60_000, // do not auto-fire; we drive tick()
      replaceLiveAuthorityDocuments: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 30));
        admits.push(Date.now());
        concurrent -= 1;
      },
    });

    try {
      const [a, b, c] = await Promise.all([
        inbox.tick(),
        inbox.tick(),
        inbox.tick(),
      ]);
      // Only the first tick sees the frame; later ticks see consumed drop or same sig.
      const applied = [a, b, c].filter(
        (r) => r && (r.status === "applied" || r.status === "idempotent"),
      );
      expect(applied.length).toBe(1);
      expect(maxConcurrent).toBeLessThanOrEqual(1);
      expect(admits.length).toBe(1);

      const ack = parseProjectionAppliedAckText(
        readFileSync(appliedProjectionAckPath(dropRoot), "utf8"),
      );
      expect(ack?.generation).toBe("1");
    } finally {
      inbox.stop();
    }
  });
});
