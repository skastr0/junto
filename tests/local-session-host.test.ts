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
  for (const h of hosts.splice(0)) {
    await h.shutdownAll("test_cleanup");
  }
  setProcessIdentityMapForTests(undefined);
  clearTermKillAuditLog();
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
    await host.shutdownAll("test");
    expect(host.runningCount()).toBe(0);
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
