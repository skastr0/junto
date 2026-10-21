/**
 * junto task check: a seat reports the checks it ran, and finish needs the
 * node's required checks green at this epoch (e3e34d19c, 02048fb3e). The
 * checked node and its seat sit in the elsewhere region, so no other area
 * sees a second task node in reach. Owner: pty-mail.
 */
import { casesFor, type AcceptanceArea } from "./area";
import { envelopeOf } from "./envelope";

const { check } = casesFor("check");

const CHECKED = "checked";
const contractOf = (lintCommand: string) => ({
  outgoing: {
    checks: [
      { id: "tests", label: "tests", command: "bun run test" },
      { id: "lint", label: "lint", command: lintCommand },
    ],
  },
});

type CheckStatusRow = { readonly checkId?: string; readonly status?: string };

export const checkArea: AcceptanceArea = {
  name: "check",
  owner: "pty-mail",
  run: async ({ cli, operator, addSeat, canvas, log }) => {
    await operator({
      _tag: "Add",
      canvas,
      nodes: [{ kind: "task", id: CHECKED, x: 1_240, y: 40, width: 160, height: 80, z: 11, contract: contractOf("bun run lint") }],
      wires: [],
    });
    const checker = await addSeat("checker", { x: 1_440, y: 40 });
    const step = async (label: string, args: ReadonlyArray<string>) => {
      const result = await cli(args, checker);
      log(label, result.stdout || result.stderr);
      return { result, envelope: envelopeOf(result) };
    };
    // The statuses task rules prints for this node's outgoing checks, by check id.
    const statuses = async (label: string) => {
      const { result, envelope } = await step(label, ["task", "rules", ref]);
      const rows: ReadonlyArray<CheckStatusRow> = envelope?.data?.task?.checks?.[0]?.checks ?? [];
      return { result, of: Object.fromEntries(rows.map((row) => [row.checkId, row.status])) as Record<string, string | undefined> };
    };
    const unmetOf = (envelope: any): { readonly red?: ReadonlyArray<string>; readonly missing?: ReadonlyArray<string> } | undefined =>
      envelope?.ok === false && envelope.error?.details?.expected?.kind === "checks-unmet" ? envelope.error.details.expected : undefined;
    const same = (a: ReadonlyArray<string> | undefined, b: ReadonlyArray<string>) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...b].sort());

    const created = await step("check: task create", ["task", "create", "checked task"]);
    const ref = `#${String(created.envelope?.data?.number)}`;
    await step("check: assign", ["task", "assign", ref]);
    const started = await step("check: start", ["task", "start", ref]);

    const noRuns = await step("check: finish with none run", ["task", "finish", ref]);
    const none = await statuses("check: rules with none run");
    const reported = await step("check: report", ["task", "check", ref, "--outgoing", "tests=0", "--outgoing", "lint=1"]);
    const mixed = await statuses("check: rules green and red");
    const redRun = await step("check: finish with lint red", ["task", "finish", ref]);
    // The operator changes lint's command: the run answers a command the node no longer names.
    await operator({ _tag: "Edit", canvas, id: CHECKED, change: { kind: "task", contract: contractOf("bun run lint --strict") } });
    const changed = await statuses("check: rules after the command changed");
    const staleRun = await step("check: finish with lint stale", ["task", "finish", ref]);
    const rerun = await step("check: report lint again", ["task", "check", ref, "--outgoing", "lint=0"]);
    const green = await statuses("check: rules all green");
    const finished = await step("check: finish all green", ["task", "finish", ref]);

    return [
      check("a task in progress on a checked node", started.envelope?.data?.state === "working", started.result),
      check("finish refused while checks are missing", same(unmetOf(noRuns.envelope)?.missing, ["tests", "lint"]) && same(unmetOf(noRuns.envelope)?.red, []), noRuns.result),
      check("rules show missing", none.of.tests === "missing" && none.of.lint === "missing", none.result),
      check("check reports applied", reported.envelope?.data?.disposition === "applied", reported.result),
      check("rules show green and red", mixed.of.tests === "green" && mixed.of.lint === "red", mixed.result),
      check("finish refused naming the red", same(unmetOf(redRun.envelope)?.red, ["lint"]) && same(unmetOf(redRun.envelope)?.missing, []), redRun.result),
      check("rules show stale", changed.of.tests === "green" && changed.of.lint === "stale", changed.result),
      check("finish refused on a stale run as not run", same(unmetOf(staleRun.envelope)?.missing, ["lint"]) && same(unmetOf(staleRun.envelope)?.red, []), staleRun.result),
      check("rerun reports applied", rerun.envelope?.data?.disposition === "applied", rerun.result),
      check("rules show all green", green.of.tests === "green" && green.of.lint === "green", green.result),
      check("finish passes with every check green", finished.envelope?.data?.state === "done", finished.result),
    ];
  },
};
