import { Match } from "effect";
import {
  KindSpecs,
  resolveSpec,
  roleOf,
  type ResolveSpecInput,
} from "./kinds";
import {
  FactoryRole,
  WELL_KNOWN_KINDS,
  type WellKnownKind,
} from "./schema";

/**
 * Phase-plane membership (blocked set).
 *
 * Law lives on **FactoryRole**, never on entity kind. Kind is only the
 * registry key that derives a role; membership consumers ask the role.
 *
 * Current law: only **actor** seats may enter the blocked set.
 * sink | scheduler | geography never do.
 */

/** Exhaustive over FactoryRole — adding a role forces a decision here. */
export const roleMayBeBlocked = (role: FactoryRole): boolean =>
  Match.value(role).pipe(
    Match.when("actor", () => true),
    Match.when("sink", () => false),
    Match.when("scheduler", () => false),
    Match.when("geography", () => false),
    Match.exhaustive,
  );

/** Registry projection: every well-known kind that currently maps to `role`. */
export const kindsWithRole = (role: FactoryRole): ReadonlyArray<WellKnownKind> =>
  WELL_KNOWN_KINDS.filter((kind) => KindSpecs[kind].role === role);

/**
 * Whether a resolved canvas seat may join the blocked set.
 * Pure physics: ResolveSpecInput → role → membership law.
 */
export const seatMayBeBlocked = (input: ResolveSpecInput): boolean =>
  roleMayBeBlocked(roleOf(resolveSpec(input)));

/** Schema re-export so membership tests bind to the same closed role set. */
export { FactoryRole };
