/**
 * junto artifact. Owner: pty-contract. A document is created, read, edited
 * against its head, refused `Stale` when edited again on the old base (a
 * document never rebases; a pad or sheet would), and commented on with a
 * text anchor quoting its body.
 */
import { casesFor, type AcceptanceArea } from "./area";
import { envelopeOf } from "./envelope";

const { check, fail } = casesFor("artifact");

const FIRST = "The acceptance report.\n\nIt names what shipped.\n";
const SECOND = "The acceptance report.\n\nIt names what shipped, and when.\n";
const QUOTE = "what shipped, and when";

export const artifactArea: AcceptanceArea = {
  name: "artifact",
  owner: "pty-contract",
  run: async ({ cli, log, nodes }) => {
    const created = await cli(["artifact", "create", "report", "--type", "document", "--node", nodes.artifacts, "--markdown", FIRST]);
    log("artifact create", created.stdout || created.stderr);
    const made = envelopeOf(created);
    const id: unknown = made?.data?.artifactId;
    const base: unknown = made?.data?.version;
    const createOk = created.code === 0 && made?.ok === true && made.data?.disposition === "applied" && typeof id === "string" && typeof base === "number";
    if (!createOk) return [check("create", false, created)];
    const artifactId = id as string;
    const head = base as number;

    const shown = await cli(["artifact", "show", artifactId]);
    log("artifact show", shown.stdout || shown.stderr);
    const show = envelopeOf(shown);

    const edited = await cli(["artifact", "edit", artifactId, "--base", String(head), "--markdown", SECOND]);
    log("artifact edit", edited.stdout || edited.stderr);
    const edit = envelopeOf(edited);
    const next = edit?.data?.version;

    // The same edit again, written against the base the first edit moved past.
    const stale = await cli(["artifact", "edit", artifactId, "--base", String(head), "--markdown", "A late rewrite.\n"]);
    log("artifact edit stale", stale.stdout || stale.stderr);
    const refused = envelopeOf(stale);

    const commented = await cli(["artifact", "comment", artifactId, "Say which build.", "--anchor", JSON.stringify({ kind: "text", quote: QUOTE })]);
    log("artifact comment", commented.stdout || commented.stderr);
    const comment = envelopeOf(commented);

    const misplaced = await cli(["artifact", "comment", artifactId, "Which cell?", "--anchor", JSON.stringify({ kind: "cells", range: "B2" })]);
    log("artifact comment wrong anchor", misplaced.stdout || misplaced.stderr);
    const wrong = envelopeOf(misplaced);

    return [
      check("create", true),
      check(
        "show reads the head",
        shown.code === 0 && show?.ok === true && show.data?.version === head && String(show.data?.text ?? "").includes("It names what shipped."),
        shown,
      ),
      check("edit on the head", edited.code === 0 && edit?.ok === true && edit.data?.disposition === "applied" && next === head + 1, edited),
      typeof next !== "number"
        ? fail("edit on a stale base is refused Stale", "the first edit made no version to be stale against")
        : check(
            "edit on a stale base is refused Stale",
            stale.code === 1 &&
              refused?.ok === false &&
              refused.error?.type === "Stale" &&
              refused.error?.details?.reason === "stale" &&
              refused.error?.details?.expected === next &&
              refused.error?.details?.retryable === true &&
              typeof refused.error?.details?.next_step === "string",
            stale,
          ),
      check(
        "comment with a text anchor",
        commented.code === 0 && comment?.ok === true && comment.data?.disposition === "applied" &&
          typeof comment.data?.threadId === "string" && typeof comment.data?.messageId === "string",
        commented,
      ),
      check(
        "a document refuses a cells anchor",
        misplaced.code === 1 && wrong?.ok === false && wrong.error?.type === "InputError" && wrong.error?.details?.path === "anchor" &&
          wrong.error?.details?.retryable === false,
        misplaced,
      ),
    ];
  },
};
