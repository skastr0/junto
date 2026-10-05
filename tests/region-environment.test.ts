/**
 * Region environment, the pure half: document shape, the ordered plan, the
 * merge and its report, and what a running seat was launched with.
 */
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  decodeCanvasDoc,
  serializeCanvas,
  type CanvasDoc,
  type EnvSource,
  type EtherRegionEnvironment,
} from "../src/shared/canvas";
import { decodeOverseerArgs } from "../src/shared/overseer-control";
import {
  EMPTY_LAUNCH_RECORD,
  changedNames,
  launchRecordOf,
  mergeRegionEnvironment,
  planRegionEnvironment,
  regionEnvironmentFingerprint,
  reservedEnvNameReason,
  sourceKey,
  type SourceResolution,
} from "../src/shared/region-environment";

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

const seat = (id: string, x: number, y: number) => ({
  id,
  type: "text" as const,
  text: id,
  x,
  y,
  width: 50,
  height: 40,
});

const value = (id: string, name: string, v: string, extra: object = {}): EnvSource =>
  ({ id, kind: "value", name, value: v, ...extra }) as EnvSource;

/** outer ⊃ inner ⊃ seat `in`; `mid` sits in outer only; `out` in neither. */
const doc = (
  outer?: EtherRegionEnvironment,
  inner?: EtherRegionEnvironment,
): CanvasDoc => ({
  nodes: [
    region("outer", [0, 0, 1000, 1000], outer, "Outer"),
    region("inner", [100, 100, 400, 400], inner, "Inner"),
    seat("in", 200, 200),
    seat("mid", 700, 700),
    seat("out", 2000, 2000),
  ],
  edges: [],
});

const ok = (values: Record<string, string>): SourceResolution => ({ status: "ok", values });

/** Resolve every `value` source to itself; anything else comes from `extra`. */
const outcomesFor = (
  plan: ReturnType<typeof planRegionEnvironment>,
  extra: Record<string, SourceResolution> = {},
): Map<string, SourceResolution> =>
  new Map(
    plan.sources
      .filter((planned) => !planned.skippedHost)
      .flatMap((planned): Array<[string, SourceResolution]> => {
        const given = extra[planned.source.id];
        if (given) return [[planned.key, given]];
        return planned.source.kind === "value"
          ? [[planned.key, ok({ [planned.source.name]: planned.source.value })]]
          : [];
      }),
  );

describe("document shape", () => {
  const every: EnvSource[] = [
    { id: "a", kind: "value", name: "EDITOR", value: "vim" },
    { id: "b", kind: "secret", name: "API_KEY", secretId: "sec_1", required: true },
    { id: "c", kind: "keychain", name: "OP_SERVICE_ACCOUNT_TOKEN", service: "op-token", account: "me" },
    { id: "d", kind: "keyring", name: "T", attributes: { service: "x" }, host: "linux-box" },
    { id: "e", kind: "onepassword", name: "GH", ref: "op://v/i/f", tokenFrom: "c" },
    { id: "f", kind: "envFile", path: "~/.config/work.env" },
    { id: "g", kind: "secretsDir", path: "/run/secrets", prefix: "APP_" },
    { id: "h", kind: "command", name: "TOKEN", argv: ["pass", "show", "token"] },
  ];
  const environment: EtherRegionEnvironment = {
    sealed: true,
    sources: every,
    folders: ["~/notes", "/srv/shared"],
  };

  it("round-trips every source kind through the canvas document", () => {
    const authored = doc(environment);
    const decoded = decodeCanvasDoc(JSON.parse(serializeCanvas(authored)));
    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) return;
    expect(decoded.success.nodes[0]).toMatchObject({
      ether: { region: { environment } },
    });
    // Stable once decoded: a second pass through the document changes nothing.
    const again = decodeCanvasDoc(JSON.parse(serializeCanvas(decoded.success)));
    expect(Result.isSuccess(again) && serializeCanvas(again.success)).toBe(
      serializeCanvas(decoded.success),
    );
  });

  it("round-trips through the overseer node.configure schema", () => {
    const decoded = decodeOverseerArgs("node.configure", {
      canvas: "factory",
      nodeId: "outer",
      changes: { ether: { region: { environment } } },
    });
    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) return;
    expect(decoded.success.changes).toMatchObject({
      ether: { region: { environment } },
    });
  });

  const rejects = (source: unknown): boolean =>
    Result.isFailure(
      decodeCanvasDoc({
        nodes: [region("r", [0, 0, 10, 10], { sources: [source as EnvSource] })],
        edges: [],
      }),
    );

  it("decodes strictly", () => {
    // An id is required: reports, tokenFrom and edits key on it.
    expect(rejects({ kind: "value", name: "A", value: "1" })).toBe(true);
    expect(rejects({ id: "", kind: "value", name: "A", value: "1" })).toBe(true);
    // No value may ride a kind that names a reference.
    expect(rejects({ id: "x", kind: "keychain", name: "A", service: "s", value: "leak" })).toBe(true);
    expect(rejects({ id: "x", kind: "secret", name: "A", secretId: "s", secret: "leak" })).toBe(true);
    expect(rejects({ id: "x", kind: "nope", name: "A" })).toBe(true);
    expect(rejects({ id: "x", kind: "value", name: "not a name", value: "1" })).toBe(true);
    expect(rejects({ id: "x", kind: "command", name: "A", argv: [] })).toBe(true);
    expect(rejects({ id: "x", kind: "value", name: "A", value: "1" })).toBe(false);
  });
});

