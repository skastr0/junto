/**
 * Factory claim pulse text — the complete CLI work briefing delivered to a
 * managed seat when a task becomes `working` on that actor.
 *
 * Contract: an agent that only reads this string must be able to form a valid
 * `junto tasks list` / `junto tasks update` without schema discovery.
 * Claim delivery must never gate on a prior `/compact` harness turn.
 */

import type { Task } from "./work-model";
import { taskBrief, taskMediaParts } from "./task";
import {
  boardContractOf,
  requiredChecks,
  regionAddress,
  regionContractOf,
  rulesInForce,
  taskEpoch,
  type RuleInForce,
} from "./rules";
import { flowDestinations } from "./flow-graph";
import { asNodeId } from "./model/base";
import type { Canvas } from "./model/canvas";
import { nodeOf, regionStack } from "./model/canvas";
import { taskBoardTitle } from "./model/title";

export type FactoryClaimPromptInput = {
  /** Tasks node id on the canvas (CLI `target`). */
  readonly boardId: string;
  readonly task: Task;
  /**
   * The canvas the board is on. Supplies the board's standing rules:
   * instructions, rules in force, pinned rulings, checks, and the next boards.
   * Omitted (tests, callers without a canvas) leaves the briefing at its base
   * contract.
   */
  readonly canvas?: Board;
};

type Board = Pick<Canvas, "nodes" | "wires">;

/** What a board is called; a board no longer on the canvas is named by its id. */
const boardTitle = (canvas: Board, boardId: string) =>
  taskBoardTitle(nodeOf(canvas, asNodeId(boardId), "task"), boardId);

const boardName = (canvas: Board, boardId: string): string =>
  boardTitle(canvas, boardId).name;

/** A board called plain "Tasks" has neither a name nor instructions to go by. */
const NAMING_HINT = "Name this node to name the board.";

const provenanceOf = (entry: RuleInForce): string => {
  switch (entry.provenance.kind) {
    case "region":
      return `region ${regionAddress(entry.provenance)}`;
    case "board":
      return "this board";
    case "task":
      return "raised with the task";
  }
};

/**
 * Board rules, visits, and checks sections. Every line is derived from the
 * canvas the operator authored — the briefing never invents a rule.
 */
