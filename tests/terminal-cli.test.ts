import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { LocalSessionHost } from "../src/main/vellum/term/local-host";
import { startTermControlServer } from "../src/main/vellum/term/control-server";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/vellum/process-identity";
import { setProcessEpochReaderForTests } from "../src/main/vellum/process-epoch";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";
import {
  TerminalSocket,
  TerminalSocketLive,
  type TerminalStreamFrame,
} from "../src/cli/core/terminal-socket";
import { renderTerminalStreamEnvelope } from "../src/cli/commands/terminal";
import { __resetVellumHomeCache } from "../src/shared/vellum-home";

const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  setProcessEpochReaderForTests({
    snapshot: () => [{
      pid: 91_001,
      processGroupId: 91_000,
      sessionId: 7,
      startKey: "synthetic-91001",
    }],
  });
  setProcessIdentityMapForTests(makeProcessIdentityMap());
});

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  delete process.env.VELLUM_HOME;
  __resetVellumHomeCache();
  setProcessEpochReaderForTests(undefined);
  setProcessIdentityMapForTests(undefined);
});

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("owner-local terminal CLI service", () => {
  it("uses the real Term UDS for create, attach, UTF-8 write, resize, and exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "vellum-terminal-cli-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    process.env.VELLUM_HOME = root;
    __resetVellumHomeCache();

    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: 91_001,
      echoWrites: "echo:",
      exitOnSignal: "SIGTERM",
    }));
    const host = new LocalSessionHost(fake.authority);
    cleanups.push(async () => {
      await host.shutdownAll("test");
    });
    const server = await startTermControlServer(host, { home: root });
    cleanups.push(() => server.close());

    const run = <A, E>(
      effect: Effect.Effect<A, E, TerminalSocket>,
    ): Promise<A> =>
      Effect.runPromise(effect.pipe(Effect.provide(TerminalSocketLive)));

    const created = await run(
      Effect.gen(function* () {
        const socket = yield* TerminalSocket;
        return yield* socket.create({
          bindingId: "cli-terminal",
          cols: 80,
          rows: 24,
        });
      }),
    );
    expect(created.status).toBe("running");

    const frames: TerminalStreamFrame[] = [];
    const attached = run(
      Effect.gen(function* () {
        const socket = yield* TerminalSocket;
        yield* socket.attach("cli-terminal", (frame) => {
          frames.push(frame);
        });
      }),
    );
    await waitFor(() => frames.some((frame) => frame.type === "attached"));

    await expect(
      run(
        Effect.gen(function* () {
          const socket = yield* TerminalSocket;
          return yield* socket.write("cli-terminal", "héllo\n");
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      run(
        Effect.gen(function* () {
          const socket = yield* TerminalSocket;
          return yield* socket.resize("cli-terminal", 101, 37);
        }),
      ),
    ).resolves.toBe(true);
    fake.controllers[0]?.exit(7);
    await attached;

    expect(frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "attached",
          bindingId: "cli-terminal",
          status: "running",
        }),
        expect.objectContaining({
          type: "output",
          data: "echo:héllo\n",
        }),
        expect.objectContaining({
          type: "resize",
          cols: 101,
          rows: 37,
        }),
        expect.objectContaining({
          type: "exit",
          code: 7,
        }),
      ]),
    );
    for (const frame of frames) {
      if ("seq" in frame) expect(frame.seq).toMatch(/^[0-9]+$/u);
    }
  });

  it("renders every attach frame as one JSON object without token or BigInt leakage", () => {
    const line = renderTerminalStreamEnvelope({
      type: "output",
      bindingId: "terminal-a",
      epoch: "epoch-a",
      seq: "42",
      data: "Olá",
    });
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({
      ok: true,
      command: "terminal attach",
      data: {
        type: "output",
        bindingId: "terminal-a",
        epoch: "epoch-a",
        seq: "42",
        data: "Olá",
      },
    });
    expect(line).not.toMatch(/token/u);
  });
});
