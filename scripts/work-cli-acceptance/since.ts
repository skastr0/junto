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
    // The bare verb is its own case: the sections below read --all, so one
    // defect in the bare form does not hide what since says.
    const bare = await cli(["since"], peer);
    log("since", bare.stdout || bare.stderr);
    const all = await cli(["since", "--all"], peer);
    log("since --all", all.stdout || all.stderr);
    const view = envelopeOf(all)?.data;
    const owed: ReadonlyArray<string> = view?.owed_replies?.lines ?? [];
    // The seeded agent was written nothing: it owes nothing.
    const quiet = await cli(["since", "--all"]);
    log("since quiet", quiet.stdout || quiet.stderr);
    const quietView = envelopeOf(quiet)?.data;
    return [
      check("bare since runs", bare.code === 0 && typeof envelopeOf(bare)?.data?.as_of === "string", bare),
      check("unread counted", all.code === 0 && typeof view?.unread === "number" && view.unread >= 1, all),
      check("mention owed a reply", owed.some((line) => line.includes("please look")), all),
      check("nothing owed", quiet.code === 0 && typeof quietView?.as_of === "string" && quietView.owed_replies === undefined, quiet),
    ];
  },
};
