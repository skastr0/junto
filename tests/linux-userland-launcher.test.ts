import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const launcher = () =>
  readFile(new URL("../build/linux/junto-remote-launch", import.meta.url), "utf8");

describe("Linux userland Remote launcher", () => {
  it("starts the displayless Node Remote without Xvfb or Electron display env", async () => {
    const source = await launcher();
    expect(source).toContain("resources/bin/junto-remote");
    expect(source).toContain("unset DISPLAY WAYLAND_DISPLAY XAUTHORITY");
    expect(source).toContain("displayless junto-remote payload is unavailable");
    expect(source).not.toContain("Xvfb");
    expect(source).not.toContain("xauth");
    expect(source).not.toContain("mcookie");
    expect(source).not.toContain("--ozone-platform");
    expect(source).not.toContain("--junto-headless");
    expect(source).not.toMatch(/--no-sandbox|disable-setuid-sandbox|ELECTRON_RUN_AS_NODE/u);
  });
});
