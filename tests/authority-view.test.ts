import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AuthorityRead,
  AuthorityStatusData,
  authorityAloneWarning,
  authorityBannerOf,
  authorityMachineLine,
  authorityPairOf,
  authorityStatusOf,
  authorityViewOf,
  authorityWaitReason,
  authorityWaitingLine,
  type AuthorityMachineFacts,
  type AuthorityRead as AuthorityReadValue,
} from "../src/shared/authority";
import type { InstallationId } from "../src/shared/installation-id";

const id = (value: string): InstallationId => value as InstallationId;
const T0112 = Date.UTC(2026, 9, 28, 1, 12);
const clock = (at: number): string => (at === T0112 ? "01:12" : `t${at}`);

const mac: AuthorityMachineFacts = {
  installationId: id("install-mac"),
  name: "macbook",
  label: "MacBook",
  reach: "here",
  since: null,
};
const mini: AuthorityMachineFacts = {
  installationId: id("install-mini"),
  name: "mini",
  label: "Mac mini",
  reach: "asleep",
  since: T0112,
};
const vps: AuthorityMachineFacts = {
  installationId: id("install-vps"),
  name: "vps",
  label: "VPS",
  reach: "unreachable",
  since: null,
};

const read = (overrides: Partial<AuthorityReadValue> = {}): AuthorityReadValue => ({
  canvas: "factory",
  self: mac.installationId,
  role: "leader",
  term: 8,
  leader: mac.installationId,
  commit: 41,
  lastIndex: 41,
  members: { list: [mac.installationId, mini.installationId] },
  fresh: false,
  canCommit: false,
  lastCommitAt: T0112,
  waitingForOperator: { total: 0, commands: 0, structure: 0 },
  authorityReachable: false,
  ...overrides,
});

describe("the authority view", () => {
  it("maps installation ids to the operator's machine names, in list order", () => {
    const view = authorityViewOf(read(), [mac, mini, vps]);
    expect(view.self.label).toBe("MacBook");
    expect(view.authority?.label).toBe("MacBook");
    expect(view.list.map((machine) => machine.label)).toEqual(["MacBook", "Mac mini"]);
    expect(view.list[0]?.isAuthority).toBe(true);
    expect(view.list[1]?.isAuthority).toBe(false);
    expect(view.staleSince).toBe(T0112);
  });

  it("keeps a listed machine the list does not know as not linked", () => {
    const unknown = id("install-unknown");
    const view = authorityViewOf(read({ members: { list: [mac.installationId, unknown] } }), [mac]);
    expect(view.list[1]).toMatchObject({
      installationId: unknown,
      name: "install-unknown",
      label: "install-unknown",
      reach: "not-linked",
      since: null,
    });
  });

  it("shows a joint list apart from the committed one", () => {
    const view = authorityViewOf(
      read({
        pendingList: {
          list: [mac.installationId, mini.installationId, vps.installationId],
          old: [mac.installationId, mini.installationId],
        },
      }),
      [mac, mini, vps],
    );
    expect(view.list.map((machine) => machine.label)).toEqual(["MacBook", "Mac mini"]);
    expect(view.pending?.list.map((machine) => machine.label)).toEqual(["MacBook", "Mac mini", "VPS"]);
    expect(view.pending?.old?.map((machine) => machine.label)).toEqual(["MacBook", "Mac mini"]);
    expect(view.pending?.sole).toBeUndefined();
  });

  it("clears the stale mark while an authority is reachable", () => {
    const view = authorityViewOf(read({ authorityReachable: true, canCommit: true }), [mac, mini]);
    expect(view.staleSince).toBeNull();
  });
});

