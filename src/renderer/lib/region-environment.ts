/**
 * Region environment, as the one screen in region settings sees it.
 *
 * A region may carry an `environment`: ordered sources that name where a
 * variable comes from (a plain value, Junto's secret store, an existing
 * Keychain or keyring item, a 1Password reference, an env file, a folder of
 * secret files, a command), extra folders, and a sealed switch. A seat's
 * environment is resolved at launch from every region that contains it.
 *
 * This module is the screen's pure half: the form a source kind needs, the
 * draft a form edits, what a draft must say before it can be saved, and the
 * resolved view built from main's report. It never holds a secret: a value
 * typed for a `secret` source goes straight to the port and only its id comes
 * back.
 *
 * The shapes (EnvSource, the environment struct, SourceReport, StaleSeat) are
 * the region environment contract's and live in @shared/region-environment.
 */
import type {
  EnvSource,
  EnvSourceKind,
  EtherRegionEnvironment,
  SourceReport,
  SourceReportStatus,
  StaleSeat,
} from "@shared/region-environment";

export type { EnvSource, EnvSourceKind, SourceReport, SourceReportStatus, StaleSeat };
/** A region's environment as the canvas stores it. */
export type RegionEnvironment = EtherRegionEnvironment;

// ── What the screen asks of main ───────────────────────────────────────────

export type PortResult<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly message: string };

/**
 * Everything the screen needs beyond the canvas document. The value handed to
 * `saveSecret` is the only secret material that ever crosses it, one way.
 */
export type RegionEnvironmentPort = {
  /** Store a secret value in Junto's secret store; answers the id to reference. */
  readonly saveSecret: (input: {
    readonly regionId: string;
    readonly name: string;
    readonly value: string;
    /** Replace the value behind an existing id instead of minting one. */
    readonly secretId?: string;
  }) => Promise<PortResult<{ readonly secretId: string }>>;
  readonly removeSecret: (secretId: string) => Promise<PortResult<object>>;
  /** The resolution for a seat placed directly in this region. */
  readonly report: (regionId: string) => Promise<PortResult<{ readonly report: ReadonlyArray<SourceReport> }>>;
  readonly staleSeats: (regionId: string) => Promise<PortResult<{ readonly seats: ReadonlyArray<StaleSeat> }>>;
  readonly restartSeat: (seatId: string) => Promise<PortResult<object>>;
};

// ── Source kinds: what each one is, and the fields it needs ────────────────

export type SourceField = {
  readonly key: string;
  readonly label: string;
  /** An example, shown while the field is empty. */
  readonly placeholder: string;
  readonly optional?: boolean;
  /** Typed masked, sent to the secret store on save, never kept. */
  readonly secret?: boolean;
  readonly hint?: string;
};

export type SourceKindSpec = {
  readonly kind: EnvSourceKind;
  readonly label: string;
  /** One line: what this represents on the operator's machine. */
  readonly summary: string;
  readonly fields: ReadonlyArray<SourceField>;
};

const NAME_FIELD: SourceField = {
  key: "name",
  label: "Variable name",
  placeholder: "OP_SERVICE_ACCOUNT_TOKEN",
};

/** Listed in the order the picker offers them: what already exists first. */
export const SOURCE_KINDS: ReadonlyArray<SourceKindSpec> = [
  {
    kind: "keychain",
    label: "macOS Keychain item",
    summary: "An item already in your Keychain, read in place.",
    fields: [
      NAME_FIELD,
      { key: "service", label: "Keychain item name", placeholder: "op-service-account" },
      { key: "account", label: "Account", placeholder: "you@example.com", optional: true },
    ],
  },
  {
    kind: "keyring",
    label: "Linux keyring item",
    summary: "An item already in the Secret Service keyring, found by its attributes.",
    fields: [
      NAME_FIELD,
      {
        key: "attributes",
        label: "Attributes",
        placeholder: "service=op-service-account",
        hint: "One per line, as name=value.",
      },
    ],
  },
  {
    kind: "onepassword",
    label: "1Password reference",
    summary: "A field in 1Password, read with the op CLI you already have.",
    fields: [
      { ...NAME_FIELD, placeholder: "ANTHROPIC_API_KEY" },
      { key: "ref", label: "Reference", placeholder: "op://Private/Anthropic/credential" },
      {
        key: "tokenFrom",
        label: "Service account token from",
        placeholder: "another source in scope",
        optional: true,
        hint: "Leave empty to use whatever op is already signed in with.",
      },
    ],
  },
  {
    kind: "envFile",
    label: "Env file",
    summary: "A dotenv file. Every name in it becomes a variable.",
    fields: [{ key: "path", label: "File", placeholder: "~/work/acme/.env" }],
  },
  {
    kind: "secretsDir",
    label: "Folder of secret files",
    summary: "One file per variable: the file name is the name, its content the value.",
    fields: [
      { key: "path", label: "Folder", placeholder: "~/.config/acme/secrets" },
      { key: "prefix", label: "Name prefix", placeholder: "ACME_", optional: true },
    ],
  },
  {
    kind: "secret",
    label: "Secret kept by Junto",
    summary: "Typed here once and kept in Junto's secret store. It is never shown again.",
    fields: [
      { ...NAME_FIELD, placeholder: "GITHUB_TOKEN" },
      { key: "secretValue", label: "Value", placeholder: "paste the secret", secret: true },
    ],
  },
  {
    kind: "value",
    label: "Plain value",
    summary: "Not a secret: saved in the canvas and visible to anyone who opens it.",
    fields: [
      { ...NAME_FIELD, placeholder: "AWS_REGION" },
      { key: "value", label: "Value", placeholder: "eu-west-1" },
    ],
  },
  {
    kind: "command",
    label: "Command",
    summary: "Whatever a command prints becomes the value. For anything not listed here.",
    fields: [
      { ...NAME_FIELD, placeholder: "VAULT_TOKEN" },
      {
        key: "argv",
        label: "Command",
        placeholder: "vault print token",
        hint: "Run as written, without a shell: no pipes, quotes or variables.",
      },
    ],
  },
];

