import { describe, expect, it } from "vitest";
import {
  composeServiceUrl,
  deriveHealth,
  enqueueServiceProbe,
  interestLevel,
  isInterestingProcessSet,
  isShellProcess,
  parseLsofListen,
  portsFromCmdlineHints,
  processIdentityChanged,
  processLooksLikeServer,
  projectService,
  resolveHostBase,
  takeQueueForHost,
  type HerdrServiceQueueItem,
} from "../src/shared/herdr-service-map";

describe("herdr-service-map interest", () => {
  it("treats shells as non-servers", () => {
    expect(isShellProcess({ name: "zsh", cmdline: "-zsh" })).toBe(true);
    expect(processLooksLikeServer({ name: "zsh", cmdline: "-zsh" })).toBe(false);
    expect(interestLevel([{ name: "zsh", pid: 1 }])).toBe("none");
  });

  it("detects vite/next/express style servers", () => {
    expect(
      processLooksLikeServer({
        name: "node",
        cmdline: "node ./node_modules/vite/bin/vite.js",
        pid: 9,
      }),
    ).toBe(true);
    expect(
      processLooksLikeServer({
        name: "next-server",
        cmdline: "next-server",
        pid: 10,
      }),
    ).toBe(true);
    expect(interestLevel([{ name: "node", cmdline: "node server.js", pid: 3 }])).toBe(
      "strong",
    );
  });

  it("weak interest for non-shell pid without server hint", () => {
    expect(interestLevel([{ name: "nvim", cmdline: "nvim", pid: 4 }])).toBe("weak");
    expect(isInterestingProcessSet([{ name: "nvim", pid: 4 }])).toBe(true);
  });

  it("detects process identity changes", () => {
    const a = [{ name: "node", pid: 1, cmdline: "vite" }];
    const b = [{ name: "node", pid: 2, cmdline: "vite" }];
    expect(processIdentityChanged(a, a)).toBe(false);
    expect(processIdentityChanged(a, b)).toBe(true);
  });
});

describe("herdr-service-map url", () => {
  it("resolves local to 127.0.0.1", () => {
    expect(resolveHostBase({ hostId: "local", kind: "local" })).toBe("127.0.0.1");
  });

  it("prefers tailscale override then endpoint user@host strip", () => {
    expect(
      resolveHostBase({
        hostId: "remote-a",
        kind: "remote",
        sshEndpoint: "me@remote-a",
        tailscaleHost: "100.64.1.2",
      }),
    ).toBe("100.64.1.2");
    expect(
      resolveHostBase({
        hostId: "remote-a",
        kind: "remote",
        sshEndpoint: "me@remote-a",
      }),
    ).toBe("remote-a");
  });

  it("composes http url with preferred dev port", () => {
    expect(
      composeServiceUrl({
        hostBase: "127.0.0.1",
        ports: [
          { port: 22, protocol: "tcp" },
          { port: 5173, protocol: "tcp" },
        ],
      }),
    ).toBe("http://127.0.0.1:5173");
  });
});

