import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Field-name contract against stock herdr control NDJSON
 * (`herdr` src/client/mod.rs :: TerminalControlCommand + write_terminal_session_output).
 * Wrong keys are often silent no-ops (input) or noisy rejects (scroll).
 */
describe("herdr control protocol field names", () => {
  const streamSrc = readFileSync(
    join(import.meta.dirname, "../src/main/vellum/herdr/stream.ts"),
    "utf8",
  );
  const planeSrc = readFileSync(
    join(import.meta.dirname, "../src/main/vellum/herdr/plane.ts"),
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
      streamSrc.indexOf("/**\n   * Detach control"),
    );
    // herdr encodes wheel for mouse-reporting apps at (column,row); without
    // these the event lands at the (0,0) corner and grok-style TUIs ignore it.
    expect(scrollMethod).toMatch(/column:/);
    expect(scrollMethod).toMatch(/row:/);
    expect(scrollMethod).toMatch(/modifiers:/);
  });

  it("terminal.release maps to stock detach (never pane/session kill commands)", () => {
    expect(streamSrc).toMatch(/type:\s*["']terminal\.release["']/);
    // herdr client: Release {} => ClientMessage::Detach — Vellum must not
    // invent workspace/tab/pane close over the control NDJSON channel.
    expect(streamSrc).not.toMatch(/type:\s*["']pane\.close["']/);
    expect(streamSrc).not.toMatch(/type:\s*["']session\.stop["']/);
  });

  it("spawns stock herdr terminal session control|observe argv", () => {
    expect(streamSrc).toMatch(/"terminal"/);
    expect(streamSrc).toMatch(/"session"/);
    expect(streamSrc).toMatch(/"control"/);
    // Observe pool is a sibling module; plane wires the same binary path.
    expect(planeSrc).toMatch(/AppProcessHerdrClient/);
    // Local facade must expose stdin.on so async EPIPE can be owned.
    expect(planeSrc).toMatch(/io\.stdin\.on\(event, listener\)/);
  });

  it("owns async control pipe errors (EPIPE) on stdin/stdout/stderr", () => {
    expect(streamSrc).toMatch(/handleControlIoError/);
    expect(streamSrc).toMatch(/isHerdrBrokenPipeError/);
    expect(streamSrc).toMatch(/stdin\.on\?\.?\(\s*["']error["']/);
    expect(streamSrc).toMatch(/writeBroken/);
  });

  it("pasteImage stages on host then pastes path via stock terminal.input", () => {
    const methodStart = streamSrc.indexOf("pasteImage(");
    expect(methodStart).toBeGreaterThan(-1);
    const method = streamSrc.slice(methodStart, streamSrc.indexOf("resize(", methodStart));
    // Stock herdr only — never invent control commands.
    expect(method).not.toMatch(/terminal\.clipboard_image/);
    expect(method).toMatch(/stageImageOnHost/);
    expect(method).toMatch(/type:\s*["']terminal\.input["']/);
    expect(method).toMatch(/pastePathPayload/);
  });
});
