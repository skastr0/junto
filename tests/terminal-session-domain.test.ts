import { describe, expect, it } from "vitest";
import {
  ControlIoPhase,
  controlPhaseIsLive,
  controlPhaseRefusesWrite,
  encodeHerdrControlLine,
  herdrControlWriteWire,
  herdrControlWriteFailed,
  herdrInputBytes,
  herdrInputText,
  herdrRelease,
  herdrResize,
  herdrScroll,
  inactiveControlError,
  normalizeControlGeometry,
  parseHerdrControlInbound,
  pipeControlError,
} from "../src/shared/terminal-session-domain";

describe("ControlIoPhase", () => {
  it("Live accepts writes; Broken/Closed refuse", () => {
    expect(controlPhaseIsLive(ControlIoPhase.Live())).toBe(true);
    expect(controlPhaseRefusesWrite(ControlIoPhase.Live())).toBe(false);
    expect(
      controlPhaseRefusesWrite(ControlIoPhase.Broken({ reason: "pipe" })),
    ).toBe(true);
    expect(
      controlPhaseIsLive(ControlIoPhase.Closed({ reason: "client_close" })),
    ).toBe(false);
  });
});

describe("herdr control NDJSON encode", () => {
  it("input bytes/text exclusive shapes", () => {
    expect(encodeHerdrControlLine(herdrInputBytes("YWI="))).toBe(
      `${JSON.stringify({ type: "terminal.input", bytes: "YWI=" })}\n`,
    );
    expect(encodeHerdrControlLine(herdrInputText("hi"))).toBe(
      `${JSON.stringify({ type: "terminal.input", text: "hi" })}\n`,
    );
    expect(encodeHerdrControlLine(herdrRelease())).toBe(
      `${JSON.stringify({ type: "terminal.release" })}\n`,
    );
    expect(encodeHerdrControlLine(herdrResize(80, 24))).toBe(
      `${JSON.stringify({ type: "terminal.resize", cols: 80, rows: 24 })}\n`,
    );
    expect(
      encodeHerdrControlLine(
        herdrScroll({ direction: "up", lines: 1, column: 2, row: 3, modifiers: 0 }),
      ),
    ).toContain('"direction":"up"');
  });

  it("parses inbound frame/closed; rejects garbage", () => {
    const frame = parseHerdrControlInbound(
      JSON.stringify({ type: "terminal.frame", bytes: "QQ==", full: true }),
    );
    expect(frame?.type).toBe("terminal.frame");
    if (frame?.type === "terminal.frame") {
      expect(frame.bytes).toBe("QQ==");
      expect(frame.full).toBe(true);
    }
    const closed = parseHerdrControlInbound(
      JSON.stringify({ type: "terminal.closed", reason: "gone" }),
    );
    expect(closed?.type).toBe("terminal.closed");
    expect(parseHerdrControlInbound("not-json")).toBeUndefined();
    expect(parseHerdrControlInbound(JSON.stringify({ type: "nope" }))).toBeUndefined();
  });
});

describe("write result wire flatten", () => {
  it("maps tagged errors to IPC-stable error strings", () => {
    const failed = herdrControlWriteFailed(pipeControlError("stdin", "write EPIPE"));
    expect(herdrControlWriteWire(failed)).toEqual({
      ok: false,
      error: "write EPIPE",
    });
    expect(
      herdrControlWriteWire(
        herdrControlWriteFailed(inactiveControlError("stream not active")),
      ),
    ).toEqual({ ok: false, error: "stream not active" });
  });
});

describe("normalizeControlGeometry", () => {
  it("floors to product mins", () => {
    expect(normalizeControlGeometry(10, 2)).toEqual({ cols: 20, rows: 5 });
    expect(normalizeControlGeometry(100.9, 40.2)).toEqual({ cols: 100, rows: 40 });
    expect(normalizeControlGeometry(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({
      cols: 80,
      rows: 24,
    });
  });
});
