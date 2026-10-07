import { Schema } from "effect";
import { Rule, Ruling } from "../work-model";
import { HostId, placement } from "./base";

// A region is geography: a named rectangle. What is inside it is always worked
// out from the rectangles, never stored, so membership cannot go stale.

const NonEmpty = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

/** A variable name a process environment accepts. */
const EnvName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)),
);

const envSourceBase = {
  /** Stable handle within the region: reports, tokenFrom and edits key on it. */
  id: NonEmpty,
  /** A source that cannot be read refuses the launch instead of being left out. */
  required: Schema.optionalKey(Schema.Boolean),
  /** Applies only on this machine. Absent means every machine. */
  host: Schema.optionalKey(HostId),
} as const;

/**
 * Where one environment value comes from. A region holds names and references
 * only, never a secret: the one stored value is `kind: "value"`, a plain
 * setting the operator typed.
 */
export const EnvSource = Schema.Union([
  Schema.Struct({
    ...envSourceBase,
    kind: Schema.Literal("value"),
    name: EnvName,
    value: Schema.String,
  }),
  /** A secret held in Junto's own secret store, by id. */
  Schema.Struct({
    ...envSourceBase,
    kind: Schema.Literal("secret"),
    name: EnvName,
    secretId: NonEmpty,
  }),
  /** An item that already exists in the macOS Keychain, read in place. */
  Schema.Struct({
    ...envSourceBase,
    kind: Schema.Literal("keychain"),
    name: EnvName,
    service: NonEmpty,
    account: Schema.optionalKey(Schema.String),
  }),
  /** An item that already exists in the Linux Secret Service, read in place. */
  Schema.Struct({
    ...envSourceBase,
    kind: Schema.Literal("keyring"),
    name: EnvName,
    attributes: Schema.Record(Schema.String, Schema.String),
  }),
  /**
   * A 1Password reference (`op://vault/item/field`). `tokenFrom` is the id of
   * another source in scope that yields the service-account token.
   */
  Schema.Struct({
    ...envSourceBase,
    kind: Schema.Literal("onepassword"),
    name: EnvName,
    ref: NonEmpty,
    tokenFrom: Schema.optionalKey(NonEmpty),
  }),
  /** A dotenv file: every name it defines. */
  Schema.Struct({
    ...envSourceBase,
    kind: Schema.Literal("envFile"),
    path: NonEmpty,
  }),
  /** A directory with one file per variable. */
  Schema.Struct({
    ...envSourceBase,
    kind: Schema.Literal("secretsDir"),
    path: NonEmpty,
    prefix: Schema.optionalKey(Schema.String),
  }),
  /** Escape hatch: the command's stdout is the value. */
  Schema.Struct({
    ...envSourceBase,
    kind: Schema.Literal("command"),
    name: EnvName,
    argv: Schema.Array(Schema.String).pipe(Schema.check(Schema.isMinLength(1))),
  }),
]);
export type EnvSource = typeof EnvSource.Type;
export type EnvSourceKind = EnvSource["kind"];

/** What seats inside a region are launched with. Read live at every spawn. */
export const RegionEnvironment = Schema.Struct({
  /** Seats inside inherit nothing from regions outside this one. */
  sealed: Schema.optionalKey(Schema.Boolean),
  /** Applied in list order; a later source overrides an earlier one by name. */
  sources: Schema.optionalKey(Schema.Array(EnvSource)),
  /** Extra directories exposed to seats inside (absolute or `~/` paths). */
  folders: Schema.optionalKey(Schema.Array(NonEmpty)),
});
export type RegionEnvironment = typeof RegionEnvironment.Type;

/** What a page created inside the region starts with. */
export const RegionPageDefaults = Schema.Struct({
  url: Schema.optionalKey(Schema.String),
  profile: Schema.optionalKey(Schema.String),
  host: Schema.optionalKey(HostId),
});
export type RegionPageDefaults = typeof RegionPageDefaults.Type;

/**
 * Stamped onto things at the moment they are created inside the region, and
 * never read again after that.
 */
export const RegionDefaults = Schema.Struct({
  page: Schema.optionalKey(RegionPageDefaults),
  /** Host id to the working directory seats and terminals start in there. */
  paths: Schema.optionalKey(Schema.Record(HostId, Schema.String)),
});
export type RegionDefaults = typeof RegionDefaults.Type;

/**
 * Operator-authored rules that stack onto every task closing at a board inside
 * the region, and the rulings that set precedent for them.
 */
export const RegionContract = Schema.Struct({
  rules: Schema.optionalKey(Schema.Array(Rule)),
  rulings: Schema.optionalKey(Schema.Array(Ruling)),
});
export type RegionContract = typeof RegionContract.Type;

export const RegionBackgroundStyle = Schema.Literals(["cover", "ratio", "repeat"]);
export type RegionBackgroundStyle = typeof RegionBackgroundStyle.Type;

export const Region = Schema.Struct({
  kind: Schema.Literal("region"),
  ...placement,
  label: Schema.optionalKey(Schema.String),
  /** Things inside travel with the region when it moves. */
  hold: Schema.Boolean,
  /** Briefing for agents inside, served on onboard. */
  instruction: Schema.optionalKey(Schema.String),
  defaults: Schema.optionalKey(RegionDefaults),
  contract: Schema.optionalKey(RegionContract),
  environment: Schema.optionalKey(RegionEnvironment),
  background: Schema.optionalKey(Schema.String),
  backgroundStyle: Schema.optionalKey(RegionBackgroundStyle),
});
export type Region = typeof Region.Type;
