import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateSchemaCompatibility,
  probeInstalledStateSchema,
} from "../src/main/vellum-command/state/schema-version-probe";
import {
  feedVersionUnbricks,
  makeSchemaRecoveryUpdater,
  runStartupSchemaRecovery,
} from "../src/main/vellum-command/update/startup-schema-recovery";

import { linuxX64UpdateFeed } from "../src/main/vellum-command/update/compiled-config";
import type {
  StagedUpdate,
  UpdateHostHooks,
  UpdateProvider,
  UpdateProviderListener,
} from "../src/main/vellum-command/update/provider";

const { makePlatformProvider } = vi.hoisted(() => ({ makePlatformProvider: vi.fn() }));
vi.mock("../src/main/vellum-command/update/platform", () => ({
  makePlatformUpdateProvider: makePlatformProvider,
}));

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const tempDb = (userVersion: number): string => {
  const root = mkdtempSync(join(tmpdir(), "vellum-schema-probe-"));
  roots.push(root);
  const path = join(root, "vellum-command.db");
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version = ${userVersion}`);
  db.close();
  return path;
};

const recoveryHost = (): UpdateHostHooks => ({
  quiesceForInstall: vi.fn(async () => {}),
  relaunchWithoutInstall: vi.fn(),
  relaunchInstalled: vi.fn(),
});

const recoveryProvider = (
  stage: () => Promise<StagedUpdate>,
): UpdateProvider => {
  let listener: UpdateProviderListener | undefined;
  return {
    kind: "linux",
    start: vi.fn((next) => { listener = next; }),
    stop: vi.fn(() => { listener = undefined; }),
    check: vi.fn(async () => {
      listener?.({
        _tag: "downloaded",
        release: { version: "0.1.4" },
        downloadedFile: "/owned-cache/desktop.tar.gz",
      });
    }),
    stageDownloaded: vi.fn(stage),
    quitAndInstall: vi.fn(),
  };
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
    path: "/tmp/vellum-command.db",
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

  it("uses the platform provider for Linux recovery and leaves advanced state unchanged", async () => {
    const path = tempDb(4);
    const before = readFileSync(path);
    const host = recoveryHost();
    const install = vi.fn(async (owner: UpdateHostHooks) => {
      owner.relaunchInstalled?.("/owned-generations/new/vellum-command");
    });
    const revalidate = vi.fn(async () => {});
    const provider = recoveryProvider(async () => ({
      executablePath: "/owned-generations/new/vellum-command",
      revalidate,
      installAfterQuiesce: install,
    }));
    makePlatformProvider.mockReturnValue(provider);
    const outcome = await runStartupSchemaRecovery({
      compatibility: { ...brick, path },
      appVersion: "0.1.0",
      isPackaged: true,
      headless: false,
      platform: "linux",
      host,
      dialog: { showMessageBox: async () => ({ response: 0 }) },
    });
    expect(makePlatformProvider).toHaveBeenCalledWith({
      platform: "linux", isPackaged: true, currentVersion: "0.1.0",
    });
    expect(outcome).toEqual({ action: "installing", targetVersion: "0.1.4" });
    expect(provider.stageDownloaded).toHaveBeenCalledWith("/owned-cache/desktop.tar.gz", { version: "0.1.4" });
    expect(revalidate).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith(host);
    expect(host.relaunchInstalled).toHaveBeenCalledWith("/owned-generations/new/vellum-command");
    expect(host.quiesceForInstall).not.toHaveBeenCalled();
    expect(host.relaunchWithoutInstall).not.toHaveBeenCalled();
    expect(provider.quitAndInstall).not.toHaveBeenCalled();
    expect(readFileSync(path)).toEqual(before);
  });

  it("shows an asynchronous Linux activation failure without relaunching the old app", async () => {
    const host = recoveryHost();
    const provider = recoveryProvider(async () => ({
      executablePath: "/owned-generations/new/vellum-command",
      installAfterQuiesce: async () => { throw new Error("activation failed"); },
    }));
    const boxes = vi.fn(async () => ({ response: 0 }));
    const outcome = await runStartupSchemaRecovery({
      compatibility: brick,
      appVersion: "0.1.0",
      isPackaged: true,
      headless: false,
      platform: "linux",
      updater: makeSchemaRecoveryUpdater(provider, host),
      dialog: { showMessageBox: boxes },
    });
    expect(outcome).toEqual({ action: "quit", reason: "update-failed:activation failed" });
    expect(boxes).toHaveBeenLastCalledWith(expect.objectContaining({
      title: "Could not update", message: "The update could not be installed",
    }));
    expect(host.relaunchWithoutInstall).not.toHaveBeenCalled();
    expect(provider.quitAndInstall).not.toHaveBeenCalled();
  });

  it("offers Quit only on unsupported platforms", async () => {
    const showMessageBox = vi.fn(async () => ({ response: 0 }));
    const outcome = await runStartupSchemaRecovery({
      compatibility: brick,
      appVersion: "0.1.0",
      isPackaged: true,
      headless: false,
      platform: "win32",
      dialog: { showMessageBox },
    });
    expect(outcome).toEqual({ action: "quit", reason: "schema-newer-than-supported-platform" });
    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ buttons: ["Quit"] }));
    expect(makePlatformProvider).not.toHaveBeenCalled();
  });

  it("uses the Linux release feed when the download-page fallback is needed", async () => {
    const openExternal = vi.fn(async () => {}).mockRejectedValueOnce(new Error("website unavailable"));
    await runStartupSchemaRecovery({
      compatibility: brick,
      appVersion: "0.1.0",
      isPackaged: true,
      headless: false,
      platform: "linux",
      dialog: { showMessageBox: async () => ({ response: 1 }) },
      openExternal,
    });
    expect(openExternal).toHaveBeenNthCalledWith(1, linuxX64UpdateFeed().url.replace(/\/linux\/x64$/u, "/"));
    expect(openExternal).toHaveBeenNthCalledWith(2, linuxX64UpdateFeed().url);
    expect(makePlatformProvider).not.toHaveBeenCalled();
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

describe("verified recovery update lifecycle", () => {
  it("refuses an unverified download and never invokes an installer", async () => {
    const host = recoveryHost();
    const provider = recoveryProvider(async () => { throw new Error("signature rejected"); });
    const updater = makeSchemaRecoveryUpdater(provider, host);
    await expect(updater.checkForUpdates()).rejects.toThrow("signature rejected");
    await expect(updater.quitAndInstall()).rejects.toThrow("no verified update");
    expect(provider.quitAndInstall).not.toHaveBeenCalled();
    expect(host.relaunchInstalled).not.toHaveBeenCalled();
    expect(provider.stop).toHaveBeenCalled();
    updater.dispose?.();
  });

  it("revalidates the exact staged candidate before installation", async () => {
    const install = vi.fn(async () => {});
    const provider = recoveryProvider(async () => ({
      executablePath: "/owned-generations/new/vellum-command",
      revalidate: async () => { throw new Error("candidate bytes changed"); },
      installAfterQuiesce: install,
    }));
    const updater = makeSchemaRecoveryUpdater(provider, recoveryHost());
    await expect(updater.checkForUpdates()).resolves.toEqual({ version: "0.1.4" });
    await expect(updater.quitAndInstall()).rejects.toThrow("candidate bytes changed");
    expect(install).not.toHaveBeenCalled();
    expect(provider.quitAndInstall).not.toHaveBeenCalled();
    updater.dispose?.();
  });

  it("waits for signature staging and drops a candidate that arrives after timeout", async () => {
    vi.useFakeTimers();
    const stagingRoot = mkdtempSync(join(tmpdir(), "vellum-recovery-proof-"));
    roots.push(stagingRoot);
    let finishStage!: (candidate: StagedUpdate) => void;
    const provider = recoveryProvider(() => new Promise((resolve) => { finishStage = resolve; }));
    const updater = makeSchemaRecoveryUpdater(provider, recoveryHost(), 100);
    const check = updater.checkForUpdates();
    const rejected = expect(check).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    finishStage({ executablePath: "/proof/app", stagingRoot });
    await Promise.resolve();
    expect(existsSync(stagingRoot)).toBe(false);
    expect(provider.stop).toHaveBeenCalled();
    await expect(updater.quitAndInstall()).rejects.toThrow("no verified update");
    updater.dispose?.();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases Mac proof staging before delegating the verified install", async () => {
    const stagingRoot = mkdtempSync(join(tmpdir(), "vellum-recovery-proof-"));
    roots.push(stagingRoot);
    const provider = recoveryProvider(async () => ({ executablePath: "/proof/app", stagingRoot }));
    const quitAndInstall = vi.fn(() => { expect(existsSync(stagingRoot)).toBe(false); });
    const updater = makeSchemaRecoveryUpdater({ ...provider, kind: "mac", quitAndInstall }, recoveryHost());
    await updater.checkForUpdates();
    await updater.quitAndInstall();
    expect(quitAndInstall).toHaveBeenCalledOnce();
    updater.dispose?.();
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
