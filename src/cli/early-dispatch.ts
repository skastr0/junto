/**
 * Pure early argv dispatch for the unified packaged CLI.
 *
 * `browser`, `companion-stdio`, and `content-transfer` bypass the Effect CLI
 * tree (stdio wire protocols + browser control socket). Operator `station *`
 * and agent `content *` remain on the Effect CLI surface.
 */
import { CONTENT_TRANSFER_COMMAND } from "../main/junto/content/helper-contract";
import { COMPANION_STDIO_COMMAND } from "./protocol-command-names";
import { ownerCommandRefusal } from "./core/owner-access";

export type EarlyDispatch =
  | { readonly kind: "owner-refused"; readonly message: string }
  | { readonly kind: "overseer-host"; readonly args: ReadonlyArray<string> }
  | { readonly kind: "browser"; readonly args: ReadonlyArray<string> }
  | { readonly kind: "content-transfer"; readonly args: ReadonlyArray<string> }
  | { readonly kind: "companion-stdio"; readonly args: ReadonlyArray<string> }
  | { readonly kind: "link"; readonly args: ReadonlyArray<string> }
  | { readonly kind: "cli"; readonly args: ReadonlyArray<string> };

/**
 * Bun places user args at index 2 in both execution modes:
 *   source   = [bunPath, "/…/src/cli/main.ts", ...args]
 *   compiled = ["bun", "/$bunfs/root/junto", ...args]
 */
export const earlyDispatchFromArgv = (
  argv: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): EarlyDispatch => {
  const user = argv.slice(2);
  if (user[0] === "machine" || user[0] === "link" || user[0] === COMPANION_STDIO_COMMAND) {
    const refusal = ownerCommandRefusal(environment);
    if (refusal !== undefined) return { kind: "owner-refused", message: refusal };
  }
  if (user[0] === "link") return { kind: "link", args: user.slice(1) };
  if (user[0] === "overseer-host") return { kind: "overseer-host", args: user.slice(1) };
  if (user[0] === "browser") {
    return { kind: "browser", args: user.slice(1) };
  }
  if (user[0] === COMPANION_STDIO_COMMAND) {
    return { kind: "companion-stdio", args: user.slice(1) };
  }
  if (user[0] === CONTENT_TRANSFER_COMMAND) {
    return { kind: "content-transfer", args: user.slice(1) };
  }
  return { kind: "cli", args: user };
};
