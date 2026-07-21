import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrServiceMap } from "../src/main/vellum/herdr/service-map";

describe("HerdrServiceMap worker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("intent probe resolves ports via batched lsof and composes local url", async () => {
    const seenArgv: string[][] = [];
    const shell = async (
      _hostId: string,
      argv: ReadonlyArray<string>,
    ): Promise<{ ok: boolean; stdout: string }> => {
      seenArgv.push([...argv]);
      return {
        ok: true,
        stdout: "node 42 me 1u IPv4 0t0 TCP *:5173 (LISTEN)\n",
      };
    };
    const map = new HerdrServiceMap({
      shell,
      batchPerTick: 2,
      tickIntervalMs: 60_000,
      now: () => 1_000_000,
    });

    const pending = map.requestProbe({
      hostId: "local",
      paneId: "w1:p1",
      processes: [{ name: "node", cmdline: "vite", pid: 42 }],
      priority: "intent",
    });
    expect(pending.health).toBe("pending");

    await map.drainHostNow("local");
    const live = map.get("local", null, "w1:p1");
    expect(live?.health).toBe("live");
    expect(live?.url).toBe("http://127.0.0.1:5173");
    expect(seenArgv).toHaveLength(1);
    expect(seenArgv[0]?.join(" ")).toContain("42");
    map.stop();
  });

  it("skips shells without calling shell", async () => {
    const shell = vi.fn(async () => ({ ok: true, stdout: "" }));
    const map = new HerdrServiceMap({ shell, now: () => 1 });
    map.observeProcesses({
      hostId: "local",
      paneId: "w1:p2",
      processes: [{ name: "zsh", cmdline: "-zsh", pid: 9 }],
    });
    await map.drainHostNow("local");
    expect(shell).not.toHaveBeenCalled();
    expect(map.get("local", null, "w1:p2")?.health).toBe("skipped");
    map.stop();
  });

  it("observeProcesses(undefined) does not wipe live projection", async () => {
    const shell = async () => ({
      ok: true,
      stdout: "node 42 me 1u IPv4 0t0 TCP *:5173 (LISTEN)\n",
    });
    const map = new HerdrServiceMap({ shell, now: () => 1_000 });
    map.requestProbe({
      hostId: "local",
      paneId: "w1:p1",
      processes: [{ name: "node", cmdline: "vite", pid: 42 }],
      priority: "intent",
    });
    await map.drainHostNow("local");
    expect(map.get("local", null, "w1:p1")?.health).toBe("live");

    // Mirror-fresh getMeta path omits processes — must not clobber.
    map.observeProcesses({
      hostId: "local",
      paneId: "w1:p1",
      processes: undefined,
    });
    expect(map.get("local", null, "w1:p1")?.health).toBe("live");
    expect(map.get("local", null, "w1:p1")?.url).toBe("http://127.0.0.1:5173");
    map.stop();
  });

  it("rate-limits ambient batch across multiple panes", async () => {
    let shellCalls = 0;
    const shell = vi.fn(async (_h: string, argv: ReadonlyArray<string>) => {
      shellCalls += 1;
      const p = argv[argv.length - 1] ?? "";
      const pid = p.split(",")[0] ?? "1";
      return {
        ok: true,
        stdout: `node ${pid} me 1u IPv4 0t0 TCP *:3000 (LISTEN)\n`,
      };
    });
    const map = new HerdrServiceMap({
      shell,
      batchPerTick: 2,
      tickIntervalMs: 60_000,
      now: () => 5_000,
    });

    for (const pane of ["p1", "p2", "p3"]) {
      map.requestProbe({
        hostId: "local",
        paneId: pane,
        priority: "ambient",
        processes: [{ name: "node", cmdline: "next dev", pid: 100 + pane.charCodeAt(1) }],
      });
    }

    await map.drainHostNow("local");
    expect(shellCalls).toBe(2);
    expect(map.get("local", null, "p1")?.health).toBe("live");
    expect(map.get("local", null, "p3")?.health).toBe("pending");

    await map.drainHostNow("local");
    expect(shellCalls).toBe(3);
    expect(map.get("local", null, "p3")?.health).toBe("live");
    map.stop();
  });

  it("change-driven observe enqueues when process identity flips", async () => {
    const shell = vi.fn(async () => ({
      ok: true,
      stdout: "node 7 me 1u IPv4 0t0 TCP *:4000 (LISTEN)\n",
    }));
    const map = new HerdrServiceMap({ shell, now: () => 10 });

    map.observeProcesses({
      hostId: "local",
      paneId: "w:p",
      processes: [{ name: "node", cmdline: "vite", pid: 1 }],
    });
    // first strong → ambient enqueued; drain
    await map.drainHostNow("local");
    expect(shell).toHaveBeenCalled();

    shell.mockClear();
    map.observeProcesses({
      hostId: "local",
      paneId: "w:p",
      processes: [{ name: "node", cmdline: "vite", pid: 7 }],
    });
    await map.drainHostNow("local");
    expect(shell).toHaveBeenCalled();
    expect(map.get("local", null, "w:p")?.ports?.[0]?.port).toBe(4000);
    map.stop();
  });
});
