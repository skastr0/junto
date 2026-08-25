import { describe, expect, it } from "vitest";
import {
  isAmpThreadId,
  parseAmpThreadReceipt,
  provisionAmpThread,
} from "../src/main/vellum/term/templates/amp-thread";
import {
  ensureProvisionedSessionId,
  usesProvisionedSession,
} from "../src/main/vellum/term/amp-seat-thread";
import {
  launchForManagedSpawn,
  planManagedSpawn,
} from "../src/main/vellum/term/managed-spawn-plan";
import { makeManagedAgentNode } from "../src/renderer/lib/node-factories";
import { AMP_TEMPLATE } from "../src/shared/managed-terminal-templates";

// The receipt shape below is real output from
// `amp threads new --visibility private` on 0.0.1787664850.
const REAL_RECEIPT = "T-01a03989-71a6-733b-ac4c-76f54969cb55\n";

describe("amp thread receipts", () => {
  it("accepts the id Amp actually prints", () => {
    expect(parseAmpThreadReceipt(REAL_RECEIPT)).toBe(
      "T-01a03989-71a6-733b-ac4c-76f54969cb55",
    );
    expect(isAmpThreadId("T-01a03989-71a6-733b-ac4c-76f54969cb55")).toBe(true);
  });

  it("reads the id out of surrounding chatter", () => {
    expect(
      parseAmpThreadReceipt(
        ["A new version of Amp is available.", REAL_RECEIPT.trim(), ""].join("\n"),
      ),
    ).toBe("T-01a03989-71a6-733b-ac4c-76f54969cb55");
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
