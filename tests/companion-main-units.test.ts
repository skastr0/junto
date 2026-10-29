/**
 * Small main-side companion pieces: the change clock long polls reports
 * signals whoever changed them and resets across a restart; the environment
 * parses Tailscale and orders hosts; the seat state follows the rollup order.
 */
import { describe, expect, it } from "vitest";
import type { AgentSignal } from "../src/shared/agent-signals";
import { companionSeat } from "../src/shared/companion-seats";
import { makeCompanionChanges } from "../src/main/junto/companion/changes";
import { lanAddressesOf, pairingHosts, parseTailscaleStatus } from "../src/main/junto/companion/environment";

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

  it("releases a waiting poll at once on close, and never waits after", async () => {
    const changes = makeCompanionChanges();
    const first = await changes.wait(undefined, 0);
    const waiting = changes.wait(first.cursor, 60_000);
    changes.close();
    await waiting;
    await changes.wait(first.cursor, 60_000);
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

  it("offers only real ports' LAN addresses, never a VM bridge, a tunnel or AirDrop", () => {
    const v4 = (address: string, internal = false) => ({ address, netmask: "255.255.255.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal, cidr: `${address}/24` });
    const v6 = { address: "fe80::1", netmask: "ffff::", family: "IPv6" as const, mac: "00:00:00:00:00:00", internal: false, cidr: "fe80::1/64", scopeid: 1 };
    expect(
      lanAddressesOf({
        lo0: [v4("127.0.0.1", true)],
        en0: [v6, v4("192.168.1.20")],
        en7: [v4("10.0.0.5")],
        bridge100: [v4("192.168.139.3")],
        vmnet8: [v4("172.16.1.1")],
        docker0: [v4("172.17.0.1")],
        utun4: [v4("100.101.102.103")],
        awdl0: [v6],
        eth0: [v4("192.168.2.9")],
        enp3s0: [v4("192.168.3.9")],
        wlan0: [v4("192.168.4.9")],
      }),
    ).toEqual(["192.168.1.20", "10.0.0.5", "192.168.2.9", "192.168.3.9", "192.168.4.9"]);
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
    expect(pick({ process: undefined })).toEqual(["offline", "not running"]);
    expect(pick({ control: at("working"), health: health("trouble") })).toEqual(["trouble", "AI reads: stuck"]);
    expect(pick({ control: at("idle"), health: health("waiting") })).toEqual(["waiting_on_you", "AI reads: wants your input"]);
    expect(pick({ control: at("working"), health: health("good") })).toEqual(["working", "AI reads: going well"]);
    expect(pick({ control: at("working"), health: health("trouble", true) })).toEqual(["working", "working"]);
    expect(pick({ control: at("idle"), doneUnread: true })).toEqual(["done_unread", "done, not read yet"]);
    expect(pick({ control: at("idle") })).toEqual(["resting", "resting"]);
    expect(companionSeat({ ...base, process: "running", control: at("idle") }).lastActivityAt).toBe(5);
  });

  it("carries the palette's level and when the seat took it, alongside the ring", () => {
    const control = (state: "idle" | "working" | "attention", reason = "") => ({ state, reason, at: 5 });
    const level = (input: Partial<Parameters<typeof companionSeat>[0]>) => {
      const seat = companionSeat({ ...base, process: "running", ring: { since: 10, activitySince: 20, turnUnseenSince: 30, signalAt: 40 }, ...input });
      return [seat.ring?.ring, seat.level, seat.levelSince];
    };
    const feedback = { kind: "feedback" as const, signalId: "s", openCount: 1 };
    // The ring draws feedback as waiting; the palette puts it in review, below working.
    expect(level({ control: control("idle"), signal: feedback })).toEqual(["wait", "review", 40]);
    expect(level({ control: control("idle"), signal: { ...feedback, kind: "escalate" } })).toEqual(["wait", "escalated", 40]);
    expect(level({ control: control("idle"), signal: { ...feedback, kind: "blocked" } })).toEqual(["halt", "blocked", 40]);
    expect(level({ control: control("attention", "permission prompt") })[1]).toBe("waiting");
    expect(level({ control: control("working") }).slice(1)).toEqual(["working", 20]);
    expect(level({ control: control("idle"), doneUnread: true }).slice(1)).toEqual(["done", 30]);
    expect(level({ control: control("idle") }).slice(1)).toEqual(["resting", 10]);
    expect(level({ process: undefined }).slice(1)).toEqual(["offline", 10]);
    expect(level({ control: control("idle"), ring: { exitReason: "spawn_failed" } })[1]).toBe("stopped");
    expect(level({ control: control("idle"), ring: {} }).slice(1)).toEqual(["resting", 5]);
    // No ring facts, no ring and no level: an older Mac's seat shape.
    expect(companionSeat({ ...base, process: "running", control: control("idle") }).level).toBeUndefined();
  });
});
