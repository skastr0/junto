import { Schema } from "effect";

/**
 * Squads: the operator's reusable seat templates. A squad is a repeatable set
 * of agent seats (harness launch, name, portrait, relative layout), the
 * connections among them, and optional opening prompts. Placing one mints
 * fresh seats; the template never points at live nodes.
 *
 * Stored as JSON in `squads.body_json`. Every field is a bounded plain value,
 * not a closed literal: a harness, verb, or side a later build retires is
 * dropped when the squad is placed, never a reason for the row to fail to
 * decode (decode-admits-history).
 */

export const SQUAD_NAME_MAX = 60;
export const SQUAD_SEATS_MAX = 24;
export const SQUAD_EDGES_MAX = 600;
export const SQUAD_PROMPT_MAX = 4000;
export const SQUADS_MAX = 60;
const ARGV_MAX = 64;

const bounded = (max: number) => Schema.String.pipe(Schema.check(Schema.isMaxLength(max)));
const required = (max: number) =>
  Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(max)));
const finite = Schema.Number.pipe(Schema.check(Schema.isFinite()));

/** Stands in for a pinned harness session id inside a template's argv. */
export const SQUAD_SESSION_TOKEN = "{squad-session}";

export const SquadSeatLaunch = Schema.Struct({
  argv: Schema.Array(bounded(8192)).pipe(Schema.check(Schema.isMaxLength(ARGV_MAX))),
  cwd: Schema.optionalKey(bounded(4096)),
});
export type SquadSeatLaunch = typeof SquadSeatLaunch.Type;

/** A seat's resolved portrait: every trait, so placed seats look the same. */
export const SquadPortrait = Schema.Struct({
  bodyHue: Schema.optionalKey(bounded(24)),
  accentHue: Schema.optionalKey(bounded(24)),
  shape: Schema.optionalKey(bounded(24)),
  topper: Schema.optionalKey(bounded(24)),
  eyes: Schema.optionalKey(bounded(24)),
  mouth: Schema.optionalKey(bounded(24)),
  brows: Schema.optionalKey(bounded(24)),
  marking: Schema.optionalKey(bounded(24)),
  blush: Schema.optionalKey(Schema.Boolean),
  temperament: Schema.optionalKey(finite),
});
export type SquadPortrait = typeof SquadPortrait.Type;

export const SquadSeat = Schema.Struct({
  /** Template-local id ("s0", "s1", ...); edges refer to seats by it. */
  key: required(16),
  harness: required(32),
  label: bounded(200),
  /** entity.name, the seat's agent key (host:harness or host:profile). */
  entityName: required(200),
  host: required(200),
  launch: SquadSeatLaunch,
  /** The argv carries SQUAD_SESSION_TOKEN; placing mints a fresh session id. */
  pinSession: Schema.optionalKey(Schema.Boolean),
  /** Offset from the squad's top-left corner. */
  dx: finite,
  dy: finite,
  width: finite,
  height: finite,
  color: Schema.optionalKey(bounded(32)),
  portrait: Schema.optionalKey(SquadPortrait),
  /** Opening prompt for this seat; overrides the squad prompt. */
  prompt: Schema.optionalKey(bounded(SQUAD_PROMPT_MAX)),
});
export type SquadSeat = typeof SquadSeat.Type;

export const SquadEdge = Schema.Struct({
  from: required(16),
  to: required(16),
  verb: required(32),
  mask: Schema.optionalKey(Schema.Array(bounded(64)).pipe(Schema.check(Schema.isMaxLength(32)))),
  fromSide: Schema.optionalKey(bounded(16)),
  toSide: Schema.optionalKey(bounded(16)),
  fromEnd: Schema.optionalKey(bounded(16)),
  toEnd: Schema.optionalKey(bounded(16)),
  color: Schema.optionalKey(bounded(32)),
  label: Schema.optionalKey(bounded(200)),
});
export type SquadEdge = typeof SquadEdge.Type;

/** The template itself, as stored in `body_json`. */
export const SquadBody = Schema.Struct({
  seats: Schema.Array(SquadSeat).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(SQUAD_SEATS_MAX)),
  ),
  edges: Schema.Array(SquadEdge).pipe(Schema.check(Schema.isMaxLength(SQUAD_EDGES_MAX))),
  /** Opening prompt for every seat without its own. */
  prompt: Schema.optionalKey(bounded(SQUAD_PROMPT_MAX)),
});
export type SquadBody = typeof SquadBody.Type;

export const SquadName = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (name: string) =>
        (name.trim().length >= 1 && name.trim().length <= SQUAD_NAME_MAX) ||
        `a squad name is 1 to ${SQUAD_NAME_MAX} characters`,
    ),
  ),
);

export type Squad = SquadBody & {
  readonly squadId: string;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/** Save a new squad (no id) or replace an existing one's name and template. */
export type SquadSaveInput = {
  readonly squadId?: string;
  readonly name: string;
  readonly body: SquadBody;
};

export type SquadResult =
  | { readonly ok: true; readonly squad: Squad }
  | { readonly ok: false; readonly message: string };

export type SquadDeleteResult =
  | { readonly ok: true; readonly squadId: string }
  | { readonly ok: false; readonly message: string };

export type SquadsChanged = { readonly squads: ReadonlyArray<Squad> };

export const decodeSquadBody = Schema.decodeUnknownResult(SquadBody);
export const decodeSquadName = Schema.decodeUnknownResult(SquadName);