export const sourceKindSpec = (kind: EnvSourceKind): SourceKindSpec =>
  SOURCE_KINDS.find((spec) => spec.kind === kind)!;

// ── Drafts ─────────────────────────────────────────────────────────────────

/**
 * What a form edits: the kind and its fields as typed. `secretValue` lives
 * here only while the form is open; `toSource` never reads it into a source.
 */
export type SourceDraft = {
  readonly id: string;
  readonly kind: EnvSourceKind;
  readonly required: boolean;
  readonly fields: Readonly<Record<string, string>>;
  /** The stored secret this draft edits, when it edits one. */
  readonly secretId?: string;
  /** "Only on this machine", carried through an edit untouched. */
  readonly host?: string;
};

export const newSourceDraft = (id: string, kind: EnvSourceKind): SourceDraft => ({
  id,
  kind,
  required: false,
  fields: {},
});

const attributesToText = (attributes: Readonly<Record<string, string>>): string =>
  Object.entries(attributes)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

const attributesFromText = (text: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key && value) attributes[key] = value;
  }
  return attributes;
};

export const draftOfSource = (source: EnvSource): SourceDraft => {
  const base = {
    id: source.id,
    kind: source.kind,
    required: source.required === true,
    ...(source.host ? { host: source.host } : {}),
  };
  switch (source.kind) {
    case "value":
      return { ...base, fields: { name: source.name, value: source.value } };
    case "secret":
      // The value is not known here and is not asked for: empty means keep it.
      return { ...base, fields: { name: source.name }, secretId: source.secretId };
    case "keychain":
      return { ...base, fields: { name: source.name, service: source.service, account: source.account ?? "" } };
    case "keyring":
      return { ...base, fields: { name: source.name, attributes: attributesToText(source.attributes) } };
    case "onepassword":
      return { ...base, fields: { name: source.name, ref: source.ref, tokenFrom: source.tokenFrom ?? "" } };
    case "envFile":
      return { ...base, fields: { path: source.path } };
    case "secretsDir":
      return { ...base, fields: { path: source.path, prefix: source.prefix ?? "" } };
    case "command":
      return { ...base, fields: { name: source.name, argv: source.argv.join(" ") } };
  }
};

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const field = (draft: SourceDraft, key: string): string => (draft.fields[key] ?? "").trim();

/**
 * What stops this draft from being saved, by field key, in plain words.
 * Empty means it can be saved. Nothing here judges the operator's setup:
 * whether an item exists is the report's to say, after saving.
 */
export const draftProblems = (draft: SourceDraft): Readonly<Record<string, string>> => {
  const problems: Record<string, string> = {};
  const spec = sourceKindSpec(draft.kind);
  for (const spec_ of spec.fields) {
    if (spec_.optional || spec_.secret) continue;
    if (!field(draft, spec_.key)) problems[spec_.key] = `${spec_.label} is needed.`;
  }
  if (spec.fields.some((f) => f.key === "name")) {
    const name = field(draft, "name");
    if (name && !VARIABLE_NAME.test(name)) {
      problems.name = "Use letters, digits and underscores, not starting with a digit.";
    }
  }
  if (draft.kind === "secret" && draft.secretId === undefined && !(draft.fields.secretValue ?? "")) {
    problems.secretValue = "Value is needed.";
  }
  if (draft.kind === "onepassword") {
    const ref = field(draft, "ref");
    if (ref && !ref.startsWith("op://")) problems.ref = "A 1Password reference starts with op://";
  }
  if (draft.kind === "keyring" && field(draft, "attributes")) {
    if (Object.keys(attributesFromText(draft.fields.attributes ?? "")).length === 0) {
      problems.attributes = "Write each attribute as name=value.";
    }
  }
  return problems;
};

