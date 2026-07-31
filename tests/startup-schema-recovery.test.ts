import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateSchemaCompatibility,
  probeInstalledStateSchema,
} from "../src/main/vellum/state/schema-version-probe";
import {
  feedVersionUnbricks,
  runStartupSchemaRecovery,
} from "../src/main/vellum/update/startup-schema-recovery";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const tempDb = (userVersion: number): string => {
  const root = mkdtempSync(join(tmpdir(), "vellum-schema-probe-"));
  roots.push(root);
  const path = join(root, "vellum.db");
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version = ${userVersion}`);
  db.close();
  return path;
};

describe("probeInstalledStateSchema", () => {
  it("reports missing when the file is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "vellum-schema-missing-"));
    roots.push(root);
    expect(probeInstalledStateSchema(join(root, "nope.db"))).toEqual({
      kind: "missing",
    });
  });

  it("reads user_version without migrating", () => {
    const path = tempDb(4);
    expect(probeInstalledStateSchema(path)).toEqual({
      kind: "present",
      userVersion: 4,
      path,
    });
  });

  it("flags newer-than-supported against a lower ceiling", () => {
    const path = tempDb(4);
    const probe = probeInstalledStateSchema(path);
    const compatibility = evaluateSchemaCompatibility(probe, 3);
    expect(compatibility).toMatchObject({
      ok: false,
      reason: "newer-than-supported",
      userVersion: 4,
      supportedVersion: 3,
    });
  });

  it("admits equal or older schema", () => {
    const path = tempDb(3);
    expect(evaluateSchemaCompatibility(probeInstalledStateSchema(path), 4)).toEqual({
      ok: true,
      userVersion: 3,
    });
  });
});

describe("feedVersionUnbricks", () => {
  it("requires a strictly newer semver", () => {
    expect(feedVersionUnbricks("0.1.0", "0.1.4")).toBe(true);
    expect(feedVersionUnbricks("0.1.4", "0.1.4")).toBe(false);
    expect(feedVersionUnbricks("0.1.4", "0.1.3")).toBe(false);
    expect(feedVersionUnbricks("0.1.4", undefined)).toBe(false);
  });
});

describe("runStartupSchemaRecovery", () => {
  const brick = {
    ok: false as const,
    reason: "newer-than-supported" as const,
    userVersion: 4,
    supportedVersion: 3,
    path: "/tmp/vellum.db",
  };

  it("quits headless without dialog", async () => {
    const outcome = await runStartupSchemaRecovery({
      compatibility: brick,
      appVersion: "0.1.0",
      isPackaged: true,
      headless: true,
    });
    expect(outcome).toEqual({
      action: "quit",
      reason: "schema-newer-than-supported-headless",
    });
  });

  it("installs when the operator chooses update and feed is newer", async () => {
    const quitAndInstall = vi.fn();
    const outcome = await runStartupSchemaRecovery({
      compatibility: brick,
      appVersion: "0.1.0",
      isPackaged: true,
      headless: false,
      dialog: {
        showMessageBox: async () => ({ response: 0 }),
      },
      updater: {
        configureFeed: vi.fn(),
        checkForUpdates: async () => ({ version: "0.1.4" }),
        quitAndInstall,
      },
    });
    expect(outcome).toEqual({
      action: "installing",
      targetVersion: "0.1.4",
    });
    expect(quitAndInstall).toHaveBeenCalledOnce();
  });

  it("refuses install when feed has nothing newer", async () => {
    const quitAndInstall = vi.fn();
    const boxes: Array<{ title: string; message: string; detail: string }> =
      [];
    const outcome = await runStartupSchemaRecovery({
      compatibility: brick,
      appVersion: "0.1.4",
      isPackaged: true,
      headless: false,
      dialog: {
        showMessageBox: async (options) => {
          boxes.push({
            title: options.title,
            message: options.message,
            detail: options.detail,
          });
          return { response: 0 };
        },
      },
      updater: {
        configureFeed: vi.fn(),
        checkForUpdates: async () => ({ version: "0.1.4" }),
        quitAndInstall,
      },
    });
    expect(outcome.action).toBe("quit");
    expect(quitAndInstall).not.toHaveBeenCalled();
    expect(boxes.some((b) => /No newer version is available yet/i.test(b.message))).toBe(
      true,
    );
    // Operator-facing copy must not leak schema/build internals.
    for (const box of boxes) {
      expect(box.detail).not.toMatch(/schema|user_version|binary|feed|notarized/i);
      expect(box.message).not.toMatch(/schema|binary|feed/i);
    }
  });

  it("opens the download page when chosen", async () => {
    const openExternal = vi.fn(async () => undefined);
    const outcome = await runStartupSchemaRecovery({
      compatibility: brick,
      appVersion: "0.1.0",
      isPackaged: true,
      headless: false,
      feedUrl: "https://example.test/mac/arm64",
      dialog: {
        showMessageBox: async () => ({ response: 1 }),
      },
      openExternal,
    });
    expect(outcome).toEqual({
      action: "quit",
      reason: "opened-download-page",
    });
    expect(openExternal).toHaveBeenCalled();
  });

  it("shows customer-facing copy for unpackaged apps without schema jargon", async () => {
    const boxes: Array<{
      title: string;
      message: string;
      detail: string;
      buttons: readonly string[];
    }> = [];
    const outcome = await runStartupSchemaRecovery({
      compatibility: brick,
      appVersion: "43.2.0",
      isPackaged: false,
      headless: false,
      dialog: {
        showMessageBox: async (options) => {
          boxes.push({
            title: options.title,
            message: options.message,
            detail: options.detail,
            buttons: options.buttons,
          });
          return { response: 0 };
        },
      },
    });
    expect(outcome).toEqual({
      action: "quit",
      reason: "schema-newer-than-supported-dev",
    });
    expect(boxes).toHaveLength(1);
    const box = boxes[0]!;
    expect(box.title).toBe("Update required");
    expect(box.message).toBe("A newer version of Vellum Command is required");
    expect(box.detail).toMatch(/newer version of Vellum Command/i);
    expect(box.detail).not.toMatch(
      /schema|user_version|binary|Development builds|packaged|43\.2\.0|v4|v3/i,
    );
    expect(box.buttons).toEqual(["Quit"]);
  });

  it("shows the same customer-facing headline for packaged apps", async () => {
    const boxes: Array<{ title: string; message: string; detail: string }> =
      [];
    await runStartupSchemaRecovery({
      compatibility: brick,
      appVersion: "0.1.0",
      isPackaged: true,
      headless: false,
      dialog: {
        showMessageBox: async (options) => {
          boxes.push({
            title: options.title,
            message: options.message,
            detail: options.detail,
          });
          return { response: 2 };
        },
      },
    });
    expect(boxes[0]?.title).toBe("Update required");
    expect(boxes[0]?.message).toBe("A newer version of Vellum Command is required");
    expect(boxes[0]?.detail).not.toMatch(/schema|user_version|binary/i);
  });
});

describe("probe rejects non-files", () => {
  it("marks directories unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "vellum-schema-dir-"));
    roots.push(root);
    writeFileSync(join(root, "note"), "x");
    const probe = probeInstalledStateSchema(root);
    expect(probe.kind).toBe("unreadable");
  });
});
