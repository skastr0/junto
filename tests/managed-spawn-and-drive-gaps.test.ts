import { describe, expect, it, vi, afterEach } from "vitest";
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
  nodeIsConnectedToWork,
  launchForManagedSpawn,
} from "../src/main/vellum/term/managed-spawn-plan";
import type { CanvasDoc } from "../src/shared/canvas";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

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
            modes: { bracketedPaste: false, synchronizedOutput: false },
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
    edges: connected
      ? [{ id: "e1", fromNode: "worker", toNode: "tasks" }]
      : [],
  });

  it("detects work edges", () => {
    expect(nodeIsConnectedToWork(baseDoc(true), "worker")).toBe(true);
    expect(nodeIsConnectedToWork(baseDoc(false), "worker")).toBe(false);
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
    expect(launch?.argv.some((a) => a === "--append-system-prompt")).toBe(true);
  });

  it("unconnected replan stays silent", () => {
    const { plan, launch } = launchForManagedSpawn({
      doc: baseDoc(false),
      nodeId: "worker",
      harness: "claude",
      documentLaunch: { kind: "harness", argv: ["claude"] },
    });
    expect(plan?.injection.inject).toBe(false);
    expect(launch?.argv.includes("--append-system-prompt")).toBe(false);
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
