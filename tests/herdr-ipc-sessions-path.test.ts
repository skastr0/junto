import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Consolidation gate: product herdr control must enter only through
 * plane.sessions — never plane.streams for open/write/close.
 */
describe("herdr IPC product path is TerminalSessions", () => {
  const ipcSrc = readFileSync(
    join(import.meta.dirname, "../src/main/vellum/herdr/ipc.ts"),
    "utf8",
  );
  const indexSrc = readFileSync(
    join(import.meta.dirname, "../src/main/index.ts"),
    "utf8",
  );

  it("stream open/write/close use sessions product API", () => {
    expect(ipcSrc).toMatch(/sessions\.openProduct/);
    expect(ipcSrc).toMatch(/sessions\.inputBytesProduct/);
    expect(ipcSrc).toMatch(/sessions\.resizeProduct/);
    expect(ipcSrc).toMatch(/sessions\.scrollProduct/);
    expect(ipcSrc).toMatch(/sessions\.pasteImageProduct/);
    expect(ipcSrc).toMatch(/sessions\.closeProduct/);
    expect(ipcSrc).toMatch(/sessions\.setFrameSink/);
  });

  it("does not call plane.streams product methods from herdr IPC", () => {
    expect(ipcSrc).not.toMatch(/plane\.streams\.open\b/);
    expect(ipcSrc).not.toMatch(/plane\.streams\.input\b/);
    expect(ipcSrc).not.toMatch(/plane\.streams\.inputText\b/);
    expect(ipcSrc).not.toMatch(/plane\.streams\.resize\b/);
    expect(ipcSrc).not.toMatch(/plane\.streams\.scroll\b/);
    expect(ipcSrc).not.toMatch(/plane\.streams\.close\b/);
    expect(ipcSrc).not.toMatch(/plane\.streams\.pasteImage\b/);
    expect(ipcSrc).not.toMatch(/plane\.streams\.setSink\b/);
  });

  it("quit count uses sessions", () => {
    expect(indexSrc).toMatch(/herdr\.sessions\.activeControlCount/);
  });
});
