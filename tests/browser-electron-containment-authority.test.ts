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
        /["'][^"'\n]*\.canvas["']|JUNTO_CANVASES_DIR|\bcanvasesDir\b|\bcanvasPath\b/u,
      );
    }
  });

  it("seeds and enumerates the fixture through the SQLite-backed model service", async () => {
    const [probe, fixture] = await sources();

    expect(probe).toContain("`--canvas-payload=${canvasPayload}`");
    expect(probe).toContain(
      '["native model fixture", options.modelFixtureJson]',
    );
    expect(fixture).toContain('requiredArgument("canvas-payload")');
    expect(fixture).toContain("activeCanvasRuntime.runPromise(ModelService)");
    expect(fixture).toContain('_tag: "CreateCanvas", canvas: canvasName');
    expect(fixture).toContain('_tag: "Add", canvas: canvasName');
    expect(fixture).toContain("model.listCanvases()");
    expect(fixture).toContain("model.canvas(name)");
    expect(fixture).not.toContain("CanvasesService");
    expect(fixture).not.toContain("CanvasesLive");
    expect(fixture).not.toContain("from-document");
    expect(fixture).toContain("nodes: Schema.Array(Node), wires: Schema.Array(Wire)");
  });
});
