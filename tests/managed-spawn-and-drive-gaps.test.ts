import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ManagedTerminalDrive,
  DEFAULT_QUEUE_TIMEOUT_MS,
} from "../src/main/vellum/term/drive";
import { isManagedTerminalReady } from "../src/main/vellum/term/drive/readiness";
import {
  armFirstTypedMessage,
  peekFirstTypedMessage,
  takeFirstTypedMessage,
  resetFirstTypedForTest,
} from "../src/main/vellum/term/first-typed";
import {
  nodeHasActionableFactoryEdge,
  launchForManagedSpawn,
  shouldAvoidSharedHarnessResume,
} from "../src/main/vellum/term/managed-spawn-plan";
import { __setSessionExistenceHomeForTest } from "../src/main/vellum/term/session-existence";
import type { CanvasDoc } from "../src/shared/canvas";
import { createRequire } from "node:module";
import { BROWSER_ENABLED } from "../src/shared/features";

const require = createRequire(import.meta.url);

const originalVellumHome = process.env.VELLUM_HOME;
afterEach(() => {
  if (originalVellumHome === undefined) delete process.env.VELLUM_HOME;
  else process.env.VELLUM_HOME = originalVellumHome;
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
    edges: connected ? [{ id: "e1", fromNode: "worker", toNode: "tasks" }] : [],
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
        { id: "artifact-edge", fromNode: "worker", toNode: "artifacts" },
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
        { id: "page-edge", fromNode: "worker", toNode: "page" },
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
        "vellum browser pages --json",
      );
    } else {
      expect(plan?.injection.systemPrompt).not.toContain("vellum browser");
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

  it("unconnected replan stays silent", () => {
    const { plan, launch } = launchForManagedSpawn({
      doc: baseDoc(false),
      nodeId: "worker",
      harness: "claude",
      documentLaunch: { kind: "harness", argv: ["claude"] },
    });
    expect(plan?.injection.inject).toBe(false);
    expect(launch?.argv?.includes("--append-system-prompt")).toBe(false);
  });

  it("connected codex arms firstTypedMessage", () => {
    const { plan } = launchForManagedSpawn({
      doc: baseDoc(true),
      nodeId: "worker",
      harness: "codex",
      documentLaunch: { kind: "harness", argv: ["codex"] },
    });
    expect(plan?.injection.tier).toBe("B");
    expect(plan?.firstTypedMessage).toContain("vellum onboard");
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
    // Isolation (VELLUM_HOME) forces resume off; this case is production path.
    delete process.env.VELLUM_HOME;
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

  it("isolated VELLUM_HOME refuses shared pin resume and mints a fresh session", () => {
    process.env.VELLUM_HOME = "/tmp/vellum-dev-isolated-home";
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

  it("production (no VELLUM_HOME) still resumes a proven Grok pin", () => {
    delete process.env.VELLUM_HOME;
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
  it("resolves false when never idle before timeout", async () => {
    vi.useFakeTimers();
    try {
      const drive = new ManagedTerminalDrive({
        write: () => true,
        isSeatIdle: () => false,
        queueTimeoutMs: 50,
        stallWatch: false,
      });
      const p = drive.writePrompt("b1", "hello");
      await vi.advanceTimersByTimeAsync(60);
      await expect(p).resolves.toBe(false);
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
