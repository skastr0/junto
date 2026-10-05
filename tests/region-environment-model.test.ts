/**
 * Region environment, the screen's pure half: what each source kind asks
 * for, what a draft saves as (and that a typed secret cannot reach the
 * document), and the resolved view built from main's report.
 */
import { describe, expect, it } from "vitest";
import {
  SOURCE_KINDS,
  cleanEnvironment,
  cleanFolders,
  describeSource,
  draftOfSource,
  draftProblems,
  draftSecretValue,
  folderProblem,
  newSourceDraft,
  reorderSources,
  resolvedView,
  sourceKindSpec,
  statusReason,
  toSource,
  upsertSource,
  type EnvSource,
  type SourceDraft,
  type SourceReport,
} from "../src/renderer/lib/region-environment";

const draft = (kind: SourceDraft["kind"], fields: Record<string, string>, over: Partial<SourceDraft> = {}): SourceDraft => ({
  ...newSourceDraft("s1", kind),
  fields,
  ...over,
});

const reported = (over: Partial<SourceReport>): SourceReport => ({
  regionId: "inner",
  regionLabel: "Payments",
  sourceId: "s1",
  kind: "keychain",
  names: ["TOKEN"],
  status: "ok",
  required: false,
  ...over,
});

describe("source kinds", () => {
  it("covers every kind the contract names, each with its own fields and an example in every one", () => {
    expect(SOURCE_KINDS.map((spec) => spec.kind).sort()).toEqual(
      ["command", "envFile", "keychain", "keyring", "onepassword", "secret", "secretsDir", "value"],
    );
    for (const spec of SOURCE_KINDS) {
      expect(spec.fields.length).toBeGreaterThan(0);
      for (const field of spec.fields) expect(field.placeholder.length).toBeGreaterThan(0);
    }
  });

  it("asks only for what a kind needs", () => {
    const keys = (kind: SourceDraft["kind"]) => sourceKindSpec(kind).fields.map((field) => field.key);
    expect(keys("keychain")).toEqual(["name", "service", "account"]);
    expect(keys("envFile")).toEqual(["path"]);
    expect(keys("secretsDir")).toEqual(["path", "prefix"]);
    expect(keys("onepassword")).toEqual(["name", "ref", "tokenFrom"]);
    expect(keys("secret")).toEqual(["name", "secretValue"]);
  });

  it("offers what the operator already has before what Junto would keep", () => {
    const order = SOURCE_KINDS.map((spec) => spec.kind);
    expect(order.indexOf("keychain")).toBeLessThan(order.indexOf("secret"));
    expect(order.indexOf("onepassword")).toBeLessThan(order.indexOf("secret"));
    expect(order.indexOf("envFile")).toBeLessThan(order.indexOf("secret"));
  });

  it("no copy carries a middle dot", () => {
    expect(JSON.stringify(SOURCE_KINDS)).not.toContain("·");
  });
});

