/**
 * `junto authority` over the owner socket (0.11/06 F5): every op answers
 * through the one host read, a refusal names the rule that stopped it, and
 * with AUTHORITY_ENABLED off every op is refused before the host is touched.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { CanvasAuthorities } from "../src/main/junto/fleet/authorities";
import { FleetDriverError } from "../src/main/junto/fleet/driver";
import { AuthorityOwnerControl, makeAuthorityOwnerActions } from "../src/main/junto/hosts/authority-owner";
import type { AuthorityMachineFacts, AuthorityRead } from "../src/shared/authority";
import { ALONE_TERM_STRIDE } from "../src/main/junto/fleet/consensus";
import type { InstallationId } from "../src/shared/installation-id";
import { OPERATOR_PROTOCOL_VERSION, decodeOperatorResponse } from "../src/shared/operator-control";

const id = (value: string): InstallationId => value as InstallationId;
const T0112 = Date.UTC(2026, 9, 28, 1, 12);

const mac: AuthorityMachineFacts = { installationId: id("install-mac"), name: "macbook", label: "MacBook", reach: "here", since: null };
const mini: AuthorityMachineFacts = { installationId: id("install-mini"), name: "mini", label: "Mac mini", reach: "not-linked", since: null };

const read = (overrides: Partial<AuthorityRead> = {}): AuthorityRead => ({
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

const request = (op: "authority.status" | "authority.list" | "authority.alone", args: object) => ({
  protocol: OPERATOR_PROTOCOL_VERSION,
  id: "req-1",
  op,
  args,
}) as never;

/** A host whose every method is a fixed answer; state `reads` is what status answers. */
const host = (options: {
  readonly reads?: ReadonlyArray<AuthorityRead>;
  readonly machines?: ReadonlyArray<AuthorityMachineFacts>;
  readonly setList?: (canvas: string, order: ReadonlyArray<string>) => AuthorityRead;
  readonly alone?: () => AuthorityRead;
  readonly touched?: () => void;
} = {}) =>
  CanvasAuthorities.of({
    judge: () => Effect.die("no batch is judged here"),
    landed: () => Effect.die("no entry is waited on here"),
    status: () => Effect.sync(() => (options.touched?.(), options.reads ?? [read()])),
    setList: (canvas, order) => Effect.sync(() => (options.touched?.(), (options.setList ?? (() => read()))(canvas, order))),
    alone: () => Effect.sync(() => (options.touched?.(), (options.alone ?? (() => read({ canCommit: true })))())),
    machines: () => Effect.sync(() => ({ self: mac, machines: options.machines ?? [mac, mini] })),
  });

const owner = (options: { readonly enabled: boolean } & Parameters<typeof host>[0] = { enabled: true }) =>
  makeAuthorityOwnerActions({ enabled: options.enabled }).pipe(
    Effect.provideService(CanvasAuthorities, host(options)),
    Effect.map((actions) => AuthorityOwnerControl.of(actions)),
  );

const answered = async (actions: AuthorityOwnerControl["Service"], envelope: ReturnType<typeof request>) => {
  const response = await Effect.runPromise(actions.dispatch(envelope));
  return { response, decoded: decodeOperatorResponse(response) };
};

