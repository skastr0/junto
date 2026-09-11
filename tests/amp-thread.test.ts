import { describe, expect, it } from "vitest";
import {
  isAmpThreadId,
  parseAmpThreadReceipt,
  provisionAmpThread,
} from "../src/main/vellum-command/term/templates/amp-thread";
import {
  ensureProvisionedSessionId,
  usesProvisionedSession,
} from "../src/main/vellum-command/term/amp-seat-thread";
import {
  launchForManagedSpawn,
  planManagedSpawn,
} from "../src/main/vellum-command/term/managed-spawn-plan";
import { makeManagedAgentNode } from "../src/renderer/lib/node-factories";
import { firstCascadeColumn } from "../src/renderer/components/node-palette/agent-launch-model";
import { harnessBinaryInstalled } from "../src/main/vellum-command/term/templates/harness-install";
import { evaluate } from "../src/main/vellum-command/term/agent-state";
import { ManagedTerminalDrive } from "../src/main/vellum-command/term/drive";
import type { ObserverGridSnapshot } from "../src/main/vellum-command/term/observer/types";
import { AMP_TEMPLATE } from "../src/shared/managed-terminal-templates";

// The receipt shape below is real output from
// `amp threads new --visibility private` on 0.0.1787664850.
const REAL_RECEIPT = "T-01a03989-71a6-733b-ac4c-76f54969cb55\n";

// Live 0.0.1789113641 stdout: the same command now prints the thread URL.
const REAL_URL_RECEIPT =
  "https://ampcode.com/threads/T-01a08fbd-9f84-732e-94b6-ff9dca60b1d8\n";

describe("amp thread receipts", () => {
  it("accepts the id Amp actually prints", () => {
    expect(parseAmpThreadReceipt(REAL_RECEIPT)).toBe(
      "T-01a03989-71a6-733b-ac4c-76f54969cb55",
    );
    expect(isAmpThreadId("T-01a03989-71a6-733b-ac4c-76f54969cb55")).toBe(true);
  });

  it("extracts the T-id from the live thread URL receipt", () => {
    expect(parseAmpThreadReceipt(REAL_URL_RECEIPT)).toBe(
      "T-01a08fbd-9f84-732e-94b6-ff9dca60b1d8",
    );
    expect(isAmpThreadId("T-01a08fbd-9f84-732e-94b6-ff9dca60b1d8")).toBe(true);
  });

  it("reads the id out of surrounding chatter", () => {
    expect(
      parseAmpThreadReceipt(
        ["A new version of Amp is available.", REAL_RECEIPT.trim(), ""].join("\n"),
      ),
    ).toBe("T-01a03989-71a6-733b-ac4c-76f54969cb55");
    expect(
      parseAmpThreadReceipt(
        ["A new version of Amp is available.", REAL_URL_RECEIPT.trim(), ""].join("\n"),
      ),
    ).toBe("T-01a08fbd-9f84-732e-94b6-ff9dca60b1d8");
  });

  it("refuses anything that is not exactly one id", () => {
    expect(parseAmpThreadReceipt("")).toBeUndefined();
    expect(parseAmpThreadReceipt("no thread here")).toBeUndefined();
    // Two ids: guessing which one is the receipt would durably pin the seat to
    // the wrong thread.
    expect(
      parseAmpThreadReceipt(
        [
          "T-01a03989-71a6-733b-ac4c-76f54969cb55",
          "T-019ffd00-6549-7498-b9ed-5d4dc405c9d6",
        ].join("\n"),
      ),
    ).toBeUndefined();
    expect(
      parseAmpThreadReceipt(
        [REAL_URL_RECEIPT.trim(), REAL_RECEIPT.trim()].join("\n"),
      ),
    ).toBeUndefined();
    expect(isAmpThreadId("T-not-a-uuid")).toBe(false);
    expect(isAmpThreadId("019ffd00-6549-7498-b9ed-5d4dc405c9d6")).toBe(false);
  });
});

