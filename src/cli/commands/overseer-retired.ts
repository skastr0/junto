import { OVERSEER_RETIRED_OPERATIONS } from "../../shared/overseer-control";
import { InputError } from "../core/errors";

/**
 * A name the overseer contract no longer takes. The CLI does not run it and
 * does not accept its old shape: it says in one line what replaced it and
 * where to read the new shape.
 */
export const RETIRED_OVERSEER_FAMILIES: Readonly<Record<string, string>> = { edge: "wire" };

/** The retired operation a typed target names: `edge.connect`, `overseer.edge.connect`, `overseer edge connect`. */
export const retiredOverseerOperation = (target: string): string | undefined => {
  const normalized = target.trim().replace(/^overseer[. ]/u, "").replace(" ", ".");
  return normalized in OVERSEER_RETIRED_OPERATIONS ? normalized : undefined;
};

export const retiredOverseerError = (retired: string): InputError => {
  const replacement = OVERSEER_RETIRED_OPERATIONS[retired] ?? retired;
  return new InputError({
    message: `${retired} is now ${replacement}: the edge family is now wire`,
    path: "operation",
    hint: `junto overseer schema show ${replacement}`,
  });
};

/** `junto overseer edge ...`, typed by an agent that still holds the old skill. */
export const retiredOverseerInvocation = (args: ReadonlyArray<string>): InputError | undefined => {
  if (args[0] !== "overseer" || args[1] === undefined) return undefined;
  const family = RETIRED_OVERSEER_FAMILIES[args[1]];
  if (family === undefined) return undefined;
  const verb = args[2] !== undefined && !args[2].startsWith("-") ? args[2] : undefined;
  const retired = verb === undefined ? undefined : retiredOverseerOperation(`${args[1]}.${verb}`);
  return retired !== undefined
    ? retiredOverseerError(retired)
    : new InputError({
        message: `the ${args[1]} family is now ${family}: junto overseer ${family} --help`,
        path: "family",
        hint: "junto overseer schema list",
      });
};
