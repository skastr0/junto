/**
 * The terminal process over a real port with real PTYs (phase 1): a spawn
 * answers at once and its input follows it in order, output and the exit
 * come back, a size change reaches the child, a signal stops it, and an
 * exited terminal takes no more input or signal. A spawn the child refuses
 * arrives as an error and then an exit, and a lost terminal process exits
 * every terminal it held.
 */
import { Effect } from "effect";
import { RpcClient } from "effect/rpc";
import { clientProtocol } from "../src/shared/rpc-port";
import { TerminalRpcs } from "../src/contract/terminal/rpcs";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { TerminalLinkMessage, TerminalLinkPort } from "../src/contract/terminal/protocol";
import { serveTerminals, type SpawnPty } from "../src/terminal/serve";
import { terminalClient, type RemoteTerminal, type RemoteTerminalExit } from "../src/node/terminals/client";

const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
const realPty: SpawnPty = (command, args, options) => nodePty.spawn(command, [...args], options);

const portOf = (port: MessagePort): TerminalLinkPort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (message: TerminalLinkMessage) => handler(message);
    port.on("message", on);
    return () => port.off("message", on);
  },
});

const opened: MessagePort[] = [];
afterEach(() => {
  for (const port of opened.splice(0)) port.close();
});

const pair = (spawnPty: SpawnPty = realPty) => {
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  const served = serveTerminals(portOf(port2), spawnPty);
  return { client: terminalClient(portOf(port1)), served };
};

const record = (terminal: RemoteTerminal) => {
  let output = "";
  const errors: string[] = [];
  terminal.onData((data) => {
    output += data;
  });
  terminal.onError((error) => errors.push(error.message));
  const exit = new Promise<RemoteTerminalExit>((resolve) => terminal.onExit(resolve));
  return { output: () => output, errors, exit };
};

const until = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const env = { PATH: process.env.PATH, TERM: "xterm-256color" };