describe("the words", () => {
  it("names each listed machine and its state when a write cannot be ruled", () => {
    const withVps = authorityViewOf(
      read({ members: { list: [mac.installationId, mini.installationId, vps.installationId] } }),
      [mac, mini, vps],
    );
    expect(authorityWaitReason(withVps, clock)).toBe(
      "No machine can take changes for factory right now. This write waits and is applied when one is back. This machine, Mac mini asleep since 01:12, VPS unreachable.",
    );
    expect(authorityWaitReason(authorityViewOf(read({ authorityReachable: true, canCommit: true }), [mac, mini]), clock)).toBeUndefined();
  });

  it("stops naming machines after six and says how many more", () => {
    const facts: AuthorityMachineFacts[] = [mac, mini, vps, ...Array.from({ length: 5 }, (_, index) => ({
      installationId: id(`install-${index}`),
      name: `machine-${index}`,
      label: `Machine ${index}`,
      reach: "unreachable" as const,
      since: null,
    }))];
    const view = authorityViewOf(
      read({ members: { list: facts.map((machine) => machine.installationId) } }),
      facts,
    );
    expect(authorityWaitReason(view, clock)).toContain("and 2 more");
  });

  it("draws a read-only banner with the states, the read mark and the waiting line", () => {
    const view = authorityViewOf(
      read({ waitingForOperator: { total: 3, commands: 2, structure: 1 } }),
      [mac, mini],
    );
    expect(authorityBannerOf(view, clock)).toEqual({
      kind: "read-only",
      title: "No machine can take changes for this canvas",
      lines: [
        "This machine, Mac mini asleep since 01:12",
        "Reads are as of 01:12, the last change this machine heard.",
        "This window is read-only. Work from seats keeps being recorded and is applied when a machine is back.",
        "3 changes made while another machine held authority are kept. They wait for you to apply or discard them.",
      ],
    });
  });

  it("draws only the waiting banner once an authority is back", () => {
    const view = authorityViewOf(
      read({ authorityReachable: true, canCommit: true, waitingForOperator: { total: 1, commands: 1, structure: 0 } }),
      [mac, mini],
    );
    expect(authorityBannerOf(view, clock)).toEqual({
      kind: "waiting",
      title: "Changes made while another machine held authority",
      lines: ["1 change made while another machine held authority is kept. It waits for you to apply or discard it."],
    });
  });

  it("says nothing when there is neither a missing authority nor a kept change", () => {
    const view = authorityViewOf(read({ authorityReachable: true, canCommit: true }), [mac, mini]);
    expect(authorityBannerOf(view, clock)).toBeUndefined();
    expect(authorityWaitingLine({ total: 0, commands: 0, structure: 0 })).toBeUndefined();
  });

  it("reads a machine by its state", () => {
    const view = authorityViewOf(read(), [mac, mini, vps]);
    expect(view.list.map((machine) => authorityMachineLine(machine, clock))).toEqual([
      "this machine",
      "Mac mini asleep since 01:12",
    ]);
    expect(authorityMachineLine({ ...vps, isAuthority: false }, clock)).toBe("VPS unreachable");
    expect(authorityMachineLine({ ...mini, reach: "reachable", since: null, isAuthority: false }, clock)).toBe(
      "Mac mini reachable",
    );
    const reachable = authorityViewOf(read(), [mac, { ...mini, reach: "reachable", since: null }]);
    expect(authorityWaitReason(reachable, clock)).toContain("Mac mini reachable but not taking changes");
  });
});

describe("alone", () => {
  it("warns what a fork keeps, and what the later term does on contact", () => {
    const warning = authorityAloneWarning({ canvas: "factory", self: "MacBook", other: "Mac mini", pending: false });
    expect(warning).toContain("Making MacBook the only machine that takes changes for factory.");
    expect(warning).toContain("both machines have kept their own");
    expect(warning).toContain("When they meet, the later one wins.");
    expect(warning).toContain("Seat and automation writes from the other side go back to their queues as commands.");
    expect(warning).toContain("Changes made in a window are kept and wait for you to apply or discard them");
    expect(warning).toContain("Nothing that was applied is deleted.");
    expect(warning).not.toContain("list change that had not been applied");
    expect(warning).not.toContain("·");
  });

  it("says an uncommitted list change is dropped, not deleted", () => {
    const warning = authorityAloneWarning({ canvas: "factory", self: "MacBook", other: "Mac mini", pending: true });
    expect(warning).toContain("A list change that had not been applied is dropped; it never took effect.");
    expect(warning).toContain("Nothing that was applied is deleted.");
  });

  it("finds the other machine only for a committed pair", () => {
    const pair = authorityViewOf(read(), [mac, mini]);
    expect(authorityPairOf(pair).other?.label).toBe("Mac mini");
    const three = authorityViewOf(
      read({ members: { list: [mac.installationId, mini.installationId, vps.installationId] } }),
      [mac, mini, vps],
    );
    expect(authorityPairOf(three).other).toBeNull();
    expect(authorityPairOf(authorityViewOf(read({ members: { list: [mac.installationId] } }), [mac])).other).toBeNull();
  });
});

describe("status", () => {
  it("carries the same view the banner uses", () => {
    const status = authorityStatusOf({
      self: mac,
      machines: [mac, mini],
      canvases: [read({ waitingForOperator: { total: 2, commands: 0, structure: 2 } })],
    });
    expect(status.self).toEqual(mac);
    expect(status.machines.map((machine) => machine.label)).toEqual(["MacBook", "Mac mini"]);
    expect(status.canvases[0]).toMatchObject({
      canvas: "factory",
      term: 8,
      authorityReachable: false,
      canCommit: false,
      staleSince: T0112,
      waiting: { total: 2, commands: 0, structure: 2 },
    });
    expect(status.canvases[0]?.list.map((machine) => machine.label)).toEqual(["MacBook", "Mac mini"]);
    expect(() => Schema.decodeUnknownSync(AuthorityStatusData)(status)).not.toThrow();
  });

  it("decodes the driver's read", () => {
    const decoded = Schema.decodeUnknownSync(AuthorityRead)(read());
    expect(decoded.canvas).toBe("factory");
    expect(decoded.members.list).toEqual([mac.installationId, mini.installationId]);
  });
});
