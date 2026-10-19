/**
 * The phone's machines tab, Phase A (read only): what the owner's answers
 * become on the phone, under remote-security's terms. Every free text is
 * scrubbed again at the companion encode, outside tailnet strings are
 * cleaned and capped, typed fields are checked and dropped, a check crosses
 * as a duration, and the worst case built from the bounds fits the frame.
 */
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { handleCompanionRequest, makeCompanionGates, outcomeOk, type CompanionBackend } from "../src/shared/companion-core";
import { demoRequest, makeDemoHost } from "../src/shared/companion-demo";
import {
  companionMachineLogs,
  companionMachineStatus,
  companionMachines,
  companionTailnetPeers,
  MACHINE_LOG_UNAVAILABLE,
  type CompanionMachineCheck,
} from "../src/shared/companion-machines";
import {
  COMPANION_MACHINE_CHECK_AGO_MAX_MS,
  COMPANION_MACHINE_LOG_ROWS,
  COMPANION_MAX_OUTBOUND_BYTES,
  CompanionResults,
  companionOk,
  decodeCompanionRequestLine,
  encodeCompanionFrame,
  type CompanionMachine,
  type CompanionRequestFrame,
} from "../src/shared/companion-protocol";
import { runCompanionSession, type CompanionHost } from "../src/shared/companion-session";
import { DEMO_MACHINES, DEMO_TAILNET } from "../src/shared/wire/companion-demo-fixture";
import type { MachineListData, MachinePeerStatus } from "../src/shared/machine-control";
import type { MachineLogRead } from "../src/shared/machine-log";
import { companionMachineScrub as scrub } from "../src/main/junto/companion/machine-scrub";
import { THIS_MACHINE } from "./support/machines";

const TOKEN = "ghp_0123456789abcdefghijABCDEFGHIJ0123456789";
const FAILURE = { tag: "SshConnectTimeout", message: `ssh said ${TOKEN}`, machine: "mini", causes: [] };

const listed = (id: string, extra: Partial<MachineListData["machines"][number]["machine"]> = {}): MachineListData["machines"][number] => ({
  machine: { id, label: id, isThisMachine: false, capabilities: ["terminal"], sshEndpoint: `me@${id}`, ...extra } as never,
  setUp: true,
  needsUpdate: false,
});

const peerStatus = (over: Partial<MachinePeerStatus> = {}): MachinePeerStatus =>
  ({ machineName: "mini", reachable: true, harnesses: [], missingSecrets: [], ...over }) as MachinePeerStatus;

const logRead = (rows: ReadonlyArray<Partial<MachineLogRead["rows"][number]>>): MachineLogRead =>
  ({
    machine: "mini",
    cut: false,
    unreadable: 0,
    rows: rows.map((row) => ({ time: "2026-10-19T01:00:00.000Z", level: "info", machine: "mini", process: "main", source: "app", area: "link", message: "ok", ...row })),
  }) as MachineLogRead;

const encoded = (value: unknown): string => encodeCompanionFrame(companionOk("r1", "machine.get", value as never));

describe("free text is scrubbed again where it is encoded for the phone", () => {
  it("drops a token from a log row, a failure, a status detail and a peer failure", () => {
    const status = companionMachineStatus(peerStatus({ detail: `stalled at ${TOKEN}`, failure: FAILURE }), [], scrub);
    const logs = companionMachineLogs(logRead([{ message: `opened with ${TOKEN}`, failure: FAILURE }]), COMPANION_MACHINE_LOG_ROWS, scrub);
    const machine = companionMachines([listed("mini")], undefined, new Map(), 0, scrub)[0]!;
    const line = encoded({ machine, status, logs });
    expect(line).not.toContain("internal");
    expect(line).not.toContain(TOKEN);
    expect(line).toContain("[redacted]");
  });

  it("says a log that could not be read with a fixed sentence only", () => {
    for (const sentence of Object.values(MACHINE_LOG_UNAVAILABLE)) expect(sentence.length).toBeLessThanOrEqual(256);
    const demo = DEMO_MACHINES.flatMap((entry) => (typeof entry.logs === "string" ? [entry.logs] : []));
    for (const sentence of demo) expect(Object.values(MACHINE_LOG_UNAVAILABLE)).toContain(sentence);
  });
});

