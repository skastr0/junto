/**
 * Region environment, resolved and launched. Fakes and temp folders only: a
 * fake source resolver stands in for every store, the canvas is an object in
 * memory, and the process is the fake terminal authority.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasDoc, EnvSource, EtherRegionEnvironment } from "../src/shared/canvas";
import {
  EMPTY_LAUNCH_RECORD,
  type EnvSourceResolver,
  type SourceResolution,
} from "../src/shared/region-environment";
import { setConfiguredToolDirectories } from "../src/main/junto/adapters/exec";
import {
  makeRegionEnvironmentResolution,
} from "../src/main/junto/region-env/resolve";
import { makeRegionEnvironmentService } from "../src/main/junto/region-env/service";
import {
  makeActorSeatOccupy,
  type ActorOccupySpec,
} from "../src/main/junto/term/actor-seat-occupy";
import { LocalSessionHost, resolveLaunch } from "../src/main/junto/term/local-host";
import { TerminalRouter } from "../src/main/junto/term/router";
import { juntoCliPathPrefixes } from "../src/main/junto/term/templates/seat-env";
import type { SeatEnvironmentResolver } from "../src/main/junto/term/seat-process";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/junto/process-identity";
import { setProcessEpochReaderForTests } from "../src/main/junto/process-epoch";
import { Result } from "effect";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";

const CANARY = "s3cr3t-CANARY-value";

const region = (
  id: string,
  rect: readonly [number, number, number, number],
  environment?: EtherRegionEnvironment,
  label = id,
) => ({
  id,
  type: "group" as const,
  x: rect[0],
  y: rect[1],
  width: rect[2],
  height: rect[3],
  label,
  ...(environment ? { ether: { region: { environment } } } : {}),
});

const seat = (id: string, x: number, y: number, harness = "claude") => ({
  id,
  type: "text" as const,
  text: id,
  x,
  y,
  width: 50,
  height: 40,
  ether: {
    entity: { kind: "agent" as const, name: `local:${harness}` },
    terminal: {
      bindingId: `bind-${id}`,
      harness,
      launch: { kind: "harness" as const, argv: [harness], cwd: "/tmp" },
    },
  },
});

/** outer ⊃ inner ⊃ seat `in`; `mid` in outer only. */
const doc = (
  outer?: EtherRegionEnvironment,
  inner?: EtherRegionEnvironment,
): CanvasDoc =>
  ({
    nodes: [
      region("outer", [0, 0, 1000, 1000], outer, "Outer"),
      region("inner", [100, 100, 400, 400], inner, "Inner"),
      seat("in", 200, 200),
      seat("mid", 700, 700),
    ],
    edges: [],
  }) as CanvasDoc;

const keychain = (id: string, name: string, extra: object = {}): EnvSource =>
  ({ id, kind: "keychain", name, service: `svc-${id}`, ...extra }) as EnvSource;

/**
 * A resolver over a table of answers by source id. It records every call and
 * what each `onepassword` source was handed for `tokenFrom`.
 */
const fakeResolver = (answers: Record<string, SourceResolution | "throw">) => {
  const calls: string[] = [];
  const tokens: Record<string, Readonly<Record<string, string>> | undefined> = {};
  const resolver: EnvSourceResolver = {
    staticNamesOf: (source) => ("name" in source ? [source.name] : []),
    resolve: async (source, context) => {
      calls.push(source.id);
      if (source.kind === "onepassword" && source.tokenFrom !== undefined) {
        tokens[source.id] = context.resolved(source.tokenFrom);
      }
      const answer = answers[source.id];
      if (answer === "throw") throw new Error(`boom ${CANARY}`);
      if (answer) return answer;
      if (source.kind === "value") {
        return { status: "ok", values: { [source.name]: source.value } };
      }
      return { status: "missing", names: "name" in source ? [source.name] : [], reason: "Not there" };
    },
  };
  return { resolver, calls, tokens };
};

const ok = (values: Record<string, string>): SourceResolution => ({ status: "ok", values });

