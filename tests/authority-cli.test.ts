/**
 * `junto authority` (plan 0.11/06, F5) over a stand-in of the owner ops:
 * status prints every machine with its state and the term as a number, a
 * canvas argument is passed through, alone prints the warning whole, and a
 * seat is refused before any op is called.
 */
import { Effect, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthorityOwner, authorityAlone, authorityStatus } from "../src/cli/commands/authority";
import { authorityAloneWarning, type AuthorityMachineFacts, type AuthorityStatusData } from "../src/shared/authority";
import type { InstallationId } from "../src/shared/installation-id";
import { WORK_TOKEN_ENV } from "../src/shared/work-control";

const id = (name: string) => `inst-${name}` as InstallationId;
const mini: AuthorityMachineFacts = { installationId: id("mini"), name: "mini", label: "Mac mini", reach: "asleep", since: Date.UTC(2026, 9, 28, 1, 12) };
const studio: AuthorityMachineFacts = { installationId: id("studio"), name: "studio", label: "Studio", reach: "reachable", since: null };
const book: AuthorityMachineFacts = { installationId: id("book"), name: "book", label: "MacBook", reach: "here", since: null };

const data: AuthorityStatusData = {
  self: book,
  machines: [mini, studio, book],
  canvases: [{
    canvas: "factory",
    term: 7,
    role: "follower",
    authority: { ...mini, isAuthority: true },
    authorityReachable: false,
    canCommit: false,
    fresh: false,
    list: [{ ...mini, isAuthority: true }, { ...book, isAuthority: false }],
    pending: null,
    staleSince: Date.UTC(2026, 9, 28, 1, 10),
    waiting: { total: 0, commands: 0, structure: 0 },
  }],
};

const warning = authorityAloneWarning({ canvas: "factory", self: "MacBook", other: "Mac mini", pending: false });

const owner = (calls: Array<unknown>) =>
  AuthorityOwner.of({
    status: (args) => Effect.sync(() => (calls.push(["status", args]), data)),
    alone: (args) => Effect.sync(() => (calls.push(["alone", args]), { canvas: args.canvas, term: 8, authority: id("book"), warning })),
  });

const run = <A, E>(effect: Effect.Effect<A, E, AuthorityOwner>, calls: Array<unknown>) =>
  Effect.runPromise(Effect.result(effect.pipe(Effect.provideService(AuthorityOwner, owner(calls)))));

describe("junto authority", () => {
  let token: string | undefined;
  beforeEach(() => {
    token = process.env[WORK_TOKEN_ENV];
    delete process.env[WORK_TOKEN_ENV];
  });
  afterEach(() => {
    if (token === undefined) delete process.env[WORK_TOKEN_ENV];
    else process.env[WORK_TOKEN_ENV] = token;
  });

  it("status lists every canvas, each machine with its state and the term as a number", async () => {
    const calls: Array<unknown> = [];
    const out = await run(authorityStatus(Option.none()), calls);
    expect(calls).toEqual([["status", {}]]);
    if (out._tag !== "Success") throw new Error("refused");
    const canvas = out.success.canvases[0]!;
    expect(canvas.term).toBe(7);
    expect(canvas.list.map((machine) => machine.state)).toEqual(["Mac mini asleep since 2026-10-28T01:12:00.000Z", "this machine"]);
    expect(canvas.authority?.state).toBe("Mac mini asleep since 2026-10-28T01:12:00.000Z");
    expect(out.success.self.state).toBe("this machine");
    expect(out.success.machines.map((machine) => machine.state)).toEqual([
      "Mac mini asleep since 2026-10-28T01:12:00.000Z", "Studio reachable", "this machine",
    ]);
    expect(canvas.staleSince).toBe(Date.UTC(2026, 9, 28, 1, 10));
  });

  it("status with a canvas asks for that canvas", async () => {
    const calls: Array<unknown> = [];
    await run(authorityStatus(Option.some("factory")), calls);
    expect(calls).toEqual([["status", { canvas: "factory" }]]);
  });

  it("alone answers with the warning in full", async () => {
    const calls: Array<unknown> = [];
    const out = await run(authorityAlone("factory"), calls);
    expect(calls).toEqual([["alone", { canvas: "factory" }]]);
    if (out._tag !== "Success") throw new Error("refused");
    expect(out.success).toEqual({ canvas: "factory", term: 8, authority: id("book"), warning });
    expect(out.success.warning).toContain("use alone only when it is gone");
  });

  it("a seat is refused before any op is called", async () => {
    process.env[WORK_TOKEN_ENV] = "seat-token";
    const calls: Array<unknown> = [];
    const status = await run(authorityStatus(Option.none()), calls);
    const alone = await run(authorityAlone("factory"), calls);
    expect(status._tag).toBe("Failure");
    expect(alone._tag).toBe("Failure");
    expect(calls).toEqual([]);
  });
});
