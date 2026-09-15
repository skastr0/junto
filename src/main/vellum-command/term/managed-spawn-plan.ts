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
  type ManagedSpawnIntent,
} from "@shared/managed-terminal-launch";
import {
  isHarnessId,
  templateFor,
  type HarnessId,
} from "@shared/managed-terminal-templates";
import type { TerminalLaunch } from "@shared/terminal";
import { usableVellumCommandHome } from "@shared/vellum-home";
import {
  planManagedInjection,
  targetsBySlot,
  type InjectionConnectedTarget,
} from "@shared/managed-terminal-injection";
import { writeAgentRulesDir } from "./agent-rules-dir";
import { writeAgentFileSpec } from "./agent-file-spec";
import {
  isPinSessionHarness,
  shouldResumeHarnessSession,
} from "./session-existence";
import { connectedCapabilities, containingRegion } from "../work/authz";

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

/** True when the live compiled grants have an actionable doctrine section. */
export const nodeHasActionableFactoryEdge = (
  doc: CanvasDoc,
  nodeId: string,
): boolean => targetsBySlot(connectedTargetsForNode(doc, nodeId)).size > 0;

export const connectedTargetsForNode = (
  doc: CanvasDoc,
  nodeId: string,
): ReadonlyArray<InjectionConnectedTarget> =>
  connectedCapabilities(doc, nodeId).map((target) => ({
    id: target.id,
    ...(target.kind ? { kind: target.kind } : {}),
    ...(target.title ? { summary: target.title } : {}),
    ports: target.grants,
  }));

export type SpawnPlanInput = {
  readonly doc?: CanvasDoc;
  readonly nodeId?: string;
  readonly harness?: string;
  readonly documentLaunch?: TerminalLaunch;
  readonly agentKey?: string;
  readonly profile?: string;
  /** Hermes provider — travels with the model on every cold wake. */
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  /** Named agent mode (Amp `-m low|medium|high|ultra`). */
  readonly mode?: string;
  readonly permissionMode?: string;
  readonly cwd?: string;
  /** Pin/resume session id from ether.terminal.sessionId. */
  readonly sessionId?: string;
  /** When true, treat sessionId as resume rather than first pin. */
  readonly resume?: boolean;
  /** Pure CC-compiled seat context; safe to finalize on another host. */
  readonly injection?: ManagedSpawnIntent["injection"];
};

const sessionIdForSpawn = (input: SpawnPlanInput): string | undefined => {
  const explicit = input.sessionId?.trim();
  if (explicit) return explicit;
  if (!input.doc || !input.nodeId) return undefined;
  return input.doc.nodes
    .find((node) => node.id === input.nodeId)
    ?.ether?.terminal?.sessionId?.trim() || undefined;
};

const injectionForSpawn = (
  input: SpawnPlanInput,
): ManagedSpawnIntent["injection"] => {
  if (input.injection) return input.injection;
  const seatBound = Boolean(input.doc && input.nodeId);
  const connectedTargets =
    input.doc && input.nodeId
      ? connectedTargetsForNode(input.doc, input.nodeId)
      : [];
  const connected = targetsBySlot(connectedTargets).size > 0;
  return {
    seatBound,
    connected,
    ...(input.nodeId ? { seatRef: input.nodeId } : {}),
    ...(input.doc && input.nodeId ? { connectedTargets } : {}),
    ...(input.doc && input.nodeId
      ? (() => {
          const region = containingRegion(input.doc, input.nodeId);
          return region?.instruction
            ? { regionInstruction: region.instruction }
            : {};
        })()
      : {}),
  };
};

/** Compile topology/session request without consulting this machine's disk. */
export const makeManagedSpawnIntent = (
  input: SpawnPlanInput,
): ManagedSpawnIntent => {
  const sessionId = sessionIdForSpawn(input);
  return {
    ...(input.documentLaunch
      ? { documentLaunch: input.documentLaunch }
      : {}),
    ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}),
    ...(sessionId ? { sessionId } : {}),
    resumeRequested: input.resume === true,
    injection: injectionForSpawn(input),
    ...(input.profile ? { profile: input.profile } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.permissionMode
      ? { permissionMode: input.permissionMode }
      : {}),
  };
};

