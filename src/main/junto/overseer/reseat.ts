import { randomUUID } from "node:crypto";
import { ulid } from "ulid";
import type { TextNode, EtherTerminalLaunch } from "@shared/canvas";
import type { HarnessId } from "@shared/managed-terminal-templates";
import { templateFor } from "@shared/managed-terminal-templates";
import { managedHarnessEnabled } from "@shared/features";
import { resolveManagedLaunch } from "@shared/managed-terminal-launch";
import { isValidStationHostId } from "@shared/station";

export type OverseerReseatOptions = {
  readonly harness: HarnessId;
  readonly host: string;
  readonly agentHost?: string;
  readonly profile?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly mode?: string;
  readonly permissionMode?: string;
  readonly cwd?: string;
  readonly label?: string;
};

const requireHostId = (value: string): string => {
  const host = value.trim();
  if (!isValidStationHostId(host)) {
    throw new Error(`invalid station host id: ${JSON.stringify(value)}`);
  }
  return host;
};

const launchChoices = (options: OverseerReseatOptions, sessionId?: string) => ({
  ...(options.profile ? { profile: options.profile } : {}),
  ...(options.model ? { model: options.model } : {}),
  ...(options.effort ? { effort: options.effort } : {}),
  ...(options.mode ? { mode: options.mode } : {}),
  ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
  ...(options.cwd ? { cwd: options.cwd } : {}),
  ...(sessionId ? { sessionId } : {}),
  injection: { seatBound: false, connected: false },
});

/**
 * Main-owned reseat of a managed agent onto a new harness (fresh binding).
 * Mirrors renderer `reseatManagedAgentNode` so native never imports renderer.
 */
export const reseatManagedAgentNode = (
  node: TextNode,
  options: OverseerReseatOptions,
): TextNode => {
  if (node.ether?.entity?.kind !== "agent") {
    throw new Error("reseatManagedAgentNode requires an agent node");
  }
  if (!managedHarnessEnabled(options.harness)) {
    throw new Error(`managed harness ${options.harness} is disabled in this build`);
  }
  const host = requireHostId(options.host);
  const agentHost = requireHostId(options.agentHost ?? host);
  const template = templateFor(options.harness);
  const full = resolveManagedLaunch(options.harness, launchChoices(options), {});
  const launch: EtherTerminalLaunch = {
    kind: "harness",
    argv: full.argv,
    ...(full.cwd ? { cwd: full.cwd } : {}),
  };
  const pinSession =
    template.capabilityBadges.sessionId === "pin" ? randomUUID() : undefined;
  const launchWithSession: EtherTerminalLaunch = pinSession
    ? (() => {
        const pinned = resolveManagedLaunch(
          options.harness,
          launchChoices(options, pinSession),
          {},
        );
        return {
          kind: "harness" as const,
          argv: pinned.argv,
          ...(pinned.cwd ? { cwd: pinned.cwd } : {}),
        };
      })()
    : launch;
  const agentKey =
    options.harness === "hermes" && options.profile
      ? `${agentHost}:${options.profile}`
      : `${agentHost}:${options.harness}`;
  const parts = [
    template.displayName,
    options.profile,
    options.model,
    options.effort,
    options.mode,
  ].filter((part): part is string => Boolean(part && part.trim()));
  const label = options.label?.trim() || parts.join(" - ");
  return {
    ...node,
    text: label,
    ether: {
      entity: { kind: "agent", name: agentKey },
      host,
      terminal: {
        bindingId: ulid(),
        label,
        harness: options.harness,
        launch: launchWithSession,
        ...(pinSession ? { sessionId: pinSession } : {}),
      },
    },
  };
};