/** The secret a draft would send to the store on save, if it carries one. */
export const draftSecretValue = (draft: SourceDraft): string | undefined => {
  if (draft.kind !== "secret") return undefined;
  const value = draft.fields.secretValue ?? "";
  return value.length > 0 ? value : undefined;
};

/**
 * The source a draft saves as. For a `secret`, `secretId` is the id the store
 * answered (or the one the draft already edits); the typed value is not an
 * input here and cannot reach the document.
 */
export const toSource = (draft: SourceDraft, secretId?: string): EnvSource => {
  const base = {
    id: draft.id,
    ...(draft.required ? { required: true as const } : {}),
    ...(draft.host ? { host: draft.host } : {}),
  };
  const name = field(draft, "name");
  switch (draft.kind) {
    case "value":
      // A plain value is kept as typed: leading and trailing space can matter.
      return { ...base, kind: "value", name, value: draft.fields.value ?? "" };
    case "secret":
      return { ...base, kind: "secret", name, secretId: secretId ?? draft.secretId ?? "" };
    case "keychain": {
      const account = field(draft, "account");
      return { ...base, kind: "keychain", name, service: field(draft, "service"), ...(account ? { account } : {}) };
    }
    case "keyring":
      return { ...base, kind: "keyring", name, attributes: attributesFromText(draft.fields.attributes ?? "") };
    case "onepassword": {
      const tokenFrom = field(draft, "tokenFrom");
      return { ...base, kind: "onepassword", name, ref: field(draft, "ref"), ...(tokenFrom ? { tokenFrom } : {}) };
    }
    case "envFile":
      return { ...base, kind: "envFile", path: field(draft, "path") };
    case "secretsDir": {
      const prefix = field(draft, "prefix");
      return { ...base, kind: "secretsDir", path: field(draft, "path"), ...(prefix ? { prefix } : {}) };
    }
    case "command":
      return { ...base, kind: "command", name, argv: field(draft, "argv").split(/\s+/).filter(Boolean) };
  }
};

/** A source in one line, for its row in the list. Never a value. */
export const describeSource = (source: EnvSource): { readonly title: string; readonly detail: string } => {
  const label = sourceKindSpec(source.kind).label;
  switch (source.kind) {
    case "value":
      return { title: source.name, detail: `${label}: ${source.value}` };
    case "secret":
      return { title: source.name, detail: label };
    case "keychain":
      return {
        title: source.name,
        detail: `${label}: ${source.service}${source.account ? `, account ${source.account}` : ""}`,
      };
    case "keyring":
      return { title: source.name, detail: `${label}: ${attributesToText(source.attributes).replace(/\n/g, ", ")}` };
    case "onepassword":
      return { title: source.name, detail: `${label}: ${source.ref}` };
    case "envFile":
      return { title: source.path, detail: label };
    case "secretsDir":
      return { title: source.path, detail: source.prefix ? `${label}, names start with ${source.prefix}` : label };
    case "command":
      return { title: source.name, detail: `${label}: ${source.argv.join(" ")}` };
  }
};

// ── Editing the environment ────────────────────────────────────────────────

/** Move one source to another position; later sources override earlier ones. */
export const reorderSources = <T>(sources: ReadonlyArray<T>, from: number, to: number): T[] => {
  const next = [...sources];
  if (from === to || from < 0 || from >= next.length) return next;
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved!);
  return next;
};

export const upsertSource = (sources: ReadonlyArray<EnvSource>, source: EnvSource): EnvSource[] =>
  sources.some((existing) => existing.id === source.id)
    ? sources.map((existing) => (existing.id === source.id ? source : existing))
    : [...sources, source];

/** Folders as the operator wrote them, without blanks or repeats. */
export const cleanFolders = (folders: ReadonlyArray<string>): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of folders) {
    const folder = raw.trim().replace(/(?<=.)\/+$/, "");
    if (!folder || seen.has(folder)) continue;
    seen.add(folder);
    out.push(folder);
  }
  return out;
};

/** A folder must be absolute or start at home: seats resolve it on their own. */
export const folderProblem = (folder: string): string | undefined => {
  const value = folder.trim();
  if (!value) return undefined;
  return value.startsWith("/") || value === "~" || value.startsWith("~/")
    ? undefined
    : "Write the full path, or start it with ~/";
};

