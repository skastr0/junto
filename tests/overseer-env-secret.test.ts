import type { Node, NodeOf } from "../src/shared/model";
import { note as noteNode, region as regionNode } from "./support/model-nodes";
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import {
  OVERSEER_SECRET_ARGS_FAILURE,
  decodeOverseerArgs,
  isOverseerMutation,
} from "../src/shared/overseer-control";
import {
  applyRegionEnvironmentEdit,
  narrowEnvironmentReport,
  regionEnvironmentOf,
  type OverseerEnvEdit,
} from "../src/shared/overseer-env";
import type { RegionEnvironmentReport } from "../src/shared/region-environment";
import {
  SECRET_STORE_MISSING,
  executeOverseerSecret,
} from "../src/core/overseer/secret";
import type { OverseerSecretStore } from "../src/core/overseer/secret-store-seam";

// A value no assertion may ever find in an output, an error or a result.
const VALUE = "s3cr3t-never-echoed";

type RegionNode = NodeOf<"region">;

const region = (environment?: object): RegionNode =>
  regionNode("region", { x: 0, y: 0, width: 800, height: 600 }, {
    label: "Build",
    hold: true,
    instruction: "ship it",
    ...(environment === undefined ? {} : { environment: environment as RegionNode["environment"] }),
  });

const edit = (node: Node, change: OverseerEnvEdit, minted = "source-minted") =>
  applyRegionEnvironmentEdit(node, change, () => minted);

/** The region as it stands once the edit's environment is put on it. */
const edited = (node: RegionNode, change: OverseerEnvEdit): RegionNode => {
  const result = edit(node, change);
  if (!result.ok) throw new Error(result.error.message);
  const { environment: _was, ...rest } = node;
  return result.value === undefined ? rest : { ...rest, environment: result.value };
};

const value = (id: string, name: string) =>
  ({ id, kind: "value", name, value: "plain" }) as const;

describe("region environment edits", () => {
  it("appends a source, mints its id, and leaves the rest of the region alone", () => {
    const next = edited(region(), {
      operation: "env.source-add",
      args: {
        nodeId: "region",
        source: { kind: "keychain", name: "EXAMPLE_AUTH_TOKEN", service: "op" },
      },
    });
    expect(regionEnvironmentOf(next)).toEqual({
      sources: [
        { id: "source-minted", kind: "keychain", name: "EXAMPLE_AUTH_TOKEN", service: "op" },
      ],
    });
    expect(next).toMatchObject({ id: "region", kind: "region", label: "Build", hold: true, instruction: "ship it" });
  });

  it("inserts at an index and refuses a duplicate id or an index past the end", () => {
    const start = region({ sources: [value("a", "A"), value("b", "B")] });
    const add = (source: object, index?: number): OverseerEnvEdit => ({
      operation: "env.source-add",
      args: { nodeId: "region", source, ...(index === undefined ? {} : { index }) } as never,
    });
    expect(
      regionEnvironmentOf(edited(start, add(value("c", "C"), 1))).sources?.map((s) => s.id),
    ).toEqual(["a", "c", "b"]);
    expect(edit(start, add(value("a", "AGAIN")))).toMatchObject({
      ok: false,
      error: { type: "InvalidArguments" },
    });
    expect(edit(start, add(value("c", "C"), 3))).toMatchObject({
      ok: false,
      error: { type: "InvalidArguments" },
    });
  });

  it("replaces a source whole and keeps its id", () => {
    const start = region({
      sources: [{ id: "a", kind: "keychain", name: "A", service: "svc", account: "me", required: true }],
    });
    const change = (source: object, sourceId = "a"): OverseerEnvEdit => ({
      operation: "env.source-edit",
      args: { nodeId: "region", sourceId, source } as never,
    });
    expect(
      regionEnvironmentOf(edited(start, change({ kind: "envFile", path: "~/.env" }))).sources,
    ).toEqual([{ id: "a", kind: "envFile", path: "~/.env" }]);
    expect(edit(start, change({ id: "renamed", kind: "envFile", path: "~/.env" }))).toMatchObject({
      ok: false,
      error: { type: "InvalidArguments" },
    });
    expect(edit(start, change({ kind: "envFile", path: "~/.env" }, "ghost"))).toMatchObject({
      ok: false,
      error: { type: "NotFound" },
    });
  });

  it("removes a source and drops the environment when nothing is left", () => {
    const start = region({ sources: [value("a", "A")] });
    const next = edited(start, {
      operation: "env.source-remove",
      args: { nodeId: "region", sourceId: "a" },
    });
    expect(next).toMatchObject({ hold: true, instruction: "ship it" });
    expect(next).not.toHaveProperty("environment");
    expect(
      edit(start, { operation: "env.source-remove", args: { nodeId: "region", sourceId: "ghost" } }),
    ).toMatchObject({ ok: false, error: { type: "NotFound" } });
  });

  it("reorders only by a complete permutation", () => {
    const start = region({ sources: [value("a", "A"), value("b", "B"), value("c", "C")] });
    const reorder = (sourceIds: string[]): OverseerEnvEdit => ({
      operation: "env.source-reorder",
      args: { nodeId: "region", sourceIds },
    });
    expect(
      regionEnvironmentOf(edited(start, reorder(["c", "a", "b"]))).sources?.map((s) => s.id),
    ).toEqual(["c", "a", "b"]);
    for (const sourceIds of [["a", "b"], ["a", "b", "b"], ["a", "b", "ghost"], ["a", "b", "c", "c"]]) {
      expect(edit(start, reorder(sourceIds))).toMatchObject({
        ok: false,
        error: { type: "InvalidArguments" },
      });
    }
  });

  it("seals, unseals, and sets folders whole", () => {
    const sealed = edited(region(), {
      operation: "env.seal",
      args: { nodeId: "region", sealed: true },
    });
    expect(regionEnvironmentOf(sealed)).toEqual({ sealed: true });
    const open = edited(sealed, { operation: "env.seal", args: { nodeId: "region", sealed: false } });
    expect(open).not.toHaveProperty("environment");

    const folders = (list: string[]): OverseerEnvEdit => ({
      operation: "env.folders",
      args: { nodeId: "region", folders: list },
    });
    const withFolders = edited(sealed, folders(["~/.config/gh", "/opt/certs"]));
    expect(regionEnvironmentOf(withFolders)).toEqual({
      sealed: true,
      folders: ["~/.config/gh", "/opt/certs"],
    });
    expect(regionEnvironmentOf(edited(withFolders, folders(["~"])))).toEqual({
      sealed: true,
      folders: ["~"],
    });
    expect(edit(sealed, folders(["relative/path"]))).toMatchObject({
      ok: false,
      error: { type: "InvalidArguments" },
    });
  });

  it("refuses a node that is not a region", () => {
    expect(
      edit(noteNode("n1"), { operation: "env.seal", args: { nodeId: "n1", sealed: true } }),
    ).toMatchObject({ ok: false, error: { type: "InvalidArguments" } });
  });
});