describe("tailnet strings are outside text", () => {
  const snapshot = {
    peers: [
      { hostName: "nas‮\u001b[31mevil", dnsName: "nas.tail1234.ts.net.", os: "linux".repeat(20), online: true, ipv4: "100.64.0.9" },
      { hostName: "\u0007\u0008", online: false, ipv4: "100.64.0.10" },
      { hostName: "x".repeat(200), online: true },
      { hostName: "mini", dnsName: "mini.tail1234.ts.net", os: "macOS", online: true, ipv4: "100.64.0.2" },
    ],
  };

  it("are cleaned, capped, and carry only the five named fields", () => {
    const peers = companionTailnetPeers([listed("mini")], snapshot, scrub);
    expect(peers.map((peer) => peer.name)).toEqual(["nasevil", `${"x".repeat(63)}\u2026`, "mini"]);
    expect(peers[0]!.dnsName).toBe("nas.tail1234.ts.net");
    expect(peers[0]!.os!.length).toBe(32);
    expect(peers[2]!.machine).toBe("mini");
    for (const peer of peers) for (const key of Object.keys(peer)) expect(["name", "dnsName", "os", "online", "machine"]).toContain(key);
    expect(JSON.stringify(peers)).not.toContain("100.64");
  });

  it("set a machine's tailnet flag from the device it matches, and unknown when none does", () => {
    const [mini, gone] = companionMachines([listed("mini"), listed("gone")], snapshot, new Map(), 0, scrub);
    expect(mini!.tailnet).toBe("online");
    expect(gone!.tailnet).toBe("unknown");
  });
});

describe("a check crosses as a duration", () => {
  it("is its age on this Mac's clock, and is not sent once older than the bound", () => {
    const checks = new Map<string, CompanionMachineCheck>([
      ["mini", { at: 1_000, reachable: true }],
      ["old", { at: 0, reachable: false }],
    ]);
    const now = COMPANION_MACHINE_CHECK_AGO_MAX_MS + 1;
    const [mini, old] = companionMachines([listed("mini"), listed("old")], undefined, checks, now, scrub);
    expect(mini!.lastCheck).toEqual({ checkedAgoMs: now - 1_000, reachable: true });
    expect(old!.lastCheck).toBeUndefined();
    expect(JSON.stringify(mini)).not.toContain('"at"');
  });
});

describe("typed fields are checked, not scrubbed", () => {
  it("drops what fails its own schema", () => {
    const status = companionMachineStatus(
      peerStatus({ missingSecrets: ["OPENAI_API_KEY", "not a name", "sk-ant=value"], failure: { ...FAILURE, tag: "bad tag!" } }),
      [],
      scrub,
    );
    expect(status.missingSecrets).toEqual(["OPENAI_API_KEY"]);
    expect(status.failure!.tag).toBe("Failure");
    const logs = companionMachineLogs(logRead([{ canvas: "demo", seat: "atlas" }, { canvas: "../x" as never, seat: "a b" as never }]), 50, scrub);
    if (!("rows" in logs)) throw new Error("rows expected");
    expect(logs.rows[0]).toMatchObject({ canvas: "demo", seat: "atlas" });
    expect(logs.rows[1]!.canvas).toBeUndefined();
    expect(logs.rows[1]!.seat).toBeUndefined();
    expect(companionMachines([listed("ok"), listed("Not A Name!")], undefined, new Map(), 0, scrub).map((m) => m.name)).toEqual(["ok"]);
  });

  it("shows the first 12 hex of this machine's build and nothing of a peer's", () => {
    const own = companionMachineStatus(
      { build: "a".repeat(64), form: "macbook", installationId: "x", machineName: "macbook", juntoHome: "/Users/me", pid: 7, ready: true } as never,
      [],
      scrub,
    );
    expect(own.build).toBe("a".repeat(12));
    expect(JSON.stringify(own)).not.toContain("/Users/me");
    expect(companionMachineStatus(peerStatus(), [], scrub).build).toBeUndefined();
  });
});

describe("size", () => {
  it("keeps the worst machine.get the bounds allow under the outbound frame", () => {
    const text = '"\\'.repeat(400).slice(0, 1024);
    const failure = { tag: "T".repeat(64), message: text };
    const worst = {
      machine: { name: "m".repeat(64), label: "l".repeat(64), thisMachine: false, form: "mac-studio", setUp: true, needsUpdate: true, tailnet: "online",
        lastCheck: { checkedAgoMs: COMPANION_MACHINE_CHECK_AGO_MAX_MS, reachable: false, failure } },
      status: {
        reachable: false,
        keychain: "unavailable",
        harnesses: Array.from({ length: 32 }, (_, i) => ({ harness: `h${i}`.padEnd(64, "h"), installed: true, signIn: "keychain-login-unavailable" })),
        missingSecrets: Array.from({ length: 64 }, (_, i) => `S${i}`.padEnd(128, "S")),
        detail: text,
        failure,
      },
      logs: {
        rows: Array.from({ length: COMPANION_MACHINE_LOG_ROWS }, () => ({
          time: "2".repeat(32), level: "fatal", area: "a".repeat(48), message: text, canvas: "c".repeat(64), seat: "s".repeat(128), failure,
        })),
        cut: true,
      },
    };
    expect(Result.isSuccess(Schema_decode(worst))).toBe(true);
    const line = encoded(worst);
    expect(line).not.toContain('"internal"');
    expect(new TextEncoder().encode(line).byteLength).toBeLessThan(COMPANION_MAX_OUTBOUND_BYTES);
  });
});

