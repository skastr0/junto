import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  filterTransportLog,
  sanitizeTransportError,
  transportLogPath,
  transportLogPathForHome,
} from "../src/shared/transport-trace";
import {
  appendTransportTrace,
  startTransportJournal,
} from "../src/main/vellum/observability/transport-journal";
import { occupancyFromSession } from "../src/shared/terminal-seat-occupancy";
import { __resetVellumCommandHomeCache } from "../src/shared/vellum-home";

const originalHome = process.env.VELLUM_COMMAND_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.VELLUM_COMMAND_HOME;
  else process.env.VELLUM_COMMAND_HOME = originalHome;
  __resetVellumCommandHomeCache();
});

describe("transport journal", () => {
  it("redacts secrets in error text", () => {
    expect(sanitizeTransportError("token=abc password=xyz boom")).toContain(
      "<redacted>",
    );
    expect(sanitizeTransportError("token=abc")).not.toContain("abc");
  });

  it("writes occupancy receipts to ~/.vellum-command/logs/transport.jsonl", () => {
    const root = mkdtempSync(join(tmpdir(), "vellum-transport-"));
    process.env.VELLUM_COMMAND_HOME = root;
    __resetVellumCommandHomeCache();
    startTransportJournal();
    appendTransportTrace({
      plane: "term",
      op: "host.get",
      ok: true,
      bindingId: "bind-1",
      status: "none",
      occupancy: occupancyFromSession("bind-1", undefined)._tag,
      decision: "get-undefined",
    });
    const text = readFileSync(transportLogPath(), "utf8");
    const rows = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { op: string; occupancy?: string });
    expect(rows.some((row) => row.op === "journal-start")).toBe(true);
    const get = rows.find((row) => row.op === "host.get");
    expect(get?.occupancy).toBe("VacantSeat");
    rmSync(root, { recursive: true, force: true });
  });

  it("names the Remote journal from that machine home", () => {
    expect(transportLogPathForHome("/Users/op")).toBe(
      "/Users/op/.vellum-command/logs/transport.jsonl",
    );
  });

  it("filters occupancy lines", () => {
    const text = [
      '{"op":"host.get","occupancy":"VacantSeat"}',
      '{"op":"ssh-transport","ok":true}',
    ].join("\n");
    expect(filterTransportLog(text, "VacantSeat")).toContain("host.get");
    expect(filterTransportLog(text, "VacantSeat")).not.toContain("ssh-transport");
  });
});
