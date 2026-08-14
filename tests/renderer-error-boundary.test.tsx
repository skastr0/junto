import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { RendererCrashFallback } from "../src/renderer/components/RendererErrorBoundary";

describe("RendererCrashFallback", () => {
  it("keeps the station copy and a reload action", () => {
    const html = renderToStaticMarkup(
      <RendererCrashFallback
        title="This work surface hit a render error"
        detail="cannot read nodes"
        onReload={() => undefined}
      />,
    );
    expect(html).toContain("Vellum Command");
    expect(html).toContain("The station is still running");
    expect(html).toContain("Reload this view");
    expect(html).toContain("cannot read nodes");
    expect(html).not.toContain("\u00b7");
  });
});

describe("renderer error boundary wiring", () => {
  it("wraps the admitted shell and the work surface", () => {
    const main = readFileSync(
      new URL("../src/renderer/main.tsx", import.meta.url),
      "utf8",
    );
    const app = readFileSync(
      new URL("../src/renderer/App.tsx", import.meta.url),
      "utf8",
    );
    expect(main).toContain("RendererErrorBoundary");
    expect(app).toContain("RendererErrorBoundary");
    expect(app).toContain("closeAllWorkbenchSurfaces");
    expect(app).toContain("closeAllTerminalSurfaces");
  });
});
