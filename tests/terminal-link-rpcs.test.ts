/**
 * The terminal link's calls (src/contract/terminal/rpcs.ts) over a real
 * MessageChannel: the terminal process decodes what the core asks, closed,
 * so a payload of the wrong shape is refused at its edge and never reaches a
 * spawn; the core decodes the answer; a core of another link version adopts
 * nothing and leaves the PTYs running; a command posted before its spawn
 * reaches the terminal process waits for it, and one for a refused spawn goes
 * with the refusal.
 */
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { Effect, Exit } from "effect";
import { RpcClient, type RpcClientError, type RpcGroup } from "effect/rpc";
import { afterEach, describe, expect, it } from "vitest";
import { clientProtocol } from "../src/shared/rpc-port";
import { TerminalInbound, type TerminalLinkMessage, type TerminalLinkPort } from "../src/contract/terminal/protocol";
import { TERMINAL_LINK_VERSION, TerminalRpcs } from "../src/contract/terminal/rpcs";
import { serveTerminals, type SpawnPty } from "../src/terminal/serve";

const opened: MessagePort[] = [];
afterEach(() => {
  for (const port of opened.splice(0)) port.close();
});

const linkOf = (port: MessagePort): TerminalLinkPort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (message: TerminalLinkMessage) => handler(message);
    port.on("message", on);
    return () => port.off("message", on);
  },
});

/** A PTY that records what reached it and never runs anything. */
const recordingPty = () => {
  const spawned: string[] = [];
  const written: string[] = [];
  const spawnPty: SpawnPty = (command) => {
    if (command === "/refused") throw new Error("posix_spawnp failed");
    spawned.push(command);
    return {
      pid: 4242,
      onExit: () => ({ dispose: () => undefined }),
      onData: () => ({ dispose: () => undefined }),
      write: (data: string) => written.push(data),
      resize: () => undefined,
      kill: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
    } as unknown as ReturnType<SpawnPty>;
  };
  return { spawned, written, spawnPty };
};

const link = (spawnPty: SpawnPty) => {
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  serveTerminals(linkOf(port2), spawnPty, { capture: async () => undefined, isCurrent: async () => false });
  return linkOf(port1);
};

type Calls = RpcClient.RpcClient<RpcGroup.Rpcs<typeof TerminalRpcs>, RpcClientError.RpcClientError>;

/** One call on a fresh client of the group, in its own scope. */
const ask = <A, E>(core: TerminalLinkPort, call: (calls: Calls) => Effect.Effect<A, E>) =>
  Effect.runPromiseExit(Effect.scoped(
    RpcClient.make(TerminalRpcs).pipe(
      Effect.provideServiceEffect(RpcClient.Protocol, clientProtocol(core)),
      Effect.flatMap(call),
    ),
  ));

const until = async (check: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("the terminal link's calls", () => {
  it("answers a spawn with its pid, decoded on the core's side", async () => {
    const pty = recordingPty();
    const exit = await ask(link(pty.spawnPty), (calls) => calls.TerminalSpawn({ id: 1, command: "/bin/cat", args: [], cols: 80, rows: 24 }));
    expect(exit).toEqual(Exit.succeed({ pid: 4242 }));
    expect(pty.spawned).toEqual(["/bin/cat"]);
  });

  it("refuses a spawn of the wrong shape at the terminal process's edge, and spawns nothing", async () => {
    const pty = recordingPty();
    const core = link(pty.spawnPty);
    // What a core from a drifted build would post: cols as text, and a field the contract does not name.
    const malformed = { id: 1, command: "/bin/cat", args: [], cols: "80", rows: 24, shell: true } as never;
    const exit = await ask(core, (calls) => calls.TerminalSpawn(malformed));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(pty.spawned).toEqual([]);
  });

  it("answers a refused spawn with the tagged refusal", async () => {
    const exit = await ask(link(recordingPty().spawnPty), (calls) => calls.TerminalSpawn({ id: 1, command: "/refused", args: [], cols: 80, rows: 24 }));
    expect(exit).toMatchObject({ _tag: "Failure" });
    expect(JSON.stringify(exit)).toContain("TerminalSpawnRefused");
    expect(JSON.stringify(exit)).toContain("posix_spawnp failed");
  });

  it("refuses an adoption from another link version, and keeps the PTY", async () => {
    const pty = recordingPty();
    const core = link(pty.spawnPty);
    await ask(core, (calls) => calls.TerminalSpawn({ id: 7, command: "/bin/cat", args: [], cols: 80, rows: 24 }));
    const refused = await ask(core, (calls) => calls.TerminalAdopt({ version: TERMINAL_LINK_VERSION + 1 }));
    expect(JSON.stringify(refused)).toContain("TerminalLinkVersionMismatch");
    const adopted = await ask(core, (calls) => calls.TerminalAdopt({ version: TERMINAL_LINK_VERSION }));
    expect(adopted).toMatchObject({ _tag: "Success", value: { version: TERMINAL_LINK_VERSION, nextId: 8, terminals: [{ id: 7, pid: 4242 }] } });
  });

  it("holds a write posted before its spawn, and drops one whose spawn was refused", async () => {
    const pty = recordingPty();
    const core = link(pty.spawnPty);
    core.post({ kind: "push", channel: TerminalInbound.write, payload: { id: 1, data: "before the spawn" } });
    core.post({ kind: "push", channel: TerminalInbound.write, payload: { id: 2, data: "for a refused spawn" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pty.written).toEqual([]);
    await ask(core, (calls) => calls.TerminalSpawn({ id: 2, command: "/refused", args: [], cols: 80, rows: 24 }));
    await ask(core, (calls) => calls.TerminalSpawn({ id: 1, command: "/bin/cat", args: [], cols: 80, rows: 24 }));
    await until(() => pty.written.length > 0);
    expect(pty.written).toEqual(["before the spawn"]);
  });

  it("after an adoption, holds nothing for an id below the next one it named, since no core spawns it again", async () => {
    const pty = recordingPty();
    const core = link(pty.spawnPty);
    await ask(core, (calls) => calls.TerminalSpawn({ id: 5, command: "/bin/cat", args: [], cols: 80, rows: 24 }));
    const adopted = await ask(core, (calls) => calls.TerminalAdopt({ version: TERMINAL_LINK_VERSION }));
    expect(adopted).toMatchObject({ _tag: "Success", value: { nextId: 6 } });
    // Id 3 was never spawned here and is below 6: it is not held.
    const errors: unknown[] = [];
    core.listen((message) => {
      if (message.kind === "push" && message.channel === "pty.error") errors.push(message.payload);
    });
    core.post({ kind: "push", channel: TerminalInbound.write, payload: { id: 3, data: "for an id no core spawns" } });
    await until(() => errors.length > 0);
    expect(errors).toEqual([{ id: 3, message: "terminal process already exited" }]);
    // Id 6 may still be spawned: its write waits for it.
    core.post({ kind: "push", channel: TerminalInbound.write, payload: { id: 6, data: "for the next spawn" } });
    await ask(core, (calls) => calls.TerminalSpawn({ id: 6, command: "/bin/cat", args: [], cols: 80, rows: 24 }));
    await until(() => pty.written.length > 0);
    expect(pty.written).toEqual(["for the next spawn"]);
  });
});
