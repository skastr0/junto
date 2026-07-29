import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { LOCAL_HOST_ID } from "@shared/remote-hosts";
import { resolveRegionCwd } from "@shared/region-defaults";
import { templateFor } from "@shared/managed-terminal-templates";
import { state$ } from "../../lib/state";
import { getVellumApi } from "../../lib/vellum-api";
import { FocusSurface } from "../FocusSurface";
import {
  Button,
  FieldLabel,
  IconButton,
  OverlayHeader,
  Select,
} from "../ui";
import {
  actorHostChoicesFromEnrollment,
  type AgentConfigurationChoices,
  type AgentHostChoice,
  type AgentSpawnChoices,
} from "./AgentCascadeMenu";
import { HostDirectoryPicker } from "./HostDirectoryPicker";

export type AgentLocationRequest = {
  readonly choices: AgentConfigurationChoices;
  readonly position: { readonly x: number; readonly y: number };
};

const AGENT_SIZE = { width: 260, height: 110 } as const;

export function AgentLocationModal({
  request,
  onClose,
  onCreate,
}: {
  readonly request: AgentLocationRequest;
  readonly onClose: () => void;
  readonly onCreate: (choices: AgentSpawnChoices & { readonly cwd: string }) => void;
}) {
  const configuredHostId =
    state$.settings.station.hostId.peek() || LOCAL_HOST_ID;
  const configuredAgentHostId =
    state$.settings.station.agentHostId.peek() || configuredHostId;
  const configured = useMemo<AgentHostChoice>(
    () => ({
      id: configuredHostId,
      agentHost: configuredAgentHostId,
      label: configuredHostId,
    }),
    [configuredAgentHostId, configuredHostId],
  );
  const [hosts, setHosts] = useState<ReadonlyArray<AgentHostChoice>>([
    configured,
  ]);
  const [hostId, setHostId] = useState(configured.id);
  const [pathSeed, setPathSeed] = useState(() =>
    resolveRegionCwd(
      state$.doc.peek(),
      request.position.x + AGENT_SIZE.width / 2,
      request.position.y + AGENT_SIZE.height / 2,
      configured.id,
    ) ?? "~"
  );
  const [selectedPath, setSelectedPath] = useState("");

  useEffect(() => {
    let live = true;
    void getVellumApi()
      ?.hostsList?.()
      .then((result) => {
        if (!live || !result.ok || !result.hosts) return;
        const next = actorHostChoicesFromEnrollment(result.hosts, configured);
        setHosts(next);
        setHostId((current) =>
          next.some((host) => host.id === current) ? current : configured.id
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [configured]);

  const selectHost = (nextHostId: string) => {
    setHostId(nextHostId);
    setSelectedPath("");
    setPathSeed(
      resolveRegionCwd(
        state$.doc.peek(),
        request.position.x + AGENT_SIZE.width / 2,
        request.position.y + AGENT_SIZE.height / 2,
        nextHostId,
      ) ?? "~",
    );
  };

  const selectedHost =
    hosts.find((host) => host.id === hostId) ?? configured;
  const description = [
    request.choices.profile,
    request.choices.model,
    request.choices.effort,
  ].filter(Boolean).join(" · ");

  return (
    <FocusSurface
      measure="form"
      height="fit"
      layer="detail"
      label="Choose agent location"
      onClose={onClose}
    >
      <OverlayHeader
        eyebrow={`agent · ${templateFor(request.choices.harness).displayName}`}
        title="Choose host and folder"
        status={description || "template defaults"}
        actions={
          <IconButton aria-label="Close agent location" title="Close" onClick={onClose}>
            <X size={14} />
          </IconButton>
        }
      />

      <div className="grid gap-4 p-4">
        <FieldLabel>
          Host
          <Select
            aria-label="Agent host"
            value={hostId}
            options={hosts.map((host) => ({
              value: host.id,
              label: host.label,
            }))}
            onChange={selectHost}
          />
        </FieldLabel>

        <FieldLabel>
          Starting folder
          <HostDirectoryPicker
            key={`${hostId}\0${pathSeed}`}
            hostId={hostId}
            initialPath={pathSeed}
            onSelect={setSelectedPath}
          />
        </FieldLabel>

        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="subtle" onClick={onClose}>
            cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={!selectedPath}
            onClick={() =>
              onCreate({
                ...request.choices,
                host: selectedHost.id,
                agentHost: selectedHost.agentHost,
                cwd: selectedPath,
              })
            }
          >
            create agent
          </Button>
        </div>
      </div>
    </FocusSurface>
  );
}
