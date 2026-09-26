import { normalizePortraitOverride, type PortraitOverride } from "./portrait-overrides";
import {
  SEAT_INSTRUCTIONS_MAX,
  SEAT_SOUL_MAX,
  cleanGuidanceText,
} from "./seat-guidance";

/**
 * Agent profiles: a saved agent the operator can seat again anywhere. A
 * profile is the seat's name, its character (portrait), its harness with the
 * model, effort and mode it launches with, and its optional soul and
 * instructions. Placing one mints a fresh seat with that configuration; the
 * canvas, folder and connections come from where it lands, so the same
 * character can work in many projects.
 *
 * Squads are sets of profile bodies plus layout and connections.
 *
 * Stored as JSON (`agent_profiles.body_json`, and inside squad bodies). Every
 * field is a bounded plain value, not a closed literal: a harness or trait a
 * later build retires is dropped when the profile is placed, never a reason
 * for a row to fail to decode (decode-admits-history). `decodeProfileBody` is
 * the one gate: it keeps known fields of the right shape and drops the rest.
 */

export const PROFILE_NAME_MAX = 60;
export const PROFILES_MAX = 200;
const HARNESS_MAX = 32;
const DIAL_MAX = 200;

export type AgentProfileBody = {
  /** The seat's name, and the profile's name in the picker. */
  readonly name: string;
  readonly harness: string;
  readonly model?: string;
  readonly effort?: string;
  /** Named agent mode (Amp). */
  readonly mode?: string;
  readonly permissionMode?: string;
  /** Hermes profile the harness runs as. */
  readonly harnessProfile?: string;
  /** Fully resolved character, so a fresh node draws the same face. */
  readonly portrait?: PortraitOverride;
  readonly soul?: string;
  readonly instructions?: string;
};

export type AgentProfile = AgentProfileBody & {
  readonly profileId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/** Save a new profile (no id) or replace an existing one's configuration. */
export type ProfileSaveInput = {
  readonly profileId?: string;
  readonly body: AgentProfileBody;
};

export type ProfileResult =
  | { readonly ok: true; readonly profile: AgentProfile }
  | { readonly ok: false; readonly message: string };

export type ProfileDeleteResult =
  | { readonly ok: true; readonly profileId: string }
  | { readonly ok: false; readonly message: string };

/** Main -> renderer: every profile, after any change. */
export type ProfilesChanged = ReadonlyArray<AgentProfile>;

/** A trimmed name, 1 to PROFILE_NAME_MAX characters, or undefined. */
export const cleanProfileName = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const name = value.replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= PROFILE_NAME_MAX ? name : undefined;
};

const dial = (value: unknown, max = DIAL_MAX): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= max ? text : undefined;
};

const boundedText = (value: unknown, max: number): string | undefined => {
  const text = cleanGuidanceText(value);
  return text !== undefined && text.length <= max ? text : undefined;
};

/**
 * Decode one stored or offered profile body. Null when the essentials (a
 * name and a harness) are missing; every optional field that is malformed or
 * over its bound is dropped on its own.
 */
export function decodeProfileBody(value: unknown): AgentProfileBody | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const name = cleanProfileName(input.name);
  const harness = dial(input.harness, HARNESS_MAX);
  if (name === undefined || harness === undefined) return null;
  const model = dial(input.model);
  const effort = dial(input.effort);
  const mode = dial(input.mode);
  const permissionMode = dial(input.permissionMode);
  const harnessProfile = dial(input.harnessProfile);
  const portrait = normalizePortraitOverride(input.portrait);
  const soul = boundedText(input.soul, SEAT_SOUL_MAX);
  const instructions = boundedText(input.instructions, SEAT_INSTRUCTIONS_MAX);
  return {
    name,
    harness,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(harnessProfile !== undefined ? { harnessProfile } : {}),
    ...(portrait !== null ? { portrait } : {}),
    ...(soul !== undefined ? { soul } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
  };
}

const sameName = (a: string, b: string): boolean =>
  a.localeCompare(b, undefined, { sensitivity: "base" }) === 0;

/** The profile with this name, ignoring case. */
export const profileNamed = (
  profiles: ReadonlyArray<AgentProfile>,
  name: string,
): AgentProfile | undefined => profiles.find((profile) => sameName(profile.name, name.trim()));

/** "Claude, opus, high" for picker cards and menu hints. */
export const profileSummary = (body: AgentProfileBody, harnessName = body.harness): string =>
  [harnessName, body.harnessProfile, body.model, body.effort, body.mode]
    .filter((part): part is string => Boolean(part))
    .join(", ");
