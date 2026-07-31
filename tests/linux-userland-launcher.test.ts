import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const launcher = () => readFile(
  new URL("../build/linux/vellum-remote-launch", import.meta.url),
  "utf8",
);

describe("Linux userland Remote launcher", () => {
  it("requires Electron's documented Xvfb display path instead of pretending an Ozone fallback is supported", async () => {
    const source = await launcher();
    expect(source).toContain(
      "Xvfb, xauth, and mcookie are required for Electron Remote startup",
    );
    expect(source).toContain('"$vellum" --vellum-headless --ozone-platform=x11 &');
    expect(source).not.toContain('"$vellum" --vellum-headless &');
    expect(source).not.toMatch(/--no-sandbox|disable-setuid-sandbox/u);
  });
});
