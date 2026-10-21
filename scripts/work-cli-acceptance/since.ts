/**
 * junto since: what is owed since this seat's last session. Runs after the
 * task area, so peer holds its mentions and worker its assignment, all
 * unread (the task area peeks). Owner: pty-mail.
 */
import { casesFor, type AcceptanceArea } from "./area";
import { envelopeOf } from "./envelope";

const { check } = casesFor("since");

export const sinceArea: AcceptanceArea = {
  name: "since",
  owner: "pty-mail",
  run: async ({ cli, log }) => {
    const peer = { nodeId: "peer", agentKey: "local:peer" };
    const since = await cli(["since"], peer);
    log("since", since.stdout || since.stderr);
    const view = envelopeOf(since)?.data;
    const owed: ReadonlyArray<string> = view?.owed_replies?.lines ?? [];
    const all = await cli(["since", "--all"], peer);
    log("since --all", all.stdout || all.stderr);
    // A seat nothing was written to owes nothing.
    const quiet = await cli(["since"]);
    log("since quiet", quiet.stdout || quiet.stderr);
    const quietView = envelopeOf(quiet)?.data;
    return [
      check("unread counted", since.code === 0 && typeof view?.unread === "number" && view.unread >= 1, since),
      check("mention owed a reply", owed.some((line) => line.includes("please look")), since),
      check("--all", all.code === 0 && typeof envelopeOf(all)?.data?.as_of === "string", all),
      check("nothing owed", quiet.code === 0 && quietView?.owed_replies === undefined, quiet),
    ];
  },
};