describe("env and secret arg schemas", () => {
  it("decodes a source without an id against the canvas's own source shape", () => {
    const ok = (source: unknown) =>
      Result.isSuccess(decodeOverseerArgs("env.source-add", { nodeId: "region", source }));
    expect(ok({ kind: "value", name: "NODE_ENV", value: "production" })).toBe(true);
    expect(ok({ id: "x", kind: "onepassword", name: "DB", ref: "op://v/i/f", tokenFrom: "t" })).toBe(true);
    expect(ok({ kind: "command", name: "T", argv: ["gh", "auth", "token"] })).toBe(true);
    expect(ok({ kind: "value", name: "not a name", value: "x" })).toBe(false);
    expect(ok({ kind: "value", name: "A", value: "x", surprise: true })).toBe(false);
    expect(ok({ kind: "telepathy", name: "A" })).toBe(false);
    expect(ok({ kind: "command", name: "T", argv: [] })).toBe(false);
  });

  it("classifies reads and mutations", () => {
    for (const operation of ["env.show", "env.doctor", "secret.list"] as const) {
      expect(isOverseerMutation(operation)).toBe(false);
    }
    for (const operation of [
      "env.source-add", "env.source-edit", "env.source-remove", "env.source-reorder",
      "env.seal", "env.folders", "secret.put", "secret.delete",
    ] as const) {
      expect(isOverseerMutation(operation)).toBe(true);
    }
  });

  it("never repeats what secret.put was given when its args do not decode", () => {
    for (const args of [
      { secretId: 7, value: VALUE },
      { secretId: "id", value: { nested: VALUE } },
      { secretId: "id", value: VALUE, [VALUE]: VALUE },
      { value: "" },
      { secretId: "not-a-uuid", value: VALUE },
      { value: `${VALUE}\u0000` },
      { value: VALUE.repeat(4096) },
      VALUE,
      [VALUE],
    ]) {
      const decoded = decodeOverseerArgs("secret.put", args);
      expect(Result.isFailure(decoded)).toBe(true);
      if (Result.isFailure(decoded)) {
        expect(decoded.failure.message).toBe(OVERSEER_SECRET_ARGS_FAILURE);
        expect(JSON.stringify(decoded.failure)).not.toContain(VALUE);
      }
    }
    expect(Result.isSuccess(decodeOverseerArgs("secret.put", { value: VALUE }))).toBe(true);
    expect(Result.isSuccess(decodeOverseerArgs("secret.put", { secretId: "5b0f6d0e-2c1a-4b7e-9d3f-8a1c2e4f6a70", value: VALUE }))).toBe(true);
  });
});

