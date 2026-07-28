import { describe, expect, it } from "vitest";
import {
  decodeStateUpdatePreflightReceiptText,
  STATE_UPDATE_PREFLIGHT_RECEIPT_MAX_BYTES,
} from "../scripts/state-update-preflight-receipt";

const freshReceipt = () => ({
  protocol: "vellum-state-update-preflight/v1",
  candidateId: "00000000-0000-4000-8000-000000000001",
  source: "fresh",
  sourceSchemaVersion: 0,
  targetSchemaVersion: 2,
  targetSchemaSha256: "a".repeat(64),
  installationId: "installation:fresh",
  role: "unenrolled",
  canvasCount: 0,
  actorSeatCount: 0,
  workSnapshotCount: 0,
  pendingCommandCount: 0,
  armedRegionCount: 0,
  schedulerCursorCount: 0,
  ready: true,
});

const installedReceipt = () => ({
  protocol: "vellum-state-update-preflight/v1",
  candidateId: "00000000-0000-4000-8000-000000000002",
  source: "installed",
  sourceSchemaVersion: 1,
  targetSchemaVersion: 2,
  targetSchemaSha256: "b".repeat(64),
  backupFile: "vellum-backup-00000000-0000-4000-8000-000000000003.db",
  installationId: "installation:installed",
  role: "command-center",
  canvasCount: 1,
  actorSeatCount: 2,
  workSnapshotCount: 3,
  pendingCommandCount: 4,
  armedRegionCount: 5,
  schedulerCursorCount: 6,
  activeIntent: {
    generation: "7",
    contentSha256: "c".repeat(64),
  },
  ready: true,
});

const decode = (value: unknown) =>
  decodeStateUpdatePreflightReceiptText(JSON.stringify(value));

describe("state update preflight receipt boundary", () => {
  it("accepts the exact fresh and installed candidate receipts", () => {
    expect(decode(freshReceipt())).toEqual(freshReceipt());
    expect(decode(installedReceipt())).toEqual(installedReceipt());
  });

  it.each([
    ["unknown key", { ...installedReceipt(), extra: true }],
    [
      "missing key",
      (({ candidateId: _candidateId, ...receipt }) => receipt)(
        installedReceipt(),
      ),
    ],
    [
      "invalid candidate UUID",
      { ...installedReceipt(), candidateId: "candidate" },
    ],
    [
      "invalid schema hash",
      { ...installedReceipt(), targetSchemaSha256: "A".repeat(64) },
    ],
    [
      "invalid active intent hash",
      {
        ...installedReceipt(),
        activeIntent: {
          generation: "7",
          contentSha256: "short",
        },
      },
    ],
    [
      "negative count",
      { ...installedReceipt(), pendingCommandCount: -1 },
    ],
    [
      "fractional count",
      { ...installedReceipt(), schedulerCursorCount: 1.5 },
    ],
    ["invalid role", { ...installedReceipt(), role: "station" }],
    [
      "invalid installation identity",
      { ...installedReceipt(), installationId: "../other" },
    ],
    ["ready false", { ...installedReceipt(), ready: false }],
  ])("rejects %s", (_label, receipt) => {
    expect(() => decode(receipt)).toThrow();
  });

  it("rejects source, backup, schema, and active-intent contradictions", () => {
    const installedWithoutBackup = installedReceipt();
    delete (
      installedWithoutBackup as Partial<
        ReturnType<typeof installedReceipt>
      >
    ).backupFile;
    const freshWithBackup = {
      ...freshReceipt(),
      backupFile:
        "vellum-backup-00000000-0000-4000-8000-000000000003.db",
    };
    const freshWithState = {
      ...freshReceipt(),
      role: "remote",
      canvasCount: 1,
      activeIntent: {
        generation: "1",
        contentSha256: "c".repeat(64),
      },
    };
    const sourceNewerThanTarget = {
      ...installedReceipt(),
      sourceSchemaVersion: 3,
      targetSchemaVersion: 2,
    };
    const missingActiveIntent = installedReceipt();
    delete (
      missingActiveIntent as Partial<
        ReturnType<typeof installedReceipt>
      >
    ).activeIntent;
    const orphanActiveIntent = {
      ...installedReceipt(),
      canvasCount: 0,
    };

    for (const receipt of [
      installedWithoutBackup,
      freshWithBackup,
      freshWithState,
      sourceNewerThanTarget,
      missingActiveIntent,
      orphanActiveIntent,
    ]) {
      expect(() => decode(receipt)).toThrow();
    }
  });

  it("rejects duplicate keys and every noncanonical encoding", () => {
    const canonical = JSON.stringify(installedReceipt());
    const {
      ready,
      ...receiptWithoutReady
    } = installedReceipt();
    const duplicateProtocol = canonical.replace(
      '{"protocol":"vellum-state-update-preflight/v1",',
      '{"protocol":"vellum-state-update-preflight/v1","protocol":"vellum-state-update-preflight/v1",',
    );
    const duplicateNestedKey = canonical.replace(
      '"generation":"7",',
      '"generation":"7","generation":"7",',
    );
    for (const text of [
      duplicateProtocol,
      duplicateNestedKey,
      ` ${canonical}`,
      `${canonical}\n`,
      JSON.stringify({
        ready,
        ...receiptWithoutReady,
      }),
    ]) {
      expect(() =>
        decodeStateUpdatePreflightReceiptText(text),
      ).toThrow();
    }
  });

  it("bounds stdin before JSON decoding", () => {
    expect(STATE_UPDATE_PREFLIGHT_RECEIPT_MAX_BYTES).toBe(
      16 * 1024,
    );
    expect(() =>
      decodeStateUpdatePreflightReceiptText(
        " ".repeat(STATE_UPDATE_PREFLIGHT_RECEIPT_MAX_BYTES + 1),
      ),
    ).toThrow(/oversized/u);
  });
});