describe("plan", () => {
  it("is empty for a seat in no region, an unknown node, and a region without an environment", () => {
    const d = doc({ sources: [value("a", "A", "1")] });
    for (const target of [{ seat: "out" }, { seat: "nope" }, { region: "nope" }, { region: "in" }]) {
      expect(planRegionEnvironment(d, target, "local").sources).toEqual([]);
    }
    expect(planRegionEnvironment(doc(), { seat: "in" }, "local")).toEqual({
      regions: [
        { regionId: "outer", regionLabel: "Outer", sealed: false },
        { regionId: "inner", regionLabel: "Inner", sealed: false },
      ],
      sources: [],
      folders: [],
    });
  });

  it("applies regions outermost first and sources in list order", () => {
    const d = doc(
      { sources: [value("o1", "A", "outer"), value("o2", "B", "outer")] },
      { sources: [value("i1", "A", "inner")] },
    );
    const plan = planRegionEnvironment(d, { seat: "in" }, "local");
    expect(plan.sources.map((s) => `${s.regionId}/${s.source.id}`)).toEqual([
      "outer/o1",
      "outer/o2",
      "inner/i1",
    ]);
    // A seat only in the outer region gets only the outer sources.
    expect(
      planRegionEnvironment(d, { seat: "mid" }, "local").sources.map((s) => s.source.id),
    ).toEqual(["o1", "o2"]);
  });

  it("a sealed region inherits nothing from outside it", () => {
    const d = doc(
      { sources: [value("o1", "A", "outer")], folders: ["/outer"] },
      { sealed: true, sources: [value("i1", "B", "inner")], folders: ["/inner"] },
    );
    const plan = planRegionEnvironment(d, { seat: "in" }, "local");
    expect(plan.regions).toEqual([{ regionId: "inner", regionLabel: "Inner", sealed: true }]);
    expect(plan.sources.map((s) => s.source.id)).toEqual(["i1"]);
    expect(plan.folders).toEqual(["/inner"]);
    // The seal protects what is inside it, not the outer region's own seats.
    expect(
      planRegionEnvironment(d, { seat: "mid" }, "local").sources.map((s) => s.source.id),
    ).toEqual(["o1"]);
  });

  it("resolves a region exactly as a seat placed directly inside it", () => {
    const d = doc(
      { sources: [value("o1", "A", "outer")], folders: ["/outer"] },
      { sources: [value("i1", "A", "inner")], folders: ["/inner", "/outer"] },
    );
    expect(planRegionEnvironment(d, { region: "inner" }, "local")).toEqual(
      planRegionEnvironment(d, { seat: "in" }, "local"),
    );
    expect(planRegionEnvironment(d, { region: "outer" }, "local")).toEqual(
      planRegionEnvironment(d, { seat: "mid" }, "local"),
    );
    expect(planRegionEnvironment(d, { region: "inner" }, "local").folders).toEqual([
      "/outer",
      "/inner",
    ]);
  });

  it("marks a source that names another machine", () => {
    const d = doc({
      sources: [value("here", "A", "1", { host: "mac" }), value("there", "B", "2", { host: "linux" })],
    });
    const plan = planRegionEnvironment(d, { seat: "mid" }, "mac");
    expect(plan.sources.map((s) => [s.source.id, s.skippedHost])).toEqual([
      ["here", false],
      ["there", true],
    ]);
  });

  it("reads `local` as the machine resolving, and a given rect over the saved one", () => {
    const d = doc({ sources: [value("l", "A", "1", { host: "local" })] });
    expect(
      planRegionEnvironment(d, { seat: "mid" }, "mac").sources.map((s) => s.skippedHost),
    ).toEqual([false]);
    // `out` is saved outside every region, but it was just dragged inside.
    const moved = { x: 700, y: 700, width: 50, height: 40 };
    expect(planRegionEnvironment(d, { seat: "out" }, "mac").sources).toEqual([]);
    expect(
      planRegionEnvironment(d, { seat: "out", rect: moved }, "mac").sources.map((s) => s.source.id),
    ).toEqual(["l"]);
    // A seat not saved at all yet still resolves from where it sits.
    expect(
      planRegionEnvironment(d, { seat: "brand-new", rect: moved }, "mac").sources,
    ).toHaveLength(1);
  });
});

