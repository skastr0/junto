import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { standaloneControlBuild } from "../scripts/build-standalone-cli";

describe("app build userland artifact contract", () => {
  it("compiles only the single packaged CLI required by the app", async () => {
    const build = await readFile(
      new URL("../scripts/build-app.sh", import.meta.url),
      "utf8",
    );
    const compiledControls = [...build.matchAll(/"\$SCRIPT_DIR\/build-standalone-cli\.ts" ([^\s]+)/gu)].map((match) => match[1]);
    expect(compiledControls).toEqual(["vellum-command"]);
    expect(standaloneControlBuild("vellum-command")).toMatchObject({
      output: "dist/vellum-command", source: "src/cli/main.ts",
    });
    expect(build).not.toContain("bun build --compile");
    expect(build).not.toContain("vellum-command-browser");
    expect(build).not.toContain("vellum-command-station");
    expect(build).not.toContain("vellum-command-content");
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
