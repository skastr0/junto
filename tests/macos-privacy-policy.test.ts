import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applySettingsPatch,
  defaultSettings,
  sanitizeFleetConsent,
} from "../src/shared/settings";
import { decodeStoredSettings } from "../src/main/junto/settings/state-schema";

const read = (path: string): string => readFileSync(path, "utf8");

describe("macOS privacy policy", () => {
  it("ships Electron JIT/audio entitlements and no inherited CLI grants", () => {
    const app = read("build/entitlements.mac.plist");
    const inherited = read("build/entitlements.mac.inherit.plist");
    const keys = [...app.matchAll(/<key>([^<]+)<\/key>/gu)].map((match) => match[1]);

    expect(keys).toEqual(["com.apple.security.cs.allow-jit", "com.apple.security.device.audio-input"]);
    expect(app).not.toContain("com.apple.security.app-sandbox");
    expect(inherited).toContain("<dict/>");
  });

  it("declares no unused macOS privacy purpose strings or request APIs", () => {
    const packaging = [
      read("package.json"),
      read("build/entitlements.mac.plist"),
      read("build/entitlements.mac.inherit.plist"),
    ].join("\n");
    const runtime = [
      read("src/main/index.ts"),
      read("src/main/junto/trusted-renderer-protocol.ts"),
      read("src/main/junto/browser/web-policy.ts"),
      read("src/main/junto/hosts/deploy-darwin.ts"),
      read("scripts/app-paths.sh"),
    ].join("\n");

    expect([...packaging.matchAll(/NS[A-Z][A-Za-z]+UsageDescription/gu)].map(([key]) => key)).toEqual(["NSMicrophoneUsageDescription"]);
    expect(runtime).not.toMatch(
      /askForMediaAccess|requestMediaAccess|desktopCapturer|systemPreferences\.getMediaAccessStatus/u,
    );
    expect(runtime).not.toMatch(/tell application|\/usr\/bin\/osascript/u);
  });

  it("defaults every cross-provider reader off", () => {
    expect(defaultSettings().providers?.enabledSources).toEqual([]);
    expect(defaultSettings().providers?.hermesHostSnapshots).toBeUndefined();
    expect(defaultSettings().fleet.remoteManagedInstalls).toBe(false);
    expect(defaultSettings().fleet.remoteManagedInstallsConsented).toBeUndefined();
  });

  it("treats an old default-on remoteManagedInstalls row as unconsented", () => {
    const current = defaultSettings();
    const restored = decodeStoredSettings(
      1,
      {
        appearance: current.appearance,
        canvas: current.canvas,
        kernel: current.kernel,
        browser: current.browser,
        advanced: current.advanced,
        audio: current.audio,
        fleet: { ditherLevel: "fine", remoteManagedInstalls: true },
      },
      current.station,
    );
    expect(restored.fleet.remoteManagedInstalls).toBe(false);
    expect(restored.fleet.remoteManagedInstallsConsented).toBeUndefined();
    expect(
      sanitizeFleetConsent({
        ditherLevel: "fine",
        remoteManagedInstalls: true,
        remoteManagedInstallsConsented: true,
      }).remoteManagedInstalls,
    ).toBe(true);
    const optedIn = applySettingsPatch(defaultSettings(), {
      fleet: { remoteManagedInstalls: true },
    });
    expect(optedIn.fleet.remoteManagedInstalls).toBe(true);
    expect(optedIn.fleet.remoteManagedInstallsConsented).toBe(true);
  });

  it("does not execute a login shell or expose general filesystem enumeration IPC", () => {
    const spawn = read("src/main/junto/adapters/exec.ts");
    const ipc = read("src/shared/ipc.ts");

    expect(spawn).not.toContain("queryLoginShellPath");
    expect(spawn).not.toMatch(/\[\s*["']-lc["']/u);
    expect(ipc).not.toContain("chassis:select-folder");
    expect(ipc).not.toContain("chassis:read-directory");
  });

  it("discloses Hermes host snapshots separately from local Hermes usage", () => {
    const docs = read("docs/macos-privacy.md");
    const ui = read("src/renderer/components/settings/ProvidersSettingsSection.tsx");
    expect(docs).toContain("Hermes host snapshots");
    expect(docs).toContain("hermes profile list");
    expect(docs).toContain("every one minute");
    expect(docs).toContain("every five minutes");
    expect(docs).toContain("default-on value is treated as off");
    expect(ui).toContain("sourceAccess");
    expect(ui).toContain("hermesHostSnapshots");
    expect(ui).toContain("Allow Hermes host snapshot access");
  });

  it("revokes admitted provider work without the global adapter shutdown switch", () => {
    const usage = read("src/main/junto/usage/usage-service.ts");
    const snapshots = read("src/main/junto/snapshots.ts");
    const exec = read("src/main/junto/adapters/exec.ts");

    expect(usage).toContain("abortAdmittedAccess");
    expect(snapshots).toContain("abortAdmittedAccess");
    expect(usage).not.toContain("terminateAdapterChildrenOnQuit");
    expect(snapshots).not.toContain("terminateAdapterChildrenOnQuit");
    expect(exec).toContain("ACCESS_CANCELLED_ERROR");
  });
});
