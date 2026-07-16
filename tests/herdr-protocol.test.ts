import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Field-name contract against herdr's control NDJSON protocol.
 * Wrong keys are often silent no-ops (input) or noisy rejects (scroll).
 */
describe("herdr control protocol field names", () => {
  const streamSrc = readFileSync(
    join(import.meta.dirname, "../src/main/vellum/herdr/stream.ts"),
    "utf8",
  );

  it("terminal.input uses bytes or text — never the silent-noop field data", () => {
    // input() body must include bytes:
    expect(streamSrc).toMatch(/type:\s*["']terminal\.input["']/);
    expect(streamSrc).toMatch(/bytes:\s*dataBase64/);
    // Guard against regressing to { data: ... } which herdr ignores.
    const inputMethod = streamSrc.slice(
      streamSrc.indexOf("input(streamId: string, dataBase64: string)"),
      streamSrc.indexOf("inputText("),
    );
    expect(inputMethod).not.toMatch(/\bdata:\s*dataBase64\b/);
    expect(inputMethod).toMatch(/\bbytes:\s*dataBase64\b/);
  });

  it("terminal.scroll uses direction + lines — not delta", () => {
    const scrollMethod = streamSrc.slice(
      streamSrc.indexOf("scroll("),
      streamSrc.indexOf("detachControl") > 0
        ? streamSrc.indexOf("/**\n   * Detach control")
        : streamSrc.indexOf("close(streamId"),
    );
    expect(scrollMethod).toMatch(/type:\s*["']terminal\.scroll["']/);
    expect(scrollMethod).toMatch(/direction/);
    expect(scrollMethod).toMatch(/lines/);
  });

  it("terminal.scroll forwards the pointer cell — mouse-reporting apps scroll under the cursor", () => {
    const scrollMethod = streamSrc.slice(
      streamSrc.indexOf("scroll("),
      streamSrc.indexOf("mouse("),
    );
    // herdr encodes wheel for mouse-reporting apps at (column,row); without
    // these the event lands at the (0,0) corner and grok-style TUIs ignore it.
    expect(scrollMethod).toMatch(/column:/);
    expect(scrollMethod).toMatch(/row:/);
    expect(scrollMethod).toMatch(/modifiers:/);
  });

  it("terminal.mouse carries kind + cell — hover/click/drag for mouse-native TUIs", () => {
    const mouseMethod = streamSrc.slice(
      streamSrc.indexOf("mouse("),
      streamSrc.indexOf("/**\n   * Detach control"),
    );
    expect(mouseMethod).toMatch(/type:\s*["']terminal\.mouse["']/);
    expect(mouseMethod).toMatch(/kind:/);
    expect(mouseMethod).toMatch(/column:/);
    expect(mouseMethod).toMatch(/row:/);
    expect(mouseMethod).toMatch(/modifiers:/);
  });

  it("terminal.clipboard_image uses extension + bytes — stages on host, pastes path", () => {
    const methodStart = streamSrc.indexOf("clipboardImage(");
    expect(methodStart).toBeGreaterThan(-1);
    const method = streamSrc.slice(methodStart, streamSrc.indexOf("resize(", methodStart));
    expect(method).toMatch(/type:\s*["']terminal\.clipboard_image["']/);
    expect(method).toMatch(/extension:\s*ext/);
    expect(method).toMatch(/bytes:\s*dataBase64/);
    // Same silent-noop trap as terminal.input — never ship a field herdr ignores.
    expect(method).not.toMatch(/\bdata:\s*dataBase64\b/);
  });
});
