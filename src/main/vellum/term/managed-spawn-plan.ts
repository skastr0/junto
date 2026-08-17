/**
 * Re-plan managed launch at spawn time from live canvas edges.
 * Document may store unconnected argv (silence at authoring); spawn applies
 * Tier A flags / arms Tier B firstTyped when edges connect the seat.
 */

import { randomUUID } from "node:crypto";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import {
  resolveManagedLaunchPlan,
  type ManagedLaunchChoices,
  type ManagedLaunchPlan,
} from "@shared/managed-terminal-launch";
import {
  isHarnessId,
  templateFor,
  type HarnessId,
} from "@shared/managed-terminal-templates";
import type { TerminalLaunch } from "@shared/terminal";
import { usableVellumCommandHome } from "@shared/vellum-home";
import {
  isPinSessionHarness,
  shouldResumeHarnessSession,
} from "./session-existence";
import { containingRegion } from "../work/authz";

/**
 * Official `bun run dev` sets `VELLUM_COMMAND_HOME` (e.g. ~/.vellum-command-dev) while leaving
 * `HOME` alone so harness state still lives under ~/.grok / ~/.claude.
 * Seeded canvases therefore carry production session pins that may already be
 * owned by a live production seat. Resuming them in the isolated process
 * yields a dead/black TUI — refuse shared resume and pin a fresh id instead.
 */
export const shouldAvoidSharedHarnessResume = (
  vellumHomeEnv: string | undefined = process.env.VELLUM_COMMAND_HOME,
): boolean => usableVellumCommandHome(vellumHomeEnv) !== undefined;

// Capability sinks that make an actor seat operational. Browser automation is
// a factory tool even though it uses the browser-control socket rather than the
// work-control socket, so a page-only seat still receives the tool briefing.
const ACTIONABLE_FACTORY_KINDS = new Set([
  "task",
  "tasks",
  "requests",
  "request",
  "artifacts",
  "page",
]);

/** True when the node has an undirected edge to an actionable factory sink. */
export const nodeHasActionableFactoryEdge = (
  doc: CanvasDoc,
  nodeId: string,
): boolean => {
  const neighbors = new Set<string>();
  for (const edge of doc.edges) {
    if (edge.fromNode === nodeId) neighbors.add(edge.toNode);
    if (edge.toNode === nodeId) neighbors.add(edge.fromNode);
  }
  for (const id of neighbors) {
    const n = doc.nodes.find((x) => x.id === id);
    const kind = n?.ether?.entity?.kind;
    if (kind && ACTIONABLE_FACTORY_KINDS.has(kind)) return true;
  }
  return false;
};

export const connectedTargetsForNode = (
  doc: CanvasDoc,
  nodeId: string,
): ReadonlyArray<{ id: string; kind?: string; summary?: string }> => {
  const neighbors = new Set<string>();
  for (const edge of doc.edges) {
    if (edge.fromNode === nodeId) neighbors.add(edge.toNode);
    if (edge.toNode === nodeId) neighbors.add(edge.fromNode);
  }
  const out: Array<{ id: string; kind?: string; summary?: string }> = [];
  for (const id of neighbors) {
    const n = doc.nodes.find((x) => x.id === id);
    if (!n) continue;
    const kind = n.ether?.entity?.kind;
    const summary =
      n.type === "text" ? n.text.split("\n")[0]?.trim() : undefined;
    out.push({
      id,
      ...(kind ? { kind } : {}),
      ...(summary ? { summary } : {}),
    });
  }
  return out;
};

export type SpawnPlanInput = {
  readonly doc?: CanvasDoc;
  readonly nodeId?: string;
  readonly harness?: string;
  readonly documentLaunch?: TerminalLaunch;
  readonly agentKey?: string;
  readonly profile?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly permissionMode?: string;
  readonly cwd?: string;
  /** Pin/resume session id from ether.terminal.sessionId. */
  readonly sessionId?: string;
  /** When true, treat sessionId as resume rather than first pin. */
  readonly resume?: boolean;
};

type RecoveredLaunchChoices = Pick<
  ManagedLaunchChoices,
  "model" | "effort" | "permissionMode" | "profile"
>;

const valueForFlag = (
  argv: ReadonlyArray<string>,
  flag: string | undefined,
): string | undefined => {
  if (!flag) return undefined;
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    const token = argv[i];
    if (token === flag) {
      const value = argv[i + 1]?.trim();
      if (value && value.length > 0) return value;
      continue;
    }
    const inline = `${flag}=`;
    if (token.startsWith(inline)) {
      const value = token.slice(inline.length).trim();
      if (value.length > 0) return value;
    }
  }
  return undefined;
};

const parseEffortConfig = (argvValue: string | undefined, key: string): string | undefined => {
  if (!argvValue) return undefined;
  const match = argvValue.match(new RegExp(`^${key}=(?:\"([^\"]+)\"|(.+))$`));
  return match?.[1] ?? match?.[2] ?? undefined;
};

