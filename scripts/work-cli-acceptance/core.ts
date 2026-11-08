/**
 * The control plane every seat starts from: doctor, onboard, capabilities, a
 * raised and withdrawn hand, and an unknown task node. The 0.9 task claim
 * and batch update are gone (the deleted area checks them).
 * Owner: pty-mail, from the original work-cli-acceptance.ts checks.
 */
import { bodyOf, casesFor, type AcceptanceArea } from "./area";
import { envelopeOf } from "./envelope";

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

    const unknownNode = await cli(["task", "list", "--node", "no-such-node"]);
    log("unknown task node", unknownNode.stdout || unknownNode.stderr);

    return [
      check("doctor", doctor.stdout.includes("protocol_version"), doctor),
      check("task list on a node in reach", (await cli(["task", "list", "--node", nodes.tasks])).code === 0),
      check("signal", signalOk, raised),
      check("signal clear", signalClearedOk),
      check("unknown task node", envelopeOf(unknownNode)?.error?.type === "UnknownTarget", unknownNode),
    ];
  },
};
