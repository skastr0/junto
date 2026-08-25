/**
 * Factory claim pulse text — the complete CLI work packet delivered to a
 * managed seat when a task becomes `working` on that actor.
 *
 * Law: an agent that only reads this string must be able to form a valid
 * `vellum-command tasks list` / `vellum-command tasks update` without schema discovery.
 * Claim delivery must never gate on a prior `/compact` harness turn.
 */

import type { CanvasDoc } from "./canvas";
import type { Task } from "./work-model";
import { taskBrief, taskMediaParts } from "./task";
import {
  effectiveClaimsStack,
  requiredBoardingChecks,
  sinkContractOf,
  taskEpoch,
  type EffectiveClaim,
} from "./claims";
import { flowDestinations } from "./flow-graph";
import { regionStack } from "./graph";

export type FactoryClaimPromptInput = {
  /** Task sink node id on the canvas (CLI `target`). */
  readonly sinkNodeId: string;
  readonly task: Task;
  /**
   * Live document. Supplies the station's standing law: sink instruction,
   * effective claims stack, pinned rulings, boarding expectations, and the
   * forward destinations. Omitted (tests, callers without a document) leaves
   * the packet at its base contract.
   */
  readonly doc?: CanvasDoc;
};

const nodeById = (doc: CanvasDoc, nodeId: string) =>
  doc.nodes.find((node) => node.id === nodeId);

const provenanceOf = (entry: EffectiveClaim): string => {
  switch (entry.provenance.kind) {
    case "region":
      return `region ${entry.provenance.label}`;
    case "sink":
      return "this station";
    case "task":
      return "raised with the task";
  }
};

/**
 * Station law, journey, and boarding sections. Every line is derived from the
 * document the operator authored — the packet never invents a rule.
 */
const stationSections = (
  doc: CanvasDoc,
  sinkNodeId: string,
  task: Task,
): readonly string[] => {
  const lines: string[] = [];

  const contract = sinkContractOf(nodeById(doc, sinkNodeId));
  const instruction = contract?.instruction;
  if (instruction !== undefined && instruction.trim().length > 0) {
    lines.push("", "What this station is for:", instruction.trim());
  }

  const triage = contract?.inbound?.instruction;
  if (triage !== undefined && triage.trim().length > 0) {
    lines.push("", "How work arriving here is handled:", triage.trim());
  }

  const regions = regionStack(doc, sinkNodeId);
  const briefings = regions
    .map((group) => group.ether?.region?.instruction)
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0);
  if (briefings.length > 0) {
    lines.push("", "Ambient region briefing (outer to inner):");
    for (const text of briefings) lines.push(`- ${text.trim()}`);
  }

  const claims = effectiveClaimsStack(doc, sinkNodeId, task);
  if (claims.length > 0) {
    lines.push(
      "",
      "Claims in force here (answer each before completed):",
      ...claims.map(
        (entry) =>
          `- [${entry.claim.severity}] ${entry.claim.text}  (id ${entry.claim.id}, from ${provenanceOf(entry)})`,
      ),
      "Answer with completionEvidence.responses: [{ claimId, response, refs }]. A soft claim may instead carry completionEvidence.claimWaivers: [{ claimId, reason }]. A hard claim must be answered.",
      `Read the live stack any time: vellum-command tasks claims '{"target":"${sinkNodeId}","task":"${task.id}"}'`,
    );
  }

  const rulings = regions.flatMap((group) =>
    (group.ether?.region?.contract?.rulings ?? []).map(
      (ruling) => `- ${ruling.text}  (pinned to ${group.label?.trim() || group.id})`,
    ),
  );
  if (rulings.length > 0) {
    lines.push("", "Pinned rulings for this region stack:", ...rulings);
  }

  const destinations = flowDestinations(doc, sinkNodeId);
  if (destinations.length > 0) {
    lines.push(
      "",
      destinations.length === 1
        ? `Forward: completing here sends the task to "${destinations[0]}".`
        : `Forward: this station forks — name one of [${destinations.join(", ")}] as next when you complete.`,
    );
    const emission = contract?.outbound?.emission;
    if (emission !== undefined && emission.trim().length > 0) {
      lines.push(
        `What this station publishes forward (put this in your completion note): ${emission.trim()}`,
      );
    }
    for (const destination of destinations) {
      const checks = requiredBoardingChecks(doc, sinkNodeId, destination);
      if (checks.length === 0) continue;
      lines.push(
        `Boarding checks for "${destination}" (green tickets are required to forward):`,
        ...checks.map(({ check, side }) => `- ${side}: ${check.label}`),
      );
    }
    const anyChecks = destinations.some(
      (destination) => requiredBoardingChecks(doc, sinkNodeId, destination).length > 0,
    );
    if (anyChecks) {
      lines.push(
        `Run them here and submit the results: vellum-command tasks board '{"target":"${sinkNodeId}","task":"${task.id}"${destinations.length > 1 ? ',"next":"<station>"' : ""}}'`,
      );
    }
  }

  const priorPassages = (task.journey ?? []).filter(
    (passage) => passage.exitedAt !== undefined,
  );
  if (priorPassages.length > 0) {
    lines.push("", "Where this task has already been:");
    for (const passage of priorPassages) {
      const emission = passage.emissionNote?.trim();
      lines.push(
        `- ${passage.nodeId} (${passage.exit ?? "left"})${emission ? `: ${emission}` : ""}`,
      );
    }
  }

  const epoch = taskEpoch(task);
  if (epoch > 0) {
    // The defect itself is recorded as the newest history note by the
    // send-back transition; the packet points at it rather than restating it.
    // The packet is delivered at the defect target, so "this station onward"
    // names exactly the shadowed receipts.
    lines.push(
      "",
      `This task was sent back to you (epoch ${epoch}). Receipts from this station onward are stale, along with all waivers and tickets — answer the claims here again and re-run boarding. The defect is the newest note in the task history.`,
    );
  }

  return lines;
};