describe("merge and report", () => {
  it("an inner region overrides the outer by name, and a later source an earlier one", () => {
    const d = doc(
      { sources: [value("o1", "A", "outer"), value("o2", "B", "outer")] },
      { sources: [value("i1", "A", "inner-first"), value("i2", "A", "inner-last")] },
    );
    const plan = planRegionEnvironment(d, { seat: "in" }, "local");
    const merged = mergeRegionEnvironment(plan, outcomesFor(plan));
    expect(merged.env).toEqual({ A: "inner-last", B: "outer" });
    expect(merged.report.map((r) => [r.regionId, r.sourceId, r.status, r.names])).toEqual([
      ["outer", "o1", "overridden", ["A"]],
      ["outer", "o2", "ok", ["B"]],
      ["inner", "i1", "overridden", ["A"]],
      ["inner", "i2", "ok", ["A"]],
    ]);
    expect(merged.providers).toEqual({
      A: sourceKey("inner", "i2"),
      B: sourceKey("outer", "o2"),
    });
    expect(merged.refusal).toBeUndefined();
  });

  it("a multi-name source that loses only some names stays ok", () => {
    const d = doc({
      sources: [
        { id: "file", kind: "envFile", path: "/x.env" },
        value("v", "A", "later"),
      ],
    });
    const plan = planRegionEnvironment(d, { seat: "mid" }, "local");
    const merged = mergeRegionEnvironment(
      plan,
      outcomesFor(plan, { file: ok({ A: "file", B: "file" }) }),
    );
    expect(merged.env).toEqual({ A: "later", B: "file" });
    expect(merged.report.map((r) => [r.sourceId, r.status, r.names])).toEqual([
      ["file", "ok", ["A", "B"]],
      ["v", "ok", ["A"]],
    ]);
  });

  it("a missing or failing source leaves the variable out and says why", () => {
    const d = doc({
      sources: [
        { id: "k", kind: "keychain", name: "TOKEN", service: "absent" },
        { id: "f", kind: "envFile", path: "/gone.env" },
        { id: "op", kind: "onepassword", name: "GH", ref: "op://v/i/f" },
        value("v", "A", "1"),
      ],
    });
    const plan = planRegionEnvironment(d, { seat: "mid" }, "local");
    const merged = mergeRegionEnvironment(
      plan,
      outcomesFor(plan, {
        k: { status: "missing", names: ["TOKEN"], reason: "No Keychain item named absent" },
        f: { status: "missing", names: [], reason: "No file at /gone.env" },
        // `op` has no outcome at all: reported, never treated as absent.
      }),
    );
    expect(merged.env).toEqual({ A: "1" });
    expect(merged.refusal).toBeUndefined();
    expect(merged.report.map((r) => [r.sourceId, r.status, r.names, r.reason])).toEqual([
      ["k", "missing", ["TOKEN"], "No Keychain item named absent"],
      ["f", "missing", [], "No file at /gone.env"],
      ["op", "error", ["GH"], "This source was not resolved"],
      ["v", "ok", ["A"], undefined],
    ]);
  });

  it("a required source that cannot be read refuses the launch with the reason", () => {
    const d = doc({
      sources: [
        { id: "k", kind: "keychain", name: "TOKEN", service: "absent", required: true },
        value("other", "B", "2", { required: true, host: "elsewhere" }),
      ],
    });
    const plan = planRegionEnvironment(d, { seat: "mid" }, "local");
    const merged = mergeRegionEnvironment(
      plan,
      outcomesFor(plan, {
        k: { status: "error", names: ["TOKEN"], reason: "the Keychain is locked" },
      }),
    );
    expect(merged.refusal).toBe(
      "Outer: TOKEN is required and could not be read. The Keychain is locked",
    );
    expect(merged.report[0]).toMatchObject({ status: "error", required: true });
    // A required source for another machine is not this machine's problem.
    expect(merged.report[1]).toMatchObject({
      status: "skipped-host",
      names: ["B"],
      reason: "Only on elsewhere",
      required: true,
    });
  });

  it("reports a name Junto keeps for itself instead of dropping it silently", () => {
    const d = doc({
      sources: [
        value("j", "JUNTO_SOCKET", "/tmp/evil.sock"),
        value("c", "CLAUDECODE", "1"),
        value("t", "TERM", "dumb"),
        { id: "file", kind: "envFile", path: "/x.env" },
        value("p", "PATH", "/opt/bin"),
      ],
    });
    const plan = planRegionEnvironment(d, { seat: "mid" }, "local");
    const merged = mergeRegionEnvironment(
      plan,
      outcomesFor(plan, { file: ok({ KEEP: "1", JUNTO_SEAT: "x", PRIME_AGENT_INTERNAL_ROLE: "w" }) }),
    );
    expect(merged.env).toEqual({ KEEP: "1", PATH: "/opt/bin" });
    expect(merged.report.map((r) => [r.sourceId, r.status, r.names])).toEqual([
      ["j", "overridden", ["JUNTO_SOCKET"]],
      ["c", "overridden", ["CLAUDECODE"]],
      ["t", "overridden", ["TERM"]],
      ["file", "ok", ["KEEP"]],
      ["p", "ok", ["PATH"]],
    ]);
    expect(merged.report[0]!.reason).toBe("Junto sets JUNTO_SOCKET itself");
    expect(merged.report[1]!.reason).toContain("nested session");
    expect(merged.report[3]!.reason).toContain("JUNTO_SEAT");
    expect(reservedEnvNameReason("PATH")).toBeUndefined();
    expect(reservedEnvNameReason("OP_SERVICE_ACCOUNT_TOKEN")).toBeUndefined();
  });

  it("never puts a value in the report", () => {
    const d = doc({ sources: [value("v", "A", "SECRET-CANARY")] });
    const plan = planRegionEnvironment(d, { seat: "mid" }, "local");
    const merged = mergeRegionEnvironment(
      plan,
      outcomesFor(plan, { v: ok({ A: "SECRET-CANARY", JUNTO_X: "SECRET-CANARY" }) }),
    );
    expect(JSON.stringify(merged.report)).not.toContain("SECRET-CANARY");
    expect(JSON.stringify(launchRecordOf(plan, merged))).not.toContain("SECRET-CANARY");
  });
});

