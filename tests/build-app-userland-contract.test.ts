import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("app build userland artifact contract", () => {
  it("compiles only the runtime controls required by the packaged app", async () => {
    const build = await readFile(
      new URL("../scripts/build-app.sh", import.meta.url),
      "utf8",
    );
    const compiledControls = [...build.matchAll(
      /build_compiled_cli "\$REPO_ROOT\/dist\/([^"]+)" ([^\s]+)/gu,
    )].map((match) => ({
      artifact: match[1],
      source: match[2],
    }));

    expect(compiledControls).toEqual([
      { artifact: "vellum", source: "src/cli/main.ts" },
      { artifact: "vellum-browser", source: "scripts/browser-cli.ts" },
      { artifact: "vellum-station", source: "scripts/station-cli.ts" },
    ]);
    expect(build).not.toContain("vellum-release-installer");
    expect(build).not.toContain("linux-release-installer.ts");
    expect(build).not.toContain("vellum-release-bridge");
    expect(build).not.toContain("linux-release-bridge.ts");
  });
});
