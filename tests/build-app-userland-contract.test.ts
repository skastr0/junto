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
    expect(compiledControls).toEqual(["junto"]);
    expect(standaloneControlBuild("junto")).toMatchObject({
      output: "dist/junto", source: "src/cli/main.ts",
    });
    expect(standaloneControlBuild("junto-desktop-bootstrap-linux-x64")).toMatchObject({
      output: "dist/junto-desktop-bootstrap-linux-x64",
      source: "scripts/linux-desktop-bootstrap.ts",
    });
    expect(build).not.toContain("junto-desktop-bootstrap-linux-x64");
    expect(build).not.toContain("bun build --compile");
    expect(build).not.toContain("junto-browser");
    expect(build).not.toContain("junto-station");
    expect(build).not.toContain("junto-content");
    expect(build).not.toContain("junto-release-installer");
    expect(build).not.toContain("linux-release-installer.ts");
    expect(build).not.toContain("junto-release-bridge");
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