describe("resolving a plan", () => {
  it("resolves in application order and merges by name", async () => {
    const fake = fakeResolver({ k: ok({ TOKEN: CANARY }) });
    const d = doc(
      { sources: [keychain("k", "TOKEN"), { id: "o", kind: "value", name: "A", value: "outer" }] },
      { sources: [{ id: "i", kind: "value", name: "A", value: "inner" }] },
    );
    const resolved = await makeRegionEnvironmentResolution(fake.resolver, "/home/op").resolve(
      d,
      { seat: "in" },
      "local",
    );
    expect(fake.calls).toEqual(["k", "o", "i"]);
    expect(resolved.env).toEqual({ TOKEN: CANARY, A: "inner" });
    expect(resolved.regions).toEqual(["outer", "inner"]);
    expect(resolved.report.map((r) => [r.sourceId, r.status])).toEqual([
      ["k", "ok"],
      ["o", "overridden"],
      ["i", "ok"],
    ]);
    // Nothing but `env` ever holds a value.
    const { env: _env, ...rest } = resolved;
    expect(JSON.stringify(rest)).not.toContain(CANARY);
  });

  it("tokenFrom may name a source inherited from an outer region", async () => {
    const fake = fakeResolver({ tok: ok({ OP_SERVICE_ACCOUNT_TOKEN: CANARY }), gh: ok({ GH: "x" }) });
    const d = doc(
      { sources: [keychain("tok", "OP_SERVICE_ACCOUNT_TOKEN")] },
      { sources: [{ id: "gh", kind: "onepassword", name: "GH", ref: "op://v/i/f", tokenFrom: "tok" }] },
    );
    await makeRegionEnvironmentResolution(fake.resolver).resolve(d, { seat: "in" }, "local");
    expect(fake.tokens.gh).toEqual({ OP_SERVICE_ACCOUNT_TOKEN: CANARY });
  });

  it("a sealed region cuts an inherited tokenFrom off like everything else", async () => {
    const fake = fakeResolver({
      tok: ok({ OP_SERVICE_ACCOUNT_TOKEN: CANARY }),
      gh: { status: "missing", names: ["GH"], reason: "No source tok is in scope for this region" },
    });
    const d = doc(
      { sources: [keychain("tok", "OP_SERVICE_ACCOUNT_TOKEN")] },
      {
        sealed: true,
        sources: [{ id: "gh", kind: "onepassword", name: "GH", ref: "op://v/i/f", tokenFrom: "tok" }],
      },
    );
    const resolved = await makeRegionEnvironmentResolution(fake.resolver).resolve(d, { seat: "in" }, "local");
    // The outer token is neither resolved nor offered.
    expect(fake.calls).toEqual(["gh"]);
    expect("gh" in fake.tokens).toBe(true);
    expect(fake.tokens.gh).toBeUndefined();
    expect(resolved.env).toEqual({});
    expect(resolved.report).toEqual([
      {
        regionId: "inner",
        regionLabel: "Inner",
        sourceId: "gh",
        kind: "onepassword",
        names: ["GH"],
        status: "missing",
        reason: "No source tok is in scope for this region",
        required: false,
      },
    ]);
  });

  it("the report lists every in-scope source with its region label, so a screen can offer tokenFrom candidates", async () => {
    const fake = fakeResolver({ tok: ok({ OP_SERVICE_ACCOUNT_TOKEN: CANARY }), tok2: ok({ T2: "y" }) });
    const d = doc(
      { sources: [keychain("tok", "OP_SERVICE_ACCOUNT_TOKEN")] },
      { sources: [keychain("tok2", "T2")] },
    );
    const resolved = await makeRegionEnvironmentResolution(fake.resolver).resolve(d, { region: "inner" }, "local");
    expect(
      resolved.report.map((r) => [r.regionLabel, r.regionId, r.sourceId, r.kind, r.names]),
    ).toEqual([
      ["Outer", "outer", "tok", "keychain", ["OP_SERVICE_ACCOUNT_TOKEN"]],
      ["Inner", "inner", "tok2", "keychain", ["T2"]],
    ]);
  });

  it("an overridden source still answers tokenFrom; a skipped or failed one does not", async () => {
    const fake = fakeResolver({ a: ok({ TOKEN: "first" }), b: ok({ TOKEN: "second" }) });
    const d = doc({
      sources: [
        keychain("a", "TOKEN"),
        keychain("b", "TOKEN"),
        keychain("elsewhere", "TOKEN", { host: "linux" }),
        keychain("gone", "T"),
        { id: "op1", kind: "onepassword", name: "X1", ref: "op://a", tokenFrom: "a" },
        { id: "op2", kind: "onepassword", name: "X2", ref: "op://a", tokenFrom: "elsewhere" },
        { id: "op3", kind: "onepassword", name: "X3", ref: "op://a", tokenFrom: "gone" },
        { id: "op4", kind: "onepassword", name: "X4", ref: "op://a", tokenFrom: "later" },
        keychain("later", "L"),
      ],
    });
    await makeRegionEnvironmentResolution(fake.resolver).resolve(d, { seat: "mid" }, "mac");
    expect(fake.tokens.op1).toEqual({ TOKEN: "first" });
    expect(fake.tokens.op2).toBeUndefined();
    expect(fake.tokens.op3).toBeUndefined();
    expect(fake.tokens.op4).toBeUndefined();
    expect(fake.calls).not.toContain("elsewhere");
  });

  it("a resolver that throws against its contract fails one source, not the launch", async () => {
    const fake = fakeResolver({ bad: "throw" });
    const d = doc({ sources: [keychain("bad", "B"), { id: "v", kind: "value", name: "A", value: "1" }] });
    const resolved = await makeRegionEnvironmentResolution(fake.resolver).resolve(d, { seat: "mid" }, "local");
    expect(resolved.env).toEqual({ A: "1" });
    expect(resolved.report[0]).toMatchObject({ status: "error", names: ["B"], reason: "This source could not be read" });
    expect(JSON.stringify(resolved.report)).not.toContain(CANARY);
    expect(resolved.refusal).toBeUndefined();
  });

  it("a required source that cannot be read sets a refusal", async () => {
    const fake = fakeResolver({});
    const d = doc({ sources: [keychain("k", "TOKEN", { required: true })] });
    const resolved = await makeRegionEnvironmentResolution(fake.resolver).resolve(d, { seat: "mid" }, "local");
    expect(resolved.refusal).toBe("Outer: TOKEN is required and could not be read. Not there");
  });

  it("makes folders absolute and drops the ones that are not paths", async () => {
    const d = doc({ folders: ["~/notes", "/srv/shared", "relative/x", "~"] });
    const resolved = await makeRegionEnvironmentResolution(fakeResolver({}).resolver, "/home/op").resolve(
      d,
      { seat: "mid" },
      "local",
    );
    expect(resolved.folders).toEqual(["/home/op/notes", "/srv/shared", "/home/op"]);
  });

  it("a launch record and a later check compare like for like without reading a secret", async () => {
    // The Keychain item is missing at launch and still missing later.
    const fake = fakeResolver({ file: ok({ FROM_FILE: "1" }) });
    const d = doc({ sources: [keychain("k", "TOKEN"), { id: "file", kind: "envFile", path: "/x.env" }] });
    const resolution = makeRegionEnvironmentResolution(fake.resolver);
    const launched = (await resolution.resolve(d, { seat: "mid" }, "local")).record;
    fake.calls.length = 0;
    const current = await resolution.current(d, { seat: "mid" }, "local");
    expect(current).toEqual(launched);
    // Only the file, whose names are not written in the document, was read.
    expect(fake.calls).toEqual(["file"]);
    expect(Object.keys(launched.names).sort()).toEqual(["FROM_FILE", "TOKEN"]);
  });
});

