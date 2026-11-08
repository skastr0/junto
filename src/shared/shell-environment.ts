/**
 * What Junto read from the operator's login shell, on the wire to the
 * renderer, the CLI and onboarding.
 *
 * Names, directories and typed causes only, never a value: a shell
 * environment carries API keys and tokens, and nothing here may show, log or
 * ship one.
 */
import { Schema } from "effect";

const Ms = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Why a read gave no environment. Typed, so a surface words each cause itself. */
export const ShellEnvironmentFailure = Schema.TaggedUnion({
  /** No usable shell was found. */
  NoShell: {},
  /** The shell could not start. */
  SpawnFailed: { errno: Schema.optionalKey(Schema.String) },
  /** It ran past its limit: heavy rc work, which JUNTO_RESOLVING_ENVIRONMENT=1 lets an rc skip. */
  TimedOut: { timeoutMs: Count },
  /** It ended without printing the environment. */
  Exited: { code: Schema.optionalKey(Schema.Int), signal: Schema.optionalKey(Schema.String) },
  /** It printed, but the environment markers were missing or unreadable. */
  NoEnvironment: {},
  OutputTooLarge: { maxBytes: Count },
});
export type ShellEnvironmentFailure = typeof ShellEnvironmentFailure.Type;

/**
 * `generation` counts the environments seats have been given; 0 means none
 * yet, and seats run with the inherited PATH and the floor.
 *
 * Never "unresolved" on the wire: main answers only after the first read,
 * which it finishes before the window opens. A later refresh answers
 * `Resolving` at once, carrying the environment still in use.
 */
export const ShellEnvironmentStatus = Schema.TaggedUnion({
  /** `generation`: the environment in use while this read runs. */
  Resolving: { since: Ms, generation: Count },
  /** `pathAdded`: PATH directories the shell added beyond what Junto inherited. */
  Resolved: {
    shell: Schema.String,
    resolvedAt: Ms,
    durationMs: Count,
    variableCount: Count,
    generation: Count,
    pathAdded: Schema.Array(Schema.String),
  },
  /** `usingPrevious`: an earlier good environment is still in use; false means the inherited PATH and the floor. */
  Failed: {
    shell: Schema.optionalKey(Schema.String),
    at: Ms,
    cause: ShellEnvironmentFailure,
    generation: Count,
    usingPrevious: Schema.Boolean,
  },
  /** JUNTO_SHELL_ENVIRONMENT=inherit: the probe is off by choice. */
  Inherited: {},
});
export type ShellEnvironmentStatus = typeof ShellEnvironmentStatus.Type;

/** One environment replacing another: variable names and PATH directories, never values. */
export const ShellEnvironmentChange = Schema.Struct({
  generation: Count,
  added: Schema.Array(Schema.String),
  removed: Schema.Array(Schema.String),
  changed: Schema.Array(Schema.String),
  pathAdded: Schema.Array(Schema.String),
  pathRemoved: Schema.Array(Schema.String),
});
export type ShellEnvironmentChange = typeof ShellEnvironmentChange.Type;

export const decodeShellEnvironmentStatus = Schema.decodeUnknownSync(ShellEnvironmentStatus);
export const decodeShellEnvironmentChange = Schema.decodeUnknownSync(ShellEnvironmentChange);
