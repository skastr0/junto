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
  formatCommandLine,
  lookupHint,
  parseCommandLine,
  tokenSourceOptions,
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
      // "Only on this machine" has no control on the screen yet; an edit
      // must not drop it.
      { id: "i", kind: "keychain", name: "T", service: "svc", host: "studio", required: true },
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

describe("a field the form does not show", () => {
  it("is still there after the source is edited", () => {
    const source = { id: "i", kind: "keychain", name: "T", service: "svc", host: "studio" } as const;
    const edited = { ...draftOfSource(source), fields: { name: "RENAMED", service: "other", account: "" } };
    expect(toSource(edited)).toEqual({ id: "i", kind: "keychain", name: "RENAMED", service: "other", host: "studio" });
  });

  it("holds for every kind, and for a field this screen has never heard of", () => {
    const sources = [
      { id: "a", kind: "value", name: "A", value: "v" },
      { id: "b", kind: "secret", name: "B", secretId: "sec" },
      { id: "c", kind: "keychain", name: "C", service: "s" },
      { id: "d", kind: "keyring", name: "D", attributes: { k: "v" } },
      { id: "e", kind: "onepassword", name: "E", ref: "op://a/b/c" },
      { id: "f", kind: "envFile", path: "/f" },
      { id: "g", kind: "secretsDir", path: "/g" },
      { id: "h", kind: "command", name: "H", argv: ["x"] },
    ] as const;
    for (const source of sources) {
      const future = { ...source, host: "studio", addedLater: { nested: true } } as unknown as EnvSource;
      expect(toSource(draftOfSource(future))).toEqual(future);
    }
  });

  it("a shown field the operator clears is cleared, not carried back", () => {
    const source: EnvSource = { id: "c", kind: "keychain", name: "C", service: "s", account: "me" };
    const cleared = { ...draftOfSource(source), fields: { name: "C", service: "s", account: "" } };
    expect(toSource(cleared)).toEqual({ id: "c", kind: "keychain", name: "C", service: "s" });
    const optional = { ...draftOfSource({ ...source, required: true }), required: false };
    expect(toSource(optional)).not.toHaveProperty("required");
  });
});

describe("commands", () => {
  const argv = (text: string) => {
    const parsed = parseCommandLine(text);
    return parsed.ok ? parsed.argv : parsed.message;
  };

  it("reads quotes the way a shell would", () => {
    expect(argv('security find-generic-password -s "My Item" -w')).toEqual([
      "security",
      "find-generic-password",
      "-s",
      "My Item",
      "-w",
    ]);
    expect(argv("op read 'op://Private/My Item/credential'")).toEqual(["op", "read", "op://Private/My Item/credential"]);
    expect(argv('echo "say \\"hi\\"" \'it"s\' a\\ b')).toEqual(["echo", 'say "hi"', 'it"s', "a b"]);
    expect(argv("  spaced    out  ")).toEqual(["spaced", "out"]);
    expect(argv('tool --flag="two words" ""')).toEqual(["tool", "--flag=two words", ""]);
    expect(argv("")).toEqual([]);
  });

  it("leaves everything else a shell does alone: it is not run by a shell", () => {
    expect(argv("echo $HOME | cat > out; ls *")).toEqual(["echo", "$HOME", "|", "cat", ">", "out;", "ls", "*"]);
    expect(argv("'$HOME' \"$HOME\"")).toEqual(["$HOME", "$HOME"]);
  });

  it("rejects a quote that is never closed, in plain words", () => {
    expect(argv('security -s "My Item')).toBe("A double quote is opened and never closed.");
    expect(argv("op read 'op://x")).toBe("A single quote is opened and never closed.");
    expect(argv("trailing\\")).toBe("The command ends with a backslash that escapes nothing.");
    expect(draftProblems(draft("command", { name: "K", argv: 'x "y' })).argv).toBe(
      "A double quote is opened and never closed.",
    );
  });

  it("saves the parsed arguments, and shows them back so they parse to the same thing", () => {
    const source = toSource(draft("command", { name: "TOKEN", argv: 'security find-generic-password -s "My Item" -w' }));
    expect(source).toMatchObject({ kind: "command", argv: ["security", "find-generic-password", "-s", "My Item", "-w"] });
    for (const args of [["a", "b c", ""], ["it's", 'say "hi"', "back\\slash"], ["both ' and \""]]) {
      expect(argv(formatCommandLine(args))).toEqual(args);
    }
    expect(describeSource(source).detail).toBe("Command: security find-generic-password -s 'My Item' -w");
  });
});

describe("what a keychain or keyring source will look up", () => {
  it("says the item and the account as they are typed", () => {
    expect(lookupHint(draft("keychain", { name: "T" }))).toBeUndefined();
    expect(lookupHint(draft("keychain", { service: "op-service-account" }))).toBe(
      'Looks for the Keychain item named "op-service-account", whatever its account.',
    );
    expect(lookupHint(draft("keychain", { service: "op-service-account", account: "me@example.com" }))).toBe(
      'Looks for the Keychain item named "op-service-account" with account "me@example.com".',
    );
  });

  it("says the attributes a keyring item must match", () => {
    expect(lookupHint(draft("keyring", { attributes: "service=op\nuser=me" }))).toBe(
      'Looks for a keyring item where service is "op" and user is "me".',
    );
    expect(lookupHint(draft("keyring", { attributes: "nonsense" }))).toBeUndefined();
    expect(lookupHint(draft("envFile", { path: "/x" }))).toBeUndefined();
  });
});

describe("where a 1Password token may come from", () => {
  const own: EnvSource[] = [
    { id: "k1", kind: "keychain", name: "OP_SERVICE_ACCOUNT_TOKEN", service: "svc" },
    { id: "f1", kind: "envFile", path: "/x" },
    { id: "op1", kind: "onepassword", name: "API_KEY", ref: "op://a/b/c" },
  ];

  it("offers every named source in scope, inherited ones labelled with their region", () => {
    const options = tokenSourceOptions({
      sources: own,
      regionId: "inner",
      excludeId: "op1",
      report: [
        reported({ regionId: "outer", regionLabel: "Company", sourceId: "o1", names: ["OP_TOKEN"] }),
        reported({ regionId: "inner", sourceId: "k1" }),
      ],
    });
    expect(options).toEqual([
      { value: "k1", label: "OP_SERVICE_ACCOUNT_TOKEN, this region" },
      { value: "o1", label: "OP_TOKEN, from Company" },
    ]);
  });

  it("the common setup: the token on an outer region, the reference on an inner one with no sources yet", () => {
    const options = tokenSourceOptions({
      sources: [],
      regionId: "inner",
      report: [reported({ regionId: "outer", regionLabel: "Company", sourceId: "o1", names: ["OP_SERVICE_ACCOUNT_TOKEN"] })],
    });
    expect(options).toEqual([{ value: "o1", label: "OP_SERVICE_ACCOUNT_TOKEN, from Company" }]);
  });

  it("never offers a source as its own token, nor one with no name to give", () => {
    const options = tokenSourceOptions({
      sources: own,
      regionId: "inner",
      excludeId: "k1",
      report: [reported({ regionId: "outer", regionLabel: "Company", sourceId: "file", kind: "envFile", names: [] })],
    });
    expect(options.map((option) => option.value)).toEqual(["op1"]);
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
