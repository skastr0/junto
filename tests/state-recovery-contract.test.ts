import { describe, expect, it } from "vitest";
import {
  decodeStateBackupId,
  decodeStateRecoveryExportResult,
  decodeStateRecoveryListResult,
} from "../src/shared/state-recovery";

const id = decodeStateBackupId(
  "22222222-2222-4222-8222-222222222222",
);

const backup = {
  id,
  file: "junto-backup-22222222-2222-4222-8222-222222222222.db",
  bytes: 4_096,
  modifiedAtEpochMs: 1_700_000_000_000,
  schemaVersion: 1,
  schemaSha256: "a".repeat(64),
};

describe("state recovery boundary", () => {
  it("strictly decodes verified inventory results", () => {
    expect(
      decodeStateRecoveryListResult({
        outcome: "listed",
        backups: [backup],
      }),
    ).toEqual({
      outcome: "listed",
      backups: [backup],
    });

    expect(() =>
      decodeStateRecoveryListResult({
        outcome: "listed",
        backups: [backup],
        destination: "/tmp/not-allowed.db",
      }),
    ).toThrow();
  });

  it("keeps cancellation distinct from export failures", () => {
    expect(
      decodeStateRecoveryExportResult({ outcome: "canceled" }),
    ).toEqual({ outcome: "canceled" });
    expect(
      decodeStateRecoveryExportResult({
        outcome: "error",
        code: "export-failed",
        message: "The backup could not be exported.",
      }),
    ).toEqual({
      outcome: "error",
      code: "export-failed",
      message: "The backup could not be exported.",
    });
  });

  it("never admits a destination path in the renderer receipt", () => {
    expect(() =>
      decodeStateRecoveryExportResult({
        outcome: "exported",
        backup,
        fileName: "portable-junto.db",
        sha256: "b".repeat(64),
        destination: "/tmp/portable-junto.db",
      }),
    ).toThrow();
  });

  it("rejects malformed and padded backup identities", () => {
    expect(() => decodeStateBackupId("not-a-backup")).toThrow();
    expect(() =>
      decodeStateBackupId(
        " 22222222-2222-4222-8222-222222222222 ",
      ),
    ).toThrow();
  });
});
