import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  describeDeployTransferFailure,
  parseDeployTransferResult,
  resolveLocalAppBundle,
  settleTarExit,
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
  it("settles tar exit even when it happens before remote readiness is awaited", async () => {
    const tar = new EventEmitter();
    let released = 0;
    const settlement = settleTarExit(tar as never, () => {
      released += 1;
    });
    tar.emit("close", 1);

    await expect(settlement).resolves.toMatchObject({
      ok: false,
      error: { message: "local tar exited 1" },
    });
    expect(released).toBe(1);
  });

  it("releases a failed tar spawn only once when error is followed by close", async () => {
    const tar = new EventEmitter();
    let released = 0;
    const settlement = settleTarExit(tar as never, () => {
      released += 1;
    });
    tar.emit("error", new Error("spawn failed"));
    tar.emit("close", 1);

    await expect(settlement).resolves.toMatchObject({
      ok: false,
      error: { message: "spawn failed" },
    });
    expect(released).toBe(1);
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
