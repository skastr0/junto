import { describe, expect, it, vi } from "vitest";
import {
  createStateRecoveryIpcHandlers,
  type StateRecoveryOperations,
} from "../src/main/vellum-command/state/recovery-ipc";
import { decodeStateBackupId } from "../src/shared/state-recovery";

const id = decodeStateBackupId(
  "22222222-2222-4222-8222-222222222222",
);
const backup = {
  id,
  file: "vellum-command-backup-22222222-2222-4222-8222-222222222222.db",
  bytes: 8_192,
  modifiedAtEpochMs: 1_700_000_000_000,
  schemaVersion: 1,
  schemaSha256: "a".repeat(64),
};

const makeOperations = (): StateRecoveryOperations => ({
  listBackups: vi.fn(async () => [backup]),
  exportBackup: vi.fn(async (_id, destination) => ({
    backup,
    destination,
    sha256: "b".repeat(64),
  })),
});

describe("state recovery IPC", () => {
  it("lists only the operation's strictly decoded inventory", async () => {
    const handlers = createStateRecoveryIpcHandlers(makeOperations());

    await expect(handlers.list()).resolves.toEqual({
      outcome: "listed",
      backups: [backup],
    });
  });

  it("rejects an invalid id before opening the native chooser", async () => {
    const operations = makeOperations();
    const choose = vi.fn(async () => ({
      outcome: "selected" as const,
      path: "/tmp/export.db",
    }));
    const handlers = createStateRecoveryIpcHandlers(operations);

    await expect(
      handlers.export("not-an-id", choose),
    ).resolves.toMatchObject({
      outcome: "error",
      code: "invalid-backup-id",
    });
    expect(choose).not.toHaveBeenCalled();
    expect(operations.exportBackup).not.toHaveBeenCalled();
  });

  it("keeps native-dialog cancellation non-failing and never exports", async () => {
    const operations = makeOperations();
    const handlers = createStateRecoveryIpcHandlers(operations);

    await expect(
      handlers.export(id, async () => ({ outcome: "canceled" })),
    ).resolves.toEqual({ outcome: "canceled" });
    expect(operations.exportBackup).not.toHaveBeenCalled();
  });

  it("passes only the main-selected path to core export and hides it from the receipt", async () => {
    const operations = makeOperations();
    const handlers = createStateRecoveryIpcHandlers(operations);
    const destination = "/Users/operator/portable-junto.db";

    const result = await handlers.export(id, async (suggested) => {
      expect(suggested).toBe(`vellum-state-backup-${id}.db`);
      return { outcome: "selected", path: destination };
    });

    expect(operations.exportBackup).toHaveBeenCalledWith(
      id,
      destination,
    );
    expect(result).toEqual({
      outcome: "exported",
      backup,
      fileName: "portable-junto.db",
      sha256: "b".repeat(64),
    });
    expect(result).not.toHaveProperty("destination");
  });

  it("distinguishes chooser failure from export failure", async () => {
    const dialogHandlers = createStateRecoveryIpcHandlers(
      makeOperations(),
    );
    await expect(
      dialogHandlers.export(id, async () => {
        throw new Error("dialog unavailable");
      }),
    ).resolves.toMatchObject({
      outcome: "error",
      code: "dialog-failed",
    });

    const operations = makeOperations();
    vi.mocked(operations.exportBackup).mockRejectedValueOnce(
      new Error("destination exists"),
    );
    const exportHandlers =
      createStateRecoveryIpcHandlers(operations);
    await expect(
      exportHandlers.export(id, async () => ({
        outcome: "selected",
        path: "/tmp/already-exists.db",
      })),
    ).resolves.toMatchObject({
      outcome: "error",
      code: "export-failed",
    });
  });
});
