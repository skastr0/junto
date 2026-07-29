/**
 * Read-only probe of the installed state database's PRAGMA user_version.
 *
 * Used before AppRuntime / StateEngine open so a binary that cannot admit a
 * newer schema can offer update recovery instead of crash-exiting.
 *
 * Never migrates, never enables WAL, never writes.
 */

import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stateDatabasePath } from "./engine";
import { CURRENT_STATE_SCHEMA_VERSION } from "./migrations";

export type InstalledStateSchemaProbe =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly message: string }
  | {
      readonly kind: "present";
      readonly userVersion: number;
      readonly path: string;
    };

export type SchemaCompatibility =
  | { readonly ok: true; readonly userVersion: number | null }
  | {
      readonly ok: false;
      readonly reason: "newer-than-supported";
      readonly userVersion: number;
      readonly supportedVersion: number;
      readonly path: string;
    };

const isRegularFile = (path: string): boolean => {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Open the canonical state DB read-only and read user_version only.
 * Returns `missing` when the file is absent (fresh install).
 */
export const probeInstalledStateSchema = (
  configuredPath?: string,
): InstalledStateSchemaProbe => {
  const path = resolve(configuredPath ?? stateDatabasePath());
  if (!existsSync(path)) return { kind: "missing" };
  if (!isRegularFile(path)) {
    return {
      kind: "unreadable",
      message: `state database path is not a regular file: ${path}`,
    };
  }

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, {
      open: true,
      readOnly: true,
      allowExtension: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowBareNamedParameters: false,
      allowUnknownNamedParameters: false,
      timeout: 2_000,
    });
    const row = database.prepare("PRAGMA user_version").get() as
      | { readonly user_version: number | bigint | null }
      | undefined;
    const userVersion = Number(row?.user_version ?? 0);
    if (!Number.isSafeInteger(userVersion) || userVersion < 0) {
      return {
        kind: "unreadable",
        message: `state schema user_version is invalid: ${String(row?.user_version)}`,
      };
    }
    return { kind: "present", userVersion, path };
  } catch (error) {
    return {
      kind: "unreadable",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      database?.close();
    } catch {
      // probe must not throw on close
    }
  }
};

/**
 * True when this binary cannot open the installed DB because the schema
 * cursor is ahead of CURRENT_STATE_SCHEMA_VERSION.
 */
export const evaluateSchemaCompatibility = (
  probe: InstalledStateSchemaProbe = probeInstalledStateSchema(),
  supportedVersion: number = CURRENT_STATE_SCHEMA_VERSION,
): SchemaCompatibility => {
  if (probe.kind === "missing") {
    return { ok: true, userVersion: null };
  }
  if (probe.kind === "unreadable") {
    // Unreadable is not the "newer schema" brick — let normal startup surface it.
    return { ok: true, userVersion: null };
  }
  if (probe.userVersion > supportedVersion) {
    return {
      ok: false,
      reason: "newer-than-supported",
      userVersion: probe.userVersion,
      supportedVersion,
      path: probe.path,
    };
  }
  return { ok: true, userVersion: probe.userVersion };
};