describe("drafts", () => {
  it("the simplest case saves as the contract's keychain source", () => {
    const source = toSource(draft("keychain", { name: " OP_SERVICE_ACCOUNT_TOKEN ", service: "op-service-account" }));
    expect(source).toEqual({
      id: "s1",
      kind: "keychain",
      name: "OP_SERVICE_ACCOUNT_TOKEN",
      service: "op-service-account",
    });
  });

  it("round-trips every kind through its form", () => {
    const sources: EnvSource[] = [
      { id: "a", kind: "value", name: "AWS_REGION", value: "eu-west-1" },
      { id: "b", kind: "secret", name: "GITHUB_TOKEN", secretId: "sec-1", required: true },
      { id: "c", kind: "keychain", name: "T", service: "svc", account: "me" },
      { id: "d", kind: "keyring", name: "T", attributes: { service: "svc", user: "me" } },
      { id: "e", kind: "onepassword", name: "K", ref: "op://Private/Item/field", tokenFrom: "c" },
      { id: "f", kind: "envFile", path: "~/work/.env" },
      { id: "g", kind: "secretsDir", path: "~/secrets", prefix: "ACME_" },
      { id: "h", kind: "command", name: "V", argv: ["vault", "print", "token"] },
    ];
    for (const source of sources) expect(toSource(draftOfSource(source))).toEqual(source);
  });

  it("says what is missing in plain words, per field", () => {
    expect(draftProblems(draft("keychain", {}))).toEqual({
      name: "Variable name is needed.",
      service: "Keychain item name is needed.",
    });
    expect(draftProblems(draft("keychain", { name: "1BAD", service: "x" })).name).toMatch(/letters, digits/);
    expect(draftProblems(draft("onepassword", { name: "K", ref: "Private/Item" })).ref).toMatch(/op:\/\//);
    expect(draftProblems(draft("keyring", { name: "K", attributes: "nonsense" })).attributes).toMatch(/name=value/);
    expect(draftProblems(draft("keychain", { name: "OK", service: "svc" }))).toEqual({});
  });

  it("a new secret needs a value; an existing one keeps its stored value when the field is left empty", () => {
    expect(draftProblems(draft("secret", { name: "K" })).secretValue).toBe("Value is needed.");
    expect(draftProblems(draft("secret", { name: "K" }, { secretId: "sec-1" }))).toEqual({});
    expect(draftSecretValue(draft("secret", { name: "K" }, { secretId: "sec-1" }))).toBeUndefined();
    expect(draftSecretValue(draft("secret", { name: "K", secretValue: "hunter2" }))).toBe("hunter2");
  });

  it("a typed secret never reaches the source that is saved", () => {
    const typed = draft("secret", { name: "GITHUB_TOKEN", secretValue: "hunter2-very-secret" });
    const source = toSource(typed, "sec-9");
    expect(source).toEqual({ id: "s1", kind: "secret", name: "GITHUB_TOKEN", secretId: "sec-9" });
    expect(JSON.stringify(source)).not.toContain("hunter2");
    // Nor does a form opened on a stored secret know its value.
    expect(JSON.stringify(draftOfSource(source))).not.toContain("hunter2");
  });

  it("only a secret source yields a value for the store", () => {
    expect(draftSecretValue(draft("value", { name: "A", value: "plain", secretValue: "x" }))).toBeUndefined();
  });

  it("describes a source without a secret value, and shows a plain value as what it is", () => {
    expect(describeSource({ id: "a", kind: "secret", name: "K", secretId: "sec-1" })).toEqual({
      title: "K",
      detail: "Secret kept by Junto",
    });
    expect(describeSource({ id: "a", kind: "value", name: "AWS_REGION", value: "eu-west-1" }).detail).toBe(
      "Plain value: eu-west-1",
    );
    expect(describeSource({ id: "a", kind: "envFile", path: "~/work/.env" })).toEqual({
      title: "~/work/.env",
      detail: "Env file",
    });
  });
});

describe("editing", () => {
  it("reorders by moving one source; order is what decides who wins", () => {
    expect(reorderSources(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(reorderSources(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(reorderSources(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
    expect(reorderSources(["a", "b", "c"], 9, 0)).toEqual(["a", "b", "c"]);
  });

  it("an edited source keeps its place; a new one goes last", () => {
    const a: EnvSource = { id: "a", kind: "envFile", path: "/a" };
    const b: EnvSource = { id: "b", kind: "envFile", path: "/b" };
    expect(upsertSource([a, b], { ...a, path: "/a2" })).toEqual([{ ...a, path: "/a2" }, b]);
    expect(upsertSource([a], b)).toEqual([a, b]);
  });

  it("folders are kept as written, without blanks or repeats, and must be findable from anywhere", () => {
    expect(cleanFolders([" ~/.config/gcloud/ ", "", "~/.config/gcloud", "/opt/tools"])).toEqual([
      "~/.config/gcloud",
      "/opt/tools",
    ]);
    expect(folderProblem("~/.config")).toBeUndefined();
    expect(folderProblem("/opt/tools")).toBeUndefined();
    expect(folderProblem("")).toBeUndefined();
    expect(folderProblem("relative/path")).toMatch(/full path/);
  });

  it("an environment with nothing in it is not stored at all", () => {
    expect(cleanEnvironment({ sealed: false, sources: [], folders: [" "] })).toBeUndefined();
    expect(cleanEnvironment({ sealed: true })).toEqual({ sealed: true });
    expect(cleanEnvironment({ sources: [{ id: "a", kind: "envFile", path: "/a" }], folders: ["/x/"] })).toEqual({
      sources: [{ id: "a", kind: "envFile", path: "/a" }],
      folders: ["/x"],
    });
  });
});

describe("the resolved view", () => {
  it("names each variable with the source and the region it comes from", () => {
    const view = resolvedView([reported({})], "inner");
    expect(view.variables).toEqual([
      {
        name: "TOKEN",
        effective: expect.objectContaining({
          kindLabel: "macOS Keychain item",
          regionLabel: "Payments",
          inherited: false,
          status: "ok",
        }),
        overridden: [],
        failed: [],
      },
    ]);
    expect(view.blocksLaunch).toBe(false);
  });

  it("marks a variable that comes from an outer region as inherited", () => {
    const view = resolvedView(
      [reported({ regionId: "outer", regionLabel: "Company", sourceId: "o1", names: ["ORG"] })],
      "inner",
    );
    expect(view.variables[0]?.effective).toMatchObject({ inherited: true, regionLabel: "Company" });
    // An inherited source is not one of this region's rows.
    expect(view.statusBySourceId).toEqual({});
  });

  it("an inner source overrides an outer one by name: the outer is struck through", () => {
    const view = resolvedView(
      [
        reported({ regionId: "outer", regionLabel: "Company", sourceId: "o1", status: "overridden" }),
        reported({ sourceId: "i1" }),
      ],
      "inner",
    );
    const token = view.variables[0]!;
    expect(token.effective).toMatchObject({ sourceId: "i1", inherited: false });
    expect(token.overridden).toEqual([expect.objectContaining({ sourceId: "o1", inherited: true })]);
  });

  it("works out per name which source wins when a many-name source loses only some", () => {
    // An env file gives A and B; a later source sets B again. The file is
    // still ok for A, so the report cannot call it overridden.
    const view = resolvedView(
      [
        reported({ sourceId: "file", kind: "envFile", names: ["A", "B"] }),
        reported({ sourceId: "later", kind: "value", names: ["B"] }),
      ],
      "inner",
    );
    const [a, b] = view.variables;
    expect(a).toMatchObject({ name: "A", effective: { sourceId: "file" }, overridden: [] });
    expect(b).toMatchObject({ name: "B", effective: { sourceId: "later" } });
    expect(b?.overridden.map((provider) => provider.sourceId)).toEqual(["file"]);
  });

  it("a variable whose only source failed is not set, and says why in the report's words", () => {
    const view = resolvedView(
      [reported({ status: "missing", reason: "No Keychain item named op-service-account." })],
      "inner",
    );
    const token = view.variables[0]!;
    expect(token.effective).toBeUndefined();
    expect(token.failed).toHaveLength(1);
    expect(statusReason(token.failed[0]!)).toBe("No Keychain item named op-service-account.");
    expect(view.statusBySourceId.s1).toMatchObject({ status: "missing" });
    expect(view.blocksLaunch).toBe(false);
  });

  it("a failing inner source falls back to the outer one, and still shows its error", () => {
    const view = resolvedView(
      [
        reported({ regionId: "outer", regionLabel: "Company", sourceId: "o1" }),
        reported({ sourceId: "i1", status: "error", reason: "op timed out after 10 seconds." }),
      ],
      "inner",
    );
    const token = view.variables[0]!;
    expect(token.effective).toMatchObject({ sourceId: "o1", inherited: true });
    expect(token.failed.map((provider) => provider.reason)).toEqual(["op timed out after 10 seconds."]);
  });

  it("a required source that fails means seats will not start", () => {
    expect(resolvedView([reported({ status: "error", required: true })], "inner").blocksLaunch).toBe(true);
    expect(resolvedView([reported({ status: "overridden", required: true })], "inner").blocksLaunch).toBe(false);
  });

  it("a source that failed before it knew its names is listed as an error of its own", () => {
    const view = resolvedView(
      [reported({ sourceId: "file", kind: "envFile", names: [], status: "missing", reason: "No file at ~/work/.env." })],
      "inner",
    );
    expect(view.variables).toEqual([]);
    expect(view.sourceErrors).toEqual([
      expect.objectContaining({ title: "Env file in Payments", reason: "No file at ~/work/.env.", status: "missing" }),
    ]);
  });

  it("a source for another machine is shown as skipped, not as an error", () => {
    const view = resolvedView([reported({ status: "skipped-host" })], "inner");
    expect(view.variables[0]?.effective).toBeUndefined();
    expect(statusReason(view.variables[0]!.failed[0]!)).toBe("This source belongs to another machine.");
    expect(view.sourceErrors).toEqual([]);
  });

  it("always has words for a status, even when the report gives none", () => {
    for (const status of ["missing", "error", "skipped-host", "overridden"] as const) {
      const words = statusReason({ status, regionLabel: "X" });
      expect(words).toMatch(/^[A-Z].*\.$/);
      expect(words).not.toContain("·");
    }
  });

  it("lists variables by name", () => {
    const view = resolvedView(
      [reported({ sourceId: "a", names: ["ZED"] }), reported({ sourceId: "b", names: ["ALPHA"] })],
      "inner",
    );
    expect(view.variables.map((variable) => variable.name)).toEqual(["ALPHA", "ZED"]);
  });
});
