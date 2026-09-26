import { Result, Schema } from "effect";
import { decodeProfileBody, type AgentProfileBody } from "./agent-profiles";
import { recoverDocumentLaunchChoices } from "./launch-choices";
import { isHarnessId } from "./managed-terminal-templates";

/**
 * Squads: the operator's reusable teams. A squad is a set of agent profiles
 * (`./agent-profiles`: name, character, harness, model, effort, soul,
 * instructions), their relative layout, the connections among them, and
 * optional opening prompts. Placing one mints fresh seats; the template never
 * points at live nodes.
 *
 * Stored as JSON in `squads.body_json`. Every field is a bounded plain value,
 * not a closed literal: a harness, verb, or side a later build retires is
 * dropped when the squad is placed, never a reason for the row to fail to
 * decode (decode-admits-history).
 *
 * Squads saved before profiles held each seat's raw launch argv instead of a
 * profile. `decodeSquadBody` converts those members forward on read (the
 * harness dials are recovered from the argv the same way spawn recovers
 * them); the stored row is never rewritten.
 */

export const SQUAD_NAME_MAX = 60;
export const SQUAD_SEATS_MAX = 24;
export const SQUAD_EDGES_MAX = 600;
export const SQUAD_PROMPT_MAX = 4000;
export const SQUADS_MAX = 60;

const bounded = (max: number) => Schema.String.pipe(Schema.check(Schema.isMaxLength(max)));
const required = (max: number) =>
  Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(max)));
const finite = Schema.Number.pipe(Schema.check(Schema.isFinite()));

/** One member of the squad: a profile placed at an offset. */
export type SquadSeat = {
  /** Template-local id ("s0", "s1", ...); edges refer to seats by it. */
  readonly key: string;
  readonly profile: AgentProfileBody;
  /** Offset from the squad's top-left corner. */
  readonly dx: number;
  readonly dy: number;
  readonly width: number;
  readonly height: number;
  readonly color?: string;
  /** Opening prompt for this seat; overrides the squad prompt. */
  readonly prompt?: string;
};

const SquadSeatFrame = Schema.Struct({
  key: required(16),
  profile: Schema.Unknown,
  dx: finite,
  dy: finite,
  width: finite,
  height: finite,
  color: Schema.optionalKey(bounded(32)),
  prompt: Schema.optionalKey(bounded(SQUAD_PROMPT_MAX)),
});

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
export type SquadBody = {
  readonly seats: ReadonlyArray<SquadSeat>;
  readonly edges: ReadonlyArray<SquadEdge>;
  /** Opening prompt for every seat without its own. */
  readonly prompt?: string;
};

const SquadBodyFrame = Schema.Struct({
  seats: Schema.Array(SquadSeatFrame).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(SQUAD_SEATS_MAX)),
  ),
  edges: Schema.Array(SquadEdge).pipe(Schema.check(Schema.isMaxLength(SQUAD_EDGES_MAX))),
  prompt: Schema.optionalKey(bounded(SQUAD_PROMPT_MAX)),
});

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

type RawRecord = { readonly [key: string]: unknown };

const recordOf = (value: unknown): RawRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RawRecord)
    : undefined;

/**
 * A member saved before profiles: `{ harness, label, launch: { argv }, portrait,
 * ... }`. Its profile is recovered from those fields; the folder, host, and
 * pinned session it was captured with belong to the placement, not the
 * profile, and fall away.
 */
const legacyMemberProfile = (seat: RawRecord): unknown => {
  const harness = seat.harness;
  if (typeof harness !== "string") return undefined;
  const argv = recordOf(seat.launch)?.argv;
  const choices = isHarnessId(harness) && Array.isArray(argv) && argv.every((arg) => typeof arg === "string")
    ? recoverDocumentLaunchChoices(harness, { kind: "harness", argv: argv as string[] })
    : {};
  return {
    name: typeof seat.label === "string" && seat.label.trim() ? seat.label : harness,
    harness,
    ...(choices.model ? { model: choices.model } : {}),
    ...(choices.effort ? { effort: choices.effort } : {}),
    ...(choices.mode ? { mode: choices.mode } : {}),
    ...(choices.permissionMode ? { permissionMode: choices.permissionMode } : {}),
    ...(choices.profile ? { harnessProfile: choices.profile } : {}),
    ...(seat.portrait !== undefined ? { portrait: seat.portrait } : {}),
  };
};

/** Bring every member to the profile shape before the frame decodes it. */
const forwardMembers = (raw: unknown): unknown => {
  const body = recordOf(raw);
  if (!body || !Array.isArray(body.seats)) return raw;
  return {
    ...body,
    seats: body.seats.map((value) => {
      const seat = recordOf(value);
      if (!seat || seat.profile !== undefined) return value;
      const { harness: _h, label: _l, entityName: _e, host: _o, launch: _a, pinSession: _p, portrait: _t, ...rest } = seat;
      return { ...rest, profile: legacyMemberProfile(seat) };
    }),
  };
};

const decodeSquadFrame = Schema.decodeUnknownResult(SquadBodyFrame);

/**
 * Decode a stored or offered squad body. Members whose profile lacks the
 * essentials (a name and a harness) are dropped; a squad left with none
 * fails.
 */
export const decodeSquadBody = (raw: unknown): Result.Result<SquadBody, string> => {
  const frame = decodeSquadFrame(forwardMembers(raw));
  if (Result.isFailure(frame)) return Result.fail(frame.failure.message);
  const seats = frame.success.seats.flatMap((seat): SquadSeat[] => {
    const profile = decodeProfileBody(seat.profile);
    if (profile === null) return [];
    const { profile: _raw, ...placement } = seat;
    return [{ ...placement, profile }];
  });
  if (seats.length === 0) return Result.fail("a squad needs at least one agent");
  return Result.succeed({
    seats,
    edges: frame.success.edges,
    ...(frame.success.prompt !== undefined ? { prompt: frame.success.prompt } : {}),
  });
};
export const decodeSquadName = Schema.decodeUnknownResult(SquadName);
