import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const sources = async (): Promise<ReadonlyArray<string>> =>
  Promise.all([
    readFile(
      new URL("../scripts/browser-electron-containment-probe.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "./fixtures/browser/electron-containment-main.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

describe("browser Electron containment authority", () => {
  it("has no retired canvas-file seed, read, or fallback path", async () => {
    const [probe, fixture] = await sources();

    for (const source of [probe, fixture]) {
      expect(source).not.toMatch(
        /\.canvas\b|VELLUM_CANVASES_DIR|\bcanvasesDir\b|\bcanvasPath\b/u,
      );
    }
  });

  it("seeds and enumerates the fixture through the SQLite-backed canvas service", async () => {
    const [probe, fixture] = await sources();

    expect(probe).toContain("`--canvas-payload=${canvasPayload}`");
    expect(probe).toContain(
      '["canvas document payload", options.canvasDocumentJson]',
    );
    expect(fixture).toContain('requiredArgument("canvas-payload")');
    expect(fixture).toContain(
      "canvases.write(canvasName, fixtureCanvas.success)",
    );
    expect(fixture).toContain("canvases.liveDocuments()");
  });
});
