/**
 * Agent profiles, pure: capture a profile from an agent seat, and mint a
 * fresh seat from one. No state, no IPC; callers supply the node, the saved
 * portrait and guidance, and where the seat lands. Squads place their members
 * through the same two functions.
 *
 * Capture
 * - Only an agent seat with a managed harness launch can be captured.
 * - The harness dials (model, effort, mode, permission, Hermes profile) are
 *   read back from the launch argv, the document's single record of them.
 * - The portrait is captured fully resolved (identity genome plus the
 *   operator's override), because a fresh node id would draw a new face.
 * - The folder, host, canvas, and connections are not part of a profile: they
 *   belong to wherever the profile is placed.
 *
 * Place
 * - A profile whose harness this build does not know or ships disabled is
 *   refused, never placed as something adjacent.
 * - The seat gets a new node id, binding id, and (when its harness pins one)
 *   session id from the ordinary seat factory.
 */
import type { CanvasNode, TextNode } from "@shared/canvas";
import {
  cleanProfileName,
  decodeProfileBody,
  type AgentProfileBody,
} from "@shared/agent-profiles";
import { portraitCharacter, type PortraitConfig } from "@shared/agent-portrait";
import { normalizePortraitOverride, type PortraitOverride } from "@shared/portrait-overrides";
import type { SeatGuidance } from "@shared/seat-guidance";
import { recoverDocumentLaunchChoices } from "@shared/launch-choices";
import { isHarnessId, type HarnessId } from "@shared/managed-terminal-templates";
import { managedHarnessEnabled } from "@shared/features";
import { makeManagedAgentNode } from "./node-factories";

export type ProfileCaptureSources = {
  /** Saved portrait override for a seat, by node id. */
  readonly portraitOf?: (nodeId: string) => PortraitConfig | undefined;
  /** Saved soul and instructions for a seat, by node id. */
  readonly guidanceOf?: (nodeId: string) => SeatGuidance | undefined;
};

/** An agent seat a profile can be captured from. */
export const isProfileSeat = (node: CanvasNode | undefined): node is TextNode =>
  node !== undefined &&
  node.type === "text" &&
  node.ether?.entity?.kind === "agent" &&
  typeof node.ether.terminal?.harness === "string" &&
  node.ether.terminal.launch?.kind === "harness";

/** The seat's name: its terminal label, else the first line of its text. */
export const seatName = (node: TextNode): string =>
  cleanProfileName(node.ether?.terminal?.label) ??
  cleanProfileName(node.text.split("\n")[0]) ??
  "agent";

/** Every portrait trait, resolved, so a new id draws the same face. */
export const resolvedPortrait = (nodeId: string, override?: PortraitConfig): PortraitOverride | undefined =>
  normalizePortraitOverride(portraitCharacter(nodeId, override)) ?? undefined;

/** Capture one seat as a profile body; null when it is not a managed agent seat. */
export const profileBodyFromSeat = (
  node: CanvasNode | undefined,
  sources: ProfileCaptureSources = {},
): AgentProfileBody | null => {
  if (!isProfileSeat(node)) return null;
  const terminal = node.ether!.terminal!;
  const harness = terminal.harness!;
  const choices = isHarnessId(harness) ? recoverDocumentLaunchChoices(harness, terminal.launch) : {};
  const guidance = sources.guidanceOf?.(node.id);
  return decodeProfileBody({
    name: seatName(node),
    harness,
    ...(choices.model ? { model: choices.model } : {}),
    ...(choices.effort ? { effort: choices.effort } : {}),
    ...(choices.mode ? { mode: choices.mode } : {}),
    ...(choices.permissionMode ? { permissionMode: choices.permissionMode } : {}),
    ...(choices.profile ? { harnessProfile: choices.profile } : {}),
    portrait: resolvedPortrait(node.id, sources.portraitOf?.(node.id)),
    ...(guidance?.soul ? { soul: guidance.soul } : {}),
    ...(guidance?.instructions ? { instructions: guidance.instructions } : {}),
  });
};

export type ProfileSeatWhere = {
  readonly x: number;
  readonly y: number;
  /** Enrolled host the seat runs on. */
  readonly host: string;
  /** Hermes routing prefix, when the host declares a distinct key. */
  readonly agentHost?: string;
  /** Working folder; without one the seat cannot start. */
  readonly cwd?: string;
};

export type ProfileSeat =
  | {
      readonly ok: true;
      readonly node: TextNode;
      /** Portrait override to save for the new seat. */
      readonly portrait?: PortraitOverride;
      /** Soul and instructions to save for the new seat. */
      readonly guidance?: SeatGuidance;
    }
  | { readonly ok: false; readonly message: string };

/** The harness this build can seat for a profile, or undefined. */
export const placeableHarness = (body: AgentProfileBody): HarnessId | undefined =>
  isHarnessId(body.harness) && managedHarnessEnabled(body.harness) ? body.harness : undefined;

/** A fresh seat for one profile at a point, with what to save beside it. */
export const seatFromProfile = (body: AgentProfileBody, where: ProfileSeatWhere): ProfileSeat => {
  const harness = placeableHarness(body);
  if (harness === undefined) {
    return { ok: false, message: `${body.name}: this build cannot run the ${body.harness} harness` };
  }
  const node = makeManagedAgentNode(where.x, where.y, {
    harness,
    host: where.host,
    ...(where.agentHost ? { agentHost: where.agentHost } : {}),
    ...(body.harnessProfile ? { profile: body.harnessProfile } : {}),
    ...(body.model ? { model: body.model } : {}),
    ...(body.effort ? { effort: body.effort } : {}),
    ...(body.mode ? { mode: body.mode } : {}),
    ...(body.permissionMode ? { permissionMode: body.permissionMode } : {}),
    ...(where.cwd ? { cwd: where.cwd } : {}),
    label: body.name,
  });
  const guidance: SeatGuidance = {
    ...(body.soul ? { soul: body.soul } : {}),
    ...(body.instructions ? { instructions: body.instructions } : {}),
  };
  return {
    ok: true,
    node,
    ...(body.portrait ? { portrait: body.portrait } : {}),
    ...(guidance.soul || guidance.instructions ? { guidance } : {}),
  };
};
