/**
 * junto task, the 0.10 lifecycle: create, assign from reach, a reviewer,
 * start, finish into review, a stamp to done, and a comment whose mention
 * reaches the mentioned seat; a handoff note through task show, and a
 * dependency that holds the finish until it is done. Reach is the region's:
 * no seat has an edge. Owner: pty-mail (pty-contract while pty-mail is out).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { TASK_HANDOFF_MAX } from "../../src/shared/task-model";
import { casesFor, type AcceptanceArea, type AcceptanceSeat } from "./area";
import { envelopeOf } from "./envelope";
import type { WorkCliCommandResult } from "../work-cli-acceptance";

const { check } = casesFor("task");

/** One inbox row as msg list prints it: text in parts, the thread and notice kind in metadata. */
type InboxItem = {
  readonly parts?: ReadonlyArray<{ readonly kind?: string; readonly text?: string }>;
  readonly metadata?: { readonly threadId?: string; readonly subjectNotice?: string };
};

/** The seat's inbox, read without marking it, newest first. */
export const inboxOf = async (cli: (args: ReadonlyArray<string>, as?: AcceptanceSeat) => Promise<WorkCliCommandResult>, seat: AcceptanceSeat) => {
  const listed = await cli(["msg", "list", JSON.stringify({ peek: true })], seat);
  const items: ReadonlyArray<InboxItem> = envelopeOf(listed)?.data?.items ?? [];
  return { listed, items };
};

const textOf = (item: InboxItem): string => (item.parts ?? []).map((part) => part.text ?? "").join("");

/** The node ids a refusal offers in details.candidates. */
const candidateIds = (refusal: any): ReadonlyArray<string> =>
  Array.isArray(refusal?.error?.details?.candidates) ? refusal.error.details.candidates.map((candidate: { nodeId?: string }) => candidate.nodeId) : [];

