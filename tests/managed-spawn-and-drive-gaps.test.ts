import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ManagedTerminalDrive,
  DEFAULT_QUEUE_TIMEOUT_MS,
} from "../src/main/vellum-command/term/drive";
import { isManagedTerminalReady } from "../src/main/vellum-command/term/drive/readiness";
import {
  armFirstTypedMessage,
  peekFirstTypedMessage,
  takeFirstTypedMessage,
  resetFirstTypedForTest,
} from "../src/main/vellum-command/term/first-typed";
import {
  nodeHasActionableFactoryEdge,
  launchForManagedSpawn,
  launchForManagedSpawnIntent,
  makeManagedSpawnIntent,
  shouldAvoidSharedHarnessResume,
} from "../src/main/vellum-command/term/managed-spawn-plan";
import { __setSessionExistenceHomeForTest } from "../src/main/vellum-command/term/session-existence";
import type { CanvasDoc } from "../src/shared/canvas";
import { createRequire } from "node:module";
import { BROWSER_ENABLED } from "../src/shared/features";

const require = createRequire(import.meta.url);

const originalVellumHome = process.env.JUNTO_HOME;
afterEach(() => {
  __setSessionExistenceHomeForTest(undefined);
  if (originalVellumHome === undefined) delete process.env.JUNTO_HOME;
  else process.env.JUNTO_HOME = originalVellumHome;
});

describe("CJS headless interop (boot gate)", () => {
  it("require('@xterm/headless') exposes Terminal constructor", () => {
    const mod = require("@xterm/headless") as { Terminal: unknown };
    expect(typeof mod.Terminal).toBe("function");
  });
});

describe("isManagedTerminalReady", () => {
  it("non-hermes is ready without signals", () => {
    expect(isManagedTerminalReady({ harness: "claude" })).toBe(true);
    expect(isManagedTerminalReady({ harness: "codex" })).toBe(true);
  });

  it("hermes requires a positive UI signal", () => {
    expect(isManagedTerminalReady({ harness: "hermes" })).toBe(false);
    expect(
      isManagedTerminalReady({ harness: "hermes", seatState: "idle" }),
    ).toBe(true);
    expect(
      isManagedTerminalReady({
        harness: "hermes",
        snapshot: {
          bindingId: "b",
          epoch: "e",
          cols: 40,
          rows: 10,
          lines: [""],
          text: "",
          seq: 1n,
          signals: {
            title: "Hermes",
            osc9: "",
            modes: {
              bracketedPaste: false,
              synchronizedOutput: false,
              altScreen: false,
              mouseModes: [],
            },
          },
        },
      }),
    ).toBe(true);
  });
});

describe("amp readiness is positive, not quiet", () => {
  const snap = (title: string, lines: readonly string[]) => ({
    bindingId: "b",
    epoch: "e",
    cols: 143,
    rows: 40,
    lines: [...lines],
    text: lines.join("\n"),
    seq: 1n,
    signals: {
      title,
      osc9: "",
      modes: {
        bracketedPaste: false,
        synchronizedOutput: false,
        altScreen: false,
        mouseModes: [],
      },
    },
  });

  it("refuses the connecting window even though the composer is painted", () => {
    // Real startup frame: the whole box is on screen, the title is still empty,
    // and a prompt written here is swallowed.
    expect(
      isManagedTerminalReady({
        harness: "amp",
        snapshot: snap("", [
          "\u2502                                              \u2502",
          "\u2570 ~ Connecting \u2500 ~/Projects/vellum (main) \u2500\u256f",
        ]),
      }),
    ).toBe(false);
  });

  it("refuses the resume replay window", () => {
    expect(
      isManagedTerminalReady({
        harness: "amp",
        snapshot: snap("", ["\u2570 ~ Catching Up \u2500 ~/Projects/vellum \u2500\u256f"]),
      }),
    ).toBe(false);
  });

  it("refuses when there is no snapshot at all", () => {
    expect(isManagedTerminalReady({ harness: "amp" })).toBe(false);
    expect(isManagedTerminalReady({ harness: "amp", seatState: "idle" })).toBe(
      false,
    );
  });

  it("is ready once Amp titles the window and the footer settles", () => {
    expect(
      isManagedTerminalReady({
        harness: "amp",
        snapshot: snap("Ready response - amp - ~/Projects/vellum", [
          "\u2570\u2500 ~/Projects/vellum (main) \u2500\u256f",
        ]),
      }),
    ).toBe(true);
  });

  it("admits an untitled complete settled composer only with bracketed paste enabled", () => {
    const snapshot = snap("", ["╭──────── low ─╮", "│             │", "╰─────────────╯"]);
    expect(isManagedTerminalReady({ harness: "amp", snapshot })).toBe(false);
    snapshot.signals.modes.bracketedPaste = true;
    expect(isManagedTerminalReady({ harness: "amp", snapshot })).toBe(true);
    expect(isManagedTerminalReady({ harness: "amp", snapshot: { ...snapshot, lines: ["│             │"] } })).toBe(false);
  });

  it.each(["Loading Thread", "Connecting", "Catching Up", "Sending", "Streaming", "Waiting for Approval", "Login required"])(
    "refuses %s even with a stale idle title and an empty composer",
    (status) => {
      const snapshot = snap("Prior turn - amp - <CWD>", ["╭──────── low ─╮", "│             │", `╰ ∼ ${status} ─╯`]);
      snapshot.signals.modes.bracketedPaste = true;
      expect(isManagedTerminalReady({ harness: "amp", snapshot })).toBe(false);
    },
  );
});