const boardSections = (
  canvas: Board,
  boardId: string,
  task: Task,
): readonly string[] => {
  const lines: string[] = [];

  const identity = boardTitle(canvas, boardId);
  const contract = boardContractOf(canvas, boardId);
  lines.push("", `Board: ${identity.name}`);
  if (identity.source === "id" && identity.name === "Tasks") lines.push(NAMING_HINT);
  const instructions = contract?.instructions;
  if (instructions !== undefined && instructions.trim().length > 0) {
    lines.push("", "What this board is for:", instructions.trim());
  }

  const handling = contract?.incoming?.handling;
  if (handling !== undefined && handling.trim().length > 0) {
    lines.push("", "How work arriving here is handled:", handling.trim());
  }

  const regions = regionStack(canvas, asNodeId(boardId));
  const briefings = regions
    .map((region) => region.instruction)
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0);
  if (briefings.length > 0) {
    lines.push("", "Ambient region briefing (outer to inner):");
    for (const text of briefings) lines.push(`- ${text.trim()}`);
  }

  const rules = rulesInForce(canvas, boardId, task);
  if (rules.length > 0) {
    lines.push(
      "",
      "Rules in force here (answer each before completed):",
      ...rules.map(
        (entry) =>
          `- ${entry.rule.text}  (id ${entry.rule.id}, from ${provenanceOf(entry)})`,
      ),
      "Answer with completionEvidence.claims: [{ ruleId, text, refs }]. A task rule whose board your chosen path no longer reaches may instead carry completionEvidence.waivers: [{ ruleId, reason }].",
      `Read the live stack any time: junto tasks rules '{"target":"${boardId}","task":"${task.id}"}'`,
    );
  }

  const rulings = regions.flatMap((region) =>
    (regionContractOf(region)?.rulings ?? []).map(
      (ruling) => `- ${ruling.text}  (pinned to ${region.label?.trim() || region.id})`,
    ),
  );
  if (rulings.length > 0) {
    lines.push("", "Pinned rulings for this region stack:", ...rulings);
  }

  const destinations = flowDestinations(canvas, boardId);
  if (destinations.length > 0) {
    const namedDestinations = destinations.map((destination) => ({
      id: destination,
      name: boardName(canvas, destination),
    }));
    lines.push(
      "",
      destinations.length === 1
        ? `Completing here sends the task to ${namedDestinations[0]!.name} (next: "${namedDestinations[0]!.id}").`
        : `Completing here forks — choose ${namedDestinations.map(({ name, id }) => `${name} ("${id}")`).join(", ")} as next when you complete.`,
    );
    const handoff = contract?.outgoing?.handoff;
    if (handoff !== undefined && handoff.trim().length > 0) {
      lines.push(
        `Write this in the handoff note when you send the task on (completion update "handoffNote"): ${handoff.trim()}`,
      );
    }
    for (const destination of destinations) {
      const checks = requiredChecks(canvas, boardId, destination);
      if (checks.length === 0) continue;
      const destinationName = boardName(canvas, destination);
      lines.push(
        `Checks required before sending on to ${destinationName}:`,
        ...checks.map(({ check, side }) => `- ${side}: ${check.label}`),
      );
    }
    const anyChecks = destinations.some(
      (destination) => requiredChecks(canvas, boardId, destination).length > 0,
    );
    if (anyChecks) {
      lines.push(
        `Run them here and submit the results: junto tasks check '{"target":"${boardId}","task":"${task.id}"${destinations.length > 1 ? ',"next":"<board>"' : ""}}'`,
      );
    }
  }

  const priorVisits = (task.visits ?? []).filter(
    (visit) => visit.exitedAt !== undefined,
  );
  if (priorVisits.length > 0) {
    lines.push("", "Where this task has already been:");
    for (const visit of priorVisits) {
      const handoffNote = visit.handoffNote?.trim();
      lines.push(
        `- ${boardName(canvas, visit.board)} (${visit.exit ?? "left"})${handoffNote ? `: ${handoffNote}` : ""}`,
      );
    }
  }

  const epoch = taskEpoch(task);
  if (epoch > 0) {
    // The defect itself is recorded as the newest history note by the
    // send-back transition; the briefing points at it rather than restating it.
    // The briefing is delivered at the defect target, so "from this board
    // onward" names exactly the shadowed claims.
    lines.push(
      "",
      `This task was sent back to you (epoch ${epoch}). Claims and waivers recorded from this board onward are stale — answer the rules here again and re-run the checks. The defect is the newest note in the task history.`,
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
  const { boardId, task, canvas } = input;
  const brief = taskBrief(task);
  const listExample = `junto tasks list '{"target":"${boardId}"}'`;
  const updateExample = `junto tasks update '{"target":"${boardId}","task":"${task.id}","state":"completed","note":"<what you did>"}'`;
  const workingExample = `junto tasks update '{"target":"${boardId}","task":"${task.id}","state":"working","note":"<progress>"}'`;

  const media = taskMediaParts(task);
  const mediaNote =
    media.length === 0
      ? []
      : [
          "",
          `This task includes ${media.length} first-class media attachment${media.length === 1 ? "" : "s"} (${media.map((part) => part.mediaType ?? "raw").join(", ")}) on history[0] as raw parts.`,
          `Inspect via ${listExample} (bytesBase64 + mediaType travel with the projected task — no host path).`,
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

  const board = canvas === undefined ? [] : boardSections(canvas, boardId, task);
  const rules =
    canvas === undefined ? [] : rulesInForce(canvas, boardId, task);

  // Machine-readable mirror of the prose guidance: a seat that parses only the
  // JSON briefing must carry the same board guidance as the prose. Handoff only
  // travels when the board can send the task on.
  const contract =
    canvas === undefined ? undefined : boardContractOf(canvas, boardId);
  const identity =
    canvas === undefined ? undefined : boardTitle(canvas, boardId);
  const guidanceInstructions = contract?.instructions?.trim();
  const guidanceHandling = contract?.incoming?.handling?.trim();
  const guidanceHandoff =
    canvas !== undefined && flowDestinations(canvas, boardId).length > 0
      ? contract?.outgoing?.handoff?.trim()
      : undefined;
  const guidance = {
    ...(guidanceInstructions ? { instructions: guidanceInstructions } : {}),
    ...(guidanceHandling ? { handling: guidanceHandling } : {}),
    ...(guidanceHandoff ? { handoff: guidanceHandoff } : {}),
  };

  const briefing = {
    target: boardId,
    ...(identity !== undefined
      ? {
          board: {
            name: identity.name,
          },
        }
      : {}),
    taskId: task.id,
    state: task.state,
    brief,
    ...(criteria !== undefined ? { finishCriteria: criteria } : {}),
    ...(task.metadata !== undefined ? { metadata: task.metadata } : {}),
    mediaCount: media.length,
    ...(rules.length > 0
      ? {
          rules: rules.map((entry) => ({
            id: entry.rule.id,
            text: entry.rule.text,
            from: provenanceOf(entry),
          })),
        }
      : {}),
    ...(canvas !== undefined && flowDestinations(canvas, boardId).length > 0
      ? {
          next: flowDestinations(canvas, boardId).map((nodeId) => ({
            nodeId,
            name: boardName(canvas, nodeId),
          })),
        }
      : {}),
    ...(Object.keys(guidance).length > 0 ? { guidance } : {}),
    ...(taskEpoch(task) > 0 ? { epoch: taskEpoch(task) } : {}),
  };

  return [
    `Task claimed ${task.id}: ${brief}`,
    "",
    "This task is claimed by you.",
    `Board target (Tasks node id): ${boardId}`,
    `Task id: ${task.id}`,
    "",
    "CLI contract (copy-paste JSON — do not invent flags):",
    `- orient:  junto onboard`,
    `- list:    ${listExample}`,
    `- progress:${workingExample}`,
    `- complete:${updateExample}`,
    '- blocked: junto blocked "<what you need>" --detail "<what you tried>"',
    "",
    "You can start from the task briefing below; list is optional once you have target + task id.",
    "",
    "Operating contract for this task:",
    "- PLAN — one line: what you will change and how you will verify it.",
    "- VERIFY — before completed, check every finish criterion (above). The server enforces them; a rejection names the missing pieces.",
    "- EVIDENCE — attach completionEvidence: artifacts published with task linkage + real git SHAs, and a claim for every rule in force (below).",
    "- CHECKS — before sending on, run the checks and submit them before you complete.",
    "- BLOCK — if you cannot proceed, junto blocked with what you tried and what you need, set the task to input-required, and stop. Do not mark failed unless the task is truly dead.",
    "",
    ...mediaNote,
    ...criteriaNote,
    ...board,
    "",
    "--- task briefing (JSON) ---",
    JSON.stringify(briefing, null, 2),
  ].join("\n");
};