describe("provisionAmpThread", () => {
  it("asks the public CLI for a private thread, with no shell", async () => {
    const calls: Array<{ binary: string; args: readonly string[] }> = [];
    const result = await provisionAmpThread({
      run: async (binary, args) => {
        calls.push({ binary, args });
        return REAL_RECEIPT;
      },
    });
    expect(result).toEqual({
      ok: true,
      threadId: "T-01a03989-71a6-733b-ac4c-76f54969cb55",
    });
    expect(calls).toEqual([
      { binary: "amp", args: ["threads", "new", "--visibility", "private"] },
    ]);
  });

  it("mints from the live URL receipt the same way as a bare id", async () => {
    const result = await provisionAmpThread({
      run: async () => REAL_URL_RECEIPT,
    });
    expect(result).toEqual({
      ok: true,
      threadId: "T-01a08fbd-9f84-732e-94b6-ff9dca60b1d8",
    });
  });

  it("surfaces an auth or network failure instead of falling back", async () => {
    const result = await provisionAmpThread({
      run: async () => {
        throw new Error("Not logged in");
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("amp_thread_unprovisioned");
    expect(result.failure.reason).toContain("Not logged in");
  });

  it("surfaces an unreadable receipt rather than inventing an id", async () => {
    const result = await provisionAmpThread({ run: async () => "created ok" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toContain("exactly one thread id");
  });
});

describe("amp launch shape depends on a provisioned thread", () => {
  const seatInput = (sessionId?: string) => ({
    harness: "amp",
    agentKey: "local:amp",
    ...(sessionId ? { sessionId } : {}),
    resume: true,
    documentLaunch: {
      kind: "harness" as const,
      argv: ["amp", "--no-ide", "threads", "continue"],
    },
  });

  it("refuses to launch without one, rather than opening Amp's picker", () => {
    // `amp --no-ide threads continue` with no id drops the operator into an
    // interactive thread picker — a seat on no particular thread.
    const planned = planManagedSpawn(seatInput());
    expect(planned).toBeUndefined();
    const resolved = launchForManagedSpawn(seatInput());
    expect(resolved.launch).toBeUndefined();
    expect(resolved.plan).toBeUndefined();
  });

  it("resumes the stored thread without probing Amp's private state", () => {
    // Pin harnesses only resume when local harness files prove the session
    // exists. Amp's proof is that Amp minted the id itself, so the resume
    // shape applies with no filesystem probe at all.
    const resolved = launchForManagedSpawn(
      seatInput("T-01a03989-71a6-733b-ac4c-76f54969cb55"),
    );
    expect(resolved.launch?.argv).toEqual([
      "amp",
      "--no-ide",
      "threads",
      "continue",
      "T-01a03989-71a6-733b-ac4c-76f54969cb55",
    ]);
  });
});

describe("ensureProvisionedSessionId", () => {
  it("returns a valid stored thread without calling the CLI again", async () => {
    const result = await ensureProvisionedSessionId({
      canvasName: "factory",
      nodeId: "n1",
      harness: "amp",
      storedSessionId: "T-01a03989-71a6-733b-ac4c-76f54969cb55",
    });
    expect(result).toEqual({
      ok: true,
      sessionId: "T-01a03989-71a6-733b-ac4c-76f54969cb55",
      // Not minted here: the seat is resuming its own thread, so the doctrine
      // must not be typed in again.
      minted: false,
    });
  });

  it("passes non-provisioned harnesses straight through", async () => {
    const result = await ensureProvisionedSessionId({
      canvasName: "factory",
      nodeId: "n1",
      harness: "claude",
      storedSessionId: "5a2f1f6c-1f1e-4c7a-9a1e-3f0f5b2a7c11",
    });
    expect(result).toEqual({
      ok: true,
      sessionId: "5a2f1f6c-1f1e-4c7a-9a1e-3f0f5b2a7c11",
      minted: false,
    });
  });

  it("knows which harnesses mint their own session", () => {
    expect(usesProvisionedSession("amp")).toBe(true);
    expect(usesProvisionedSession("claude")).toBe(false);
    expect(usesProvisionedSession("not-a-harness")).toBe(false);
  });
});

describe("amp mode survives a wake", () => {
  it("recovers -m from the stored argv instead of dropping to the default", () => {
    // A wake re-plans from the document's argv. Without mode recovery a seat
    // created in ultra would come back in Amp's default mode.
    const resolved = launchForManagedSpawn({
      harness: "amp",
      agentKey: "local:amp",
      sessionId: "T-01a03989-71a6-733b-ac4c-76f54969cb55",
      resume: true,
      documentLaunch: {
        kind: "harness" as const,
        argv: [
          "amp",
          "--no-ide",
          "threads",
          "continue",
          "T-01a03989-71a6-733b-ac4c-76f54969cb55",
          "-m",
          "ultra",
        ],
      },
    });
    expect(resolved.launch?.argv).toEqual([
      "amp",
      "--no-ide",
      "threads",
      "continue",
      "T-01a03989-71a6-733b-ac4c-76f54969cb55",
      "-m",
      "ultra",
    ]);
  });
});

describe("an Amp seat authored from the picker", () => {
  it("stores the picked mode in the node's launch argv", () => {
    const node = makeManagedAgentNode(0, 0, {
      harness: "amp",
      host: "local",
      mode: "ultra",
    });
    const argv = node.ether?.terminal?.launch?.argv ?? [];
    expect(argv.slice(0, 2)).toEqual(["amp", "--no-ide"]);
    expect(argv).toContain("-m");
    expect(argv[argv.indexOf("-m") + 1]).toBe("ultra");
    // The thread is Amp's to mint, so the node carries no session id yet.
    expect(node.ether?.terminal?.sessionId).toBeUndefined();
  });

  it("offers exactly the modes Amp documents, and no model list", () => {
    expect(AMP_TEMPLATE.modes).toEqual(["low", "medium", "high", "ultra"]);
    expect(AMP_TEMPLATE.efforts).toEqual([]);
    expect(AMP_TEMPLATE.argvSpec.modelFlag).toBeUndefined();
  });
});

describe("AC-1: Amp is offered only where it is installed", () => {
  it("finds amp on PATH and at its known install location, and nothing else", () => {
    expect(
      harnessBinaryInstalled("amp", "amp", {
        pathEnv: "/nowhere",
        home: "/fake-home",
        pathSep: ":",
      }),
    ).toBe(false);
  });

  it("offers modes rather than models in the picker's first column", () => {
    expect(firstCascadeColumn("amp")).toEqual({
      kind: "modes",
      modes: ["low", "medium", "high", "ultra"],
    });
    expect(firstCascadeColumn("claude")).toEqual({ kind: "models" });
    expect(firstCascadeColumn("hermes")).toEqual({ kind: "profiles" });
  });
});

describe("AC-7: mail waits for a verified idle Amp seat", () => {
  const snap = (
    title: string,
    lines: readonly string[],
  ): ObserverGridSnapshot => ({
    cols: 143,
    rows: 40,
    lines: [...lines],
    text: lines.join("\n"),
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
    seq: 1n,
    epoch: "e1",
    bindingId: "b1",
  });

  // Real frames again: a streaming turn, then the settled composer.
  const WORKING = snap("\u28f6 amp - ~/Projects/vellum", [
    "\u2570 ~ Streaming \u2500 ~/Projects/vellum (main) \u2500\u256f",
  ]);
  const IDLE = snap("Ready response - amp - ~/Projects/vellum", [
    "\u2570\u2500 ~/Projects/vellum (main) \u2500\u256f",
  ]);

  it("queues while the turn streams and submits once the turn settles", async () => {
    const writes: string[] = [];
    let seatIdle = evaluate(WORKING, { harness: "amp" }).state === "idle";
    expect(seatIdle).toBe(false);

    const drive = new ManagedTerminalDrive({
      write: (_bindingId, data) => {
        writes.push(data);
        return true;
      },
      isSeatIdle: () => seatIdle,
      stallWatch: false,
      pasteToCrSettleMs: 0,
    });

    const delivery = drive.writePrompt("b1", "mail body", {
      queueTimeoutMs: 5_000,
    });
    await Promise.resolve();
    expect(writes).toEqual([]);
    expect(drive.queuedCount("b1")).toBe(1);

    seatIdle = evaluate(IDLE, { harness: "amp" }).state === "idle";
    expect(seatIdle).toBe(true);
    drive.onSeatIdle("b1");
    expect(await delivery).toBe(true);
    expect(writes).toEqual([
      "\u001b[200~mail body\u001b[201~",
      "\r",
    ]);
    drive.resetForTest();
  });
});

describe("AC-8: a restart resumes the same thread without re-injecting doctrine", () => {
  const seat = (resume: boolean) => ({
    harness: "amp",
    agentKey: "local:amp",
    sessionId: "T-01a03989-71a6-733b-ac4c-76f54969cb55",
    resume,
    injection: {
      seatBound: true,
      connected: true,
      seatRef: "agent-1",
      connectedTargets: [
        { id: "task-1", kind: "task", title: "tasks", grants: ["tasks.list"] },
      ],
    },
    documentLaunch: {
      kind: "harness" as const,
      argv: [
        "amp",
        "--no-ide",
        "threads",
        "continue",
        "T-01a03989-71a6-733b-ac4c-76f54969cb55",
      ],
    },
  });

  it("re-opens the exact thread and arms no bootstrap message", () => {
    const resumed = planManagedSpawn(seat(true));
    expect(resumed?.launch?.argv).toEqual([
      "amp",
      "--no-ide",
      "threads",
      "continue",
      "T-01a03989-71a6-733b-ac4c-76f54969cb55",
    ]);
    // The thread already carries the doctrine in its own history.
    expect(resumed?.firstTypedMessage).toBeUndefined();
    expect(resumed?.injection.inject).toBe(false);
  });

  it("arms the Tier-B bootstrap for the freshly minted thread", () => {
    // The thread `amp threads new` just created is empty, so the first launch
    // is a fresh seat even though its argv is the resume subcommand. Without
    // this split an Amp seat would never receive its doctrine at all.
    const fresh = planManagedSpawn(seat(false));
    expect(fresh?.launch?.argv).toEqual([
      "amp",
      "--no-ide",
      "threads",
      "continue",
      "T-01a03989-71a6-733b-ac4c-76f54969cb55",
    ]);
    expect(fresh?.injection.tier).toBe("B");
    expect(fresh?.injection.inject).toBe(true);
    expect(fresh?.firstTypedMessage?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("AC-10: a thread that cannot be provisioned is visible, not silent", () => {
  it("keeps every failure inside one typed reason the seat can show", async () => {
    // Auth, network, and unreadable-receipt failures share one shape on
    // purpose: the seat surfaces a reason, and no path substitutes a
    // different thread or launches without one.
    const authFailure = await provisionAmpThread({
      run: async () => {
        throw new Error("not authenticated");
      },
    });
    const receiptFailure = await provisionAmpThread({
      run: async () => "some unrelated banner",
    });
    for (const failed of [authFailure, receiptFailure]) {
      expect(failed.ok).toBe(false);
      if (failed.ok) continue;
      expect(failed.failure.code).toBe("amp_thread_unprovisioned");
      expect(failed.failure.reason.length).toBeGreaterThan(0);
    }
  });

  it("never reaches a launch when the thread is unknown", () => {
    // The last line of defence: even if a caller ignored the failure, the
    // planner refuses to build argv without a thread.
    expect(
      launchForManagedSpawn({
        harness: "amp",
        agentKey: "local:amp",
        resume: true,
        documentLaunch: {
          kind: "harness" as const,
          argv: ["amp", "--no-ide", "threads", "continue"],
        },
      }).launch,
    ).toBeUndefined();
  });
});

describe("AC-9: provisioning touches only the public thread surface", () => {
  it("invokes one documented command and no config, cache, or log path", async () => {
    const calls: Array<readonly string[]> = [];
    await provisionAmpThread({
      run: async (_binary, args) => {
        calls.push(args);
        return "T-01a03989-71a6-733b-ac4c-76f54969cb55";
      },
    });
    expect(calls).toEqual([["threads", "new", "--visibility", "private"]]);
    const flat = calls.flat().join(" ");
    for (const forbidden of [
      "--settings-file",
      "--log-file",
      "--mcp-config",
      "plugins",
      "orb",
      "-x",
      "--execute",
    ]) {
      expect(flat).not.toContain(forbidden);
    }
  });
});
