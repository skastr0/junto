import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Field-name contract against stock herdr control NDJSON
 * (`herdr` src/client/mod.rs :: TerminalControlCommand + write_terminal_session_output).
 * Wrong keys are often silent no-ops (input) or noisy rejects (scroll).
 * Domain helpers live in terminal-session-domain; stream manager must wire them.
 */
describe("herdr control protocol field names", () => {
  const streamSrc = readFileSync(
    join(import.meta.dirname, "../src/main/vellum/herdr/stream.ts"),
    "utf8",
  );
  const domainSrc = readFileSync(
    join(import.meta.dirname, "../src/shared/terminal-session-domain.ts"),
    "utf8",
  );
  const planeSrc = readFileSync(
    join(import.meta.dirname, "../src/main/vellum/herdr/plane.ts"),
    "utf8",
  );

  it("terminal.input uses bytes or text — never the silent-noop field data", () => {
    expect(domainSrc).toMatch(/type:\s*Schema\.Literal\(["']terminal\.input["']\)/);
    expect(domainSrc).toMatch(/bytes:\s*Schema\.String/);
    expect(domainSrc).toMatch(/text:\s*Schema\.String/);
    // Stream wires domain helpers, not a freeform `data` field.
    expect(streamSrc).toMatch(/herdrInputBytes/);
    expect(streamSrc).toMatch(/herdrInputText/);
    const inputMethod = streamSrc.slice(
      streamSrc.indexOf("input(streamId: string, dataBase64: string)"),
      streamSrc.indexOf("inputText("),
    );
    expect(inputMethod).not.toMatch(/\bdata:\s*dataBase64\b/);
    expect(inputMethod).toMatch(/herdrInputBytes\(dataBase64\)/);
  });

  it("terminal.scroll uses direction + lines — not delta", () => {
    expect(domainSrc).toMatch(/terminal\.scroll/);
    expect(domainSrc).toMatch(/direction:\s*Schema\.Literal\("up", "down"\)/);
    expect(domainSrc).toMatch(/lines:/);
    expect(streamSrc).toMatch(/herdrScroll/);
    const scrollMethod = streamSrc.slice(
      streamSrc.indexOf("scroll("),
      streamSrc.indexOf("/**\n   * Detach control"),
    );
    expect(scrollMethod).toMatch(/direction/);
    expect(scrollMethod).toMatch(/lines/);
  });

  it("terminal.scroll forwards the pointer cell — mouse-reporting apps scroll under the cursor", () => {
    const scrollMethod = streamSrc.slice(
      streamSrc.indexOf("scroll("),
      streamSrc.indexOf("/**\n   * Detach control"),
    );
    expect(scrollMethod).toMatch(/column:/);
    expect(scrollMethod).toMatch(/row:/);
    expect(scrollMethod).toMatch(/modifiers:/);
  });

  it("terminal.release maps to stock detach (never pane/session kill commands)", () => {
    expect(domainSrc).toMatch(/terminal\.release/);
    expect(streamSrc).toMatch(/herdrRelease/);
    // herdr client: Release {} => ClientMessage::Detach — Vellum must not
    // invent workspace/tab/pane close over the control NDJSON channel.
    expect(streamSrc).not.toMatch(/type:\s*["']pane\.close["']/);
    expect(streamSrc).not.toMatch(/type:\s*["']session\.stop["']/);
    expect(domainSrc).not.toMatch(/pane\.close/);
  });

  it("spawns stock herdr terminal session control|observe argv", () => {
    expect(streamSrc).toMatch(/"terminal"/);
    expect(streamSrc).toMatch(/"session"/);
    expect(streamSrc).toMatch(/"control"/);
    expect(planeSrc).toMatch(/AppProcessHerdrClient/);
    expect(planeSrc).toMatch(/io\.stdin\.on\(event, listener\)/);
  });

  it("owns async control pipe errors (EPIPE) on stdin/stdout/stderr", () => {
    expect(streamSrc).toMatch(/handleControlIoError/);
    expect(streamSrc).toMatch(/isHerdrBrokenPipeError/);
    expect(streamSrc).toMatch(/stdin\.on\?\.?\(\s*["']error["']/);
    expect(streamSrc).toMatch(/ControlIoPhase/);
    expect(streamSrc).toMatch(/controlPhaseRefusesWrite|controlPhaseIsLive/);
  });

  it("encodes outbound NDJSON via terminal-session domain helpers", () => {
    expect(streamSrc).toMatch(/encodeHerdrControlLine|herdrInputBytes|herdrRelease/);
    expect(streamSrc).toMatch(/terminal-session-domain/);
  });

  it("pasteImage stages on host then pastes path via stock terminal.input", () => {
    const methodStart = streamSrc.indexOf("pasteImage(");
    expect(methodStart).toBeGreaterThan(-1);
    const method = streamSrc.slice(methodStart, streamSrc.indexOf("resize(", methodStart));
    expect(method).not.toMatch(/terminal\.clipboard_image/);
    expect(method).toMatch(/stageImageOnHost/);
    expect(method).toMatch(/herdrInputText/);
    expect(method).toMatch(/pastePathPayload/);
  });
});
