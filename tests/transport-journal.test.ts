import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  filterTransportLog,
  formatTransportFailure,
  formatTransportFrame,
  rememberTransportStderr,
  sanitizeTransportError,
  seatTapeFromSummary,
  stationTapeFromExchange,
  transportLogPath,
  transportLogPathForHome,
} from "../src/shared/transport-trace";
import {
  appendTransportTrace,
  recordTransportError,
  startTransportJournal,
} from "../src/main/vellum-command/observability/transport-journal";
import { __resetVellumCommandHomeCache } from "../src/shared/vellum-home";

const originalHome = process.env.VELLUM_COMMAND_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.VELLUM_COMMAND_HOME;
  else process.env.VELLUM_COMMAND_HOME = originalHome;
  __resetVellumCommandHomeCache();
});

describe("transport journal", () => {
  it("repairs product-log directories and files to owner-only modes", () => {
    const root = mkdtempSync(join(tmpdir(), "vellum-transport-modes-"));
    process.env.VELLUM_COMMAND_HOME = root;
    __resetVellumCommandHomeCache();
    const product = join(root, ".vellum-command");
    const logs = join(product, "logs");
    const journal = join(logs, "transport.jsonl");
    const rotated = `${journal}.1`;
    try {
      mkdirSync(logs, { recursive: true });
      writeFileSync(journal, "existing\n");
      writeFileSync(rotated, "rotated\n");
      chmodSync(product, 0o777);
      chmodSync(logs, 0o777);
      chmodSync(journal, 0o666);
      chmodSync(rotated, 0o666);

      startTransportJournal();
      appendTransportTrace({
        plane: "term",
        op: "mode-proof",
        ok: true,
      });

      expect(statSync(product).mode & 0o777).toBe(0o700);
      expect(statSync(logs).mode & 0o777).toBe(0o700);
      expect(statSync(journal).mode & 0o777).toBe(0o600);
      expect(statSync(rotated).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("redacts secrets and keeps the full error, stack, and stderr", () => {
    expect(sanitizeTransportError("token=abc password=xyz boom")).toContain(
      "<redacted>",
    );
    expect(sanitizeTransportError("token=abc")).not.toContain("abc");
    const err = new Error("host remote-a is not a remote SSH endpoint");
    err.stack = `${err.message}\n    at ensureRemoteClient (router.ts:916:13)`;
    const tagged = Object.assign(err, {
      _tag: "SshExitError",
      operation: "forward",
      code: 255,
      stderr: "Permission denied (publickey).\nOffending key: token=abc",
    });
    const failure = formatTransportFailure(tagged);
    expect(failure.error).toContain("not a remote SSH endpoint");
    expect(failure.error).toContain("operation=forward");
    expect(failure.error).toContain("code=255");
    expect(failure.stack).toContain("ensureRemoteClient");
    expect(failure.stderr).toContain("Permission denied (publickey)");
    expect(failure.stderr).not.toContain("token=abc");
    expect(failure.error.length).toBeGreaterThan(40);
    const long = `ssh failed ${"x".repeat(2000)}`;
    expect(sanitizeTransportError(long)).toBe(long);
    expect(sanitizeTransportError(long).length).toBeGreaterThan(400);
    const classified = new Error("ssh exited 255 during one-shot");
    rememberTransportStderr(
      classified,
      "Permission denied (publickey).\nOffending key: token=abc\n" +
        "debug1: Authentications that can continue: publickey\n".repeat(20),
    );
    const remembered = formatTransportFailure(classified);
    expect(remembered.stderr).toContain("Authentications that can continue");
    expect(remembered.stderr).not.toContain("token=abc");
    expect(JSON.stringify(classified)).not.toContain("publickey");
    const frame = formatTransportFrame({
      request: {
        v: 1,
        id: "1",
        op: "write",
        leaseId: "lease-1",
        data: "typed password=super-secret into the pty",
      },
      response: { v: 1, id: "1", ok: false, error: "lease gone token=abc" },
    });
    expect(frame).toContain('"op":"write"');
    expect(frame).toContain("<omitted>");
    expect(frame).not.toContain("super-secret");
    expect(frame).toContain("<redacted>");
  });

  it("writes the full failure tape including stack, stderr, and frame", () => {
    const root = mkdtempSync(join(tmpdir(), "vellum-transport-fail-"));
    process.env.VELLUM_COMMAND_HOME = root;
    __resetVellumCommandHomeCache();
    startTransportJournal();
    const err = new Error("ssh exited 255 during forward");
    err.stack = `${err.message}\n    at forward (service.ts:1121:19)`;
    rememberTransportStderr(err, "Permission denied (publickey).\n");
    recordTransportError(
      {
        plane: "ssh-transport",
        op: "forward",
        endpoint: "remote-a",
        frame: formatTransportFrame({
          request: { op: "write", data: "typed secret" },
        }),
      },
      err,
    );
    const rows = readFileSync(transportLogPath(), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            op: string;
            error?: string;
            stack?: string;
            stderr?: string;
            frame?: string;
          },
      );
    const fail = rows.find((row) => row.op === "forward");
    expect(fail?.error).toContain("ssh exited 255");
    expect(fail?.stack).toContain("service.ts:1121");
    expect(fail?.stderr).toContain("Permission denied");
    expect(fail?.frame).toContain("<omitted>");
    expect(fail?.frame).not.toContain("typed secret");
    rmSync(root, { recursive: true, force: true });
  });

  it("derives occupancy only from a completed session snapshot", () => {
    expect(seatTapeFromSummary("bind-1", undefined)).toEqual({
      status: "none",
      occupancy: "VacantSeat",
    });
    expect(
      seatTapeFromSummary("bind-1", {
        epoch: "ep_1",
        status: "running",
      }),
    ).toEqual({
      status: "running",
      occupancy: "OccupiedSeat",
      epoch: "ep_1",
    });
    expect(
      seatTapeFromSummary("bind-1", {
        epoch: "ep_1",
        status: "exited",
      }),
    ).toMatchObject({ status: "exited", occupancy: "VacantSeat" });
  });

  it("writes a seat-table hop without a journal-start heartbeat", () => {
    const root = mkdtempSync(join(tmpdir(), "vellum-transport-"));
    process.env.VELLUM_COMMAND_HOME = root;
    __resetVellumCommandHomeCache();
    startTransportJournal();
    appendTransportTrace({
      plane: "term",
      op: "host.occupy",
      ok: true,
      bindingId: "bind-1",
      status: "none",
      occupancy: "VacantSeat",
      decision: "occupy",
    });
    const rows = readFileSync(transportLogPath(), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { op: string; decision?: string });
    expect(rows.some((row) => row.op === "journal-start")).toBe(false);
    expect(rows.find((row) => row.op === "host.occupy")?.decision).toBe(
      "occupy",
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("names the Remote journal from that machine home", () => {
    expect(transportLogPathForHome("/Users/op")).toBe(
      "/Users/op/.vellum-command/logs/transport.jsonl",
    );
  });

  it("summarizes Station hops without projection bodies or work records", () => {
    const tape = stationTapeFromExchange(
      {
        op: "project",
        projection: {
          generation: "12",
          body: "CANVAS SECRET token=abc",
        },
      },
      {
        op: "project",
        decision: "install",
        active: { generation: "12" },
      },
    );
    expect(tape).toEqual({
      decision: "install",
      generation: "12",
    });
    expect(JSON.stringify(tape)).not.toContain("CANVAS");
    expect(JSON.stringify(tape)).not.toContain("token=");
    const status = stationTapeFromExchange(
      { op: "status" },
      {
        op: "status",
        state: "ready",
        projection: { generation: "12" },
        readiness: {
          database: true,
          workControl: true,
          simulation: false,
          session: true,
        },
      },
    );
    expect(status.status).toBe("ready missing=simulation");
    expect(status.generation).toBe("12");
    const report = stationTapeFromExchange({
      op: "report",
      batch: { records: [{ payload: "do not store" }, {}], hasMore: false },
    });
    expect(report.records).toBe(2);
    expect(JSON.stringify(report)).not.toContain("do not store");
  });

  it("filters tape lines by substring", () => {
    const text = [
      '{"op":"host.exit","status":"exited"}',
      '{"op":"ssh-transport","ok":true}',
    ].join("\n");
    expect(filterTransportLog(text, "host.exit")).toContain("exited");
    expect(filterTransportLog(text, "host.exit")).not.toContain("ssh-transport");
  });
});
