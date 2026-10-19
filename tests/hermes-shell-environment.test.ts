import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeThisMachine } from "../src/shared/remote-hosts";
import { setHostsSnapshot } from "../src/main/junto/hosts/snapshot";
import { HermesPlane, HermesPlaneLive } from "../src/main/junto/hermes/plane";
import { HermesTransport } from "../src/main/junto/hermes/transport";
import type { ToolResult } from "../src/main/junto/region-env/tool";
import { THIS_MACHINE } from "./support/machines";

// A local Hermes session starts with the operator's shell environment: it
// waits for the first read, and reads again first after a startup file
// changed. The shell is scripted, the clock is a counter.

const shell = vi.hoisted(() => ({
  pending: [] as Array<(result: unknown) => void>,
  reads: 0,
  mtimes: new Map<string, number>(),
  clock: 1_000,
}));

const spawned = vi.hoisted(() => [] as Array<NodeJS.ProcessEnv | undefined>);

// The plane is frozen; a stand-in that records the spawn and stops there.
vi.mock("../src/main/junto/app-process-plane", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/main/junto/app-process-plane")>();
  const plane = Object.create(actual.appProcessPlane) as typeof actual.appProcessPlane;
  Object.defineProperty(plane, "spawnChild", {
    value: (spec: { readonly env?: NodeJS.ProcessEnv }) => {
      spawned.push(spec.env);
      throw new Error("spawn stopped by the test");
    },
  });
  return { ...actual, appProcessPlane: plane };
});

vi.mock("../src/main/junto/shell-environment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/main/junto/shell-environment")>();
  return {
    ...actual,
    shellEnvironment: actual.makeShellEnvironment({
      runTool: () => {
        shell.reads += 1;
        return new Promise((resolve) => shell.pending.push(resolve as (result: unknown) => void));
      },
      target: { PATH: "/usr/bin:/bin" },
      home: () => "/home/t",
      now: () => (shell.clock += 5),
      shell: () => "/bin/zsh",
      turnedOff: () => false,
      cwd: async () => "/app/.junto",
      mtimeMs: async (path) => shell.mtimes.get(path),
    }),
  };
});

const dump = (variables: Readonly<Record<string, string>>): ToolResult => ({
  kind: "ok",
  stdout: `JUNTO_ENV_BEGIN\n${Object.entries(variables).map(([k, v]) => `${k}=${v}\0`).join("")}JUNTO_ENV_END\n`,
});

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 200; turn += 1) await Promise.resolve();
};

const answer = async (result: ToolResult): Promise<void> => {
  await flush();
  const next = shell.pending.shift();
  if (!next) throw new Error("no shell read is waiting");
  next(result);
  await flush();
};

const transport = Layer.succeed(HermesTransport, HermesTransport.of({
  profiles: () => Effect.succeed({ ok: true, stdout: "" }),
  version: () => Effect.succeed({ ok: true, stdout: "Hermes Agent v0.18.2" }),
  connectAcp: () => Effect.die("unexpected remote ACP connection"),
}));

const withPlane = <A>(use: (plane: typeof HermesPlane.Service) => Promise<A>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const plane = yield* HermesPlane;
      return yield* Effect.promise(() => use(plane));
    }).pipe(Effect.provide(Layer.provide(HermesPlaneLive, transport)), Effect.scoped),
  );

beforeEach(() => {
  setHostsSnapshot([makeThisMachine(THIS_MACHINE, { hermesId: "fleet" })]);
  spawned.length = 0;
});

afterEach(() => {
  setHostsSnapshot([]);
});

describe("a local Hermes session and the shell environment", () => {
  it("waits for the first read, then reads again after a startup file changed", async () => {
    await withPlane(async (plane) => {
      const first = plane.fetchAgentMessage("fleet:default", "hello");
      await flush();
      // The shell is still being read: nothing has spawned.
      expect(shell.reads).toBe(1);
      expect(spawned).toHaveLength(0);
      await answer(dump({ PATH: "/shell/bin:/usr/bin", FROM_RC: "one" }));
      await first;
      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.FROM_RC).toBe("one");
      expect(spawned[0]?.PATH?.split(":")[0]).toBe("/shell/bin");

      // Unchanged startup files: the next session reads nothing.
      await plane.fetchAgentMessage("fleet:default", "again");
      expect(shell.reads).toBe(1);
      expect(spawned).toHaveLength(2);

      // The operator edits .zshrc: the next session reads again first.
      shell.mtimes.set("/home/t/.zshrc", shell.clock + 1);
      const third = plane.fetchAgentMessage("fleet:default", "after the edit");
      await flush();
      expect(shell.reads).toBe(2);
      expect(spawned).toHaveLength(2);
      await answer(dump({ PATH: "/shell/bin:/usr/bin", FROM_RC: "two" }));
      await third;
      expect(spawned).toHaveLength(3);
      expect(spawned[2]?.FROM_RC).toBe("two");
    });
  });
});