/**
 * Recover durable picker selections from the authorial harness argv.
 *
 * Launch argv is the document's single representation of picker choices; this
 * deliberately reads only template-owned flags, then lets the current session
 * and edge-aware injection be rebuilt by resolveManagedLaunchPlan.
 */
const recoverDocumentLaunchChoices = (
  harness: HarnessId,
  launch: TerminalLaunch | undefined,
): RecoveredLaunchChoices => {
  if (launch?.kind !== "harness" || !launch.argv) return {};

  const argv = launch.argv;
  const spec = templateFor(harness).argvSpec;

  const effort = spec.effortConfigKey
    ? parseEffortConfig(valueForFlag(argv, spec.effortFlag), spec.effortConfigKey)
    : valueForFlag(argv, spec.effortFlag);

  const permissionMode = spec.permissionModeFlag === "--yolo"
    ? (argv.includes("--yolo") ? "yolo" : undefined)
    : valueForFlag(argv, spec.permissionModeFlag);

  switch (harness) {
    case "claude":
      return {
        ...(valueForFlag(argv, spec.modelFlag) ? { model: valueForFlag(argv, spec.modelFlag) } : {}),
        ...(effort ? { effort } : {}),
        ...(permissionMode ? { permissionMode } : {}),
      };
    case "codex": {
      const effortArg = valueForFlag(argv, "-c");
      const codexEffort = effortArg
        ? parseEffortConfig(effortArg, spec.effortConfigKey ?? "model_reasoning_effort")
        : undefined;
      return {
        ...(valueForFlag(argv, spec.modelFlag) ? { model: valueForFlag(argv, spec.modelFlag) } : {}),
        ...(codexEffort ? { effort: codexEffort } : {}),
        ...(permissionMode ? { permissionMode } : {}),
      };
    }
    case "grok":
      return {
        ...(valueForFlag(argv, spec.modelFlag) ? { model: valueForFlag(argv, spec.modelFlag) } : {}),
        ...(effort
          ? { effort }
          : {}),
        ...(permissionMode ? { permissionMode } : {}),
      };
    case "hermes":
      return {
        ...(valueForFlag(argv, spec.profileFlag)
          ? { profile: valueForFlag(argv, spec.profileFlag) }
          : {}),
        ...(valueForFlag(argv, spec.modelFlag) ? { model: valueForFlag(argv, spec.modelFlag) } : {}),
        ...(permissionMode ? { permissionMode } : {}),
      };
    // pi / prime-agent / kimi / muse / devin: generic template slots
    // (model/effort/permission from the template's own flags; no profile).
    default:
      return {
        ...(valueForFlag(argv, spec.modelFlag) ? { model: valueForFlag(argv, spec.modelFlag) } : {}),
        ...(effort ? { effort } : {}),
        ...(permissionMode ? { permissionMode } : {}),
      };
  }
};

const profileFromAgentKey = (agentKey: string | undefined): string | undefined => {
  const separator = agentKey?.indexOf(":") ?? -1;
  const profile = separator >= 0 ? agentKey?.slice(separator + 1).trim() : undefined;
  // `${host}:hermes` is the no-profile actor key minted by the node factory.
  return profile && profile !== "hermes" ? profile : undefined;
};

/**
 * Build spawn plan. When harness is known and doc shows work edges, inject
 * doctrine (Tier A argv / Tier B firstTyped). Unconnected → silence.
 */
export const planManagedSpawn = (input: SpawnPlanInput): ManagedLaunchPlan | undefined => {
  const harnessRaw = input.harness?.trim();
  if (!harnessRaw || !isHarnessId(harnessRaw)) return undefined;
  const harness: HarnessId = harnessRaw;

  const connected =
    input.doc && input.nodeId
      ? nodeHasActionableFactoryEdge(input.doc, input.nodeId)
      : false;

  const sessionId = input.sessionId?.trim();
  const recovered = recoverDocumentLaunchChoices(harness, input.documentLaunch);
  const profile = input.profile ?? recovered.profile ??
    (harness === "hermes" ? profileFromAgentKey(input.agentKey) : undefined);
  const cwd =
    input.cwd?.trim() ||
    input.documentLaunch?.cwd?.trim() ||
    undefined;
  // -r / --resume only when external harness state proves the id exists.
  // Canvas mint alone is not proof; unproven → pin/create (fail open).
  const resume =
    Boolean(sessionId && input.resume) &&
    shouldResumeHarnessSession(true, {
      harness,
      sessionId: sessionId ?? "",
      ...(cwd ? { cwd } : {}),
    });
  const choices: ManagedLaunchChoices = {
    injection: {
      // A canvas seat is always seat-bound: base doctrine injects even with no
      // actionable edge; edge contracts compile in when edges connect.
      //
      // NOT on resume. A resumed session already carries the doctrine in its
      // own history from the spawn that created it, so re-injecting it adds
      // several KB of duplicate system prompt on top of a fully restored
      // context. On a long session that is enough to cross the harness's
      // auto-compaction threshold the moment it reopens, silently destroying
      // the context the operator reopened to keep. `onboard` remains the live
      // path for anything that changed while the seat was down.
      seatBound: Boolean(input.doc && input.nodeId) && !resume,
      connected: connected && !resume,
      ...(input.nodeId
        ? { seatRef: input.nodeId }
        : {}),
      ...(input.doc && input.nodeId
        ? { connectedTargets: connectedTargetsForNode(input.doc, input.nodeId) }
        : {}),
      // Region briefing (operator-authored instruction) travels into the ONE
      // doctrine body at spawn; onboard remains the live fallback when a
      // region appears or changes mid-session.
      ...(input.doc && input.nodeId
        ? (() => {
            const region = containingRegion(input.doc, input.nodeId);
            return region?.instruction ? { regionInstruction: region.instruction } : {};
          })()
        : {}),
    },
    ...(profile ? { profile } : {}),
    ...(input.model ?? recovered.model ? { model: input.model ?? recovered.model } : {}),
    ...(input.effort ?? recovered.effort ? { effort: input.effort ?? recovered.effort } : {}),
    ...(input.permissionMode ?? recovered.permissionMode
      ? { permissionMode: input.permissionMode ?? recovered.permissionMode }
      : {}),
    ...(sessionId && resume
      ? { resumeId: sessionId }
      : sessionId
        ? { sessionId }
        : {}),
    ...(cwd ? { cwd } : {}),
  };

  return resolveManagedLaunchPlan(harness, choices);
};

