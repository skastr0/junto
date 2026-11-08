/**
 * Install-local diagnostic files under <home>/.junto/logs. Not product state.
 */
import { join } from "node:path";
import { resolveJuntoHome } from "./junto-home";

export const juntoLogDirectory = (home = resolveJuntoHome()): string =>
  join(home, ".junto", "logs");
