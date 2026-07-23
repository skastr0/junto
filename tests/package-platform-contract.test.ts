import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const script = async (name: string) =>
  readFile(new URL(`../scripts/${name}`, import.meta.url), "utf8");

describe("native package pipeline contract", () => {
  it("keeps product metadata neutral and scopes Apple policy to macOS", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      description: string;
      build: { forceCodeSigning?: unknown; mac: Record<string, unknown>; linux: Record<string, unknown> };
    };
    expect(pkg.description).not.toMatch(/macOS/u);
    expect(pkg.build.forceCodeSigning).toBeUndefined();
    expect(pkg.build.mac).toMatchObject({ forceCodeSigning: true, artifactName: "${productName}-${version}-${arch}-mac.${ext}" });
    expect(pkg.build.linux).toMatchObject({ artifactName: "${productName}-${version}-${arch}-linux.${ext}", target: ["dir"] });
  });

  it("compiles both controls before dispatching to an explicit native packager", async () => {
    const build = await script("build-app.sh");
    expect(build).toContain('--target mac|linux');
    expect(build).toContain('build_compiled_cli "$REPO_ROOT/dist/vellum" src/cli/main.ts');
    expect(build).toContain('build_compiled_cli "$REPO_ROOT/dist/vellum-browser" scripts/browser-cli.ts');
    expect(build).toContain('native %s packaging must run on its target OS');
    expect(build).toContain('mac) exec bash "$SCRIPT_DIR/package-app-macos.sh"');
    expect(build).toContain('linux) exec bash "$SCRIPT_DIR/package-app-linux.sh"');
  });

  it("keeps Linux free of macOS tooling and reserves package policy for later work", async () => {
    const linux = await script("package-app-linux.sh");
    expect(linux).toContain('bun rebuild node-pty');
    expect(linux).toContain('bunx electron-builder --linux --dir');
    expect(linux).not.toMatch(/codesign|notar|PlistBuddy|launchctl|\bopen\b/u);
    const mac = await script("package-app-macos.sh");
    expect(mac).toContain('bunx electron-builder --mac');
    expect(mac).toContain('notarize-app.sh');
  });

  it("dispatches after-pack resources by platform and fixes their modes", async () => {
    const afterPack = await script("electron-builder-after-pack.mjs");
    expect(afterPack).toContain('platform === "darwin"');
    expect(afterPack).toContain('platform === "linux"');
    expect(afterPack).toContain('unsupported Vellum package platform');
    expect(afterPack).toContain('["vellum", "vellum-browser", "unix-peer-pid.py"]');
    expect(afterPack).toContain('chmod(resource, 0o755)');
  });
});
