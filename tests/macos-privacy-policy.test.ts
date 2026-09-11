import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultSettings } from "../src/shared/settings";

const read = (path: string): string => readFileSync(path, "utf8");

describe("macOS privacy policy", () => {
  it("ships only the Electron JIT entitlement and no inherited grants", () => {
    const app = read("build/entitlements.mac.plist");
    const inherited = read("build/entitlements.mac.inherit.plist");
    const keys = [...app.matchAll(/<key>([^<]+)<\/key>/gu)].map((match) => match[1]);

    expect(keys).toEqual(["com.apple.security.cs.allow-jit"]);
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
      read("src/main/vellum-command/trusted-renderer-protocol.ts"),
      read("src/main/vellum-command/browser/web-policy.ts"),
      read("src/main/vellum-command/hosts/deploy-darwin.ts"),
      read("scripts/app-paths.sh"),
    ].join("\n");

    expect(packaging).not.toMatch(/NS[A-Z][A-Za-z]+UsageDescription/u);
    expect(runtime).not.toMatch(
      /askForMediaAccess|requestMediaAccess|desktopCapturer|systemPreferences\.getMediaAccessStatus/u,
    );
    expect(runtime).not.toMatch(/tell application|\/usr\/bin\/osascript/u);
  });

  it("defaults every cross-provider reader off", () => {
    expect(defaultSettings().providers?.enabledSources).toEqual([]);
    expect(defaultSettings().fleet.remoteManagedInstalls).toBe(false);
  });

  it("does not execute a login shell or expose general filesystem enumeration IPC", () => {
    const spawn = read("src/main/vellum-command/adapters/exec.ts");
    const ipc = read("src/shared/ipc.ts");

    expect(spawn).not.toContain("queryLoginShellPath");
    expect(spawn).not.toMatch(/\[\s*["']-lc["']/u);
    expect(ipc).not.toContain("chassis:select-folder");
    expect(ipc).not.toContain("chassis:read-directory");
  });
});
