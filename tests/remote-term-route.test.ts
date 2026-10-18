/**
 * A machine whose record sets juntoHome runs its core there, so the terminal
 * route forwards that home's control socket and reads that home's token, with
 * no $HOME lookup. A juntoHome that is not already clean, or too long for a
 * forwarded socket, is refused before any SSH runs. A record without one keeps
 * the $HOME route.
 */
import * as Command from "effect/unstable/process/ChildProcess";
import { Effect, Scope } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostsSnapshot, setHostsSnapshot } from "../src/main/junto/hosts/snapshot";
import { createSshProgramCompiler } from "../src/main/junto/ssh/program";
import { SshTransport, type LocalForwardSocket } from "../src/main/junto/ssh/service";
import { LocalSessionHost } from "../src/main/junto/term/local-host";
import {
  configureTerminalRouterLayeredRunner,
  resetTerminalRouterLayeredRunnerForTests,
  TerminalRouter,
} from "../src/main/junto/term/router";
import { makeThisMachine } from "../src/shared/remote-hosts";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";

const initialHosts = hostsSnapshot();
const routers: TerminalRouter[] = [];
const localHosts: LocalSessionHost[] = [];
const TOKEN = "term-token-never-in-an-error";

afterEach(async () => {
  for (const router of routers.splice(0)) router.beginShutdown();
  for (const host of localHosts.splice(0)) await host.shutdownAll("test");
  setHostsSnapshot(initialHosts);
  resetTerminalRouterLayeredRunnerForTests();
});

const studio = (juntoHome?: string) => ({
  id: "studio",
  label: "Studio",
  isThisMachine: false as const,
  sshEndpoint: "studio.example",
  ...(juntoHome === undefined ? {} : { juntoHome }),
  capabilities: ["terminal" as const],
});

const lastArg = (command: Command.Command): string => {
  if (!Command.isStandardCommand(command)) throw new TypeError("expected StandardCommand");
  return command.args.at(-1)!;
};

/** A router over an SSH transport that records what each dial runs and forwards, in order. */
const dialing = (juntoHome?: string) => {
  const compiler = createSshProgramCompiler({
    controlDir: "/tmp/junto-term-route-test", envExecutable: "/usr/bin/env", sshExecutable: "/usr/bin/ssh", environment: {},
  });
  const calls: string[] = [];
  const transport = SshTransport.of({
    run: (program) => {
      const text = lastArg(compiler.oneShot(program).command);
      calls.push(`run ${text}`);
      return Effect.succeed({ stdout: text.includes("$HOME") ? "/home/op\n" : `${TOKEN}\n`, stderr: "" });
    },
    forward: (program) => {
      const request = compiler.forward(program, "0".repeat(32)).request;
      if (!Command.isStandardCommand(request)) throw new TypeError("expected StandardCommand");
      const spec = request.args[request.args.indexOf("-L") + 1]!;
      calls.push(`forward ${spec.slice(spec.indexOf(":") + 1)}`);
      return Effect.succeed({
        localSocket: "/tmp/junto-term-route-test/no-such-forward" as LocalForwardSocket,
        close: Effect.void,
        exitCode: Effect.never,
      });
    },
    transfer: () => Effect.die("no transfer"),
    connect: () => Effect.die("no link"),
    warm: () => Effect.void,
    teardown: () => Effect.void,
  });
  configureTerminalRouterLayeredRunner((effect) =>
    Effect.runPromise(effect.pipe(Effect.provideService(SshTransport, transport)) as Effect.Effect<never>));
  const local = new LocalSessionHost(
    makeFakeTerminalProcessAuthority(() => ({ pid: undefined, exitOnSignal: false })).authority,
    { killGraceMs: 5, shutdownGraceMs: 5, lateExitGraceMs: 5 },
  );
  const router = new TerminalRouter(local);
  localHosts.push(local);
  routers.push(router);
  setHostsSnapshot([makeThisMachine("workbench"), studio(juntoHome)]);
  const open = () => router.create({ bindingId: "remote-a", hostId: "studio" });
  return { router, calls, open };
};

const errorText = async (pending: Promise<unknown>): Promise<string> => {
  const error = await pending.then(() => undefined, (cause: unknown) => cause);
  expect(error).toBeDefined();
  return error instanceof Error ? error.message : String(error);
};

describe("the terminal route to a machine's Junto home", () => {
  it("forwards the record's juntoHome socket and reads its token there, with no $HOME lookup", async () => {
    const { calls, open } = dialing("/Users/op/preview");
    expect(await errorText(open())).not.toContain(TOKEN);
    expect(calls).toEqual([
      "forward /Users/op/preview/.junto/term/control.sock",
      "run '/bin/cat' '/Users/op/preview/.junto/term/token'",
    ]);
  });

  it("keeps the $HOME route for a record without juntoHome", async () => {
    const { calls, open } = dialing();
    await errorText(open());
    expect(calls).toEqual([
      `run printf '%s\\n' "$HOME"`,
      "forward /home/op/.junto/term/control.sock",
      "run '/bin/cat' '/home/op/.junto/term/token'",
    ]);
  });

  it.each([
    "/Users/op/../root",
    "/Users/op/./preview",
    "/Users/op/preview/",
    "//Users/op/preview",
    "/Users/op//preview",
  ])("refuses %s as written before any SSH runs", async (juntoHome) => {
    const { calls, open } = dialing(juntoHome);
    expect(await errorText(open())).toContain("Junto home must be a clean absolute path");
    expect(calls).toEqual([]);
  });

  it("refuses a home too long for a forwarded socket, never shortening it", async () => {
    const { calls, open } = dialing(`/Users/op/${"p".repeat(80)}`);
    expect(await errorText(open())).toContain("at most 103 UTF-8 bytes");
    expect(calls).toEqual([]);
  });

  it("drops a dialed pair when the record's juntoHome changes, and dials the new home", async () => {
    const { router, calls, open } = dialing("/Users/op/next");
    const client = {
      isLive: () => true,
      beginShutdown: vi.fn(),
      close: vi.fn(),
      drainOnQuit: vi.fn(async () => ({ clean: true, closeObserved: true, pendingRequests: 0, diagnostics: [] })),
      get: vi.fn(async () => undefined),
      create: vi.fn(async () => { throw new Error("the old home's pair was reused"); }),
    };
    // Dialed for the old home in this same snapshot generation: only the home differs.
    (router as unknown as { remotes: Map<string, unknown>; generation: number }).remotes.set("studio", {
      client,
      forward: {},
      endpoint: "studio.example",
      juntoHome: "/Users/op/previous",
      generation: (router as unknown as { generation: number }).generation,
      scope: Effect.runSync(Scope.make()),
      rootScope: Effect.runSync(Scope.make()),
      leaseMap: new Map(),
      reverseLease: new Map(),
    });
    expect(await errorText(open())).not.toContain("reused");
    expect(client.beginShutdown).toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled();
    expect(calls).toEqual([
      "forward /Users/op/next/.junto/term/control.sock",
      "run '/bin/cat' '/Users/op/next/.junto/term/token'",
    ]);
  });
});
