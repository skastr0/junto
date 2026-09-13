import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Chromium re-applies proxy command-line switches over Session proxy
// preferences on every NetworkContext creation (ApplyProxyModeFromCommandLine),
// so an inherited switch would restamp a managed browser partition after
// session.setProxy() pinned the owned CONNECT proxy. These switches must be
// removed from the live command line and never appended.
const INHERITED_PROXY_SWITCHES = [
  "no-proxy-server",
  "proxy-server",
  "proxy-bypass-list",
  "proxy-pac-url",
  "proxy-auto-detect",
] as const;

describe("browser network bootstrap", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src/main/index.ts"), "utf8");

  it("strips inherited proxy switches before Chromium scheme registration", () => {
    const scheme = source.indexOf("registerTrustedRendererScheme(protocol,");
    expect(scheme).toBeGreaterThanOrEqual(0);
    for (const name of INHERITED_PROXY_SWITCHES) {
      const removeCall = source.indexOf(`removeSwitch("${name}")`);
      expect(removeCall, `main must call removeSwitch("${name}")`).toBeGreaterThanOrEqual(0);
      expect(
        removeCall,
        `removeSwitch("${name}") must run before scheme registration`,
      ).toBeLessThan(scheme);
      expect(source, `main must never appendSwitch("${name}"`).not.toContain(
        `appendSwitch("${name}"`,
      );
    }
    expect(source).not.toContain('appendSwitch("no-proxy-server")');
    expect(source).not.toContain('appendSwitch("proxy-server"');
    expect(source).toContain('await app.setProxy({ mode: "direct" })');
    expect(source).toContain('await session.defaultSession.setProxy({ mode: "direct" })');
    expect(source).toContain("installBrowserEgressProxyAuth(app)");
  });

  it("strips inherited proxy switches in every Electron main fixture that opens managed sessions", () => {
    const fixtures = [
      "tests/fixtures/browser/electron-containment-main.ts",
      "tests/fixtures/browser/electron-profile-wipe-main.ts",
      "tests/fixtures/browser/electron-renderer-crash-recovery-main.ts",
    ];
    for (const fixture of fixtures) {
      const fixtureSource = readFileSync(join(import.meta.dirname, "..", fixture), "utf8");
      const whenReady = fixtureSource.indexOf("app.whenReady()");
      expect(whenReady, `${fixture} must wait for app readiness`).toBeGreaterThanOrEqual(0);
      for (const name of INHERITED_PROXY_SWITCHES) {
        const removeCall = fixtureSource.indexOf(`removeSwitch("${name}")`);
        expect(
          removeCall,
          `${fixture} must call removeSwitch("${name}")`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          removeCall,
          `${fixture} must strip proxy switches before whenReady proxy setup`,
        ).toBeLessThan(whenReady);
        expect(fixtureSource, `${fixture} must never appendSwitch("${name}"`).not.toContain(
          `appendSwitch("${name}"`,
        );
      }
    }
  });
});
