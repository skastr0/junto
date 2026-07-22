import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  describeDeployTransferFailure,
  captureTarStderr,
  awaitTarCloseBounded,
  parseDeployTransferResult,
  resolveLocalAppBundle,
  watchTarExit,
} from "../src/main/vellum/hosts/deploy-remote";
import { SshTransferExitError } from "../src/main/vellum/ssh/service";

describe("resolveLocalAppBundle", () => {
  it("returns a string path or null without throwing", () => {
    // In CI / bare checkout there may be no .app; function must stay pure-safe.
    const path = resolveLocalAppBundle();
    expect(path === null || (typeof path === "string" && path.length > 0)).toBe(
      true,
    );
  });
});

describe("parseDeployTransferResult", () => {
  it("recognizes full and term-only readiness markers", () => {
    expect(
      parseDeployTransferResult({
        stdout: "STATION_READY term=1 browser=1",
        stderr: "",
      }),
    ).toMatchObject({
      ok: true,
      detail: expect.stringContaining("term + browser"),
    });
    expect(
      parseDeployTransferResult({
        stdout: "TERM_SOCK_OK browser=0",
        stderr: "",
      }),
    ).toMatchObject({
      ok: true,
      detail: expect.stringContaining("term control ready"),
    });
  });

  it("keeps a successful install honest when no readiness marker arrived", () => {
    expect(
      parseDeployTransferResult({
        stdout: "",
        stderr: "STATION_PARTIAL term=0 browser=0",
      }),
    ).toMatchObject({
      ok: true,
      detail: expect.stringContaining("still be warming"),
    });
  });
});

describe("deploy transfer lifecycle", () => {
  it("records tar exit even when it happens before remote readiness is awaited", async () => {
    const tar = new EventEmitter();
    let released = 0;
    const exit = watchTarExit(tar as never, () => {
      released += 1;
    });
    tar.emit("close", 1);

    await expect(exit.settlement).resolves.toMatchObject({
      ok: false,
      error: { message: "local tar exited 1" },
    });
    await expect(exit.closed).resolves.toBeUndefined();
    expect(exit.isClosed()).toBe(true);
    expect(exit.isReleased()).toBe(true);
    expect(released).toBe(1);
  });

  it("does not treat a tar error as a terminal-close witness", async () => {
    const tar = new EventEmitter();
    const exit = watchTarExit(tar as never);
    let closed = false;
    void exit.closed.then(() => {
      closed = true;
    });
    tar.emit("error", new Error("spawn failed"));

    await expect(exit.settlement).resolves.toMatchObject({
      ok: false,
      error: { message: "spawn failed" },
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    tar.emit("close", 1);
    await expect(exit.closed).resolves.toBeUndefined();
    expect(exit.isReleased()).toBe(true);
    expect(tar.listenerCount("error")).toBe(0);
    expect(tar.listenerCount("close")).toBe(0);
  });

  it("bounds a never-closing tar wait and clears its timer", async () => {
    const tar = new EventEmitter();
    const exit = watchTarExit(tar as never);
    const started = Date.now();
    await awaitTarCloseBounded(exit, 10);

    expect(Date.now() - started).toBeLessThan(250);
    expect(exit.isClosed()).toBe(false);
    expect(exit.isReleased()).toBe(false);
  });

  it("captures bounded tar stderr while draining the stream", () => {
    const stderr = new EventEmitter();
    const captured = captureTarStderr(stderr as never);
    stderr.emit("data", Buffer.alloc(64 * 1024, "a"));
    stderr.emit("data", Buffer.from("discarded"));

    expect(Buffer.byteLength(captured(), "utf8")).toBe(64 * 1024);
  });

  it("surfaces bounded remote readiness diagnostics on a failed transfer", () => {
    const darwin = new SshTransferExitError(
      "remote" as never,
      3,
      "",
      "REMOTE_NOT_DARWIN Linux",
    );
    expect(describeDeployTransferFailure(darwin)).toContain("not macOS");

    const timeout = new SshTransferExitError(
      "remote" as never,
      2,
      "TERM_SOCK_TIMEOUT",
      "STATION_PARTIAL term=0 browser=0",
    );
    expect(describeDeployTransferFailure(timeout)).toContain("STATION_PARTIAL");
  });
});
