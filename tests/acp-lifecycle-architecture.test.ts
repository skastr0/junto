import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relative: string): string =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

describe("ACP lifecycle architecture", () => {
  it("routes local ACP spawn and signaling only through the central app process plane", () => {
    const client = source("src/main/vellum/chat/acp-client.ts");
    const plane = source("src/main/vellum/hermes/plane.ts");

    expect(client).not.toContain("admitChildProcess");
    expect(client).not.toContain("OwnedProcess");
    expect(client).not.toContain("signalOwned");
    expect(client).not.toContain("releaseOwned");
    expect(client).not.toMatch(/\.kill\s*\(/u);
    expect(plane).not.toContain("admitChildProcess");
    expect(plane).toContain("appProcessPlane.spawnChild({");
    expect(plane).toContain("processPlane: appProcessPlane");
    expect(plane).not.toMatch(/\bspawn\s*\(/u);
    expect(plane).not.toContain("localChildren");
    expect(plane).not.toContain("terminateLocalAcpChild");
  });

  it("keeps remote ACP scope-owned and outside the OS signal plane", () => {
    const client = source("src/main/vellum/chat/acp-client.ts");
    const plane = source("src/main/vellum/hermes/plane.ts");

    expect(client).toContain('readonly kind: "remote-scope"');
    expect(plane).toContain('kind: "remote-scope"');
    expect(plane).toContain('Scope.make("sequential")');
    expect(plane).not.toContain("Scope.fork(");
    expect(plane).not.toMatch(/\.kill\s*\(/u);
    expect(plane).not.toContain("signalOwned");
  });

  it("publishes one Hermes shutdown flight and makes its finalizer fail closed", () => {
    const plane = source("src/main/vellum/hermes/plane.ts");

    expect(plane).toContain("const shutdown = makeHermesShutdownPort(chat)");
    expect(plane).toContain("finalizeHermesShutdown(shutdown)");
    expect(plane).toContain("const receipt = await shutdown.drainOnQuit()");
    expect(plane).toContain("requireCleanChatShutdown(receipt)");
    expect(plane).not.toContain("await chat.closeAll()");
  });
});
