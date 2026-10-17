/**
 * A seat's status on the seats channel carries the approved fields and
 * nothing else: what stays home is left out, not blanked, and a field the
 * snapshot gains later stays home until the wire names it.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeSeatsStatus, fromSeatsStatus, statusIssueAt, toSeatsStatus } from "../src/main/junto/term/seats-status";
import { AgentSeatStatus } from "../src/shared/agent-seat-state";
import { topNeed, type BindingId, type SeatSnapshot } from "../src/shared/harness-domain";

const AT = 1_792_000_000_000;

const full = (extra: Partial<SeatSnapshot> = {}): SeatSnapshot => ({
  seat: "mini-binding" as BindingId,
  status: { _tag: "Blocked", reason: { _tag: "Error", kind: "auth", message: "401 for key sk-live-abc at /Users/me/.env" } },
  since: AT,
  statusSource: "screen",
  statusFidelity: "screen",
  activity: { status: { _tag: "Working", phase: "tool" }, source: "osc7501", fidelity: "native" },
  channels: ["screen", "osc7501"],
  sessionId: "0b7a2c1e-session",
  transcriptPath: "/Users/me/.claude/projects/x/0b7a2c1e.jsonl",
  usage: { contextPct: 42, contextTokens: 84_000, contextWindow: 200_000, quotaPct: 90, quotaWindow: "weekly", costUsd: 1.25, at: AT },
  lastError: { kind: "auth", message: "Not logged in, Please run /login", at: AT },
  compaction: { trigger: "manual", since: AT },
  turnUnseen: { outcome: "completed", since: AT },
  reports: [{ kind: "blocked", signalId: "01M53Z-signal", text: "Need the staging key sk-live-abc", since: AT }],
  awareness: [
    {
      questionId: "q.activity",
      answer: { axis: "activity", value: "editing" },
      probability: 0.8,
      evidenceHash: "abc123",
      since: AT,
    },
  ],
  stalledSince: AT,
  wakeAt: AT + 60_000,
  lastDelivery: { messageId: "01M53Z-msg", ok: false, reason: "composer held a draft: rm -rf ~", at: AT },
  updatedAt: AT,
  ...extra,
});

const statusOf = (snapshot: SeatSnapshot) => ({ snapshot, need: topNeed(snapshot) });

const APPROVED_SNAPSHOT_KEYS = [
  "status", "since", "statusSource", "statusFidelity", "activity", "channels", "usage", "lastError",
  "compaction", "turnUnseen", "reports", "awareness", "stalledSince", "wakeAt", "lastDelivery", "updatedAt",
];

describe("the seats wire status", () => {
  it("carries the approved fields and leaves what stays home out", () => {
    const wire = toSeatsStatus(statusOf(full()))!;
    expect(Object.keys(wire.snapshot).sort()).toEqual([...APPROVED_SNAPSHOT_KEYS].sort());
    expect(wire.snapshot.status).toEqual({ _tag: "Blocked", reason: { _tag: "Error", kind: "auth" } });
    expect(wire.snapshot.lastError).toEqual({ kind: "auth", at: AT });
    expect(wire.snapshot.reports).toEqual([{ kind: "blocked", signalId: "01M53Z-signal", since: AT }]);
    expect(wire.snapshot.lastDelivery).toEqual({ messageId: "01M53Z-msg", ok: false, at: AT });
    const text = JSON.stringify(wire);
    for (const home of ["sk-live-abc", "Not logged in", "rm -rf", "0b7a2c1e", "/Users/me"]) {
      expect(text).not.toContain(home);
    }
  });

  it("a field the snapshot gains later still encodes only the approved list", () => {
    const grown = {
      ...full(),
      secretNewField: "a token",
      status: { _tag: "Blocked", reason: { _tag: "Permission", tool: "Bash", command: "cat ~/.ssh/id_rsa" } },
      usage: { at: AT, contextPct: 10, apiKey: "sk-live-abc" },
    } as unknown as SeatSnapshot;
    const wire = toSeatsStatus(statusOf(grown))!;
    expect(Object.keys(wire.snapshot).sort()).toEqual([...APPROVED_SNAPSHOT_KEYS].sort());
    expect(wire.snapshot.status).toEqual({ _tag: "Blocked", reason: { _tag: "Permission", tool: "Bash" } });
    expect(wire.snapshot.usage).toEqual({ contextPct: 10, at: AT });
    expect(JSON.stringify(wire)).not.toMatch(/secretNewField|id_rsa|sk-live/u);
  });

  it("a name or id outside its pattern does not cross", () => {
    const wire = toSeatsStatus(
      statusOf(
        full({
          status: { _tag: "Blocked", reason: { _tag: "Permission", tool: "rm -rf /", requestId: "toolu 01" } },
          reports: [{ kind: "escalate", signalId: "has spaces", since: AT }],
          lastDelivery: { messageId: "../../etc", ok: true, at: AT },
        }),
      ),
    )!;
    expect(wire.snapshot.status).toEqual({ _tag: "Blocked", reason: { _tag: "Permission" } });
    expect(wire.snapshot.reports).toEqual([]);
    expect(wire.snapshot.lastDelivery).toBeUndefined();

    const exited = toSeatsStatus(statusOf(full({ status: { _tag: "Exited", code: 143, signal: "SIGTERM", expected: false } })))!;
    expect(exited.snapshot.status).toEqual({ _tag: "Exited", code: 143, signal: "SIGTERM", expected: false });
    const odd = toSeatsStatus(statusOf(full({ status: { _tag: "Exited", signal: "kill me" } })))!;
    expect(odd.snapshot.status).toEqual({ _tag: "Exited" });
  });

  it("the receiver holds a status that reads, on its own binding", () => {
    const wire = toSeatsStatus(statusOf(full({ status: { _tag: "Blocked", reason: { _tag: "Question", text: "which key?" } } })))!;
    const held = fromSeatsStatus(wire, "edit-binding" as BindingId);
    expect(Schema.is(AgentSeatStatus)(held)).toBe(true);
    expect(held.snapshot.seat).toBe("edit-binding");
    expect(held.snapshot.status).toEqual({ _tag: "Blocked", reason: { _tag: "Question" } });
    expect(held.snapshot.turnUnseen).toEqual({ outcome: "completed", since: AT });
  });

  it("where a status failed to read names the path and kind, never a peer value", () => {
    const wire = toSeatsStatus(statusOf(full()))!;
    const failed = (value: unknown): string => {
      try {
        decodeSeatsStatus(value);
      } catch (cause) {
        return statusIssueAt(cause);
      }
      throw new Error("decoded");
    };
    const bad = failed({ ...wire, snapshot: { ...wire.snapshot, lastDelivery: { messageId: "PEER-SECRET value", ok: true, at: AT } } });
    expect(bad).toMatch(/^\w+ at snapshot\.lastDelivery\.messageId$/u);
    expect(bad).not.toContain("PEER-SECRET");
    const keyed = failed({ ...wire, snapshot: { ...wire.snapshot, "PEER SECRET KEY": 1 } });
    expect(keyed).not.toContain("PEER");
    expect(failed(7)).toMatch(/ at the status$/u);
  });

  it("the wire decodes closed and bounded", () => {
    const wire = toSeatsStatus(statusOf(full()))!;
    expect(() => decodeSeatsStatus({ ...wire, extra: 1 })).toThrow();
    expect(() => decodeSeatsStatus({ ...wire, snapshot: { ...wire.snapshot, sessionId: "s" } })).toThrow();
    expect(() => decodeSeatsStatus({ ...wire, snapshot: { ...wire.snapshot, transcriptPath: "/etc/passwd" } })).toThrow();
    expect(() =>
      decodeSeatsStatus({ ...wire, snapshot: { ...wire.snapshot, status: { _tag: "Blocked", reason: { _tag: "Question", text: "x" } } } }),
    ).toThrow();
    expect(() =>
      decodeSeatsStatus({ ...wire, snapshot: { ...wire.snapshot, reports: Array.from({ length: 33 }, () => wire.snapshot.reports[0]) } }),
    ).toThrow();
  });
});
