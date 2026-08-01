import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("browser direct network bootstrap", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src/main/index.ts"), "utf8");

  it("disables inherited proxy resolution before Chromium scheme registration", () => {
    const direct = source.indexOf('app.commandLine.appendSwitch("no-proxy-server")');
    const scheme = source.indexOf("registerTrustedRendererScheme(protocol,");

    expect(direct).toBeGreaterThanOrEqual(0);
    expect(direct).toBeLessThan(scheme);
    expect(source).not.toContain('appendSwitch("proxy-server"');
  });
});