describe("firstTyped arming", () => {
  afterEach(() => resetFirstTypedForTest());

  it("arms once and take consumes", () => {
    armFirstTypedMessage("b1", "  doctrine  ");
    expect(peekFirstTypedMessage("b1")).toBe("doctrine");
    expect(takeFirstTypedMessage("b1")).toBe("doctrine");
    expect(peekFirstTypedMessage("b1")).toBeUndefined();
    armFirstTypedMessage("b1", "again");
    // Already delivered — second arm ignored until clear.
    expect(peekFirstTypedMessage("b1")).toBeUndefined();
  });
});

describe("managed spawn plan", () => {
  const baseDoc = (connected: boolean): CanvasDoc => ({
    nodes: [
      {
        id: "worker",
        type: "text",
        text: "claude",
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        ether: {
          entity: { kind: "agent", name: "local:claude" },
          terminal: {
            bindingId: "bind-1",
            harness: "claude",
            launch: { kind: "harness", argv: ["claude"] },
          },
        },
      },
      {
        id: "tasks",
        type: "text",
        text: "tasks",
        x: 200,
        y: 0,
        width: 100,
        height: 80,
        ether: { entity: { kind: "task" }, tasks: { items: [] } },
      },
    ],
    edges: connected ? [{ id: "e1", fromNode: "worker", toNode: "tasks", ether: { verb: "contributes" } }] : [],
  });

  it("detects work edges", () => {
    expect(nodeHasActionableFactoryEdge(baseDoc(true), "worker")).toBe(true);
    expect(nodeHasActionableFactoryEdge(baseDoc(false), "worker")).toBe(false);
  });

  it("treats artifact and page capability edges as injection-worthy", () => {
    const base = baseDoc(false);
    const artifacts: CanvasDoc = {
      ...base,
      nodes: [
        ...base.nodes,
        {
          id: "artifacts",
          type: "text",
          text: "artifacts",
          x: 200,
          y: 0,
          width: 100,
          height: 80,
          ether: { entity: { kind: "artifacts" }, artifacts: { items: [] } },
        },
      ],
      edges: [
        ...base.edges,
        { id: "artifact-edge", fromNode: "worker", toNode: "artifacts", ether: { verb: "publishes" } },
      ],
    };
    expect(nodeHasActionableFactoryEdge(artifacts, "worker")).toBe(true);

    const page: CanvasDoc = {
      ...base,
      nodes: [
        ...base.nodes,
        {
          id: "page",
          type: "link",
          url: "https://example.test",
          x: 200,
          y: 0,
          width: 100,
          height: 80,
          ether: { entity: { kind: "page" }, browser: { profile: "personal" } },
        },
      ],
      edges: [
        ...base.edges,
        { id: "page-edge", fromNode: "worker", toNode: "page", ether: { verb: "navigates" } },
      ],
    };
    expect(nodeHasActionableFactoryEdge(page, "worker")).toBe(true);
    const { plan } = launchForManagedSpawn({
      doc: page,
      nodeId: "worker",
      harness: "claude",
      documentLaunch: { kind: "harness", argv: ["claude"] },
    });
    expect(plan?.injection.inject).toBe(true);
    if (BROWSER_ENABLED) {
      expect(plan?.injection.systemPrompt).toContain(
        "vellum-command browser pages --json",
      );
    } else {
      expect(plan?.injection.systemPrompt).not.toContain("vellum-command browser");
    }
  });

  it("connected replan applies Tier A system prompt for claude", () => {
    const { plan, launch } = launchForManagedSpawn({
      doc: baseDoc(true),
      nodeId: "worker",
      harness: "claude",
      documentLaunch: { kind: "harness", argv: ["claude"] },
    });
    expect(plan?.injection.inject).toBe(true);
    expect(plan?.injection.tier).toBe("A");
    expect(launch?.argv?.some((a) => a === "--append-system-prompt")).toBe(
      true,
    );
  });

  it("unconnected canvas seat still injects base doctrine (no edge contracts)", () => {
    const { plan, launch } = launchForManagedSpawn({
      doc: baseDoc(false),
      nodeId: "worker",
      harness: "claude",
      documentLaunch: { kind: "harness", argv: ["claude"] },
    });
    // Seat-bound seats always get base doctrine; edges only add contracts.
    expect(plan?.injection.inject).toBe(true);
    expect(plan?.injection.tier).toBe("A");
    expect(launch?.argv?.some((a) => a === "--append-system-prompt")).toBe(
      true,
    );
    const prompt = plan?.injection.systemPrompt ?? "";
    expect(prompt).toContain("Junto");
    expect(prompt).not.toContain("Edge contracts");
  });

  it("connected codex delivers doctrine as argv prompt (not firstTyped paste)", () => {
    const { plan, launch } = launchForManagedSpawn({
      doc: baseDoc(true),
      nodeId: "worker",
      harness: "codex",
      documentLaunch: { kind: "harness", argv: ["codex"] },
    });
    expect(plan?.injection.tier).toBe("B");
    // positional promptMode → doctrine rides argv, auto-submits at spawn
    expect(plan?.firstTypedMessage).toBeUndefined();
    const argv = launch?.argv ?? [];
    expect(argv.some((a) => a.includes("vellum-command onboard"))).toBe(true);
  });

  it("connected devin delivers doctrine as positional prompt after --", () => {
    const { plan, launch } = launchForManagedSpawn({
      doc: baseDoc(true),
      nodeId: "worker",
      harness: "devin",
      documentLaunch: { kind: "harness", argv: ["devin"] },
    });
    expect(plan?.injection.tier).toBe("B");
    expect(plan?.firstTypedMessage).toBeUndefined();
    const argv = launch?.argv ?? [];
    const sep = argv.indexOf("--");
    expect(sep).toBeGreaterThan(-1);
    expect(argv[sep + 1]).toContain("vellum-command onboard");
  });

  it("preserves picker choices while adding connected injection", () => {
    const { launch } = launchForManagedSpawn({
      doc: baseDoc(true),
      nodeId: "worker",
      harness: "claude",
      documentLaunch: {
        kind: "harness",
        argv: [
          "claude",
          "--model",
          "opus",
          "--effort",
          "high",
          "--permission-mode",
          "plan",
        ],
      },
    });
    expect(launch?.argv).toEqual(
      expect.arrayContaining([
        "--model",
        "opus",
        "--effort",
        "high",
        "--permission-mode",
        "plan",
        "--append-system-prompt",
      ]),
    );
    expect(launch?.argv).not.toContain("default");
  });

  it("preserves inline Claude picker flags and permission values", () => {
    const { launch } = launchForManagedSpawn({
      doc: baseDoc(true),
      nodeId: "worker",
      harness: "claude",
      documentLaunch: {
        kind: "harness",
        argv: [
          "claude",
          "--model=opus",
          "--effort=high",
          "--permission-mode=plan",
        ],
      },
    });
    expect(launch?.argv).toEqual(
      expect.arrayContaining([
        "--model",
        "opus",
        "--effort",
        "high",
        "--permission-mode",
        "plan",
        "--append-system-prompt",
      ]),
    );
    expect(launch?.argv).not.toContain("--model=opus");
  });

  it("recovers Hermes profile from the agent key", () => {
    const { launch } = launchForManagedSpawn({
      doc: baseDoc(true),
      nodeId: "worker",
      harness: "hermes",
      agentKey: "remote:research",
      documentLaunch: { kind: "harness", argv: ["hermes", "chat", "--tui"] },
    });
    expect(launch?.argv).toEqual(
      expect.arrayContaining(["--profile", "research"]),
    );
  });

  it("re-passes Codex model, effort, and approval on resume", () => {
    // Isolation (JUNTO_HOME) forces resume off; this case is production path.
    delete process.env.JUNTO_HOME;
    const home = mkdtempSync(join(tmpdir(), "vellum-codex-resume-"));
    __setSessionExistenceHomeForTest(home);
    try {
      const rolloutDir = join(home, ".codex", "sessions", "2026", "07", "30");
      mkdirSync(rolloutDir, { recursive: true });
      writeFileSync(
        join(rolloutDir, "rollout-2026-07-30T00-00-00-thread_123.jsonl"),
        "",
      );
      const { launch } = launchForManagedSpawn({
        doc: baseDoc(true),
        nodeId: "worker",
        harness: "codex",
        sessionId: "thread_123",
        resume: true,
        documentLaunch: {
          kind: "harness",
          argv: [
            "codex",
            "-m",
            "gpt-5",
            "-c",
            'model_reasoning_effort="high"',
            "-a",
            "never",
          ],
        },
      });
      expect(launch?.argv).toEqual(
        expect.arrayContaining([
          "resume",
          "thread_123",
          "-m",
          "gpt-5",
          "-c",
          'model_reasoning_effort="high"',
          "-a",
          "never",
        ]),
      );
    } finally {
      __setSessionExistenceHomeForTest(undefined);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("finalizes named-session proof on the selected spawn host", () => {
    delete process.env.JUNTO_HOME;
    const commandCenterHome = mkdtempSync(join(tmpdir(), "vellum-cc-proof-"));
    const remoteHome = mkdtempSync(join(tmpdir(), "vellum-remote-proof-"));
    const sid = "aaaaaaaa-bbbb-cccc-dddd-ffffffffffff";
    try {
      // Compilation runs while Command Center has no session proof. It must be
      // pure and retain only the request plus document-derived injection.
      __setSessionExistenceHomeForTest(commandCenterHome);
      const intent = makeManagedSpawnIntent({
        doc: baseDoc(true),
        nodeId: "worker",
        harness: "grok",
        agentKey: "station:grok",
        sessionId: sid,
        resume: true,
        cwd: "/work",
        documentLaunch: {
          kind: "harness",
          argv: ["grok", "--session-id", sid],
          cwd: "/work",
        },
      });
      expect(intent.resumeRequested).toBe(true);
      expect(intent.injection).toMatchObject({
        seatBound: true,
        connected: true,
      });

      // The same intent resumes when the selected Remote owns proof.
      mkdirSync(
        join(
          remoteHome,
          ".grok",
          "sessions",
          encodeURIComponent("/work"),
          sid,
        ),
        { recursive: true },
      );
      __setSessionExistenceHomeForTest(remoteHome);
      const proven = launchForManagedSpawnIntent(
        { harness: "grok", agentKey: "station:grok" },
        intent,
      );
      expect(proven.launch?.argv).toEqual(expect.arrayContaining(["-r", sid]));
      expect(proven.plan?.injection.inject).toBe(false);
      expect(proven.plan?.firstTypedMessage).toBeUndefined();

      // Removing only Remote proof makes that identical intent pin fresh and
      // retain normal doctrine injection; Command Center state is irrelevant.
      rmSync(join(remoteHome, ".grok"), { recursive: true, force: true });
      const unproven = launchForManagedSpawnIntent(
        { harness: "grok", agentKey: "station:grok" },
        intent,
      );
      expect(unproven.launch?.argv).toEqual(
        expect.arrayContaining(["--session-id", sid]),
      );
      expect(unproven.launch?.argv).not.toContain("-r");
      expect(unproven.plan?.injection.inject).toBe(true);
    } finally {
      __setSessionExistenceHomeForTest(undefined);
      rmSync(commandCenterHome, { recursive: true, force: true });
      rmSync(remoteHome, { recursive: true, force: true });
    }
  });

  it("suppresses Tier B first-typed doctrine only for a host-proven resume", () => {
    delete process.env.JUNTO_HOME;
    const home = mkdtempSync(join(tmpdir(), "vellum-kimi-resume-host-"));
    const sid = "ses_remote_kimi";
    try {
      mkdirSync(join(home, ".kimi-code", "sessions", "work", sid), {
        recursive: true,
      });
      __setSessionExistenceHomeForTest(home);
      const intent = makeManagedSpawnIntent({
        harness: "kimi",
        agentKey: "station:kimi",
        documentLaunch: { kind: "harness", argv: ["kimi"] },
        sessionId: sid,
        resume: true,
        injection: {
          seatBound: true,
          connected: true,
          seatRef: "actor-kimi",
          connectedTargets: [{ id: "tasks", kind: "task" }],
        },
      });
      const resolved = launchForManagedSpawnIntent(
        { harness: "kimi", agentKey: "station:kimi" },
        intent,
      );

      expect(resolved.launch?.argv).toEqual(
        expect.arrayContaining(["-S", sid]),
      );
      expect(resolved.plan?.injection.inject).toBe(false);
      expect(resolved.plan?.firstTypedMessage).toBeUndefined();
    } finally {
      __setSessionExistenceHomeForTest(undefined);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("isolated JUNTO_HOME refuses shared pin resume and mints a fresh session", () => {
    process.env.JUNTO_HOME = "/tmp/vellum-dev-isolated-home";
    expect(shouldAvoidSharedHarnessResume()).toBe(true);
    const prodSession = "0c813489-ff73-4f9d-af00-96adc0d63d94";
    const { launch } = launchForManagedSpawn({
      doc: baseDoc(true),
      nodeId: "worker",
      harness: "grok",
      sessionId: prodSession,
      resume: true,
      documentLaunch: {
        kind: "harness",
        argv: [
          "grok",
          "-r",
          prodSession,
          "-m",
          "grok-4.5",
          "--permission-mode",
          "default",
        ],
        cwd: "/Users/op/Projects/vellum",
      },
    });
    expect(launch?.argv).toBeDefined();
    expect(launch?.argv).not.toContain("-r");
    expect(launch?.argv).not.toContain(prodSession);
    expect(launch?.argv).toEqual(expect.arrayContaining(["--session-id"]));
    const sidIdx = launch!.argv!.indexOf("--session-id");
    const fresh = launch!.argv![sidIdx + 1];
    expect(fresh).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(fresh).not.toBe(prodSession);
  });

  it("production (no JUNTO_HOME) still resumes a proven Grok pin", () => {
    delete process.env.JUNTO_HOME;
    const home = mkdtempSync(join(tmpdir(), "vellum-grok-resume-"));
    __setSessionExistenceHomeForTest(home);
    try {
      const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const sessionDir = join(
        home,
        ".grok",
        "sessions",
        encodeURIComponent("/work"),
        sid,
      );
      mkdirSync(sessionDir, { recursive: true });
      const { launch } = launchForManagedSpawn({
        harness: "grok",
        sessionId: sid,
        resume: true,
        cwd: "/work",
        documentLaunch: {
          kind: "harness",
          argv: ["grok", "--session-id", sid],
          cwd: "/work",
        },
      });
      expect(launch?.argv).toEqual(expect.arrayContaining(["-r", sid]));
    } finally {
      __setSessionExistenceHomeForTest(undefined);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("recovers Codex inline effort and inline approval flags", () => {
    const { launch } = launchForManagedSpawn({
      doc: baseDoc(true),
      nodeId: "worker",
      harness: "codex",
      documentLaunch: {
        kind: "harness",
        argv: [
          "codex",
          "-m=gpt-5",
          "-c",
          'model_reasoning_effort="ultra"',
          "-a=never",
        ],
      },
    });
    expect(launch?.argv).toEqual(
      expect.arrayContaining([
        "-m",
        "gpt-5",
        "-c",
        'model_reasoning_effort="ultra"',
        "-a",
        "never",
      ]),
    );
  });

  it("recovers Hermes --yolo permission mode for long-running seats", () => {
    const { launch } = launchForManagedSpawn({
      doc: baseDoc(true),
      nodeId: "worker",
      harness: "hermes",
      documentLaunch: {
        kind: "harness",
        argv: ["hermes", "chat", "--tui", "--yolo"],
      },
    });
    expect(launch?.argv).toEqual(expect.arrayContaining(["--yolo"]));
  });
});

describe("writePrompt queue timeout", () => {
  it("refuses without writing when never idle before timeout", async () => {
    vi.useFakeTimers();
    try {
      const drive = new ManagedTerminalDrive({
      pasteToCrSettleMs: 0,
        write: () => true,
        isSeatIdle: () => false,
        queueTimeoutMs: 50,
        stallWatch: false,
      });
      const p = drive.writePrompt("b1", "hello");
      await vi.advanceTimersByTimeAsync(60);
      await expect(p).resolves.toMatchObject({
        status: "refused",
        reason: "queue-timeout",
        wrotePhysicalBytes: false,
        pasteWrites: 0,
        writesBefore: 0,
        writesAfter: 0,
      });
      drive.resetForTest();
    } finally {
      vi.useRealTimers();
    }
  });

  it("DEFAULT_QUEUE_TIMEOUT_MS is finite", () => {
    expect(DEFAULT_QUEUE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_QUEUE_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });
});
