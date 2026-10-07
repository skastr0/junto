import { describe, expect, it } from "vitest";
import { Effect, Result } from "effect";
import type { CanvasNode } from "../src/shared/canvas";
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
} from "../src/main/junto/overseer/secret";
import type { OverseerSecretStore } from "../src/main/junto/overseer/secret-store-seam";
import { reportBlocksLaunch } from "../src/cli/core/env-report";
import { InputError } from "../src/cli/core/errors";
import {
  decodeSecretPutInput,
  readSecretValue,
  stripOneTrailingNewline,
} from "../src/cli/core/secret-input";

// A value no assertion may ever find in an output, an error or a result.
const VALUE = "s3cr3t-never-echoed";

const region = (environment?: object): CanvasNode =>
  ({
    id: "region",
    type: "group",
    label: "Build",
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    ether: {
      region: {
        hold: true,
        instruction: "ship it",
        ...(environment === undefined ? {} : { environment }),
      },
    },
  }) as CanvasNode;

const edit = (node: CanvasNode, change: OverseerEnvEdit, minted = "source-minted") =>
  applyRegionEnvironmentEdit(node, change, () => minted);

const edited = (node: CanvasNode, change: OverseerEnvEdit): CanvasNode => {
  const result = edit(node, change);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
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
    expect(next.ether?.region).toMatchObject({ hold: true, instruction: "ship it" });
    expect(next).toMatchObject({ id: "region", type: "group", label: "Build" });
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
    expect(next.ether?.region).toEqual({ hold: true, instruction: "ship it" });
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
    expect(open.ether?.region).not.toHaveProperty("environment");

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
    const note = { id: "n1", type: "text", text: "note", x: 0, y: 0, width: 10, height: 10 } as CanvasNode;
    expect(
      edit(note, { operation: "env.seal", args: { nodeId: "n1", sealed: true } }),
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

const run = <A>(effect: Effect.Effect<A, InputError>) =>
  Effect.runPromise(Effect.result(effect));

const noFile = () => Effect.fail(new InputError({ message: "no file in this test" }));

describe("secret put input", () => {
  it("takes {} or {secretId} as its argument", async () => {
    expect(await run(decodeSecretPutInput(undefined, noFile))).toMatchObject({ success: {} });
    expect(await run(decodeSecretPutInput("  ", noFile))).toMatchObject({ success: {} });
    expect(await run(decodeSecretPutInput('{"secretId":"5b0f6d0e-2c1a-4b7e-9d3f-8a1c2e4f6a70"}', noFile))).toMatchObject({
      success: { secretId: "5b0f6d0e-2c1a-4b7e-9d3f-8a1c2e4f6a70" },
    });
    expect(
      await run(decodeSecretPutInput("@named.json", () => Effect.succeed('{"secretId":"6c1a7e1f-3d2b-4c8f-8e4a-9b2d3f5a7b81"}'))),
    ).toMatchObject({ success: { secretId: "6c1a7e1f-3d2b-4c8f-8e4a-9b2d3f5a7b81" } });
  });

  it("refuses a value in the argument, stdin as the argument, and anything else, without echo", async () => {
    for (const input of [
      JSON.stringify({ value: VALUE }),
      JSON.stringify({ secretId: "5b0f6d0e-2c1a-4b7e-9d3f-8a1c2e4f6a70", value: VALUE }),
      JSON.stringify({ secretId: "5b0f6d0e-2c1a-4b7e-9d3f-8a1c2e4f6a70", note: VALUE }),
      JSON.stringify({ secretId: VALUE }),
      JSON.stringify(VALUE),
      `{"secretId": ${VALUE}`,
      "-",
      "@-",
    ]) {
      const result = await run(decodeSecretPutInput(input, noFile));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("InputError");
        expect(JSON.stringify(result.failure)).not.toContain(VALUE);
        expect(result.failure.received).toBeUndefined();
      }
    }
  });

  it("reads the value from a pipe and strips exactly one trailing newline", async () => {
    const piped = (text: string) =>
      run(readSecretValue({ isTTY: false, text: () => Promise.resolve(text) }));
    expect(await piped(`${VALUE}\n`)).toMatchObject({ success: VALUE });
    expect(await piped(VALUE)).toMatchObject({ success: VALUE });
    expect(await piped(`${VALUE}\n\n`)).toMatchObject({ success: `${VALUE}\n` });
    expect(await piped(` ${VALUE} `)).toMatchObject({ success: ` ${VALUE} ` });
    expect(stripOneTrailingNewline("a\r\n")).toBe("a\r");
  });

  it("refuses a terminal, an empty value, and an unreadable stdin", async () => {
    let read = false;
    const tty = await run(
      readSecretValue({
        isTTY: true,
        text: () => {
          read = true;
          return Promise.resolve(VALUE);
        },
      }),
    );
    expect(Result.isFailure(tty)).toBe(true);
    expect(read).toBe(false);
    for (const text of ["", "\n"]) {
      expect(
        Result.isFailure(await run(readSecretValue({ isTTY: false, text: () => Promise.resolve(text) }))),
      ).toBe(true);
    }
    const broken = await run(
      readSecretValue({ isTTY: false, text: () => Promise.reject(new Error(VALUE)) }),
    );
    expect(Result.isFailure(broken)).toBe(true);
    expect(JSON.stringify(broken)).not.toContain(VALUE);
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
  it("fails only for a required source that is missing or in error", () => {
    const report = (status: string, required: boolean) => ({
      regions: [{ regionId: "outer", regionLabel: "outer", sealed: false, sources: [source("s", "ok", true)] }],
      seats: [{ nodeId: "seat", title: "Seat", regions: ["outer"], report: [source("s", status, required)], folders: [], restartToApply: false }],
    });
    expect(reportBlocksLaunch(report("missing", true))).toBe(true);
    expect(reportBlocksLaunch(report("error", true))).toBe(true);
    expect(reportBlocksLaunch(report("missing", false))).toBe(false);
    expect(reportBlocksLaunch(report("error", false))).toBe(false);
    for (const status of ["ok", "skipped-host", "overridden"]) {
      expect(reportBlocksLaunch(report(status, true))).toBe(false);
    }
    expect(reportBlocksLaunch({ regions: [], seats: [] })).toBe(false);
    // One seat's own report obeys the same rule.
    expect(reportBlocksLaunch(report("missing", true).seats[0])).toBe(true);
  });

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