/** The environment as it is stored: empty parts never survive. */
export const cleanEnvironment = (environment: RegionEnvironment): RegionEnvironment | undefined => {
  const sources = environment.sources ?? [];
  const folders = cleanFolders(environment.folders ?? []);
  const next: RegionEnvironment = {
    ...(environment.sealed === true ? { sealed: true } : {}),
    ...(sources.length > 0 ? { sources } : {}),
    ...(folders.length > 0 ? { folders } : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
};

// ── The resolved view ──────────────────────────────────────────────────────

export type ResolvedProvider = {
  readonly sourceId: string;
  readonly kind: EnvSourceKind;
  readonly kindLabel: string;
  readonly regionId: string;
  readonly regionLabel: string;
  /** From a region outside this one. */
  readonly inherited: boolean;
  readonly status: SourceReportStatus;
  readonly reason?: string;
  readonly required: boolean;
};

export type ResolvedVariable = {
  readonly name: string;
  /** The source whose value a seat gets; absent when none in scope yields one. */
  readonly effective?: ResolvedProvider;
  /** Sources that name it and lose to a later one: shown struck through. */
  readonly overridden: ReadonlyArray<ResolvedProvider>;
  /** Sources that name it and could not provide it. */
  readonly failed: ReadonlyArray<ResolvedProvider>;
};

/** A source that failed before it could say which names it provides. */
export type ResolvedSourceError = ResolvedProvider & { readonly title: string };

export type ResolvedView = {
  readonly variables: ReadonlyArray<ResolvedVariable>;
  readonly sourceErrors: ReadonlyArray<ResolvedSourceError>;
  /** A required source failed: seats in this region will not start. */
  readonly blocksLaunch: boolean;
  /** Status per source of THIS region, for its row in the list. */
  readonly statusBySourceId: Readonly<Record<string, ResolvedProvider>>;
};

const FAILED: ReadonlySet<SourceReportStatus> = new Set(["missing", "error"]);

export const STATUS_LABEL: Readonly<Record<SourceReportStatus, string>> = {
  ok: "Set",
  missing: "Missing",
  error: "Error",
  "skipped-host": "Not on this machine",
  overridden: "Overridden",
};

/** A reason is always shown in words; the report's own when it gives one. */
export const statusReason = (provider: Pick<ResolvedProvider, "status" | "reason" | "regionLabel">): string => {
  const reason = provider.reason?.trim();
  if (reason) return reason;
  switch (provider.status) {
    case "ok":
      return "";
    case "missing":
      return "Nothing was found for this source.";
    case "error":
      return "This source could not be read.";
    case "skipped-host":
      return "This source belongs to another machine.";
    case "overridden":
      return "A later source sets the same name.";
  }
};

/**
 * The resolved list for one region from main's report. The report is in
 * application order (outermost region first, then list order), so for one
 * name the last source that provides it is the one a seat gets.
 */
export const resolvedView = (report: ReadonlyArray<SourceReport>, regionId: string): ResolvedView => {
  const byName = new Map<string, { providers: ResolvedProvider[] }>();
  const sourceErrors: ResolvedSourceError[] = [];
  const statusBySourceId: Record<string, ResolvedProvider> = {};
  let blocksLaunch = false;

  for (const entry of report) {
    const provider: ResolvedProvider = {
      sourceId: entry.sourceId,
      kind: entry.kind,
      kindLabel: sourceKindSpec(entry.kind).label,
      regionId: entry.regionId,
      regionLabel: entry.regionLabel,
      inherited: entry.regionId !== regionId,
      status: entry.status,
      ...(entry.reason ? { reason: entry.reason } : {}),
      required: entry.required,
    };
    if (entry.regionId === regionId) statusBySourceId[entry.sourceId] = provider;
    if (entry.required && FAILED.has(entry.status)) blocksLaunch = true;
    if (entry.names.length === 0) {
      // Nothing to hang it on in the list of names: an env file that is not
      // there, a folder that cannot be read.
      if (FAILED.has(entry.status)) {
        sourceErrors.push({ ...provider, title: `${provider.kindLabel} in ${entry.regionLabel}` });
      }
      continue;
    }
    for (const name of entry.names) {
      const slot = byName.get(name) ?? { providers: [] };
      slot.providers.push(provider);
      byName.set(name, slot);
    }
  }

  const variables: ResolvedVariable[] = [];
  for (const [name, { providers }] of byName) {
    // The report says which sources lost; among the rest the last one wins.
    const live = providers.filter((p) => p.status === "ok");
    const effective = live.at(-1);
    variables.push({
      name,
      ...(effective ? { effective } : {}),
      overridden: providers.filter((p) => p !== effective && (p.status === "overridden" || p.status === "ok")),
      failed: providers.filter((p) => FAILED.has(p.status) || p.status === "skipped-host"),
    });
  }
  variables.sort((a, b) => a.name.localeCompare(b.name));
  return { variables, sourceErrors, blocksLaunch, statusBySourceId };
};