export const taskArea: AcceptanceArea = {
  name: "task",
  owner: "pty-mail",
  run: async ({ cli, call, addSeat, canvas, log, nodes, outside }) => {
    const worker = await addSeat("worker", { x: 300, y: 20 });
    const reviewer = await addSeat("reviewer", { x: 460, y: 20 });
    const peer = await addSeat("peer", { x: 620, y: 20 });
    // In a region on no line with the task node's (a seat in no region is at the root, and reaches it).
    const outsider = await addSeat("outsider", { x: 1_300, y: 40 });

    const created = await cli(["task", "create", "acc task", "--stamps", "1"]);
    log("task create", created.stdout || created.stderr);
    const made = envelopeOf(created)?.data;
    const ref = `#${String(made?.number)}`;
    const step = async (label: string, args: ReadonlyArray<string>, as?: AcceptanceSeat) => {
      const result = await cli(args, as);
      log(label, result.stdout || result.stderr);
      return { result, data: envelopeOf(result)?.data };
    };

    const assigned = await step("task assign", ["task", "assign", ref, "@worker"]);
    const reviewing = await step("task reviewer add", ["task", "reviewer", "add", ref, "@reviewer"]);
    const started = await step("task start", ["task", "start", ref], worker);
    const finished = await step("task finish", ["task", "finish", ref], worker);
    const stamped = await step("task stamp", ["task", "stamp", ref, "approve"], reviewer);

    // A mention is a seat link (mention.ts); `@name` in the text is the help's promise.
    const linked = await step("task comment link", ["task", "comment", ref, `[@peer](junto://canvas/${canvas}?node=peer) please look at the link`]);
    const atName = await step("task comment @name", ["task", "comment", ref, "@peer please look at the name"]);
    const outOfReach = await step("task comment out of reach", ["task", "comment", ref, `[@outsider](junto://canvas/${canvas}?node=outsider) look`]);
    // By name, a seat out of reach is no seat this comment can mention (cli-protocol, a50a1a912).
    const nameOutOfReach = await step("task comment @name out of reach", ["task", "comment", ref, "@outsider look"]);

    // Waiting: the state it is in answers at once; one it never reaches times out (b6814af4e).
    const waited = await step("task wait done", ["task", "wait", ref, "--until", "done"]);
    const timedOut = await step("task wait timeout", ["task", "wait", ref, "--until", "in-review", "--timeout", "500ms"]);
    const oldWait = await call("task.wait", { target: nodes.tasks, taskId: made?.taskId });
    log("task.wait old shape", JSON.stringify(oldWait));
    const rulesOfTask = await step("task rules task", ["task", "rules", ref]);
    const rulesOfNode = await step("task rules node", ["task", "rules", "--node", nodes.tasks]);

    const workerMail = await inboxOf(cli, worker);
    log("worker inbox", workerMail.listed.stdout || workerMail.listed.stderr);
    const reviewerMail = await inboxOf(cli, reviewer);
    log("reviewer inbox", reviewerMail.listed.stdout || reviewerMail.listed.stderr);
    const peerMail = await inboxOf(cli, peer);
    log("peer inbox", peerMail.listed.stdout || peerMail.listed.stderr);
    const inThread = (items: ReadonlyArray<InboxItem>, notice: string, words: string) =>
      items.some((item) => item.metadata?.threadId === made?.taskId && item.metadata?.subjectNotice === notice && textOf(item).includes(words));
    const outsiderShow = await step("task show out of reach", ["task", "show", ref], outsider);

    // A handoff note at the cap round-trips through task show; one past it is refused by the CLI.
    const noted = await step("task create noted", ["task", "create", "noted task", "--stamps", "0"]);
    const notedRef = `#${String(noted.data?.number)}`;
    const note = "n".repeat(TASK_HANDOFF_MAX);
    await step("task assign noted", ["task", "assign", notedRef, "@worker"]);
    await step("task start noted", ["task", "start", notedRef], worker);
    const finishedNoted = await step("task finish --note at the cap", ["task", "finish", notedRef, "--note", note], worker);
    const shownNoted = await step("task show noted", ["task", "show", notedRef]);
    // No core behind this work home: an InputError came before transport, a RuntimeDown crossed it.
    const noCore = join(outside, "task-no-core");
    mkdirSync(noCore, { recursive: true });
    const overNote = await cli(["task", "finish", notedRef, "--note", `${note}n`], worker, { JUNTO_WORK_HOME: noCore });
    log("task finish --note past the cap", overNote.stdout || overNote.stderr);
    const overNoteBody = envelopeOf(overNote);

    // A dependency not done refuses finish, naming it by number and state; done, it lets the finish through.
    const before = await step("task create dependency", ["task", "create", "dependency", "--stamps", "0"]);
    const beforeRef = `#${String(before.data?.number)}`;
    const after = await step("task create dependent", ["task", "create", "dependent", "--stamps", "0"]);
    const afterRef = `#${String(after.data?.number)}`;
    const depended = await step("task depend", ["task", "depend", afterRef, "--on", beforeRef]);
    await step("task assign dependent", ["task", "assign", afterRef, "@worker"]);
    await step("task start dependent", ["task", "start", afterRef], worker);
    const blocked = await step("task finish deps-unmet", ["task", "finish", afterRef], worker);
    const blockedBody = envelopeOf(blocked.result);
    const unfinished: ReadonlyArray<{ readonly number?: number; readonly state?: string }> =
      blockedBody?.error?.details?.expected?.kind === "deps-unmet" ? blockedBody.error.details.expected.unfinished ?? [] : [];
    await step("task assign dependency", ["task", "assign", beforeRef, "@peer"]);
    await step("task start dependency", ["task", "start", beforeRef], peer);
    const doneBefore = await step("task finish dependency", ["task", "finish", beforeRef], peer);
    const unblocked = await step("task finish dependent", ["task", "finish", afterRef], worker);
    const refused = envelopeOf(outOfReach.result);
    const nameRefused = envelopeOf(nameOutOfReach.result);

    return [
      check("create", created.code === 0 && made?.disposition === "applied" && made?.state === "backlog" && typeof made?.taskId === "string", created),
      check("assign from reach", assigned.data?.state === "assigned", assigned.result),
      check("assignment notice in the task thread", inThread(workerMail.items, "assignment", "assigned you"), workerMail.listed),
      check("reviewer add", reviewing.data?.disposition === "applied", reviewing.result),
      check("stamp request notice", inThread(reviewerMail.items, "stamp-request", "asks for your stamp"), reviewerMail.listed),
      check("start", started.data?.state === "working", started.result),
      check("finish into review", finished.data?.state === "in-review", finished.result),
      check("stamp to done", stamped.data?.state === "done", stamped.result),
      check("wait answers a reached state", waited.data?.state === "done" && waited.data?.taskId === made?.taskId, waited.result),
      check("wait times out typed", envelopeOf(timedOut.result)?.error?.type === "Timeout" && envelopeOf(timedOut.result)?.error?.details?.from === "done", timedOut.result),
      check("old wait shape refused", oldWait?.ok === false && oldWait.error?.type === "InputError"),
      check("rules of a task", rulesOfTask.data?.node === nodes.tasks && Array.isArray(rulesOfTask.data?.rules) && rulesOfTask.data?.task !== undefined, rulesOfTask.result),
      check("rules of a node", rulesOfNode.data?.node === nodes.tasks && Array.isArray(rulesOfNode.data?.rules), rulesOfNode.result),
      check("comment", linked.data?.disposition === "applied" && linked.data?.threadId !== undefined, linked.result),
      check("mention link reaches the seat", inThread(peerMail.items, "mention", "please look at the link"), peerMail.listed),
      // Main rewrites @name to its mention link against the seats in reach (a50a1a912): the seat in reach is told.
      check("@name mention reaches the seat", atName.data?.disposition === "applied" && inThread(peerMail.items, "mention", "please look at the name"), atName.result),
      check("mention out of reach refused", refused?.ok === false && refused.error?.type === "ScopeError" && refused.error?.details?.reason === "not_in_reach", outOfReach.result),
      // The refusal names the seats this comment can mention: the one in reach, never the one out of it.
      check(
        "@name out of reach is unknown",
        nameRefused?.ok === false && nameRefused.error?.type === "UnknownTarget" && nameRefused.error?.details?.path === "text" && nameRefused.error?.details?.target === "@outsider"
          && candidateIds(nameRefused).includes(peer.nodeId) && !candidateIds(nameRefused).includes(outsider.nodeId),
        nameOutOfReach.result,
      ),
      check(
        `finish --note at ${String(TASK_HANDOFF_MAX)} characters round-trips through task show`,
        finishedNoted.data?.state === "done" && shownNoted.data?.task?.current?.handoff === note,
        finishedNoted.data?.state === "done" ? shownNoted.result : finishedNoted.result,
      ),
      check(
        `finish --note at ${String(TASK_HANDOFF_MAX + 1)} characters is refused before transport`,
        overNote.code === 1 && overNoteBody?.ok === false && overNoteBody.error?.type === "InputError" &&
          overNoteBody.error?.details?.path === "note" &&
          String(overNoteBody.error?.message).includes(`at most ${String(TASK_HANDOFF_MAX)} characters`),
        overNote,
      ),
      check(
        "finish refuses deps-unmet, naming the unfinished task by number and state",
        depended.data?.disposition === "applied" && blockedBody?.ok === false &&
          unfinished.length === 1 && unfinished[0]?.number === before.data?.number && unfinished[0]?.state === "backlog" &&
          String(blockedBody.error?.message).includes(`This task depends on work not done yet: ${beforeRef} is in the backlog`),
        blocked.result,
      ),
      check(
        "finish goes through once the dependency is done",
        doneBefore.data?.state === "done" && unblocked.data?.state === "done",
        doneBefore.data?.state === "done" ? unblocked.result : doneBefore.result,
      ),
      // Out of reach, the task is not there to name (task-control.ts findTask).
      check(`task in ${nodes.region} is unknown from ${nodes.elsewhere}`, envelopeOf(outsiderShow.result)?.error?.type === "UnknownTarget", outsiderShow.result),
    ];
  },
};
