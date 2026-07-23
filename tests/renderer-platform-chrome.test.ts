import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("renderer platform chrome", () => {
  const root = join(import.meta.dirname, "..");
  const index = readFileSync(join(root, "src/main/index.ts"), "utf8");
  const main = readFileSync(join(root, "src/renderer/main.tsx"), "utf8");
  const styles = readFileSync(join(root, "src/renderer/styles.css"), "utf8");

  it("uses a preload platform marker for macOS-only geometry", () => {
    expect(main).toContain("dataset.vellumPlatform = window.vellum?.platform ?? \"unknown\"");
    expect(styles).toContain('html[data-vellum-platform="darwin"] .focus-surface');
    expect(styles).toContain('html[data-vellum-platform="darwin"] .station-bar');
    expect(index).toContain('process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}');
  });

  it("leaves Linux chrome free of hiddenInset spacing and drag regions", () => {
    const station = styles.slice(styles.indexOf(".station-bar {"), styles.indexOf(".station-context__loading"));
    expect(station).toContain("padding: 0 18px;");
    const genericRule = station.slice(0, station.indexOf("}\n\n") + 1);
    expect(genericRule).not.toContain("-webkit-app-region");
  });
});