const settleTurn = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("the terminal process", () => {
  it("echoes input written before the pid is known, and reports the exit", async () => {
    const { client, served } = pair();
    const cat = client.spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24, env });
    const seen = record(cat);
    cat.write("typed before the pid\r");
    expect(await cat.pid).toBeGreaterThan(0);
    await until(() => seen.output().includes("typed before the pid"));
    cat.kill("SIGTERM");
    expect((await seen.exit).signal).toBe(15);
    expect(served.live()).toBe(0);
  });

  it("resizes the child", async () => {
    const { client } = pair();
    const shell = client.spawn({ command: "/bin/sh", args: ["-c", "read go; stty size"], cols: 80, rows: 24, env });
    const seen = record(shell);
    await shell.pid;
    shell.resize(132, 40);
    shell.write("go\r");
    await until(() => seen.output().includes("40 132"));
    expect((await seen.exit).code).toBe(0);
  });

  it("an exited terminal refuses input and ignores a signal", async () => {
    const { client } = pair();
    const echo = client.spawn({ command: "/bin/echo", args: ["done"], cols: 80, rows: 24, env });
    const seen = record(echo);
    expect((await seen.exit).code).toBe(0);
    const after = { errors: [] as string[] };
    // Listeners on an exited terminal are never called; the push names it.
    echo.onError((error) => after.errors.push(error.message));
    echo.write("too late");
    echo.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(after.errors).toEqual([]);
  });

  it("a kill after the child is reaped and before its exit is reported is dropped", async () => {
    let exit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    const kills: Array<string | undefined> = [];
    const reaped: SpawnPty = () => ({
      pid: 4242,
      onExit: (listener: typeof exit) => {
        exit = listener;
        return { dispose: () => undefined };
      },
      onData: () => ({ dispose: () => undefined }),
      kill: (signal?: string) => kills.push(signal),
      write: () => undefined,
      resize: () => undefined,
    }) as unknown as ReturnType<SpawnPty>;
    let alive = true;
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    serveTerminals(portOf(port2), reaped, {
      capture: async (pid) => ({ pid, startKey: "spawned" }),
      isCurrent: async () => alive,
    });
    const client = terminalClient(portOf(port1));
    const pty = client.spawn({ command: "/bin/true", args: [], cols: 80, rows: 24 });
    await pty.pid;
    pty.kill("SIGTERM");
    await until(() => kills.length === 1);
    // The child is reaped; node-pty has not reported the exit yet.
    alive = false;
    pty.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(kills).toEqual(["SIGTERM"]);
    exit?.({ exitCode: 0 });
  });

  it("a kill whose epoch check is still pending when the exit is reported is dropped", async () => {
    let exit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    const kills: Array<string | undefined> = [];
    const fake: SpawnPty = () => ({
      pid: 4243,
      onExit: (listener: typeof exit) => {
        exit = listener;
        return { dispose: () => undefined };
      },
      onData: () => ({ dispose: () => undefined }),
      kill: (signal?: string) => kills.push(signal),
      write: () => undefined,
      resize: () => undefined,
    }) as unknown as ReturnType<SpawnPty>;
    let answer: ((current: boolean) => void) | undefined;
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    serveTerminals(portOf(port2), fake, {
      capture: async (pid) => ({ pid, startKey: "spawned" }),
      isCurrent: () => new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
    });
    const client = terminalClient(portOf(port1));
    const pty = client.spawn({ command: "/bin/true", args: [], cols: 80, rows: 24 });
    await pty.pid;
    pty.kill("SIGTERM");
    await until(() => answer !== undefined);
    // The exit lands while ps is still answering; the answer then says current.
    exit?.({ exitCode: 0 });
    answer?.(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(kills).toEqual([]);
  });

  it("stops reading a PTY the core has fallen a megabyte behind on, and reads it again once the core catches up", async () => {
    let emit: ((data: string) => void) | undefined;
    const calls: string[] = [];
    const fake: SpawnPty = () => ({
      pid: 4244,
      onExit: () => ({ dispose: () => undefined }),
      onData: (listener: (data: string) => void) => {
        emit = listener;
        return { dispose: () => undefined };
      },
      pause: () => calls.push("pause"),
      resume: () => calls.push("resume"),
      kill: () => undefined,
      write: () => undefined,
      resize: () => undefined,
    }) as unknown as ReturnType<SpawnPty>;
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    serveTerminals(portOf(port2), fake, { capture: async () => undefined, isCurrent: async () => false });
    // A core that does not keep up: it answers the spawn and acknowledges nothing.
    const core = portOf(port1);
    void Effect.runPromise(Effect.scoped(
      RpcClient.make(TerminalRpcs).pipe(
        Effect.provideServiceEffect(RpcClient.Protocol, clientProtocol(core)),
        Effect.flatMap((calls) => calls.TerminalSpawn({ id: 1, command: "/bin/true", args: [], cols: 80, rows: 24 })),
      ),
    ));
    await until(() => emit !== undefined);
    const chunk = "x".repeat(64 * 1024);
    for (let i = 0; i < 16; i++) emit!(chunk);
    expect(calls).toEqual([]);
    emit!(chunk);
    expect(calls).toEqual(["pause"]);
    emit!(chunk);
    expect(calls).toEqual(["pause"]);
    core.post({ kind: "push", channel: "pty.ack", payload: { id: 1, chars: 12 * 64 * 1024 } });
    await settleTurn();
    expect(calls).toEqual(["pause"]);
    core.post({ kind: "push", channel: "pty.ack", payload: { id: 1, chars: 4 * 64 * 1024 } });
    await until(() => calls.length === 2);
    expect(calls).toEqual(["pause", "resume"]);
  });

  it("a core that keeps up acknowledges what it handled, so a fast stream is never paused", async () => {
    const calls: string[] = [];
    const spawnPty: SpawnPty = (command, args, options) => {
      const pty = realPty(command, args, options);
      const { pause, resume } = pty;
      pty.pause = () => {
        calls.push("pause");
        pause.call(pty);
      };
      pty.resume = () => {
        calls.push("resume");
        resume.call(pty);
      };
      return pty;
    };
    const { client } = pair(spawnPty);
    const flood = client.spawn({ command: "/bin/sh", args: ["-c", "head -c 4000000 /dev/zero | tr '\\0' x"], cols: 80, rows: 24, env });
    const seen = record(flood);
    expect((await seen.exit).code).toBe(0);
    expect(seen.output().replace(/[^x]/g, "").length).toBe(4_000_000);
    expect(calls.filter((call) => call === "pause").length).toBe(calls.filter((call) => call === "resume").length);
  });

  it("a refused spawn arrives as an error, then an exit", async () => {
    const refusing: SpawnPty = () => {
      throw new Error("posix_spawnp failed");
    };
    const { client } = pair(refusing);
    const refused = client.spawn({ command: "/no/such", args: [], cols: 80, rows: 24 });
    const seen = record(refused);
    await expect(refused.pid).rejects.toThrow(/posix_spawnp failed/);
    expect(await seen.exit).toEqual({ code: undefined, signal: undefined });
    expect(seen.errors).toEqual(["posix_spawnp failed"]);
  });

  /** A new core's port on the same terminal process. */
  const nextCore = (served: ReturnType<typeof serveTerminals>) => {
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    served.attach(portOf(port2));
    return terminalClient(portOf(port1));
  };

  const running = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("a core that is gone leaves its PTY running; the next core adopts it with its screen, and loses no output", async () => {
    const { client, served } = pair();
    const meta = { bindingId: "seat-a" };
    const shell = client.spawn({ command: "/bin/sh", args: ["-c", "printf before; sleep 0.3; printf during; exec cat"], cols: 80, rows: 24, env, meta });
    const seen = record(shell);
    const pid = (await shell.pid)!;
    await until(() => seen.output().includes("before"));
    await settleTurn();
    served.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(running(pid)).toBe(true);
    expect(served.live()).toBe(1);

    const next = nextCore(served);
    const [taken] = await Effect.runPromise(next.adopt());
    expect(taken!.meta).toEqual(meta);
    expect(taken!.adopted).toMatchObject({ pid, cols: 80, rows: 24, meta, seq: 1, history: "before" });
    expect(taken!.adopted.exit).toBeUndefined();
    const after = record(taken!.terminal);
    await until(() => after.output().includes("during"));
    taken!.terminal.write("typed after\r");
    await until(() => after.output().includes("typed after"));
    expect(after.output().match(/during/g)).toHaveLength(1);
    expect(after.output()).not.toContain("before");
    // A spawn on the new core does not take the adopted id.
    const other = next.spawn({ command: "/bin/echo", args: ["other"], cols: 80, rows: 24, env });
    expect(other.id).toBeGreaterThan(taken!.terminal.id);
    taken!.terminal.kill("SIGKILL");
    expect((await after.exit).signal).toBe(9);
  });

  it("an exit while no core is there is held, after its output, for the next one", async () => {
    const { client, served } = pair();
    const shell = client.spawn({ command: "/bin/sh", args: ["-c", "sleep 0.2; printf bye; exit 3"], cols: 80, rows: 24, env });
    const pid = (await shell.pid)!;
    served.close();
    await until(() => served.live() === 0);
    const next = nextCore(served);
    const [taken] = await Effect.runPromise(next.adopt());
    expect(taken!.adopted).toMatchObject({ pid, exit: { code: 3 } });
    const after = record(taken!.terminal);
    expect((await after.exit).code).toBe(3);
    expect(after.output()).toContain("bye");
    await settleTurn();
    expect(await Effect.runPromise(nextCore(served).adopt())).toEqual([]);
  });

  it("an exit posted to a core that died before its port closed is still named by the next adopt", async () => {
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    let dead = false;
    const dying = portOf(port2);
    const served = serveTerminals({ post: (message) => { if (!dead) dying.post(message); }, listen: dying.listen }, realPty);
    const client = terminalClient(portOf(port1));
    const shell = client.spawn({ command: "/bin/sh", args: ["-c", "sleep 0.2; exit 4"], cols: 80, rows: 24, env });
    const pid = (await shell.pid)!;
    // The core is gone, but its port has not closed: the exit is posted into nothing.
    dead = true;
    await until(() => served.live() === 0);
    await settleTurn();
    served.detach(dying);
    const next = nextCore(served);
    const [taken] = await Effect.runPromise(next.adopt());
    expect(taken!.adopted).toMatchObject({ pid, exit: { code: 4 } });
    expect((await record(taken!.terminal).exit).code).toBe(4);
    await settleTurn();
    expect(await Effect.runPromise(nextCore(served).adopt())).toEqual([]);
  });

  it("history keeps the newest handled output under its bound, cut on a chunk boundary", async () => {
    let emit: ((data: string) => void) | undefined;
    const fake: SpawnPty = () => ({
      pid: 4246,
      onExit: () => ({ dispose: () => undefined }),
      onData: (listener: (data: string) => void) => {
        emit = listener;
        return { dispose: () => undefined };
      },
      pause: () => undefined,
      resume: () => undefined,
      kill: () => undefined,
      write: () => undefined,
      resize: () => undefined,
    }) as unknown as ReturnType<SpawnPty>;
    const { client, served } = pair(fake);
    const terminal = client.spawn({ command: "/bin/true", args: [], cols: 80, rows: 24 });
    const seen = record(terminal);
    await terminal.pid;
    // 650 KiB handled against a 512 KiB bound: the first chunk goes, and so
    // must the whole second, since keeping part of it would cut mid-chunk.
    const chunks = ["a".repeat(100 * 1024), "b".repeat(450 * 1024), "c".repeat(100 * 1024)];
    for (const chunk of chunks) emit!(chunk);
    await until(() => seen.output().length === 650 * 1024);
    await settleTurn();
    served.close();
    const [taken] = await Effect.runPromise(nextCore(served).adopt());
    expect(taken!.adopted.seq).toBe(3);
    expect(taken!.adopted.history).toBe(chunks[2]);
  });

  it("with no core a PTY reads to the high mark and stops, and every chunk reaches the next core", async () => {
    let emit: ((data: string) => void) | undefined;
    const calls: string[] = [];
    const fake: SpawnPty = () => ({
      pid: 4245,
      onExit: () => ({ dispose: () => undefined }),
      onData: (listener: (data: string) => void) => {
        emit = listener;
        return { dispose: () => undefined };
      },
      pause: () => calls.push("pause"),
      resume: () => calls.push("resume"),
      kill: () => undefined,
      write: () => undefined,
      resize: () => undefined,
    }) as unknown as ReturnType<SpawnPty>;
    const { client, served } = pair(fake);
    await client.spawn({ command: "/bin/true", args: [], cols: 80, rows: 24 }).pid;
    served.close();
    const chunk = "x".repeat(64 * 1024);
    for (let i = 0; i < 17; i++) emit!(chunk);
    expect(calls).toEqual(["pause"]);
    const [taken] = await Effect.runPromise(nextCore(served).adopt());
    const after = record(taken!.terminal);
    await until(() => after.output().length === 17 * chunk.length);
    await until(() => calls.length === 2);
    expect(calls).toEqual(["pause", "resume"]);
  });

  it("an adopt the terminal process never answers fails tagged when it is lost", async () => {
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    const orphan = terminalClient(portOf(port1));
    const asked = Effect.runPromise(orphan.adopt());
    orphan.fail("the terminal process exited");
    await expect(asked).rejects.toMatchObject({ _tag: "TerminalAdoptFailed", message: "the terminal process exited" });
  });

  it("an orderly quit hangs up every PTY", async () => {
    const { client, served } = pair();
    const cat = client.spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24, env });
    const seen = record(cat);
    await cat.pid;
    client.hangupAll();
    expect((await seen.exit).signal).toBe(1);
    expect(served.live()).toBe(0);
  });

  it("a lost terminal process exits every terminal it held", async () => {
    const { client } = pair();
    const cat = client.spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24, env });
    const seen = record(cat);
    await cat.pid;
    client.fail("the terminal process exited");
    expect(await seen.exit).toEqual({ code: undefined, signal: undefined });
    expect(seen.errors).toEqual(["the terminal process exited"]);
    cat.kill("SIGKILL");
  });
});
