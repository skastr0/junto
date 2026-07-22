import { describe, expect, it, afterEach, vi } from "vitest";
import {
  LocalSessionHost,
  classifyTermKillTarget,
  clearTermKillAuditLog,
  getTermKillAuditLog,
  type TermChild,
  type TermSpawnFn,
} from "../src/main/vellum/term/local-host";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/vellum/process-identity";

const hosts: LocalSessionHost[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const h of hosts.splice(0)) {
    await h.shutdownAll("test_cleanup");
  }
  setProcessIdentityMapForTests(undefined);
  clearTermKillAuditLog();
  vi.restoreAllMocks();
});

const fakeSpawn = (opts?: {
  readonly output?: string;
  readonly exitCode?: number;
  readonly exitDelayMs?: number;
  readonly pid?: number;
}): TermSpawnFn => {
  return () => {
    const dataListeners = new Set<(d: string) => void>();
    const exitListeners = new Set<(c: number | undefined, s: number | undefined) => void>();
    let alive = true;
    const child: TermChild = {
      pid: opts?.pid ?? 4242,
      write(_data: string) {
        /* noop */
      },
      resize() {
        /* noop */
      },
      kill() {
        if (!alive) return;
        alive = false;
        for (const l of exitListeners) l(0, undefined);
      },
      onData(listener) {
        dataListeners.add(listener);
      },
      onExit(listener) {
        exitListeners.add(listener);
      },
    };
    queueMicrotask(() => {
      if (opts?.output) {
        for (const l of dataListeners) l(opts.output!);
      }
      const delay = opts?.exitDelayMs ?? 5;
      setTimeout(() => {
        if (!alive) return;
        alive = false;
        for (const l of exitListeners) l(opts?.exitCode ?? 0, undefined);
      }, delay);
    });
    return child;
  };
};

