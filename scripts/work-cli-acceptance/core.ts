/**
 * The control plane as 0.9 left it: doctor, onboard, capabilities, a legacy
 * claim and a partial batch, a raised and withdrawn hand, and a scope error.
 * Owner: pty-mail, from the original work-cli-acceptance.ts checks.
 */
import { bodyOf, casesFor, type AcceptanceArea } from "./area";

const { check } = casesFor("core");

export const coreArea: AcceptanceArea = {
  name: "core",
  owner: "pty-mail",
  run: async ({ cli, log, nodes }) => {
    const doctor = await cli(["doctor"]);
    log("doctor", doctor.stdout || doctor.stderr);
    const onboard = await cli(["onboard"]);
    log("onboard", onboard.stdout || onboard.stderr);
    const caps = await cli(["capabilities"]);
    log("capabilities", caps.stdout || caps.stderr);

    const claim = await cli(["task", "claim", JSON.stringify({ target: nodes.tasks, task: "t1" })]);
    log("task claim", claim.stdout || claim.stderr);
    const batch = await cli([
      "task",
      "update",
      JSON.stringify([
        { target: nodes.tasks, task: "t1", state: "completed", note: "done" },
        { target: nodes.tasks, task: "missing", state: "completed" },
      ]),
      "--concurrency",
      "2",
    ]);
    log(`task update batch exit=${batch.code}`, batch.stdout || batch.stderr);

    // Raising a hand needs no edge: blocked, then read it back, then withdraw.
    const raised = await cli(["blocked", "Approve the acceptance artifact to ship?", "--detail", "Acceptance run is otherwise green."]);
    log("blocked", raised.stdout || raised.stderr);
    const raisedBody = bodyOf(raised);
    const signalId = raisedBody?.ok === true ? raisedBody.data?.signal?.signalId : undefined;
    const signalOk = raised.code === 0 && typeof signalId === "string" && raisedBody.data?.signal?.state === "open";
    let signalClearedOk = false;
    if (typeof signalId === "string") {
      const listed = await cli(["signal", "list"]);
      log("signal list", listed.stdout || listed.stderr);
      const cleared = await cli(["signal", "clear", signalId]);
      log("signal clear", cleared.stdout || cleared.stderr);
      signalClearedOk = cleared.code === 0 && bodyOf(cleared)?.data?.signals?.[0]?.state === "withdrawn";
    }

    const scope = await cli(["task", "list", JSON.stringify({ target: "no-such-node" })]);
    log("scope error", scope.stdout || scope.stderr);

    const claimBody = bodyOf(claim);
    const batchBody = bodyOf(batch);
    return [
      check("doctor", doctor.stdout.includes("protocol_version"), doctor),
      check("claim", claimBody?.ok === true && claimBody.data?.outcome === "succeeded", claim),
      check("batch partial", batchBody?.ok === true && batchBody.data?.outcome === "partial_failure" && batch.code === 1, batch),
      check("signal", signalOk, raised),
      check("signal clear", signalClearedOk),
      check("scope", (scope.stderr || scope.stdout).includes("ScopeError"), scope),
    ];
  },
};
