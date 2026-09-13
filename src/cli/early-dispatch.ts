/**
 * Pure early argv dispatch for the unified packaged CLI.
 *
 * `browser`, `station-stdio`, and `content-transfer` bypass the Effect CLI
 * tree (stdio wire protocols + browser control socket). Operator `station *`
 * and agent `content *` remain on the Effect CLI surface.
 */
import {
  CONTENT_TRANSFER_COMMAND,
} from "./content-transfer";
import { STATION_STDIO_COMMAND } from "./station-stdio";

export type EarlyDispatch =
  | { readonly kind: "overseer-host"; readonly args: ReadonlyArray<string> }
  | { readonly kind: "browser"; readonly args: ReadonlyArray<string> }
  | { readonly kind: "station-stdio"; readonly args: ReadonlyArray<string> }
  | { readonly kind: "content-transfer"; readonly args: ReadonlyArray<string> }
  | { readonly kind: "cli"; readonly args: ReadonlyArray<string> };

/**
 * Bun places user args at index 2 in both execution modes:
 *   source   = [bunPath, "/…/src/cli/main.ts", ...args]
 *   compiled = ["bun", "/$bunfs/root/vellum-command", ...args]
 */
export const earlyDispatchFromArgv = (
  argv: ReadonlyArray<string>,
): EarlyDispatch => {
  const user = argv.slice(2);
  if (user[0] === "overseer-host") return { kind: "overseer-host", args: user.slice(1) };
  if (user[0] === "browser") {
    return { kind: "browser", args: user.slice(1) };
  }
  if (user[0] === STATION_STDIO_COMMAND) {
    return { kind: "station-stdio", args: user.slice(1) };
  }
  // `station stdio` synonym — keeps operator `station status` on Effect CLI.
  if (user[0] === "station" && user[1] === "stdio") {
    return { kind: "station-stdio", args: user.slice(2) };
  }
  if (user[0] === CONTENT_TRANSFER_COMMAND) {
    return { kind: "content-transfer", args: user.slice(1) };
  }
  return { kind: "cli", args: user };
};