type RecoveredLaunchChoices = Pick<
  ManagedLaunchChoices,
  "model" | "effort" | "mode" | "permissionMode" | "profile" | "provider"
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

  // Named agent mode (Amp `-m`). Recovered like every other template-owned
  // flag so a wake or restart relaunches the seat in the mode it was created
  // with, rather than silently dropping back to the harness default.
  const mode = valueForFlag(argv, spec.modeFlag);

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
      // Provider is recovered next to the model on purpose: a Hermes resume
      // that carries one without the other reverts the model silently, and the
      // only place the revert shows is a session_model_usage row.
      return {
        ...(valueForFlag(argv, spec.profileFlag)
          ? { profile: valueForFlag(argv, spec.profileFlag) }
          : {}),
        ...(valueForFlag(argv, spec.modelFlag) ? { model: valueForFlag(argv, spec.modelFlag) } : {}),
        ...(valueForFlag(argv, spec.providerFlag)
          ? { provider: valueForFlag(argv, spec.providerFlag) }
          : {}),
        ...(permissionMode ? { permissionMode } : {}),
      };
    // pi / prime-agent / kimi / muse / devin: generic template slots
    // (model/effort/permission from the template's own flags; no profile).
    default:
      return {
        ...(valueForFlag(argv, spec.modelFlag) ? { model: valueForFlag(argv, spec.modelFlag) } : {}),
        ...(effort ? { effort } : {}),
        ...(mode ? { mode } : {}),
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
 * Materialize the app-owned rules directory for a harness whose Tier-A carrier
 * is a directory rather than a flag string (agy `--add-dir`).
 *
 * Returns undefined for every other harness, for an unarmed injection, and for
 * a failed write — the resolver treats a missing directory as "no carrier" and
 * falls back to typed delivery, so a seat is never launched un-briefed.
 */
const rulesDirForSpawn = (
  harness: HarnessId,
  injection: ManagedSpawnIntent["injection"],
): string | undefined => {
  if (!templateFor(harness).argvSpec.rulesDirFlag) return undefined;
  const seatRef = injection.seatRef?.trim();
  if (!seatRef) return undefined;
  const plan = planManagedInjection(harness, injection);
  if (!plan.inject) return undefined;
  const doctrine = plan.systemPrompt ?? plan.firstTypedMessage;
  if (!doctrine) return undefined;
  return writeAgentRulesDir({ seatRef, doctrine });
};

/**
 * Materialize the app-owned agent definition for a harness whose Tier-A carrier
 * is a FILE rather than a flag string (kimi `--agent-file`).
 *
 * Same shape and same failure posture as the rules directory above: undefined
 * for every other harness, for an unarmed injection, and for a failed write —
 * the resolver then falls back to typed delivery, so a seat is never launched
 * un-briefed. A harness that also owns a system-prompt flag (grok `--rules` +
 * `--agent`) is excluded: its agent file is the caller's choice, not doctrine.
 */
const agentFileForSpawn = (
  harness: HarnessId,
  injection: ManagedSpawnIntent["injection"],
): string | undefined => {
  const spec = templateFor(harness).argvSpec;
  if (!spec.agentFlag || spec.systemPromptFlag || spec.rulesDirFlag) {
    return undefined;
  }
  const seatRef = injection.seatRef?.trim();
  if (!seatRef) return undefined;
  const plan = planManagedInjection(harness, injection);
  if (!plan.inject) return undefined;
  const doctrine = plan.systemPrompt ?? plan.firstTypedMessage;
  if (!doctrine) return undefined;
  return writeAgentFileSpec({ seatRef, doctrine });
};

/**
 * Build spawn plan. When harness is known and doc shows work edges, inject
 * doctrine (Tier A argv / Tier B firstTyped). Unconnected → silence.
 */
export const planManagedSpawn = (input: SpawnPlanInput): ManagedLaunchPlan | undefined => {
  const harnessRaw = input.harness?.trim();
  if (!harnessRaw || !isHarnessId(harnessRaw)) return undefined;
  const harness: HarnessId = harnessRaw;

  const injection = injectionForSpawn(input);
  const sessionId = input.sessionId?.trim();
  const recovered = recoverDocumentLaunchChoices(harness, input.documentLaunch);
  const profile = input.profile ?? recovered.profile ??
    (harness === "hermes" ? profileFromAgentKey(input.agentKey) : undefined);
  const cwd =
    input.cwd?.trim() ||
    input.documentLaunch?.cwd?.trim() ||
    undefined;
  // A provisioned session (Amp) is minted BY the harness through its public
  // CLI and stored on the node, so the id itself is the proof and the resume
  // subcommand is the only launch shape there is. Probing local harness state
  // for it would mean reading Amp's private files, which this integration does
  // not do — and launching without the id would drop the seat into Amp's
  // interactive thread picker instead of the thread the node owns.
  const provisioned =
    templateFor(harness).capabilityBadges.sessionId === "provision";
  if (provisioned && !sessionId) {
    // Fail closed: no thread, no launch. Every entry point that reaches here
    // without provisioning first gets the same refusal rather than a seat on
    // the wrong thread.
    return undefined;
  }
  // For a provisioned harness `resume` means only one thing here: does the
  // thread already carry history? A thread minted for this spawn is empty, so
  // the seat still needs its Tier-B doctrine even though the launch argv is
  // the resume subcommand either way (see the resumeId choice below).
  // -r / --resume only when external harness state proves the id exists.
  // Canvas mint alone is not proof; unproven → pin/create (fail open).
  const resume = provisioned
    ? Boolean(sessionId && input.resume)
    : Boolean(sessionId && input.resume) &&
      shouldResumeHarnessSession(true, {
        harness,
        sessionId: sessionId ?? "",
        ...(cwd ? { cwd } : {}),
      });
  // Harnesses whose Tier-A carrier is a DIRECTORY (agy `--add-dir`) need the
  // doctrine on disk before argv is built. This host owns a filesystem, so it
  // writes the app-owned rules dir and hands the resolver the path; a failed
  // write returns undefined and the resolver falls back to typed delivery.
  const armedInjection = {
    ...injection,
    seatBound: injection.seatBound && !resume,
    connected: injection.connected && !resume,
  };
  const rulesDir = rulesDirForSpawn(harness, armedInjection);
  // Same for a FILE carrier (kimi `--agent-file`). A resumed seat leaves
  // `armedInjection` unarmed, so no file is written and the launch is the plain
  // `-S <id>` resume the harness accepts — `--agent-file` cannot ride there.
  const agentFile = agentFileForSpawn(harness, armedInjection);

  const choices: ManagedLaunchChoices = {
    // A resumed session already carries the doctrine in its own history.
    // The Command Center may compile the topology context, but only this
    // spawn host decides resume and therefore whether injection is armed.
    injection: armedInjection,
    ...(rulesDir ? { rulesDir } : {}),
    ...(agentFile ? { agentFile } : {}),
    ...(profile ? { profile } : {}),
    ...(input.provider ?? recovered.provider
      ? { provider: input.provider ?? recovered.provider }
      : {}),
    ...(input.model ?? recovered.model ? { model: input.model ?? recovered.model } : {}),
    ...(input.effort ?? recovered.effort ? { effort: input.effort ?? recovered.effort } : {}),
    ...(input.mode ?? recovered.mode ? { mode: input.mode ?? recovered.mode } : {}),
    ...(input.permissionMode ?? recovered.permissionMode
      ? { permissionMode: input.permissionMode ?? recovered.permissionMode }
      : {}),
    // A provisioned harness has exactly one launch shape — `threads continue
    // <id>` — whether or not the thread has history, because the id IS the
    // seat's thread. Injection arming is decided by `resume` above, not here.
    ...(sessionId && (resume || provisioned)
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
  let sessionId = sessionIdForSpawn(input);
  let resume = input.resume;

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

  const harnessId = input.harness?.trim();
  if (
    harnessId &&
    isHarnessId(harnessId) &&
    templateFor(harnessId).capabilityBadges.sessionId === "provision" &&
    !sessionId
  ) {
    // The document launch is no safer than the planned one here: its argv ends
    // at `threads continue` with no id. Refuse both.
    return { launch: undefined, plan: undefined };
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

const spawnInputForManagedIntent = (
  actor: { readonly harness: string; readonly agentKey: string },
  intent: ManagedSpawnIntent,
): SpawnPlanInput => ({
  harness: actor.harness,
  agentKey: actor.agentKey,
  documentLaunch: intent.documentLaunch,
  cwd: intent.cwd,
  sessionId: intent.sessionId,
  resume: intent.resumeRequested,
  injection: intent.injection,
  profile: intent.profile,
  provider: intent.provider,
  model: intent.model,
  effort: intent.effort,
  mode: intent.mode,
  permissionMode: intent.permissionMode,
});

/** Finalize a pure intent on the process host that owns session evidence. */
export const launchForManagedSpawnIntent = (
  actor: { readonly harness: string; readonly agentKey: string },
  intent: ManagedSpawnIntent,
): ReturnType<typeof launchForManagedSpawn> =>
  launchForManagedSpawn(spawnInputForManagedIntent(actor, intent));

/** Re-plan a failed proven resume as a fresh pin without losing seat doctrine. */
export const planFreshManagedSpawnIntent = (
  actor: { readonly harness: string; readonly agentKey: string },
  intent: ManagedSpawnIntent,
  sessionId: string,
): ManagedLaunchPlan | undefined =>
  planManagedSpawn({
    ...spawnInputForManagedIntent(actor, intent),
    sessionId,
    resume: false,
  });

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
    ...(recovered.provider ? { provider: recovered.provider } : {}),
    ...(recovered.model ? { model: recovered.model } : {}),
    ...(recovered.effort ? { effort: recovered.effort } : {}),
    ...(recovered.permissionMode
      ? { permissionMode: recovered.permissionMode }
      : {}),
    ...(cwd ? { cwd } : {}),
  });
};