describe("one service behind every surface", () => {
  const service = (
    d: () => CanvasDoc | undefined,
    answers: Record<string, SourceResolution | "throw"> = {},
    running: Record<string, typeof EMPTY_LAUNCH_RECORD> = {},
  ) => {
    const fake = fakeResolver(answers);
    return {
      fake,
      running,
      service: makeRegionEnvironmentService({
        resolution: makeRegionEnvironmentResolution(fake.resolver, "/home/op"),
        readDoc: async () => d(),
        hostId: async () => "local",
        launchRecord: (bindingId) => running[bindingId],
      }),
    };
  };

  it("a region reads exactly as a seat placed directly inside it", async () => {
    const d = doc(
      { sources: [keychain("tok", "TOKEN"), { id: "o", kind: "value", name: "A", value: "outer" }] },
      { sources: [{ id: "i", kind: "value", name: "A", value: "inner" }] },
    );
    const { service: s } = service(() => d, { tok: ok({ TOKEN: CANARY }) });
    expect(await s.regionReport("c", "inner")).toEqual((await s.seatReport("c", "in"))?.report);
    // A caller that already holds the canvas gets the identical answer.
    expect(await s.seatReportFor(d, "in")).toEqual(await s.seatReport("c", "in"));
    expect(await s.seatReportFor(d, "nope")).toBeUndefined();
    expect(await s.regionReport("c", "outer")).toEqual((await s.seatReport("c", "mid"))?.report);
    expect(await s.regionReport("c", "in")).toBeUndefined();
    expect(await s.regionReport("c", "nope")).toBeUndefined();
  });

  it("the canvas-wide report asks each store once per region, not once per seat", async () => {
    const d = {
      ...doc({ sources: [keychain("tok", "TOKEN")] }, { sealed: true, folders: ["/x"] }),
    } as CanvasDoc;
    const withMore = { ...d, nodes: [...d.nodes, seat("mid2", 800, 800), seat("mid3", 600, 800)] } as CanvasDoc;
    const { service: s, fake } = service(() => withMore, { tok: ok({ TOKEN: CANARY }) });
    const report = await s.canvasReport("c");
    expect(report?.regions.map((r) => [r.regionId, r.regionLabel, r.sealed, r.sources.length])).toEqual([
      ["outer", "Outer", false, 1],
      ["inner", "Inner", true, 0],
    ]);
    expect(report?.seats.map((x) => [x.nodeId, x.regions, x.report.length, x.folders, x.restartToApply])).toEqual([
      ["in", ["inner"], 0, ["/x"], false],
      ["mid", ["outer"], 1, [], false],
      ["mid2", ["outer"], 1, [], false],
      ["mid3", ["outer"], 1, [], false],
    ]);
    expect(fake.calls).toEqual(["tok"]);
    expect(JSON.stringify(report)).not.toContain(CANARY);
  });

  it("a seat is stale only when it is running on a different resolution", async () => {
    let current = doc({ sources: [{ id: "a", kind: "value", name: "A", value: "1" }, keychain("k", "GONE")] });
    const running: Record<string, typeof EMPTY_LAUNCH_RECORD> = {};
    const { service: s } = service(() => current, {}, running);
    // Not running: nothing to restart, whatever the document says.
    expect((await s.seatReport("c", "mid"))?.restartToApply).toBe(false);
    expect(await s.staleSeats("c", "outer")).toEqual([]);
    // Launched on the current resolution.
    running["bind-mid"] = (await s.forLaunch({ canvasName: "c", nodeId: "mid" })).record;
    running["bind-in"] = running["bind-mid"]!;
    expect((await s.seatReport("c", "mid"))?.restartToApply).toBe(false);
    expect(await s.staleSeats("c", "outer")).toEqual([]);
    // The operator edits the region: A now comes from a new source, GONE is
    // removed, NEW is added.
    current = doc({
      sources: [
        { id: "a2", kind: "value", name: "A", value: "2" },
        { id: "n", kind: "value", name: "NEW", value: "n" },
      ],
    });
    expect((await s.seatReport("c", "mid"))?.restartToApply).toBe(true);
    expect(await s.staleSeats("c", "outer")).toEqual([
      { seatId: "in", title: "local:claude", changed: ["A", "GONE", "NEW"] },
      { seatId: "mid", title: "local:claude", changed: ["A", "GONE", "NEW"] },
    ]);
    // Nested regions are included; a region with no stale seat is empty.
    expect((await s.staleSeats("c", "inner"))?.map((x) => x.seatId)).toEqual(["in"]);
    // A seat launched before any environment existed is stale once one does.
    running["bind-mid"] = EMPTY_LAUNCH_RECORD;
    expect((await s.staleSeats("c", "outer"))?.find((x) => x.seatId === "mid")?.changed).toEqual(["A", "NEW"]);
  });

  it("an unreadable canvas launches with nothing and reports nothing", async () => {
    const { service: s } = service(() => undefined);
    const resolved = await s.forLaunch({ canvasName: "c", nodeId: "mid" });
    expect(resolved.env).toEqual({});
    expect(resolved.record).toEqual(EMPTY_LAUNCH_RECORD);
    expect(await s.canvasReport("c")).toBeUndefined();
    expect(await s.seatReport("c", "mid")).toBeUndefined();
  });

  it("reads a just-moved seat from its live rect", async () => {
    const d = doc(undefined, { sources: [{ id: "i", kind: "value", name: "A", value: "inner" }] });
    const { service: s } = service(() => d);
    expect((await s.forLaunch({ canvasName: "c", nodeId: "mid" })).env).toEqual({});
    expect(
      (await s.forLaunch({ canvasName: "c", nodeId: "mid", seatRect: { x: 200, y: 200, width: 50, height: 40 } })).env,
    ).toEqual({ A: "inner" });
  });
});

