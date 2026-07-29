import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import {
  templateFor,
  type HarnessId,
} from "@shared/managed-terminal-templates";
import type {
  HostsOpResult,
  ManagedTerminalModelOption,
  ManagedTerminalProfileOption,
} from "@shared/ipc";
import {
  LOCAL_HOST_ID,
  TERMINAL_HOST_CAPABILITY,
} from "@shared/remote-hosts";
import { getVellumApi } from "../../lib/vellum-api";

export type AgentConfigurationChoices = {
  readonly harness: HarnessId;
  readonly profile?: string;
  readonly model?: string;
  readonly effort?: string;
};

export type AgentSpawnChoices = AgentConfigurationChoices & {
  /** Enrolled placement HostId. */
  readonly host: string;
  /** Hermes routing prefix for entity.name. */
  readonly agentHost: string;
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
      agentHost: host.hermesId ?? host.id,
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

type CascadePosition =
  | { readonly top: number; readonly left: number; readonly flexDirection: "row" }
  | { readonly top: number; readonly right: number; readonly flexDirection: "row-reverse" };

const MENU_WIDTH = 184;
const MENU_GAP = 3;
const MENU_MAX_HEIGHT = 288;

const positionFor = (anchor: HTMLElement, columnCount: number): CascadePosition => {
  const rect = anchor.getBoundingClientRect();
  const width = columnCount * MENU_WIDTH + Math.max(0, columnCount - 1) * MENU_GAP;
  const roomRight = window.innerWidth - rect.right - 8;
  const top = Math.max(8, Math.min(rect.top - 5, window.innerHeight - MENU_MAX_HEIGHT - 8));
  if (roomRight >= width) {
    return { top, left: rect.right + MENU_GAP, flexDirection: "row" };
  }
  return {
    top,
    right: window.innerWidth - rect.left + MENU_GAP,
    flexDirection: "row-reverse",
  };
};

function LoadingRows() {
  return (
    <div className="agent-cascade__loading" aria-label="Loading options" role="status">
      <i />
      <i />
      <i />
    </div>
  );
}

function MenuColumn({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="agent-cascade__column" role="menu" aria-label={label} tabIndex={-1}>
      {children}
    </div>
  );
}

function CascadeItem({
  label,
  expanded,
  onEnter,
  onSelect,
}: {
  readonly label: string;
  readonly expanded?: boolean;
  readonly onEnter?: () => void;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-haspopup={expanded === undefined ? undefined : "menu"}
      aria-expanded={expanded}
      onMouseEnter={onEnter}
      onFocus={onEnter}
      onClick={onSelect}
    >
      <span>{label}</span>
      {expanded === undefined ? null : <ChevronRight size={12} aria-hidden />}
    </button>
  );
}

export function AgentCascadeMenu({
  harness,
  anchor,
  onConfigure,
  onPointerEnter,
  onPointerLeave,
}: {
  readonly harness: HarnessId;
  readonly anchor: HTMLElement;
  readonly onConfigure: (choices: AgentConfigurationChoices) => void;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
}) {
  const [models, setModels] = useState<readonly ManagedTerminalModelOption[] | null>(null);
  const [profiles, setProfiles] = useState<readonly ManagedTerminalProfileOption[] | null>(
    harness === "hermes" ? null : [],
  );
  const [enumeratedEfforts, setEnumeratedEfforts] = useState<readonly string[]>([]);
  const [activeProfile, setActiveProfile] = useState<ManagedTerminalProfileOption | null>(null);
  const [activeModel, setActiveModel] = useState<ManagedTerminalModelOption | null>(null);
  const [position, setPosition] = useState<CascadePosition>(() => positionFor(anchor, 1));

  useEffect(() => {
    let live = true;
    const api = getVellumApi();
    void api
      ?.managedTerminalModels?.(harness)
      .then((result) => {
        if (!live) return;
        setModels(result.models);
        setEnumeratedEfforts(result.efforts);
      })
      .catch(() => {
        if (live) setModels([]);
      });
    if (!api?.managedTerminalModels) setModels([]);

    if (harness === "hermes") {
      void api
        ?.managedTerminalProfiles?.()
        .then((result) => {
          if (live) setProfiles(result.profiles);
        })
        .catch(() => {
          if (live) setProfiles([]);
        });
      if (!api?.managedTerminalProfiles) setProfiles([]);
    }
    return () => {
      live = false;
    };
  }, [harness]);

  const efforts = useMemo(() => {
    if (!activeModel) return [] as readonly string[];
    if (activeModel.efforts?.length) return activeModel.efforts;
    if (enumeratedEfforts.length) return enumeratedEfforts;
    return templateFor(harness).efforts;
  }, [activeModel, enumeratedEfforts, harness]);

  const showModelColumn =
    harness !== "hermes" || (activeProfile !== null && (models === null || models.length > 0));
  const showEffortColumn = activeModel !== null && efforts.length > 0;
  const columnCount =
    1 +
    Number(showModelColumn && harness === "hermes") +
    Number(showEffortColumn);

  useLayoutEffect(() => {
    const update = () => setPosition(positionFor(anchor, columnCount));
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor, columnCount]);

  const profileChoices = profiles ?? [];
  // Hermes: pin the profile's configured model to the top of the second column
  // so hover→pick stays one glance away from "use profile default".
  const modelChoices = useMemo(() => {
    const base = models ?? [];
    if (harness !== "hermes" || !activeProfile?.model) return base;
    const pin = activeProfile.model;
    const rest = base.filter((m) => m.id !== pin);
    const pinned = base.find((m) => m.id === pin) ?? { id: pin, label: pin };
    return [pinned, ...rest];
  }, [models, harness, activeProfile]);
  const firstColumnIsLoading = harness === "hermes" ? profiles === null : models === null;
  const configure = (choices: AgentConfigurationChoices): void => {
    onConfigure(choices);
  };

  return createPortal(
    <div
      className="agent-cascade node-palette"
      style={{ position: "fixed", zIndex: 70, ...position } as CSSProperties}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      <MenuColumn label={harness === "hermes" ? "Hermes profiles" : `${templateFor(harness).displayName} models`}>
        {firstColumnIsLoading ? (
          <LoadingRows />
        ) : harness === "hermes" ? (
          profileChoices.map((profile) => {
            // Chevron only when a model column can open (loading or non-empty).
            const canExpandModels =
              models === null || modelChoices.length > 0;
            return (
              <CascadeItem
                key={profile.name}
                label={profile.name}
                expanded={
                  canExpandModels ? activeProfile?.name === profile.name : undefined
                }
                onEnter={() => {
                  setActiveProfile(profile);
                  setActiveModel(null);
                }}
                onSelect={() =>
                  configure({
                    harness,
                    profile: profile.name,
                    ...(profile.model ? { model: profile.model } : {}),
                  })
                }
              />
            );
          })
        ) : (
          modelChoices.map((model) => {
            const hasEfforts =
              (model.efforts?.length ?? 0) > 0 ||
              enumeratedEfforts.length > 0 ||
              templateFor(harness).efforts.length > 0;
            return (
              <CascadeItem
                key={model.id}
                label={model.label}
                expanded={hasEfforts ? activeModel?.id === model.id : undefined}
                onEnter={() => setActiveModel(model)}
                onSelect={() => configure({ harness, model: model.id })}
              />
            );
          })
        )}
      </MenuColumn>

      {showModelColumn && harness === "hermes" ? (
        <MenuColumn label={`${activeProfile?.name ?? "Hermes"} models`}>
          {models === null ? (
            <LoadingRows />
          ) : (
            modelChoices.map((model) => {
              const hasEfforts =
                (model.efforts?.length ?? 0) > 0 ||
                enumeratedEfforts.length > 0 ||
                templateFor(harness).efforts.length > 0;
              return (
                <CascadeItem
                  key={model.id}
                  label={model.label}
                  expanded={hasEfforts ? activeModel?.id === model.id : undefined}
                  onEnter={() => setActiveModel(model)}
                  onSelect={() =>
                    configure({
                      harness,
                      ...(activeProfile ? { profile: activeProfile.name } : {}),
                      model: model.id,
                    })
                  }
                />
              );
            })
          )}
        </MenuColumn>
      ) : null}

      {showEffortColumn ? (
        <MenuColumn label={`${activeModel.label} effort`}>
          {efforts.map((effort) => (
            <CascadeItem
              key={effort}
              label={effort}
              onSelect={() =>
                configure({
                  harness,
                  ...(activeProfile ? { profile: activeProfile.name } : {}),
                  model: activeModel.id,
                  effort,
                })
              }
            />
          ))}
        </MenuColumn>
      ) : null}
    </div>,
    document.body,
  );
}