describe("authority ops", () => {
  it("are refused before the host is touched with AUTHORITY_ENABLED off", async () => {
    let touched = false;
    const actions = await Effect.runPromise(owner({ enabled: false, touched: () => { touched = true; } }));
    const { response } = await answered(actions, request("authority.status", {}));
    expect(response).toMatchObject({ ok: false, error: { type: "forbidden", message: "authority is not enabled in this build" } });
    expect(touched).toBe(false);
  });

  it("answers status through the one read, and the answer fits the owner contract", async () => {
    const actions = await Effect.runPromise(owner({ enabled: true }));
    const { response, decoded } = await answered(actions, request("authority.status", { canvas: "factory" }));
    expect(response).toMatchObject({ ok: true, op: "authority.status" });
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success" && decoded.success.ok && decoded.success.op === "authority.status") {
      expect(decoded.success.data.self.name).toBe("macbook");
      expect(decoded.success.data.canvases[0]?.authority?.label).toBe("MacBook");
      expect(decoded.success.data.canvases[0]?.list.map((machine) => machine.label)).toEqual(["MacBook", "Mac mini"]);
    }
  });

  it("answers the list edit with what was named and what still rules", async () => {
    const actions = await Effect.runPromise(owner({
      enabled: true,
      setList: () => read({ pendingList: { list: [mac.installationId, mini.installationId], old: [mac.installationId] } }),
    }));
    const { response } = await answered(actions, request("authority.list", { canvas: "factory", order: ["macbook", "mini"] }));
    expect(response).toMatchObject({ ok: true, op: "authority.list" });
    if (response.ok && response.op === "authority.list") {
      expect(response.data.named.map((machine) => machine.name)).toEqual(["macbook", "mini"]);
      expect(response.data.committed.map((machine) => machine.name)).toEqual(["macbook", "mini"]);
      expect(response.data.pending).toBe(true);
      expect(response.data.waiting).toContain("quorum");
    }
  });

  it("refuses alone while this machine can still commit", async () => {
    const actions = await Effect.runPromise(owner({ enabled: true, reads: [read({ canCommit: true, leader: mac.installationId })] }));
    const { response } = await answered(actions, request("authority.alone", { canvas: "factory" }));
    expect(response).toMatchObject({ ok: false, error: { type: "conflict" } });
    if (!response.ok) expect(response.error.message).toBe("MacBook can still take changes for factory; alone is only for a pair that cannot");
  });

  it("refuses alone on a committed list that is not a pair", async () => {
    const actions = await Effect.runPromise(owner({ enabled: true, reads: [read({ members: { list: [mac.installationId] } })] }));
    const { response } = await answered(actions, request("authority.alone", { canvas: "factory" }));
    expect(response).toMatchObject({ ok: false, error: { type: "conflict" } });
    if (!response.ok) expect(response.error.message).toBe("alone is only for a canvas listed on two machines; factory lists 1");
  });

  it("refuses alone on a canvas this machine is not listed for", async () => {
    const actions = await Effect.runPromise(owner({
      enabled: true,
      reads: [read({ members: { list: [mini.installationId, id("install-vps")] } })],
      machines: [mac, mini, { installationId: id("install-vps"), name: "vps", label: "VPS", reach: "not-linked", since: null }],
    }));
    const { response } = await answered(actions, request("authority.alone", { canvas: "factory" }));
    expect(response).toMatchObject({ ok: false, error: { type: "conflict" } });
    if (!response.ok) expect(response.error.message).toBe("MacBook is not on factory's authority list, so it cannot take it alone");
  });

  it("breaks the pair and prints the warning with the other machine and the dropped list", async () => {
    const actions = await Effect.runPromise(owner({
      enabled: true,
      reads: [read({ pendingList: { list: [mac.installationId, mini.installationId], old: [mac.installationId] } })],
      alone: () => read({ term: 8 + ALONE_TERM_STRIDE, canCommit: true, members: { list: [mac.installationId, mini.installationId], sole: mac.installationId } }),
    }));
    const { response } = await answered(actions, request("authority.alone", { canvas: "factory" }));
    expect(response).toMatchObject({ ok: true, op: "authority.alone" });
    if (response.ok && response.op === "authority.alone") {
      expect(response.data.term).toBe(8 + ALONE_TERM_STRIDE);
      expect(response.data.warning).toContain("Making MacBook the only machine that takes changes for factory.");
      expect(response.data.warning).toContain("Mac mini");
      expect(response.data.warning).toContain("A list change that had not been applied is dropped");
    }
  });

  it("reports a driver refusal as io and retryable only when the driver says so", async () => {
    const failing = CanvasAuthorities.of({
      judge: () => Effect.die("no batch is judged here"),
      landed: () => Effect.die("no entry is waited on here"),
      status: () => Effect.fail(new FleetDriverError({ message: "this machine's canvases could not be read", cause: "the store was busy", retryable: true })),
      setList: () => Effect.die("no"),
      alone: () => Effect.die("no"),
      machines: () => Effect.succeed({ self: mac, machines: [mac] }),
    });
    const actions = await Effect.runPromise(
      makeAuthorityOwnerActions({ enabled: true }).pipe(Effect.provideService(CanvasAuthorities, failing)),
    );
    const { response } = await answered(actions, request("authority.status", {}));
    expect(response).toMatchObject({ ok: false, error: { type: "io", message: "this machine's canvases could not be read", details: { retryable: true } } });
  });
});
