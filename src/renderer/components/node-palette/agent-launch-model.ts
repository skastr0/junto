import type { HostsOpResult } from "@shared/ipc";
import {
  LOCAL_HOST_ID,
  TERMINAL_HOST_CAPABILITY,
} from "@shared/remote-hosts";
import { HERMES_INTEGRATION_ENABLED } from "@shared/features";
import type { HarnessId } from "@shared/managed-terminal-templates";

/** Palette / re-seat harness configuration (model, effort, hermes profile). */
export type AgentConfigurationChoices = {
  readonly harness: HarnessId;
  readonly profile?: string;
  readonly model?: string;
  readonly effort?: string;
};

export type AgentHostChoice = {
  readonly id: string;
  readonly agentHost: string;
  readonly label: string;
};

type EnrolledHost = NonNullable<HostsOpResult["hosts"]>[number];

/** Exact enrolled choices for creating one actor seat. */
export const actorHostChoicesFromEnrollment = (
  hosts: ReadonlyArray<EnrolledHost>,
  configured: AgentHostChoice,
): ReadonlyArray<AgentHostChoice> => {
  const seen = new Set<string>();
  const enrolled = hosts
    .filter((host) => {
      if (
        seen.has(host.id) ||
        !host.capabilities.includes(TERMINAL_HOST_CAPABILITY)
      ) {
        return false;
      }
      seen.add(host.id);
      return true;
    })
    .map((host) => ({
      id: host.id,
      agentHost: HERMES_INTEGRATION_ENABLED
        ? host.hermesId ?? host.id
        : host.id,
      label:
        host.kind === "remote"
          ? `${host.label || host.id} (remote)`
          : host.label || host.id,
    }))
    .sort((left, right) => {
      if (left.id === LOCAL_HOST_ID) return -1;
      if (right.id === LOCAL_HOST_ID) return 1;
      return left.label.localeCompare(right.label);
    });
  return enrolled.some((host) => host.id === configured.id)
    ? enrolled
    : [configured, ...enrolled];
};