/**
 * Build the managed-terminal claim prompt for one working task.
 * Pure — no I/O; kernel delivery is the only caller in production.
 */
export const buildFactoryClaimPrompt = (
  input: FactoryClaimPromptInput,
): string => {
  const { sinkNodeId, task, doc } = input;
  const brief = taskBrief(task);
  const listExample = `vellum-command tasks list '{"target":"${sinkNodeId}"}'`;
  const updateExample = `vellum-command tasks update '{"target":"${sinkNodeId}","task":"${task.id}","state":"completed","note":"<what you did>"}'`;
  const workingExample = `vellum-command tasks update '{"target":"${sinkNodeId}","task":"${task.id}","state":"working","note":"<progress>"}'`;

  const media = taskMediaParts(task);
  const mediaNote =
    media.length === 0
      ? []
      : [
          "",
          `This task includes ${media.length} first-class media attachment${media.length === 1 ? "" : "s"} (${media.map((part) => part.mediaType ?? "raw").join(", ")}) on history[0] as raw parts.`,
          `Inspect via ${listExample} (bytesBase64 + mediaType travel with the projected claim — no host path).`,
        ];

  const criteria = task.finishCriteria;
  const criteriaNote: string[] = [];
  if (criteria !== undefined) {
    criteriaNote.push("", "Finish criteria (hard gate on complete):");
    if (criteria.description) {
      criteriaNote.push(`- description: ${criteria.description}`);
    }
    if (criteria.artifacts) {
      criteriaNote.push(
        `- artifacts required on node "${criteria.artifacts.nodeId}"` +
          (criteria.artifacts.instruction
            ? ` — ${criteria.artifacts.instruction}`
            : "") +
          (criteria.artifacts.names && criteria.artifacts.names.length > 0
            ? ` (exact names: ${criteria.artifacts.names.join(", ")})`
            : ""),
        '  Publish with task linkage, then complete with completionEvidence.artifacts: [{ artifactId, nodeId }].',
      );
    }
    if (criteria.git) {
      criteriaNote.push(
        `- git: at least ${criteria.git.minCommits} commit(s)`,
        '  Complete with completionEvidence.git.commits: ["<sha>", ...].',
      );
    }
  }

  const station = doc === undefined ? [] : stationSections(doc, sinkNodeId, task);
  const claims =
    doc === undefined ? [] : effectiveClaimsStack(doc, sinkNodeId, task);

  // Machine-readable mirror of the prose guidance: a seat that parses only the
  // JSON packet must see the same station law the prose carries. Emission is
  // forwarding guidance, so it only travels when the station forwards.
  const contract =
    doc === undefined ? undefined : sinkContractOf(nodeById(doc, sinkNodeId));
  const guidanceInstruction = contract?.instruction?.trim();
  const guidanceTriage = contract?.inbound?.instruction?.trim();
  const guidanceEmission =
    doc !== undefined && flowDestinations(doc, sinkNodeId).length > 0
      ? contract?.outbound?.emission?.trim()
      : undefined;
  const guidance = {
    ...(guidanceInstruction ? { instruction: guidanceInstruction } : {}),
    ...(guidanceTriage ? { triage: guidanceTriage } : {}),
    ...(guidanceEmission ? { emission: guidanceEmission } : {}),
  };

  const packet = {
    sinkTarget: sinkNodeId,
    taskId: task.id,
    state: task.state,
    brief,
    ...(criteria !== undefined ? { finishCriteria: criteria } : {}),
    ...(task.metadata !== undefined ? { metadata: task.metadata } : {}),
    mediaCount: media.length,
    ...(claims.length > 0
      ? {
          claims: claims.map((entry) => ({
            id: entry.claim.id,
            text: entry.claim.text,
            severity: entry.claim.severity,
            from: provenanceOf(entry),
          })),
        }
      : {}),
    ...(doc !== undefined && flowDestinations(doc, sinkNodeId).length > 0
      ? { forwardsTo: flowDestinations(doc, sinkNodeId) }
      : {}),
    ...(Object.keys(guidance).length > 0 ? { guidance } : {}),
    ...(taskEpoch(task) > 0 ? { epoch: taskEpoch(task) } : {}),
  };

  return [
    `[factory claim] task ${task.id}: ${brief}`,
    "",
    "You claimed this task from the factory pull queue.",
    `Sink target (tasks node id): ${sinkNodeId}`,
    `Task id: ${task.id}`,
    "",
    "CLI contract (copy-paste JSON — do not invent flags):",
    `- orient:  vellum-command onboard`,
    `- list:    ${listExample}`,
    `- progress:${workingExample}`,
    `- complete:${updateExample}`,
    "- blocked: vellum-command escalate  (JSON per `vellum-command schema show request.escalate` / examples)",
    "",
    "You can start from the task packet below; list is optional once you have target + task id.",
    "",
    "Operating contract for this task:",
    "- PLAN — one line: what you will change and how you will verify it.",
    "- VERIFY — before completed, check every finish criterion (above). The server enforces them; a rejection names the missing pieces.",
    "- EVIDENCE — attach completionEvidence: artifacts published with task linkage + real git SHAs, and a response for every claim in force (below).",
    "- BOARD — where this station forwards, run the boarding checks and submit them before you complete.",
    "- BLOCK — if you cannot proceed, escalate with what you tried and what you need. Do not mark failed unless the task is truly dead.",
    "",
    ...mediaNote,
    ...criteriaNote,
    ...station,
    "",
    "--- task packet (JSON) ---",
    JSON.stringify(packet, null, 2),
  ].join("\n");
};
