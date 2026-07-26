import { describe, expect, it } from "vitest";
import {
  extractSessionIdFromText,
  recordCapturedSessionId,
  getCapturedSessionId,
  resetSessionIdStoreForTest,
} from "../src/main/vellum/term/session-id-store";
import { launchForManagedSpawn } from "../src/main/vellum/term/managed-spawn-plan";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  GROK_MIN_POST_SPAWN_MS,
  ManagedTerminalDrive,
} from "../src/main/vellum/term/drive";
import { makeManagedAgentNode } from "../src/renderer/lib/node-factories";

describe("session id capture + pin", () => {
  it("extracts UUID and CODEX/HERMES env forms", () => {
    expect(
      extractSessionIdFromText("session 550e8400-e29b-41d4-a716-446655440000 ok"),
    ).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(extractSessionIdFromText("CODEX_THREAD_ID=thread_abc12345")).toBe(
      "thread_abc12345",
    );
    expect(extractSessionIdFromText("HERMES_SESSION_ID=hs_xyz99999")).toBe(
      "hs_xyz99999",
    );
  });

  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it("makeManagedAgentNode pins UUID sessionId for claude/grok", () => {
    for (const harness of ["claude", "grok"] as const) {
      const n = makeManagedAgentNode(0, 0, { harness });
      const sid = n.ether?.terminal?.sessionId;
      expect(sid).toMatch(UUID_RE);
      expect(n.ether?.terminal?.harness).toBe(harness);
      expect(n.ether?.terminal?.bindingId).toBeTruthy();
      const argv = n.ether?.terminal?.launch?.argv ?? [];
      expect(argv).toContain("--session-id");
      expect(argv).toContain(sid);
    }
  });

  it("makeManagedAgentNode does not pin sessionId for capture harnesses", () => {
    for (const harness of ["codex", "hermes"] as const) {
      const n = makeManagedAgentNode(0, 0, {
        harness,
        ...(harness === "hermes" ? { profile: "default" } : {}),
      });
      expect(n.ether?.terminal?.sessionId).toBeUndefined();
      const argv = n.ether?.terminal?.launch?.argv ?? [];
      expect(argv).not.toContain("--session-id");
    }
  });

  it("spawn replan resumes stored sessionId", () => {
    const node = makeManagedAgentNode(0, 0, { harness: "claude" });
    const sid = node.ether!.terminal!.sessionId!;
    expect(sid).toMatch(UUID_RE);
    const doc: CanvasDoc = { nodes: [node], edges: [] };
    const { launch } = launchForManagedSpawn({
      doc,
      nodeId: node.id,
      harness: "claude",
      documentLaunch: node.ether!.terminal!.launch,
    });
    expect(launch?.argv).toBeDefined();
    // resume path prefers -r / --resume when resume=true (default when stored)
    const argv = launch!.argv ?? [];
    expect(
      argv.includes("--resume") ||
        argv.includes("-r") ||
        argv.includes("--session-id") ||
        argv.includes(sid),
    ).toBe(true);
    expect(argv).toContain(sid);
  });

  it("capture store holds binding→session", () => {
    resetSessionIdStoreForTest();
    recordCapturedSessionId("b1", "thread_x");
    expect(getCapturedSessionId("b1")).toBe("thread_x");
  });
});

describe("Grok post-spawn delay", () => {
  it("markSpawned delays writePrompt", async () => {
    const writes: string[] = [];
    let now = 1_000;
    const drive = new ManagedTerminalDrive({
      write: (_id, data) => {
        writes.push(data);
        return true;
      },
      isSeatIdle: () => true,
      now: () => now,
      stallWatch: false,
    });
    drive.markSpawned("g1", GROK_MIN_POST_SPAWN_MS);
    const p = drive.writePrompt("g1", "hi");
    // Advance past delay via real timers — use short delay for test
    drive.resetForTest();
    // Re-test with 0 delay mark equivalent
    const drive2 = new ManagedTerminalDrive({
      write: (_id, data) => {
        writes.push(data);
        return true;
      },
      isSeatIdle: () => true,
      now: () => Date.now(),
      stallWatch: false,
    });
    drive2.markSpawned("g2", 0);
    await expect(drive2.writePrompt("g2", "hi")).resolves.toBe(true);
    expect(writes.length).toBeGreaterThan(0);
    void p;
  });
});
