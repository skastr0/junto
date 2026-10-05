import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ManagedTerminalDrive,
  DEFAULT_QUEUE_TIMEOUT_MS,
} from "../src/main/junto/term/drive";
import { isManagedTerminalReady } from "../src/main/junto/term/drive/readiness";
import {
  launchForManagedSpawn,
  launchForManagedSpawnIntent,
  makeManagedSpawnIntent,
  shouldAvoidSharedHarnessResume,
} from "../src/main/junto/term/managed-spawn-plan";
import { __setSessionExistenceHomeForTest } from "../src/main/junto/term/session-existence";
import type { CanvasDoc } from "../src/shared/canvas";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const originalJuntoHome = process.env.JUNTO_HOME;
afterEach(() => {
  __setSessionExistenceHomeForTest(undefined);
  if (originalJuntoHome === undefined) delete process.env.JUNTO_HOME;
  else process.env.JUNTO_HOME = originalJuntoHome;
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
          "\u2570 ~ Connecting \u2500 ~/Projects/junto (main) \u2500\u256f",
        ]),
      }),
    ).toBe(false);
  });

  it("refuses the resume replay window", () => {
    expect(
      isManagedTerminalReady({
        harness: "amp",
        snapshot: snap("", ["\u2570 ~ Catching Up \u2500 ~/Projects/junto \u2500\u256f"]),
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
        snapshot: snap("Ready response - amp - ~/Projects/junto", [
          "\u2570\u2500 ~/Projects/junto (main) \u2500\u256f",
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
        id: "peer",
        type: "text",
        text: "codex",
        x: 200,
        y: 0,
        width: 100,
        height: 80,
        ether: { entity: { kind: "agent", name: "local:codex" } },
      },
    ],
    edges: connected ? [{ id: "e1", fromNode: "worker", toNode: "peer", ether: { verb: "messages" } }] : [],
  });

  it("a connected seat launches on the plain harness argv", () => {
    for (const harness of ["claude", "codex", "devin"] as const) {
      const { plan, launch } = launchForManagedSpawn({
        doc: baseDoc(true),
        nodeId: "worker",
        harness,
        documentLaunch: { kind: "harness", argv: [harness] },
      });
      expect(Object.keys(plan ?? {})).toEqual(["launch"]);
      expect(launch?.argv?.[0]).toBe(harness);
      expect(launch?.argv).not.toContain("--append-system-prompt");
      expect(launch?.argv).not.toContain("--");
      expect(launch?.argv?.some((a) => a.includes("junto"))).toBe(false);
    }
  });

  it("preserves picker choices on a connected seat", () => {
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
    const home = mkdtempSync(join(tmpdir(), "junto-codex-resume-"));
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
    const commandCenterHome = mkdtempSync(join(tmpdir(), "junto-cc-proof-"));
    const remoteHome = mkdtempSync(join(tmpdir(), "junto-remote-proof-"));
    const sid = "aaaaaaaa-bbbb-cccc-dddd-ffffffffffff";
    try {
      // Compilation runs while Command Center has no session proof. It must be
      // pure and retain only the request.
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
      expect(intent).not.toHaveProperty("injection");

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

      // Removing only Remote proof makes that identical intent pin fresh;
      // Command Center state is irrelevant.
      rmSync(join(remoteHome, ".grok"), { recursive: true, force: true });
      const unproven = launchForManagedSpawnIntent(
        { harness: "grok", agentKey: "station:grok" },
        intent,
      );
      expect(unproven.launch?.argv).toEqual(
        expect.arrayContaining(["--session-id", sid]),
      );
      expect(unproven.launch?.argv).not.toContain("-r");
    } finally {
      __setSessionExistenceHomeForTest(undefined);
      rmSync(commandCenterHome, { recursive: true, force: true });
      rmSync(remoteHome, { recursive: true, force: true });
    }
  });

  it("a host-proven resume names the session and carries nothing else", () => {
    delete process.env.JUNTO_HOME;
    const home = mkdtempSync(join(tmpdir(), "junto-kimi-resume-host-"));
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
      });
      const resolved = launchForManagedSpawnIntent(
        { harness: "kimi", agentKey: "station:kimi" },
        intent,
      );

      expect(resolved.launch?.argv).toEqual(["kimi", "-S", sid]);
      expect(Object.keys(resolved.plan ?? {})).toEqual(["launch"]);
    } finally {
      __setSessionExistenceHomeForTest(undefined);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("isolated JUNTO_HOME refuses shared pin resume and mints a fresh session", () => {
    process.env.JUNTO_HOME = "/tmp/junto-dev-isolated-home";
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
        cwd: "/Users/op/Projects/junto",
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
    const home = mkdtempSync(join(tmpdir(), "junto-grok-resume-"));
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