describe("herdr-service-map health", () => {
  it("pending / live / stale / dead / skipped", () => {
    expect(deriveHealth({ interesting: false, pending: false })).toBe("skipped");
    expect(deriveHealth({ interesting: true, pending: true })).toBe("pending");
    expect(
      deriveHealth({
        interesting: true,
        pending: false,
        ports: [{ port: 3000 }],
        checkedAt: 1000,
        now: 2000,
      }),
    ).toBe("live");
    expect(
      deriveHealth({
        interesting: true,
        pending: false,
        ports: [{ port: 3000 }],
        checkedAt: 0,
        now: 10 * 60_000,
        staleAfterMs: 60_000,
      }),
    ).toBe("stale");
    expect(
      deriveHealth({
        interesting: true,
        pending: false,
        ports: [],
        checkedAt: 1000,
        now: 2000,
      }),
    ).toBe("dead");
    expect(deriveHealth({ interesting: true, pending: false, processGone: true })).toBe(
      "dead",
    );
  });

  it("projectService attaches url only when live/stale", () => {
    const live = projectService({
      hostId: "local",
      paneId: "w1:p1",
      processes: [{ name: "node", cmdline: "vite", pid: 1 }],
      ports: [{ port: 5173 }],
      hostBase: "127.0.0.1",
      checkedAt: Date.now(),
    });
    expect(live.health).toBe("live");
    expect(live.url).toBe("http://127.0.0.1:5173");

    const dead = projectService({
      hostId: "local",
      paneId: "w1:p1",
      processes: [{ name: "node", cmdline: "vite", pid: 1 }],
      ports: [],
      hostBase: "127.0.0.1",
      checkedAt: Date.now(),
    });
    expect(dead.health).toBe("dead");
    expect(dead.url).toBeUndefined();
  });

  it("does not call a coding harness dead when it has no listening port", () => {
    const amp = projectService({
      hostId: "local",
      paneId: "w1:p1",
      processes: [{ name: "amp", cmdline: "amp", pid: 42 }],
      ports: [],
      hostBase: "127.0.0.1",
      checkedAt: Date.now(),
    });

    expect(interestLevel(amp.processes)).toBe("weak");
    expect(amp.health).toBe("skipped");
    expect(amp.url).toBeUndefined();
  });
});

describe("herdr-service-map queue", () => {
  const item = (
    paneId: string,
    priority: HerdrServiceQueueItem["priority"],
    enqueuedAt = 1,
  ): HerdrServiceQueueItem => ({
    hostId: "local",
    paneId,
    priority,
    enqueuedAt,
  });

  it("dedupes pane and upgrades priority to intent", () => {
    let q = enqueueServiceProbe([], item("p1", "ambient", 10));
    q = enqueueServiceProbe(q, item("p1", "intent", 20));
    expect(q).toHaveLength(1);
    expect(q[0]?.priority).toBe("intent");
    expect(q[0]?.enqueuedAt).toBe(10);
  });

  it("sorts intent before change before ambient", () => {
    let q = enqueueServiceProbe([], item("a", "ambient", 1));
    q = enqueueServiceProbe(q, item("b", "intent", 2));
    q = enqueueServiceProbe(q, item("c", "change", 3));
    expect(q.map((x) => x.paneId)).toEqual(["b", "c", "a"]);
  });

  it("takeQueueForHost respects limit and host filter", () => {
    let q: ReadonlyArray<HerdrServiceQueueItem> = [];
    q = enqueueServiceProbe(q, {
      hostId: "local",
      paneId: "p1",
      priority: "ambient",
      enqueuedAt: 1,
    });
    q = enqueueServiceProbe(q, {
      hostId: "local",
      paneId: "p2",
      priority: "ambient",
      enqueuedAt: 2,
    });
    q = enqueueServiceProbe(q, {
      hostId: "remote-a",
      paneId: "p3",
      priority: "intent",
      enqueuedAt: 3,
    });
    const { taken, rest } = takeQueueForHost(q, "local", 1);
    expect(taken).toHaveLength(1);
    expect(taken[0]?.paneId).toBe("p1");
    expect(rest.some((r) => r.paneId === "p2")).toBe(true);
    expect(rest.some((r) => r.paneId === "p3")).toBe(true);
  });
});


describe("herdr-service-map lsof parse", () => {
  it("extracts listen ports for target pids", () => {
    const stdout = `
COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    4242 me   23u  IPv4 0x1      0t0  TCP *:5173 (LISTEN)
node    4242 me   24u  IPv6 0x2      0t0  TCP *:3000 (LISTEN)
sshd    9999 me    3u  IPv4 0x3      0t0  TCP *:22 (LISTEN)
`;
    const ports = parseLsofListen(stdout, [4242]);
    expect(ports.map((p) => p.port)).toEqual([3000, 5173]);
  });

  it("reads --port from cmdline hints", () => {
    expect(
      portsFromCmdlineHints([{ cmdline: "node server.js --port 4001", pid: 1 }]).map(
        (p) => p.port,
      ),
    ).toEqual([4001]);
  });
});
