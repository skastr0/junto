import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("browser network bootstrap", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src/main/index.ts"), "utf8");

  it("does not install process-wide proxy switches before Chromium scheme registration", () => {
    const scheme = source.indexOf("registerTrustedRendererScheme(protocol,");
    expect(scheme).toBeGreaterThanOrEqual(0);
    expect(source).not.toContain('appendSwitch("no-proxy-server")');
    expect(source).not.toContain('appendSwitch("proxy-server"');
    expect(source).toContain('await app.setProxy({ mode: "direct" })');
    expect(source).toContain('await session.defaultSession.setProxy({ mode: "direct" })');
    expect(source).toContain("installBrowserEgressProxyAuth(app)");
  });
});