describe("LocalSessionHost", () => {
  it("spawns, emits output, exits", async () => {
    const host = new LocalSessionHost(
      fakeSpawn({ output: "vellum-pty-ok\n", exitDelayMs: 10 }),
    );
    hosts.push(host);
    const outputs: string[] = [];
    host.on("event", (ev) => {
      if (ev.type === "output") outputs.push(ev.data);
    });

    const summary = host.create({
      bindingId: "bind-test-1",
      launch: { kind: "command", argv: ["/bin/echo", "vellum-pty-ok"] },
      cols: 80,
      rows: 24,
      canvasName: "main",
      nodeId: "n1",
    });
    expect(summary.bindingId).toBe("bind-test-1");
    expect(summary.detached).toBe(false);
    expect(summary.pid).toBe(4242);

    await new Promise<void>((resolve) => {
      const t = setTimeout(() => resolve(), 500);
      host.on("event", (ev) => {
        if (ev.type === "exit" && ev.bindingId === "bind-test-1") {
          clearTimeout(t);
          resolve();
        }
      });
    });

    expect(outputs.join("")).toContain("vellum-pty-ok");
    expect(host.get("bind-test-1")?.status).toBe("exited");
  });

  it("enforces single control lease without takeover", async () => {
    const host = new LocalSessionHost(
      fakeSpawn({ exitDelayMs: 5000 }),
    );
    hosts.push(host);
    host.create({
      bindingId: "bind-lease",
      launch: { kind: "command", argv: ["/bin/sleep", "30"] },
    });
    const a = host.attach({ bindingId: "bind-lease", mode: "control" });
    expect(a.ok).toBe(true);
    const b = host.attach({ bindingId: "bind-lease", mode: "control" });
    expect(b.ok).toBe(false);
    const c = host.attach({ bindingId: "bind-lease", mode: "control", takeover: true });
    expect(c.ok).toBe(true);
    if (a.ok) host.release(a.lease);
    await host.shutdownAll();
    expect(host.runningCount()).toBe(0);
  });

  it("marks detached when canvas binding cleared", () => {
    const host = new LocalSessionHost(fakeSpawn({ exitDelayMs: 5000 }));
    hosts.push(host);
    host.create({
      bindingId: "bind-det",
      launch: { kind: "command", argv: ["/bin/sleep", "30"] },
      canvasName: "c",
      nodeId: "n",
    });
    expect(host.get("bind-det")?.detached).toBe(false);
    host.bindCanvas("bind-det", null);
    expect(host.get("bind-det")?.detached).toBe(true);
    expect(host.detachedRunning().some((s) => s.bindingId === "bind-det")).toBe(true);
  });

  it("process-binds an anchored session and unbinds it on exit", async () => {
    const identities = makeProcessIdentityMap();
    setProcessIdentityMapForTests(identities);
    // Identity bind requires a live OS pid (startKey probe). process.pid is OK
    // here ONLY because forceKill is sealed: it refuses OS kill on self and
    // uses the fake child.kill handle instead of process.kill(-self).
    const host = new LocalSessionHost(fakeSpawn({ pid: process.pid, exitDelayMs: 20 }));
    hosts.push(host);
    host.create({ bindingId: "bind-process", canvasName: "main", nodeId: "term-node" });
    expect(identities.resolve(process.pid)).toMatchObject({
      kind: "terminal",
      bindingId: "bind-process",
      canvasName: "main",
      nodeId: "term-node",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(identities.resolve(process.pid)).toBeUndefined();
  });

  it("shutdownAll stops running sessions", async () => {
    const host = new LocalSessionHost(fakeSpawn({ exitDelayMs: 60_000 }));
    hosts.push(host);
    host.create({
      bindingId: "bind-quit",
      launch: { kind: "command", argv: ["/bin/sleep", "60"] },
    });
    expect(host.runningCount()).toBe(1);
    const result = await host.shutdownAll("test");
    expect(result).toEqual({ clean: true, stragglers: [] });
    expect(host.runningCount()).toBe(0);
  });

  it.each(["listener", "bind"] as const)(
    "retains post-spawn authority when a %s step throws",
    async (failureAt) => {
      const signals: NodeJS.Signals[] = [];
      const exitListeners = new Set<
        (code: number | undefined, signal: number | undefined) => void
      >();
      let exited = false;
      const spawn: TermSpawnFn = () => ({
        pid: 80_500,
        write() {},
        kill(signal = "SIGTERM") {
          signals.push(signal);
        },
        onData() {},
        onExit(listener) {
          exitListeners.add(listener);
        },
      });
      const host = new LocalSessionHost(spawn, {
        killGraceMs: 2,
        shutdownGraceMs: 6,
        lateExitGraceMs: 6,
      });
      hosts.push(host);
      if (failureAt === "listener") {
        host.on("event", (event) => {
          if (event.type === "session" && event.status === "running") {
            throw new Error("running listener failed");
          }
        });
      } else {
        const identities = makeProcessIdentityMap();
        setProcessIdentityMapForTests({
          ...identities,
          bind: () => {
            throw new Error("identity bind failed");
          },
        });
      }
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const created = host.create({
        bindingId: `post-spawn-${failureAt}`,
        canvasName: "main",
        nodeId: "term-node",
      });

      expect(created.status).toBe("running");
      expect(host.runningCount()).toBe(1);
      expect(signals[0]).toBe("SIGTERM");
      const result = await host.shutdownAll(`post-spawn-${failureAt}`);
      expect(result.clean).toBe(false);
      expect(host.runningCount()).toBe(1);

      if (!exited) {
        exited = true;
        for (const listener of exitListeners) listener(0, undefined);
      }
      expect(host.runningCount()).toBe(0);
      expect(host.get(`post-spawn-${failureAt}`)?.status).toBe("exited");
      expect(error).toHaveBeenCalled();
    },
  );

  it("escalates a superseded exact generation and ignores its late exit", async () => {
    const children: Array<{
      readonly pid: number;
      readonly signals: NodeJS.Signals[];
      exit(): void;
    }> = [];
    const spawn: TermSpawnFn = () => {
      const exitListeners = new Set<(c: number | undefined, s: number | undefined) => void>();
      let exited = false;
      const controller = {
        pid: 81_000 + children.length,
        signals: [] as NodeJS.Signals[],
        exit() {
          if (exited) return;
          exited = true;
          for (const listener of exitListeners) listener(0, undefined);
        },
      };
      children.push(controller);
      return {
        pid: controller.pid,
        write() {},
        kill(signal = "SIGTERM") {
          controller.signals.push(signal);
          // Deliberately resist both signals until the test emits a late exit.
        },
        onData() {},
        onExit(listener) {
          exitListeners.add(listener);
        },
      };
    };
    const host = new LocalSessionHost(spawn, {
      killGraceMs: 5,
      shutdownGraceMs: 20,
      lateExitGraceMs: 20,
    });
    hosts.push(host);
    const visibleExits: string[] = [];
    host.on("event", (event) => {
      if (event.type === "exit") visibleExits.push(event.epoch);
    });

    const old = host.create({ bindingId: "replace-me" });
    const replacement = host.create({ bindingId: "replace-me" });
    expect(host.runningCount()).toBe(2);
    expect(host.get("replace-me")?.epoch).toBe(replacement.epoch);

    await vi.waitFor(() => {
      expect(children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    });
    children[0]?.exit();

    expect(host.runningCount()).toBe(1);
    expect(host.get("replace-me")).toMatchObject({
      epoch: replacement.epoch,
      status: "running",
    });
    expect(visibleExits).not.toContain(old.epoch);
    children[1]?.exit();
    expect(host.runningCount()).toBe(0);
  });

  it("continues when the final owned child exits inside the bounded late window", async () => {
    vi.useFakeTimers();
    const signals: NodeJS.Signals[] = [];
    let emitExit: (() => void) | undefined;
    const spawn: TermSpawnFn = () => {
      const exitListeners = new Set<(c: number | undefined, s: number | undefined) => void>();
      emitExit = () => {
        for (const listener of exitListeners) listener(0, undefined);
      };
      return {
        pid: 81_500,
        write() {},
        kill(signal = "SIGTERM") {
          signals.push(signal);
        },
        onData() {},
        onExit(listener) {
          exitListeners.add(listener);
        },
      };
    };
    const host = new LocalSessionHost(spawn, {
      killGraceMs: 5,
      shutdownGraceMs: 10,
      lateExitGraceMs: 30,
    });
    hosts.push(host);
    host.create({ bindingId: "late-but-bounded" });

    let settled = false;
    const shutdown = host.shutdownAll("late-window").then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(settled).toBe(false);
    expect(signals).toContain("SIGKILL");

    emitExit?.();
    await expect(shutdown).resolves.toEqual({ clean: true, stragglers: [] });
    expect(vi.getTimerCount()).toBe(0);
    expect(host.runningCount()).toBe(0);
    vi.useRealTimers();
  });

  it("reports a TERM- and KILL-resistant child as an unclean shutdown", async () => {
    vi.useFakeTimers();
    const signals: NodeJS.Signals[] = [];
    let emitExit: (() => void) | undefined;
    const spawn: TermSpawnFn = () => {
      const exitListeners = new Set<(c: number | undefined, s: number | undefined) => void>();
      emitExit = () => {
        for (const listener of exitListeners) listener(0, undefined);
      };
      return {
        pid: 82_001,
        write() {},
        kill(signal = "SIGTERM") {
          signals.push(signal);
        },
        onData() {},
        onExit(listener) {
          exitListeners.add(listener);
        },
      };
    };
    const host = new LocalSessionHost(spawn, {
      killGraceMs: 2,
      shutdownGraceMs: 8,
      lateExitGraceMs: 8,
    });
    hosts.push(host);
    host.create({ bindingId: "stubborn" });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const shutdown = host.shutdownAll("stubborn-test");
    await vi.advanceTimersByTimeAsync(24);
    const result = await shutdown;

    expect(result.clean).toBe(false);
    if (!result.clean) {
      expect(result.stragglers).toHaveLength(1);
      expect(result.stragglers[0]).toMatchObject({
        bindingId: "stubborn",
        status: "running",
        pid: 82_001,
      });
    }
    expect(signals[0]).toBe("SIGTERM");
    expect(signals).toContain("SIGKILL");
    expect(host.runningCount()).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("retained 1 local terminal"));

    const stubbornExit = emitExit;
    expect(() => host.create({ bindingId: "recovery" })).not.toThrow();
    const recoveryExit = emitExit;
    stubbornExit?.();
    recoveryExit?.();
    expect(host.runningCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    error.mockRestore();
  });

  it("makes a retained killed generation strictly noninteractive", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<
      (code: number | undefined, signal: number | undefined) => void
    >();
    const spawn: TermSpawnFn = () => ({
      pid: 82_500,
      write(data) {
        writes.push(data);
      },
      resize() {},
      kill() {
        // Deliberately retained beyond the bounded shutdown.
      },
      onData(listener) {
        dataListeners.add(listener);
      },
      onExit(listener) {
        exitListeners.add(listener);
      },
    });
    const host = new LocalSessionHost(spawn, {
      killGraceMs: 2,
      shutdownGraceMs: 8,
      lateExitGraceMs: 8,
    });
    hosts.push(host);
    const outputs: string[] = [];
    host.on("event", (event) => {
      if (event.type === "output") outputs.push(event.data);
    });
    host.create({ bindingId: "retained-noninteractive" });
    const attached = host.attach({
      bindingId: "retained-noninteractive",
      mode: "control",
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const shutdown = host.shutdownAll("noninteractive-test");
    await vi.advanceTimersByTimeAsync(24);
    await expect(shutdown).resolves.toMatchObject({ clean: false });

    expect(host.write(attached.lease, "must-not-write")).toBe(false);
    expect(host.resize(attached.lease, 90, 30)).toBe(false);
    expect(host.attach({ bindingId: "retained-noninteractive", mode: "control" }))
      .toEqual({ ok: false, message: "session interaction revoked during stop" });
    expect(host.attach({ bindingId: "retained-noninteractive", mode: "observe" }))
      .toEqual({ ok: false, message: "session interaction revoked during stop" });
    for (const listener of dataListeners) listener("ignored-after-stop");
    expect(writes).toEqual([]);
    expect(outputs).toEqual([]);

    for (const listener of exitListeners) listener(0, undefined);
    expect(host.runningCount()).toBe(0);
    vi.useRealTimers();
    error.mockRestore();
  });

  it("write requires control lease", () => {
    const writes: string[] = [];
    const spawn: TermSpawnFn = () => {
      const dataListeners = new Set<(d: string) => void>();
      const exitListeners = new Set<(c: number | undefined, s: number | undefined) => void>();
      return {
        // NEVER pid 1 — forceKill historically did process.kill(-1) = host-wide blast.
        pid: 77_001,
        write(d) {
          writes.push(d);
        },
        kill() {
          for (const l of exitListeners) l(0, undefined);
        },
        onData(l) {
          dataListeners.add(l);
        },
        onExit(l) {
          exitListeners.add(l);
        },
      };
    };
    const host = new LocalSessionHost(spawn);
    hosts.push(host);
    host.create({ bindingId: "w1", launch: { kind: "shell" } });
    const obs = host.attach({ bindingId: "w1", mode: "observe" });
    expect(obs.ok).toBe(true);
    if (obs.ok) {
      expect(host.write(obs.lease, "nope")).toBe(false);
    }
    const ctl = host.attach({ bindingId: "w1", mode: "control" });
    expect(ctl.ok).toBe(true);
    if (ctl.ok) {
      expect(host.write(ctl.lease, "yes\n")).toBe(true);
    }
    expect(writes).toEqual(["yes\n"]);
  });

  it("classifyTermKillTarget refuses init/self/parent (the historical blast radii)", () => {
    expect(classifyTermKillTarget({ pid: 1 }).allowed).toBe(false);
    expect(classifyTermKillTarget({ pid: process.pid }).allowed).toBe(false);
    if (typeof process.ppid === "number") {
      expect(classifyTermKillTarget({ pid: process.ppid }).allowed).toBe(false);
    }
    expect(classifyTermKillTarget({ pid: -1 }).allowed).toBe(false);
    expect(classifyTermKillTarget({ pid: 0 }).allowed).toBe(false);
    expect(classifyTermKillTarget({ pid: 4242 }).allowed).toBe(true);
  });

  it("shutdownAll on a session with fake pid=self never process-group-kills (audit)", async () => {
    clearTermKillAuditLog();
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    // Intentionally dangerous fake pid — registration refused; child.kill only.
    const host = new LocalSessionHost(fakeSpawn({ pid: process.pid, exitDelayMs: 60_000 }));
    hosts.push(host);
    host.create({ bindingId: "bind-self-pid" });
    await host.shutdownAll("probe-self-pid");
    const audit = getTermKillAuditLog();
    // Local terminal authority contains no pid, so self cannot become group authority.
    expect(audit.some((a) => a.requestedGroup)).toBe(false);
    // No OS process.kill at all for this session.
    expect(spy).not.toHaveBeenCalled();
    expect(host.runningCount()).toBe(0);
    spy.mockRestore();
  });
});
