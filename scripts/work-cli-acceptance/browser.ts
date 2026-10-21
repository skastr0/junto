/**
 * junto browser comment. Owner: pty-contract. A seat comments on a box of a
 * page, with a shot main takes of the box, on the editing machine only.
 *
 * This core hosts no browser control socket: the app starts it inside the
 * Electron browser composition (src/main/index.ts), and on main that socket
 * admits no CLI caller yet (edge-grant.ts admitSocket, "not available in this
 * build"). So the net asserts the text bound, which holds before transport,
 * and the exact refusal a comment gets here; the grant cases stay pending on
 * product-attention's e2e lane. No shot is faked.
 *
 * Every call points JUNTO_BROWSER_HOME into the sandbox, so the CLI never
 * reaches the operator's own app.
 */
import { join } from "node:path";
import { BROWSER_MAX_COMMENT_TEXT_BYTES } from "../../src/shared/browser-control";
import { casesFor, type AcceptanceArea } from "./area";
import { envelopeOf } from "./envelope";

const { check, pending } = casesFor("browser");

const ON = "product-attention e2e lane";
const SESSION = "session-acceptance";
const BOX = "40,120,320,80";

export const browserArea: AcceptanceArea = {
  name: "browser",
  owner: "pty-contract",
  run: async ({ cli, log, outside }) => {
    const env = { JUNTO_BROWSER: "1", JUNTO_BROWSER_HOME: join(outside, "browser-home") };
    const comment = (text: string) => cli(["browser", "comment", SESSION, "--box", BOX, "--text", text], undefined, env);

    const oversized = await comment("a".repeat(BROWSER_MAX_COMMENT_TEXT_BYTES + 1));
    log("browser comment oversized text", oversized.stdout || oversized.stderr);
    const bound = envelopeOf(oversized);

    const posted = await comment("this button overlaps the title");
    log("browser comment with no control socket", posted.stdout || posted.stderr);
    const down = envelopeOf(posted);

    return [
      // The same call with a text in bounds reaches transport (below), so this refusal came first.
      check(
        "an oversized --text is refused before transport",
        oversized.code === 1 && bound?.ok === false && bound.error?.type === "InputError" &&
          String(bound.error?.message).includes(`text exceeds ${String(BROWSER_MAX_COMMENT_TEXT_BYTES)} UTF-8 bytes`) &&
          bound.error?.details?.next_step === "junto schema show browser.comment",
        oversized,
      ),
      check(
        "a comment where no app hosts browser control is refused RuntimeDown",
        posted.code === 1 && down?.ok === false && down.error?.type === "RuntimeDown" &&
          down.error?.details?.reason === "runtime_down" && down.error?.details?.retryable === true &&
          down.error?.details?.next_step === "start the Junto app on this machine",
        posted,
      ),
      pending("a seat with no live grant is refused forbidden", ON),
      pending("a seat with a live grant posts, and the comment reads back in the page's thread with a PageBoxAnchor", ON),
    ];
  },
};