import { Schema } from "effect";
const Schema_decode = Schema.decodeUnknownResult(CompanionResults["machine.get"]);

describe("against the demo", () => {
  const demo = () => makeDemoHost({ appVersion: "test", machineName: THIS_MACHINE });
  const frame = (op: string, args: object): CompanionRequestFrame => {
    const decoded = decodeCompanionRequestLine(demoRequest("m1", op as never, args));
    if (Result.isFailure(decoded)) throw new Error("did not decode");
    return decoded.success;
  };

  it("lists every state, reads one machine with a level filter, and lists the tailnet", async () => {
    const host = demo();
    const list = await host.call(frame("machines.list", {}));
    expect(list).toMatchObject({ ok: true, result: { machines: DEMO_MACHINES.map((entry) => entry.machine) } });
    const mini = await host.call(frame("machine.get", { name: "mini", minLevel: "error" }));
    expect(mini).toMatchObject({ ok: true, result: { logs: { rows: [{ level: "error" }] } } });
    expect(await host.call(frame("machine.get", { name: "nowhere" }))).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(await host.call(frame("tailnet.peers", {}))).toMatchObject({ ok: true, result: { available: true, peers: DEMO_TAILNET } });
  });

  it("refuses a level outside the closed list", () => {
    expect(Result.isFailure(decodeCompanionRequestLine(demoRequest("m2", "machine.get", { name: "mini", minLevel: "loud" })))).toBe(true);
  });
});

describe("machine.get in flight", () => {
  it("holds a phone to two unanswered reads", async () => {
    const waits: Array<() => void> = [];
    const backend = {
      machine: () => new Promise((resolve) => waits.push(() => resolve(outcomeOk({ ...DEMO_MACHINES[1]!, logs: { rows: [], cut: false } }) as never))),
    } as unknown as CompanionBackend;
    const gates = makeCompanionGates();
    const call = () => {
      const decoded = decodeCompanionRequestLine(demoRequest("g", "machine.get", { name: "mini" }));
      if (Result.isFailure(decoded)) throw new Error("did not decode");
      return handleCompanionRequest(decoded.success, { backend, device: { deviceId: "dev", state: "paired" }, allowWrite: () => true, gates });
    };
    const pending = [call(), call()];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await call()).toMatchObject({ ok: false, error: { code: "rate-limited" } });
    for (const wake of waits.splice(0)) wake();
    await Promise.all(pending);
    const again = call();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const wake of waits.splice(0)) wake();
    expect(await again).toMatchObject({ ok: true });
  });
});

describe("machines.changed", () => {
  it("is sent after a machines.list when a newer check lands, and not as ages grow", async () => {
    const base: CompanionMachine = { name: "mini", label: "Mac mini", thisMachine: false, setUp: true, needsUpdate: false, tailnet: "online", lastCheck: { checkedAgoMs: 1_000, reachable: true } };
    let current = base;
    let wake: (() => void) | undefined;
    let seq = 0;
    const host: CompanionHost = {
      hello: async () => ({ ok: true, hello: { appVersion: "t", deviceId: "dev", deviceName: "p", station: "s", serverTime: 0 } }),
      call: async (request) => companionOk(request.id, "machines.list", { machines: [current] }) as never,
      waitChange: (cursor) =>
        cursor === undefined
          ? Promise.resolve({ cursor: "c0", changed: false, signals: [], reset: false })
          : new Promise((resolve) => { wake = () => resolve({ cursor: `c${(seq += 1)}`, changed: true, signals: [], reset: false }); }),
    };
    const written: string[] = [];
    let feed: ((line: string) => void) | undefined;
    let end: (() => void) | undefined;
    const lines = (async function* () {
      for (;;) {
        const next = await new Promise<string | undefined>((resolve) => { feed = resolve; end = () => resolve(undefined); });
        if (next === undefined) return;
        yield next;
      }
    })();
    const session = runCompanionSession({ lines, write: (line) => written.push(line), host, waitMs: 10 });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    feed!(demoRequest("l1", "machines.list", {}));
    await tick();
    const events = () => written.filter((line) => line.includes('"machines.changed"'));
    current = { ...base, lastCheck: { checkedAgoMs: 5_000, reachable: true } };
    wake?.();
    await tick();
    expect(events()).toHaveLength(0);
    current = { ...base, lastCheck: { checkedAgoMs: 10, reachable: true } };
    wake?.();
    await tick();
    expect(events()).toHaveLength(1);
    end!();
    await session;
  });
});
