import { basename } from "node:path";
import {
  decodeStateBackupId,
  decodeStateRecoveryExportResult,
  decodeStateRecoveryListResult,
  type StateBackupExportReceipt,
  type StateBackupId,
  type StateBackupInventoryEntry,
  type StateRecoveryExportResult,
  type StateRecoveryListResult,
} from "@shared/state-recovery";

export type StateRecoveryDestinationChoice =
  | { readonly outcome: "canceled" }
  | { readonly outcome: "selected"; readonly path: string };

export type StateRecoveryDestinationChooser = (
  suggestedFileName: string,
) => Promise<StateRecoveryDestinationChoice>;

export type StateRecoveryOperations = {
  readonly listBackups: () => Promise<
    ReadonlyArray<StateBackupInventoryEntry>
  >;
  readonly exportBackup: (
    id: StateBackupId,
    destination: string,
  ) => Promise<StateBackupExportReceipt>;
};

const listError = (): StateRecoveryListResult =>
  decodeStateRecoveryListResult({
    outcome: "error",
    code: "inventory-failed",
    message: "Junto could not verify retained state backups.",
  });

const exportError = (
  code:
    | "invalid-backup-id"
    | "dialog-failed"
    | "export-failed",
  message: string,
): StateRecoveryExportResult =>
  decodeStateRecoveryExportResult({
    outcome: "error",
    code,
    message,
  });

/**
 * Closed recovery boundary. The renderer selects only a verified backup id;
 * the main process owns both destination selection and the absolute path.
 */
export const createStateRecoveryIpcHandlers = (
  operations: StateRecoveryOperations,
): {
  readonly list: () => Promise<StateRecoveryListResult>;
  readonly export: (
    input: unknown,
    chooseDestination: StateRecoveryDestinationChooser,
  ) => Promise<StateRecoveryExportResult>;
} => ({
  list: async () => {
    try {
      const backups = await operations.listBackups();
      return decodeStateRecoveryListResult({
        outcome: "listed",
        backups,
      });
    } catch {
      return listError();
    }
  },

  export: async (input, chooseDestination) => {
    let id: StateBackupId;
    try {
      id = decodeStateBackupId(input);
    } catch {
      return exportError(
        "invalid-backup-id",
        "The selected state backup is invalid.",
      );
    }

    let choice: StateRecoveryDestinationChoice;
    try {
      choice = await chooseDestination(
        `junto-state-backup-${id}.db`,
      );
    } catch {
      return exportError(
        "dialog-failed",
        "Junto could not open the backup export chooser.",
      );
    }
    if (choice.outcome === "canceled") {
      return decodeStateRecoveryExportResult({
        outcome: "canceled",
      });
    }
    if (choice.path.length === 0) {
      return exportError(
        "dialog-failed",
        "The backup export chooser returned no destination.",
      );
    }

    try {
      const receipt = await operations.exportBackup(id, choice.path);
      return decodeStateRecoveryExportResult({
        outcome: "exported",
        backup: receipt.backup,
        fileName: basename(receipt.destination),
        sha256: receipt.sha256,
      });
    } catch {
      return exportError(
        "export-failed",
        "The verified state backup could not be exported. Choose a new file name; existing files are never overwritten.",
      );
    }
  },
});
