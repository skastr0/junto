/**
 * Small main-side companion pieces: the change clock long polls reports
 * signals whoever changed them and resets across a restart; the environment
 * parses Tailscale and orders hosts; the seat state follows the rollup order.
 */
import { describe, expect, it } from "vitest";
import type { AgentSignal } from "../src/shared/agent-signals";
import { companionSeat } from "../src/shared/companion-seats";
import { makeCompanionChanges } from "../src/main/junto/companion/changes";
import { pairingHosts, parseTailscaleStatus } from "../src/main/junto/companion/environment";

const signal = (state: AgentSignal["state"]): AgentSignal => ({
  signalId: "sig_1",
  canvasName: "main",
  nodeId: "planner",
  kind: "blocked",
  text: "stuck",
  createdAt: 1,
  state,
});

describe("companion change clock", () => {
  it("returns at once for a fresh cursor, then wakes on a change with the signals since", async () => {
    const changes = makeCompanionChanges();
    const first = await changes.wait(undefined, 1_000);
    expect(first).toMatchObject({ changed: false, signals: [], reset: false });
    const waiting = changes.wait(first.cursor, 5_000);
    changes.noteSignal(signal("open"));
    changes.noteSignal(signal("answered"));
    const woke = await waiting;
    expect(woke.changed).toBe(true);
    expect(woke.signals.map((s) => s.state)).toEqual(["open", "answered"]);
    const quiet = await changes.wait(woke.cursor, 20);
    expect(quiet).toMatchObject({ changed: false, signals: [] });
  });

  it("reads a cursor from another boot as a reset", async () => {
    const before = await makeCompanionChanges().wait(undefined, 0);
    const after = await makeCompanionChanges().wait(before.cursor, 0);
    expect(after.reset).toBe(true);
  });
});

describe("companion environment", () => {
  it("parses tailscale status and orders hosts without repeats", () => {
    const tailscale = parseTailscaleStatus(
      JSON.stringify({ Self: { DNSName: "mac.tail1234.ts.net.", TailscaleIPs: ["fd7a:115c::1", "100.101.102.103"] } }),
    );
    expect(tailscale).toEqual({ name: "mac.tail1234.ts.net", address: "100.101.102.103" });
    expect(parseTailscaleStatus("not json")).toBeUndefined();
    expect(parseTailscaleStatus(JSON.stringify({ Self: {} }))).toBeUndefined();
    expect(pairingHosts({ tailscale, localName: "mac.local", lanAddresses: ["192.168.1.2", "192.168.1.2"] })).toEqual([
      "mac.tail1234.ts.net",
      "100.101.102.103",
      "mac.local",
      "192.168.1.2",
    ]);
    expect(pairingHosts({ tailscale: undefined, localName: "mac.local", lanAddresses: [] })).toEqual(["mac.local"]);
  });
});

describe("companion seat state", () => {
  const base = {
    seat: { nodeId: "n", name: "N", portraitIdentity: "n" },
    region: { regionId: null, label: "open field", path: [] },
  };
  const health = (tone: "trouble" | "waiting" | "good", stale = false) => ({
    value: tone === "trouble" ? ("stuck" as const) : tone === "waiting" ? ("waiting_on_operator" as const) : ("going_well" as const),
    tone,
    label: tone === "trouble" ? "stuck" : tone === "waiting" ? "wants your input" : "going well",
    confidence: 0.9,
    observedAt: 1,
    stale,
  });

  it("reads signal, then proven attention, then process, then health, then control", () => {
    const at = (state: "idle" | "working" | "attention" | "unknown" | "gone", reason = "") => ({ state, reason, at: 5 });
    const pick = (input: Partial<Parameters<typeof companionSeat>[0]>) => {
      const seat = companionSeat({ ...base, process: "running", ...input });
      return [seat.state, seat.line];
    };
    expect(pick({ signal: { kind: "blocked", signalId: "s", openCount: 1 }, control: at("attention") })).toEqual(["blocked", "blocked"]);
    expect(pick({ control: at("attention", "permission prompt"), health: health("trouble") })).toEqual(["needs_input", "wants your input"]);
    expect(pick({ control: at("attention", "stalled"), health: health("trouble") })).toEqual(["needs_input", "stalled, needs a look"]);
    expect(pick({ process: "stopped", health: health("trouble") })).toEqual(["stopped", "stopped"]);
    expect(pick({ process: "starting" })).toEqual(["starting", "starting up"]);
    expect(pick({ process: undefined })).toEqual(["offline", "offline"]);
    expect(pick({ control: at("working"), health: health("trouble") })).toEqual(["trouble", "AI reads: stuck"]);
    expect(pick({ control: at("idle"), health: health("waiting") })).toEqual(["waiting_on_you", "AI reads: wants your input"]);
    expect(pick({ control: at("working"), health: health("good") })).toEqual(["working", "AI reads: going well"]);
    expect(pick({ control: at("working"), health: health("trouble", true) })).toEqual(["working", "working"]);
    expect(pick({ control: at("idle"), doneUnread: true })).toEqual(["done_unread", "done, not read yet"]);
    expect(pick({ control: at("idle") })).toEqual(["resting", "resting"]);
    expect(companionSeat({ ...base, process: "running", control: at("idle") }).lastActivityAt).toBe(5);
  });
});
