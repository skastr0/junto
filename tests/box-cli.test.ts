import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BoxId,
} from "../src/main/vellum/box";
import {
  BoxCli,
  makeBoxCli,
} from "../src/main/vellum/box/cli";
import {
  BoxProcessError,
  BoxProcessRunner,
  resolveBoxCliCandidates,
  type BoxProcessRequest,
  type BoxProcessResult,
} from "../src/main/vellum/box/process";
import { admitOwnedBox } from "../src/main/vellum/box/ownership";

const boxId = Schema.decodeUnknownSync(BoxId)("bx_c79mgja6");
const machine = {
  box: {
    id: boxId,
    name: "Vellum qualification",
    ip: "203.0.113.8",
    state: "running",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:01.000Z",
    desktopUrl: "secret-bearing field must be ignored",
  },
};
const ownedBox = admitOwnedBox({
  machine: machine.box,
  hostId: "box-c79mgja6",
  enrolledAt: "2026-07-27T00:00:02.000Z",
});

const status = {
  account: {
    identifier: "operator@example.com",
    loginState: "active",
    plan: "Standard",
    status: "active",
    suspension: null,
  },
  api: {
    error: null,
    healthy: true,
    status: "healthy",
    url: "https://ascii.dev",
  },
  config: {
    apiUrl: "https://ascii.dev",
    channel: "prod",
    path: "/tmp/box/config.json",
  },
};

const makeRunner = (
  respond: (
    request: BoxProcessRequest,
  ) => BoxProcessResult | BoxProcessError,
) =>
  BoxProcessRunner.of({
    run: (request) => {
      const result = respond(request);
      return result instanceof BoxProcessError
        ? Effect.fail(result)
        : Effect.succeed(result);
    },
  });

const success = (stdout: string): BoxProcessResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

const withCli = <A>(
  runner: Context.Tag.Service<typeof BoxProcessRunner>,
  path: string,
  effect: (cli: Context.Tag.Service<typeof BoxCli>) => Effect.Effect<A, unknown>,
) => Effect.runPromise(effect(makeBoxCli(runner, { executablePath: path })));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Box CLI adapter", () => {
  it("detects the official ~/.ascii/bin/box installation path", () => {
    const root = mkdtempSync(join(tmpdir(), "vellum-box-cli-"));
    const executable = join(root, ".ascii", "bin", "box");
    try {
      mkdirSync(join(root, ".ascii", "bin"), { recursive: true });
      writeFileSync(executable, "#!/bin/sh\nexit 0\n");
      chmodSync(executable, 0o700);

      expect(resolveBoxCliCandidates(undefined, { PATH: "" }, root)).toEqual([
        executable,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("probes version, authentication, and API health without listing Boxes", async () => {
    const calls: BoxProcessRequest[] = [];
    const runner = makeRunner((request) => {
      calls.push(request);
      if (request.args.includes("--version")) return success("box 0.1.135-ascii-prod1\n");
      return success(JSON.stringify(status));
    });

    const availability = await withCli(runner, "/bin/true", (cli) =>
      cli.availability,
    );

    expect(availability).toMatchObject({
      available: true,
      authenticated: true,
      healthy: true,
      version: "0.1.135-ascii-prod1",
      account: "operator@example.com",
    });
    expect(calls.map((call) => call.args)).toEqual([
      ["--no-update", "--version"],
      ["--no-update", "--json", "status"],
    ]);
    expect(calls.flatMap((call) => call.args)).not.toContain("list");
  });

  it("creates no-env Boxes and decodes only non-secret machine fields", async () => {
    let request: BoxProcessRequest | undefined;
    const runner = makeRunner((next) => {
      request = next;
      return success(JSON.stringify(machine));
    });

    const result = await withCli(runner, "/bin/true", (cli) =>
      cli.create({ autoStop: false, includeAccountSecrets: false }),
    );

    expect(request?.args).toEqual([
      "--no-update",
      "--json",
      "new",
      "--no-auto-stop",
      "--no-env",
    ]);
    expect(result).toEqual({
      id: boxId,
      name: "Vellum qualification",
      ip: "203.0.113.8",
      state: "running",
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:01.000Z",
    });
    expect("desktopUrl" in result).toBe(false);
  });

  it("passes remote commands as argv instead of shell text", async () => {
    let request: BoxProcessRequest | undefined;
    const runner = makeRunner((next) => {
      request = next;
      return success("ok\n");
    });

    const stdout = await withCli(runner, "/bin/true", (cli) =>
      cli.ssh(ownedBox, ["printf", "%s", "hello; touch /tmp/no"]),
    );

    expect(stdout).toBe("ok\n");
    expect(request?.args).toEqual([
      "--no-update",
      "ssh",
      boxId,
      "printf",
      "%s",
      "hello; touch /tmp/no",
    ]);
  });

  it("surfaces nonzero exits and malformed JSON as typed failures", async () => {
    const failed = makeRunner(() => ({
      exitCode: 9,
      stdout: "",
      stderr: "not authenticated",
    }));
    const malformed = makeRunner(() => success("{"));

    await expect(
      withCli(failed, "/bin/true", (cli) => cli.info(ownedBox)),
    ).rejects.toThrow(/not authenticated/u);
    await expect(
      withCli(malformed, "/bin/true", (cli) => cli.info(ownedBox)),
    ).rejects.toThrow(/invalid JSON/u);
  });
});