describe("what a running seat was launched with", () => {
  const record = (d: CanvasDoc, target = "in") => {
    const plan = planRegionEnvironment(d, { seat: target }, "local");
    return launchRecordOf(plan, mergeRegionEnvironment(plan, outcomesFor(plan)));
  };

  it("is the empty record outside every environment", () => {
    expect(record(doc(), "out")).toEqual(EMPTY_LAUNCH_RECORD);
    expect(record(doc())).toEqual(EMPTY_LAUNCH_RECORD);
  });

  it("the fingerprint moves with the document and with nothing else", () => {
    const base = doc({ sources: [value("a", "A", "1")] }, { sources: [value("b", "B", "2")] });
    const same = doc({ sources: [value("a", "A", "1")] }, { sources: [value("b", "B", "2")] });
    expect(record(base).fingerprint).toBe(record(same).fingerprint);
    const variants: CanvasDoc[] = [
      doc({ sources: [value("a", "A", "9")] }, { sources: [value("b", "B", "2")] }),
      doc({ sources: [value("a", "A", "1")] }, { sealed: true, sources: [value("b", "B", "2")] }),
      doc({ sources: [value("a", "A", "1")] }, { sources: [value("b", "B", "2")], folders: ["/x"] }),
      doc({ sources: [value("a", "A", "1"), value("c", "C", "3")] }, { sources: [value("b", "B", "2")] }),
      doc({ sources: [value("a", "A", "1")] }),
    ];
    for (const variant of variants) {
      expect(record(variant).fingerprint).not.toBe(record(base).fingerprint);
    }
    // Reordering inside a region changes who wins, so it counts.
    const ab = doc({ sources: [value("a", "A", "1"), value("b", "A", "2")] });
    const ba = doc({ sources: [value("b", "A", "2"), value("a", "A", "1")] });
    expect(regionEnvironmentFingerprint(planRegionEnvironment(ab, { seat: "mid" }, "local"))).not.toBe(
      regionEnvironmentFingerprint(planRegionEnvironment(ba, { seat: "mid" }, "local")),
    );
  });

  it("names what would differ after a restart: added, removed, or from another source", () => {
    const launched = record(
      doc({ sources: [value("a", "A", "1"), value("gone", "GONE", "x"), value("keep", "KEEP", "k")] }),
    );
    const current = record(
      doc(
        { sources: [value("a", "A", "1"), value("keep", "KEEP", "k")] },
        { sources: [value("a2", "A", "inner"), value("new", "NEW", "n")] },
      ),
    );
    expect(changedNames(launched, current)).toEqual(["A", "GONE", "NEW"]);
    expect(changedNames(launched, launched)).toEqual([]);
  });
});
