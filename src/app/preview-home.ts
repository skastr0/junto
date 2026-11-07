import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

declare const __JUNTO_PREVIEW_BUILD__: boolean;

/** Runs before product imports: a Finder launch has no launcher environment. */
export const pinFreshPreviewHome = (home: string, environment: NodeJS.ProcessEnv): void => {
  const fresh = environment.JUNTO_PREVIEW_HOME ?? join(home, ".junto-preview");
  if (dirname(fresh) !== home || !/^\.junto-preview(?:-[a-z0-9][a-z0-9-]*)?$/.test(basename(fresh))) {
    throw new Error("Junto PREVIEW home must be .junto-preview or .junto-preview-<name> directly under the account home.");
  }
  if (!existsSync(fresh) || lstatSync(fresh).isSymbolicLink()
    || !existsSync(join(fresh, ".fresh-preview"))
    || existsSync(join(fresh, "snapshot.json")) || existsSync(join(fresh, "before"))) {
    throw new Error("Junto PREVIEW requires its fresh home. Prepare it with scripts/preview.sh --prepare; copied-state launch is refused.");
  }
  // A launch from a seat's shell inherits the live app's sockets and token.
  for (const name of Object.keys(environment)) {
    if (name.startsWith("JUNTO_")) delete environment[name];
  }
  environment.JUNTO_HOME = fresh;
  if (fresh !== join(home, ".junto-preview")) environment.JUNTO_PREVIEW_HOME = fresh;
  environment.JUNTO_PREVIEW = "1";
  // The fresh home is never seeded, so every session pinned in it is its own.
  environment.JUNTO_HOME_OWNS_SESSIONS = "1";
};

if (typeof __JUNTO_PREVIEW_BUILD__ !== "undefined" && __JUNTO_PREVIEW_BUILD__) {
  pinFreshPreviewHome(homedir(), process.env);
}