const fakeStore = (): OverseerSecretStore & { readonly held: Map<string, string> } => {
  const held = new Map<string, string>();
  return {
    held,
    backend: "memory",
    save: ({ value: saved, secretId }) => {
      if (secretId === "not-an-id") return { ok: false, message: "That is not a secret id." };
      const id = secretId ?? `minted-${held.size + 1}`;
      held.set(id, saved);
      return { ok: true, secretId: id };
    },
    remove: (secretId) => {
      held.delete(secretId);
      return { ok: true };
    },
    list: () => [...held.keys()].sort(),
  };
};

describe("overseer secret operations", () => {
  it("stores a value and answers with the id, never the value", () => {
    const store = fakeStore();
    const minted = executeOverseerSecret({ operation: "secret.put", args: { value: VALUE } }, store);
    expect(minted).toEqual({
      ok: true,
      data: { secretId: "minted-1", stored: true, backend: "memory" },
    });
    const replaced = executeOverseerSecret(
      { operation: "secret.put", args: { secretId: "minted-1", value: `${VALUE}-2` } },
      store,
    );
    expect(replaced).toMatchObject({ ok: true, data: { secretId: "minted-1" } });
    expect(store.held.get("minted-1")).toBe(`${VALUE}-2`);
    expect(JSON.stringify([minted, replaced])).not.toContain(VALUE);
  });

  it("reports the store's own refusal without the value", () => {
    const refused = executeOverseerSecret(
      { operation: "secret.put", args: { secretId: "not-an-id", value: VALUE } },
      fakeStore(),
    );
    expect(refused).toEqual({
      ok: false,
      error: { type: "InvalidArguments", message: "That is not a secret id." },
    });
  });

  it("lists ids only and deletes by id", () => {
    const store = fakeStore();
    executeOverseerSecret({ operation: "secret.put", args: { secretId: "b", value: VALUE } }, store);
    executeOverseerSecret({ operation: "secret.put", args: { secretId: "a", value: VALUE } }, store);
    const listed = executeOverseerSecret({ operation: "secret.list", args: {} }, store);
    expect(listed).toEqual({ ok: true, data: { secretIds: ["a", "b"], backend: "memory" } });
    expect(JSON.stringify(listed)).not.toContain(VALUE);
    expect(
      executeOverseerSecret({ operation: "secret.delete", args: { secretId: "a" } }, store),
    ).toEqual({ ok: true, data: { secretId: "a", deleted: true } });
    expect(store.held.has("a")).toBe(false);
  });

  it("answers Unsupported when no store is wired", () => {
    expect(
      executeOverseerSecret({ operation: "secret.put", args: { value: VALUE } }, undefined),
    ).toEqual({ ok: false, error: { type: "Unsupported", message: SECRET_STORE_MISSING } });
  });
});


const source = (
  sourceId: string,
  status: string,
  required: boolean,
  regionId = "outer",
) => ({
  regionId,
  regionLabel: regionId,
  sourceId,
  kind: "keychain" as const,
  names: ["TOKEN"],
  status: status as "ok",
  required,
});

describe("environment report", () => {

  it("narrows the canvas-wide report to a region or to a seat", () => {
    const whole: RegionEnvironmentReport = {
      regions: [
        { regionId: "outer", regionLabel: "Outer", sealed: false, sources: [source("a", "ok", false)] },
        { regionId: "inner", regionLabel: "Inner", sealed: true, sources: [source("b", "ok", false, "inner")] },
        { regionId: "other", regionLabel: "Other", sealed: false, sources: [] },
      ],
      seats: [
        { nodeId: "deep", title: "Deep", regions: ["outer", "inner"], report: [], folders: [], restartToApply: false },
        { nodeId: "shallow", title: "Shallow", regions: ["outer"], report: [], folders: [], restartToApply: true },
        { nodeId: "apart", title: "Apart", regions: ["other"], report: [], folders: [], restartToApply: false },
      ],
    };
    const ids = (report: RegionEnvironmentReport) => ({
      regions: report.regions.map((entry) => entry.regionId),
      seats: report.seats.map((entry) => entry.nodeId),
    });
    expect(ids(narrowEnvironmentReport(whole, "inner"))).toEqual({ regions: ["inner"], seats: ["deep"] });
    expect(ids(narrowEnvironmentReport(whole, "outer"))).toEqual({ regions: ["outer"], seats: ["deep", "shallow"] });
    expect(ids(narrowEnvironmentReport(whole, "deep"))).toEqual({ regions: ["outer", "inner"], seats: ["deep"] });
    expect(ids(narrowEnvironmentReport(whole, "elsewhere"))).toEqual({ regions: [], seats: [] });
  });
});