/** Prefer re-planned launch when injection applies; else document launch. */
export const launchForManagedSpawn = (
  input: SpawnPlanInput,
): {
  readonly launch: TerminalLaunch | undefined;
  readonly plan: ManagedLaunchPlan | undefined;
} => {
  // Pull sessionId from node terminal when doc+node present.
  let sessionId = input.sessionId;
  let resume = input.resume;
  if (input.doc && input.nodeId && !sessionId) {
    const node = input.doc.nodes.find((n) => n.id === input.nodeId);
    const stored = node?.ether?.terminal?.sessionId?.trim();
    if (stored) {
      sessionId = stored;
    }
  }

  // Isolated VELLUM_COMMAND_HOME (dev) shares harness homes with production. Never
  // resume a pin session that production may still own; mint a fresh pin so
  // the agent TUI actually comes up.
  const isolateShared = shouldAvoidSharedHarnessResume();
  if (isolateShared) {
    resume = false;
    const harnessRaw = input.harness?.trim();
    if (harnessRaw && isPinSessionHarness(harnessRaw)) {
      sessionId = randomUUID();
    }
  }

  const plan = planManagedSpawn({ ...input, sessionId, resume });
  if (!plan) {
    // Never fall through to a document launch that still carries -r / a
    // production session pin when we are isolating shared harness sessions.
    if (isolateShared) {
      return { launch: undefined, plan: undefined };
    }
    return { launch: input.documentLaunch, plan: undefined };
  }
  // Unconnected but may still need session pin/resume on argv.
  if (!plan.injection.inject) {
    // Prefer planned launch when session/resume flags were applied, or when
    // isolation forced a fresh pin (document argv may still embed -r).
    if (sessionId || isolateShared) return { launch: plan.launch, plan };
    return {
      launch: input.documentLaunch ?? plan.launch,
      plan,
    };
  }
  // Connected: use planned argv (Tier A flags + session).
  return { launch: plan.launch, plan };
};

export const harnessFromNode = (node: CanvasNode | undefined): string | undefined => {
  const h = node?.ether?.terminal?.harness?.trim();
  return h && h.length > 0 ? h : undefined;
};

/**
 * Fail-open after a dead resume: mint a fresh pin session id and rebuild argv
 * without `-r`/`--resume`. Caller owns any durable canvas write of the new id.
 */
export const planFreshPinSession = (input: {
  readonly harness: HarnessId;
  readonly documentLaunch?: TerminalLaunch;
  readonly agentKey?: string;
  readonly cwd?: string;
  readonly sessionId: string;
}): ManagedLaunchPlan => {
  const recovered = recoverDocumentLaunchChoices(input.harness, input.documentLaunch);
  const profile =
    recovered.profile ??
    (input.harness === "hermes" ? profileFromAgentKey(input.agentKey) : undefined);
  const cwd = input.cwd?.trim() || input.documentLaunch?.cwd?.trim() || undefined;
  return resolveManagedLaunchPlan(input.harness, {
    // Fresh-pin recovery: no seat context — detached silence.
    injection: { seatBound: false, connected: false },
    sessionId: input.sessionId,
    ...(profile ? { profile } : {}),
    ...(recovered.model ? { model: recovered.model } : {}),
    ...(recovered.effort ? { effort: recovered.effort } : {}),
    ...(recovered.permissionMode
      ? { permissionMode: recovered.permissionMode }
      : {}),
    ...(cwd ? { cwd } : {}),
  });
};
