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
    name: "Vellum Command qualification",
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
  runner: Context.Service.Shape<typeof BoxProcessRunner>,
  path: string,
  effect: (cli: Context.Service.Shape<typeof BoxCli>) => Effect.Effect<A, unknown>,
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

  it("creates no-env Boxes from JSONL receipts and reads the complete machine", async () => {
    const requests: BoxProcessRequest[] = [];
    const runner = makeRunner((next) => {
      requests.push(next);
      if (next.args.includes("new")) {
        return success(
          [
            JSON.stringify({
              event: "created",
              id: boxId,
              ttlSeconds: null,
            }),
            JSON.stringify({
              event: "state",
              id: boxId,
              state: "provisioning",
            }),
            JSON.stringify({
              event: "ready",
              id: boxId,
              state: "ready",
              ip: "203.0.113.8",
            }),
          ].join("\n"),
        );
      }
      return success(JSON.stringify(machine));
    });

    const result = await withCli(runner, "/bin/true", (cli) =>
      cli.create({
        autoStop: { kind: "ttl", ttlSeconds: 600 },
        includeAccountSecrets: false,
      }),
    );

    expect(requests.map((request) => request.args)).toEqual([
      [
        "--no-update",
        "--json",
        "new",
        "--ttl",
        "600",
        "--no-env",
      ],
      ["--no-update", "--json", "info", boxId],
    ]);
    expect(result).toEqual({
      id: boxId,
      name: "Vellum Command qualification",
      ip: "203.0.113.8",
      state: "running",
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:01.000Z",
    });
    expect("desktopUrl" in result).toBe(false);
  });

  it("prepares SSH with one fixed no-op and exposes no command surface", async () => {
    let request: BoxProcessRequest | undefined;
    const runner = makeRunner((next) => {
      request = next;
      return success("ok\n");
    });

    await withCli(runner, "/bin/true", (cli) => cli.prepareSsh(ownedBox));

    expect(request?.args).toEqual([
      "--no-update",
      "ssh",
      boxId,
      "true",
    ]);
  });

  it("changes only the owned Box provider lifetime", async () => {
    const requests: BoxProcessRequest[] = [];
    const runner = makeRunner((next) => {
      requests.push(next);
      return success("{}");
    });

    await withCli(runner, "/bin/true", (cli) =>
      Effect.all([
        cli.setAutoStop(ownedBox, { kind: "ttl", ttlSeconds: 600 }),
        cli.setAutoStop(ownedBox, { kind: "disabled" }),
      ], { concurrency: 1 }),
    );

    expect(requests.map((request) => request.args)).toEqual([
      ["--no-update", "extend", boxId, "--ttl", "600"],
      ["--no-update", "extend", boxId, "--no-auto-stop"],
    ]);
  });

  it("preserves the created Box identity when a later creation event fails", async () => {
    const runner = makeRunner(() => ({
      exitCode: 1,
      stdout: [
        JSON.stringify({ event: "created", id: boxId, ttlSeconds: null }),
        JSON.stringify({
          event: "error",
          error: "machine provisioning failed",
        }),
      ].join("\n"),
      stderr: "",
    }));

    const result = await Effect.runPromise(
      Effect.result(
        makeBoxCli(runner, { executablePath: "/bin/true" }).create(),
      ),
    );

    expect(result._tag).toBe("Failure");
    expect(result._tag === "Failure" ? result.failure : undefined).toMatchObject({
      _tag: "BoxCliCommandError",
      boxId,
      detail: "machine provisioning failed",
    });
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
    ).rejects.toMatchObject({
      _tag: "BoxCliCommandError",
      detail: expect.stringMatching(/not authenticated/u),
    });
    await expect(
      withCli(malformed, "/bin/true", (cli) => cli.info(ownedBox)),
    ).rejects.toMatchObject({
      _tag: "BoxCliProtocolError",
      detail: expect.stringMatching(/invalid JSON/u),
    });
  });
});
