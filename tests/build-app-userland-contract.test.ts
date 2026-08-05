import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("app build userland artifact contract", () => {
  it("compiles only the single packaged CLI required by the app", async () => {
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
    ]);
    expect(build).not.toContain("vellum-browser");
    expect(build).not.toContain("vellum-station");
    expect(build).not.toContain("vellum-content");
    expect(build).not.toContain("vellum-release-installer");
    expect(build).not.toContain("linux-release-installer.ts");
    expect(build).not.toContain("vellum-release-bridge");
    expect(build).not.toContain("linux-release-bridge.ts");
  });

  it("keeps the verified ship path aligned with the product-name gate", async () => {
    const build = await readFile(
      new URL("../scripts/build-app.sh", import.meta.url),
      "utf8",
    );
    const verifyBlock = build.slice(build.indexOf('if [[ "$VERIFY" -eq 1 ]]'));
    expect(verifyBlock).toContain("bun run lint:product-name");
  });
});
