import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  enumeratedToolDirs,
  staticPathDirs,
} from "../src/main/junto/adapters/exec";
import {
  applySettingsPatch,
  defaultSettings,
  sanitizeFleetConsent,
} from "../src/shared/settings";
import { decodeStoredSettings } from "../src/main/junto/settings/state-schema";
import {
  PERMITTED_USAGE_DESCRIPTIONS,
  unpermittedUsageDescriptions,
} from "../scripts/mac-info-plist-policy.mjs";

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

  // Electron ships its template Info.plist only in the macOS package.
  it.runIf(process.platform === "darwin")("strips Electron's template purpose strings from the packaged Info.plist", () => {
    // Electron's own Info.plist is the base electron-builder extends. Every
    // purpose string it or package.json declares, minus the afterPack strip,
    // is what the signed bundle declares.
    const template = read("node_modules/electron/dist/Electron.app/Contents/Info.plist");
    const declared = [
      ...template.matchAll(/<key>(NS[A-Za-z]+UsageDescription)<\/key>/gu),
      ...read("package.json").matchAll(/"(NS[A-Za-z]+UsageDescription)"/gu),
    ].map(([, key]) => key!);
    expect(declared).toContain("NSCameraUsageDescription");
    const stripped = new Set(unpermittedUsageDescriptions(declared));
    expect([...new Set(declared.filter((key) => !stripped.has(key)))]).toEqual([
      "NSMicrophoneUsageDescription",
    ]);
    expect(PERMITTED_USAGE_DESCRIPTIONS).toEqual(["NSMicrophoneUsageDescription"]);
    expect(read("scripts/electron-builder-after-pack.mjs")).toContain(
      "await stripUnpermittedUsageDescriptions(executablePath)",
    );
  });

  it("documents App Transport Security as the loopback updater exception only", () => {
    const doc = read("docs/macos-privacy.md");
    expect(doc).toContain("NSAllowsArbitraryLoads");
    expect(doc).toContain("127.0.0.1");
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

  it("never executes shell startup files for PATH discovery or exposes filesystem enumeration IPC", () => {
    const spawn = read("src/main/junto/adapters/exec.ts");
    const ipc = read("src/shared/ipc.ts");

    // No probe name, no shell selection, no login/interactive rc flags, no
    // sentinel protocol: a regression on any of these reintroduces arbitrary
    // rc execution under Junto's TCC identity.
    expect(spawn).not.toMatch(/captureLoginShellPath|loginShellPath|queryLoginShellPath/u);
    expect(spawn).not.toMatch(/process\.env\.SHELL/u);
    expect(spawn).not.toMatch(/\[\s*["'](?:-l|-i|-c|-lc|-ic|-ilc|-lic)["']/u);
    expect(spawn).not.toContain("JUNTO_ENV_BEGIN");
    expect(ipc).not.toContain("chassis:select-folder");
    expect(ipc).not.toContain("chassis:read-directory");
  });

  it("never puts a TCC-protected folder on the spawn PATH", () => {
    const home = homedir();
    const protectedRoots = [
      "Desktop",
      "Documents",
      "Downloads",
      "Music",
      "Movies",
      "Pictures",
    ].map((name) => join(home, name));
    const isProtected = (dir: string) =>
      protectedRoots.some(
        (root) => dir === root || dir.startsWith(`${root}/`),
      );
    for (const dir of [...staticPathDirs(home), ...enumeratedToolDirs(home)]) {
      expect(isProtected(dir), `spawn PATH must not contain ${dir}`).toBe(false);
    }
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

  it("shows desktop notifications from one plane, never at launch", () => {
    const docs = read("docs/macos-privacy.md");
    expect(docs).toContain("Desktop notifications");
    expect(docs).toContain("Nothing is shown at launch");
    // The banner is what makes macOS ask; only the notification plane may raise one.
    const main = [
      read("src/main/index.ts"),
      read("src/main/junto/ipc.ts"),
      read("src/main/junto/notifications/plane.ts"),
    ].join("\n");
    expect(main).not.toMatch(/new Notification\(/u);
    expect(read("src/main/junto/notifications/ipc.ts").match(/new Notification\(/gu)).toHaveLength(1);
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