describe("the launch applies it", () => {
  let binDir = "";
  const hosts: LocalSessionHost[] = [];
  const epochs = new Map<number, string>();

  /** A harness binary whose `--help` lists (or does not list) `--add-dir`. */
  const installBin = (name: string, helpLists: boolean): void => {
    const file = join(binDir, name);
    writeFileSync(
      file,
      `#!/bin/sh\nif [ "$1" = "--help" ]; then echo "Options:"; ${helpLists ? 'echo "  --add-dir <dir>  Add a directory";' : ""} echo "  --model <m>  Model"; fi\nexit 0\n`,
    );
    chmodSync(file, 0o755);
  };

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "junto-region-env-bins-"));
    installBin("claude", true);
    installBin("codex", false);
    installBin("grok", true);
    setConfiguredToolDirectories([binDir]);
    epochs.clear();
    setProcessEpochReaderForTests({
      snapshot: () =>
        [...epochs].map(([pid, startKey]) => ({
          pid,
          processGroupId: Math.max(2, pid - 1),
          sessionId: 7,
          startKey,
        })),
    });
    setProcessIdentityMapForTests(
      makeProcessIdentityMap({
        processAlive: () => true,
        readProcessStartKey: (pid) => epochs.get(pid),
      }),
    );
  });

  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.shutdownAll("test_cleanup");
    setConfiguredToolDirectories([]);
    rmSync(binDir, { recursive: true, force: true });
    setProcessEpochReaderForTests(undefined);
    setProcessIdentityMapForTests(undefined);
  });

  const agent = (harness: string) =>
    ({
      kind: "agent" as const,
      harness,
      agentKey: `local:${harness}`,
      launch: { kind: "harness" as const, argv: [harness, "--model", "m"], cwd: "/tmp", env: { FROM_SEAT: "seat" } },
    }) as Parameters<typeof resolveLaunch>[0];

  // Resolve harness binaries from the temp folder only, never the machine's.
  const hermetic = () => ({ PATH: binDir });

  it("region values sit under the seat's own env and under Junto's", () => {
    const launch = Result.getOrThrow(
      resolveLaunch(agent("claude"), {
        seatInject: { ...hermetic(), JUNTO_SOCKET: "/real.sock", JUNTO_SEAT: "local:claude" },
        regionEnv: {
          OP_SERVICE_ACCOUNT_TOKEN: CANARY,
          FROM_SEAT: "region",
          JUNTO_SOCKET: "/evil.sock",
          CLAUDECODE: "1",
          TERM: "dumb",
        },
      }),
    );
    expect(launch.env.OP_SERVICE_ACCOUNT_TOKEN).toBe(CANARY);
    expect(launch.env.FROM_SEAT).toBe("seat");
    expect(launch.env.JUNTO_SOCKET).toBe("/real.sock");
    expect(launch.env.CLAUDECODE).toBeUndefined();
    expect(launch.env.TERM).not.toBe("dumb");
    // A value is never an argument.
    expect(launch.args.join(" ")).not.toContain(CANARY);
  });

  it("a region overrides a variable the machine already has, through a planned launch", () => {
    // A planned launch carries a snapshot of the ambient environment. That
    // snapshot is not the seat's own choice and must not beat the region.
    const prior = { AMBIENT_ONE: process.env.AMBIENT_ONE, AMBIENT_TWO: process.env.AMBIENT_TWO };
    process.env.AMBIENT_ONE = "machine";
    process.env.AMBIENT_TWO = "machine";
    try {
      const planned = {
        ...agent("claude"),
        launch: {
          kind: "harness" as const,
          argv: ["claude"],
          cwd: "/tmp",
          // AMBIENT_ONE is the snapshot; AMBIENT_TWO was changed on the seat.
          env: { ...(process.env as Record<string, string>), AMBIENT_TWO: "seat", PATH: binDir },
        },
      } as Parameters<typeof resolveLaunch>[0];
      const launch = Result.getOrThrow(
        resolveLaunch(planned, {
          regionEnv: { AMBIENT_ONE: "region", AMBIENT_TWO: "region", ONLY_REGION: "region" },
        }),
      );
      expect(launch.env.AMBIENT_ONE).toBe("region");
      expect(launch.env.AMBIENT_TWO).toBe("seat");
      expect(launch.env.ONLY_REGION).toBe("region");
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("folders ride the harness's own option, only where the installed binary lists it", () => {
    const folders = ["/srv/shared", "/home/op/notes"];
    const args = (harness: string) =>
      Result.getOrThrow(
        resolveLaunch(agent(harness), { folders, seatInject: hermetic() }),
      ).args;
    expect(args("claude")).toEqual([
      "--add-dir",
      "/srv/shared",
      "--add-dir",
      "/home/op/notes",
      "--model",
      "m",
    ]);
    // The template names the option, this installed binary does not list it.
    expect(args("codex")).toEqual(["--model", "m"]);
    // The binary lists such an option, the template claims none for grok.
    expect(args("grok")).toEqual(["--model", "m"]);
    expect(
      Result.getOrThrow(resolveLaunch(agent("claude"), { seatInject: hermetic() })).args,
    ).toEqual(["--model", "m"]);
  });

  const spec = (bindingId: string): ActorOccupySpec => ({
    bindingId,
    harness: "claude",
    agentKey: "local:claude",
    canvasName: "factory",
    nodeId: `node-${bindingId}`,
    spawnIntent: {
      documentLaunch: { kind: "harness", argv: ["claude"], cwd: "/tmp" },
      resumeRequested: false,
    },
  });

  const occupyWith = (seatEnvironment: SeatEnvironmentResolver) => {
    const fake = makeFakeTerminalProcessAuthority((_spec, index) => {
      const pid = 43_100 + index;
      epochs.set(pid, `synthetic-${pid}`);
      return { pid, exitOnSignal: false };
    });
    const host = new LocalSessionHost(fake.authority, {
      killGraceMs: 5,
      shutdownGraceMs: 5,
      lateExitGraceMs: 5,
    });
    hosts.push(host);
    const occupy = makeActorSeatOccupy({
      local: host,
      localHostId: () => Effect.succeed("cc-self"),
      clientForOccupy: async () => {
        throw new Error("local only");
      },
      remoteProjectionAdmission: () => Effect.void,
      seatEnvironment,
    });
    return { fake, host, occupy };
  };

  it("every local seat launch asks for its region environment and spawns with it", async () => {
    const asked: unknown[] = [];
    const record = { fingerprint: "f1", names: { OP_SERVICE_ACCOUNT_TOKEN: "sig" }, folders: ["/srv/shared"] };
    const { fake, host, occupy } = occupyWith(async (seat) => {
      asked.push(seat);
      // A region PATH is honored (Junto's own directory stays in front), which
      // also keeps this launch on the temp folder's binary.
      return {
        env: { OP_SERVICE_ACCOUNT_TOKEN: CANARY, PATH: binDir },
        folders: ["/srv/shared"],
        record,
      };
    });
    const summary = await Effect.runPromise(
      occupy.occupy({ ...spec("b1"), seatRect: { x: 1, y: 2, width: 3, height: 4 } }),
    );
    expect(summary.status).toBe("running");
    expect(asked).toEqual([
      { canvasName: "factory", nodeId: "node-b1", seatRect: { x: 1, y: 2, width: 3, height: 4 } },
    ]);
    const spawned = fake.controllers[0]!.spec;
    expect(spawned.env?.OP_SERVICE_ACCOUNT_TOKEN).toBe(CANARY);
    // The region's PATH is on the seat's PATH, behind Junto's own CLI
    // directory. Where it sits among the rest is the host's business.
    const pathEntries = (spawned.env?.PATH ?? "").split(delimiter);
    expect(pathEntries).toContain(binDir);
    for (const prefix of juntoCliPathPrefixes()) {
      expect(pathEntries.indexOf(prefix)).toBeGreaterThanOrEqual(0);
      expect(pathEntries.indexOf(prefix)).toBeLessThan(pathEntries.indexOf(binDir));
    }
    expect(spawned.command).toBe(join(binDir, "claude"));
    expect(spawned.args ?? []).toEqual(expect.arrayContaining(["--add-dir", "/srv/shared"]));
    expect((spawned.args ?? []).join(" ")).not.toContain(CANARY);
    // The session keeps the record, and the record holds no value.
    expect(host.regionEnvironmentRecord("b1")).toEqual(record);
    expect(JSON.stringify(host.get("b1"))).not.toContain(CANARY);
  });

  it("a required source that cannot be read refuses the launch in plain words", async () => {
    const { fake, host, occupy } = occupyWith(async () => ({
      env: {},
      folders: [],
      record: EMPTY_LAUNCH_RECORD,
      refusal: "Outer: TOKEN is required and could not be read. Not there",
    }));
    await expect(Effect.runPromise(occupy.occupy(spec("b2")))).rejects.toThrow(
      "This seat was not started. Outer: TOKEN is required and could not be read. Not there",
    );
    expect(fake.controllers).toHaveLength(0);
    expect(host.get("b2")).toBeUndefined();
    expect(host.regionEnvironmentRecord("b2")).toBeUndefined();
  });

  describe("a plain shell terminal inside a region", () => {
    const shell = (env?: Record<string, string>) =>
      ({
        kind: "terminal" as const,
        launch: { kind: "command" as const, argv: ["/bin/sh", "-l"], ...(env ? { env } : {}) },
      }) as Parameters<typeof resolveLaunch>[0];

    it("gets the region's variables, under what the terminal itself sets", () => {
      const launch = Result.getOrThrow(
        resolveLaunch(shell({ FROM_TERMINAL: "terminal" }), {
          regionEnv: { OP_SERVICE_ACCOUNT_TOKEN: CANARY, FROM_TERMINAL: "region", TERM: "dumb" },
        }),
      );
      expect(launch.env.OP_SERVICE_ACCOUNT_TOKEN).toBe(CANARY);
      expect(launch.env.FROM_TERMINAL).toBe("terminal");
      // Every terminal is a real terminal, whatever a region says.
      expect(launch.env.TERM).not.toBe("dumb");
      expect(launch.args.join(" ")).not.toContain(CANARY);
      // No region, no change: the shell is the operator's ordinary shell.
      const plain = Result.getOrThrow(resolveLaunch(shell(), {}));
      expect(plain.env.OP_SERVICE_ACCOUNT_TOKEN).toBeUndefined();
    });

    const routerWith = (seatEnvironment: SeatEnvironmentResolver | undefined) => {
      const fake = makeFakeTerminalProcessAuthority((_spec, index) => {
        const pid = 43_300 + index;
        epochs.set(pid, `synthetic-${pid}`);
        return { pid, exitOnSignal: false };
      });
      const host = new LocalSessionHost(fake.authority, {
        killGraceMs: 5,
        shutdownGraceMs: 5,
        lateExitGraceMs: 5,
      });
      hosts.push(host);
      const router = new TerminalRouter(host);
      if (seatEnvironment) router.setTerminalEnvironment(seatEnvironment);
      return { fake, host, router };
    };
    const launch = { kind: "command" as const, argv: ["/bin/sh", "-l"] };

    it("is started with it by the router, from where the node sits now", async () => {
      const asked: unknown[] = [];
      const record = { fingerprint: "f1", names: { OP_SERVICE_ACCOUNT_TOKEN: "sig" }, folders: [] };
      const { fake, host, router } = routerWith(async (seat) => {
        asked.push(seat);
        return { env: { OP_SERVICE_ACCOUNT_TOKEN: CANARY }, folders: ["/srv/shared"], record };
      });
      const summary = await router.create({
        bindingId: "t1",
        canvasName: "factory",
        nodeId: "node-t1",
        launch,
        seatRect: { x: 1, y: 2, width: 3, height: 4 },
      });
      expect(summary.status).toBe("running");
      expect(asked).toEqual([
        { canvasName: "factory", nodeId: "node-t1", seatRect: { x: 1, y: 2, width: 3, height: 4 } },
      ]);
      const spawned = fake.controllers[0]!.spec;
      expect(spawned.env?.OP_SERVICE_ACCOUNT_TOKEN).toBe(CANARY);
      // A shell has no add-directory option: folders change nothing in its argv.
      expect(spawned.args ?? []).toEqual(["-l"]);
      expect(host.regionEnvironmentRecord("t1")).toEqual(record);
      expect(JSON.stringify(host.get("t1"))).not.toContain(CANARY);
    });

    it("is refused in plain words when a required source cannot be read", async () => {
      const { fake, host, router } = routerWith(async () => ({
        env: {},
        folders: [],
        record: EMPTY_LAUNCH_RECORD,
        refusal: "Outer: TOKEN is required and could not be read. Not there",
      }));
      await expect(
        router.create({ bindingId: "t2", canvasName: "factory", nodeId: "node-t2", launch }),
      ).rejects.toThrow(
        "This terminal was not started. Outer: TOKEN is required and could not be read. Not there",
      );
      expect(fake.controllers).toHaveLength(0);
      expect(host.get("t2")).toBeUndefined();
    });

    it("starts with nothing when the resolution cannot run, and is not asked without a node", async () => {
      let asks = 0;
      const { fake, router } = routerWith(async () => {
        asks += 1;
        throw new Error("canvas store is down");
      });
      expect((await router.create({ bindingId: "t3", canvasName: "factory", nodeId: "node-t3", launch })).status).toBe("running");
      expect(asks).toBe(1);
      // A terminal that is not on a canvas is in no region.
      expect((await router.create({ bindingId: "t4", launch })).status).toBe("running");
      expect(asks).toBe(1);
      expect(fake.controllers).toHaveLength(2);
    });

    it("a router nobody wired starts terminals exactly as before", async () => {
      const { fake, host, router } = routerWith(undefined);
      expect((await router.create({ bindingId: "t5", canvasName: "factory", nodeId: "node-t5", launch })).status).toBe("running");
      expect(fake.controllers).toHaveLength(1);
      expect(host.regionEnvironmentRecord("t5")).toEqual(EMPTY_LAUNCH_RECORD);
    });
  });

  it("a resolver that fails outright still launches the seat, with nothing", async () => {
    const { fake, host, occupy } = occupyWith(async () => {
      throw new Error("canvas store is down");
    });
    // No region PATH here, so point the whole process at the temp folder.
    const priorPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      const summary = await Effect.runPromise(occupy.occupy(spec("b3")));
      expect(summary.status).toBe("running");
      expect(fake.controllers).toHaveLength(1);
      expect(fake.controllers[0]!.spec.command).toBe(join(binDir, "claude"));
      expect(host.regionEnvironmentRecord("b3")).toEqual(EMPTY_LAUNCH_RECORD);
    } finally {
      process.env.PATH = priorPath;
    }
  });
});
