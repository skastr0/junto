import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

declare const __JUNTO_PREVIEW_BUILD__: boolean;

/** Runs before product imports: a Finder launch has no launcher environment. */
export const pinFreshPreviewHome = (home: string, environment: NodeJS.ProcessEnv): void => {
  const fresh = join(home, ".junto-preview");
  if (!existsSync(fresh) || lstatSync(fresh).isSymbolicLink()
    || !existsSync(join(fresh, ".fresh-preview"))
    || existsSync(join(fresh, "snapshot.json")) || existsSync(join(fresh, "before"))) {
    throw new Error("Junto PREVIEW requires its fresh home. Prepare it with scripts/preview.sh --prepare; copied-state launch is refused.");
  }
  environment.JUNTO_HOME = fresh;
  environment.JUNTO_PREVIEW = "1";
  delete environment.JUNTO_HOME_OWNS_SESSIONS;
  delete environment.JUNTO_WORK_TOKEN;
};

if (typeof __JUNTO_PREVIEW_BUILD__ !== "undefined" && __JUNTO_PREVIEW_BUILD__) {
  pinFreshPreviewHome(homedir(), process.env);
}
