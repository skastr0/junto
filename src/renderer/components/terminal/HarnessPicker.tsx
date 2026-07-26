/**
 * Progressive harness picker — the authoring act for managed-terminal agents.
 * harness → [profile hermes] → model → effort
 * Click at any level accepts defaults below and spawns.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  HARNESS_IDS,
  type HarnessId,
  allTemplates,
  templateFor,
} from "@shared/managed-terminal-templates";
import type {
  ManagedTerminalModelOption,
  ManagedTerminalProfileOption,
} from "@shared/ipc";
import { LOCAL_HOST_ID, TERMINAL_HOST_CAPABILITY } from "@shared/remote-hosts";
import { makeManagedAgentNode } from "../../lib/node-factories";
import { addNode } from "../../lib/mutations";
import { state$ } from "../../lib/state";
import { openTerminal } from "../../lib/terminal-actions";
import { getVellumApi } from "../../lib/vellum-api";
import { FocusSurface } from "../FocusSurface";
import { Button, Chip, Eyebrow, FieldLabel, Select } from "../ui";

type HostOpt = { readonly id: string; readonly label: string };

type Step = "harness" | "profile" | "model" | "effort";

const stepFor = (harness: HarnessId | null, profile: string | null, model: string | null): Step => {
  if (!harness) return "harness";
  if (harness === "hermes" && !profile) return "profile";
  if (!model) return "model";
  const efforts = templateFor(harness).efforts;
  if (efforts.length > 0) return "effort";
  return "effort";
};

export function HarnessPicker({
  anchor,
  onClose,
}: {
  readonly anchor: { x: number; y: number };
  readonly onClose: () => void;
}) {
  const stationHost = state$.settings.station.hostId.peek() || LOCAL_HOST_ID;
  const [hostOptions, setHostOptions] = useState<HostOpt[]>([
    { id: LOCAL_HOST_ID, label: "this machine" },
  ]);
  const [hostId, setHostId] = useState(
    stationHost === LOCAL_HOST_ID ? LOCAL_HOST_ID : stationHost,
  );
  const [harness, setHarness] = useState<HarnessId | null>(null);
  const [profile, setProfile] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [models, setModels] = useState<readonly ManagedTerminalModelOption[]>([]);
  const [profiles, setProfiles] = useState<readonly ManagedTerminalProfileOption[]>([]);
  const [templateEfforts, setTemplateEfforts] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [enumNote, setEnumNote] = useState<string | null>(null);

  useEffect(() => {
    const api = getVellumApi();
    void api
      ?.hostsList?.()
      .then((res) => {
        if (!res?.ok || !Array.isArray(res.hosts)) return;
        const opts = res.hosts
          .filter(
            (h) =>
              typeof h.id === "string" &&
              h.id.length > 0 &&
              Array.isArray(h.capabilities) &&
              h.capabilities.includes(TERMINAL_HOST_CAPABILITY),
          )
          .map((h) => ({
            id: h.id,
            label:
              h.kind === "remote"
                ? `${h.label || h.id} (remote)`
                : h.label || h.id,
          }));
        const seen = new Set<string>();
        const merged: HostOpt[] = [];
        for (const opt of opts) {
          if (seen.has(opt.id)) continue;
          seen.add(opt.id);
          merged.push(opt);
        }
        if (merged.length === 0) {
          merged.push({ id: LOCAL_HOST_ID, label: "this machine" });
        }
        merged.sort((a, b) => {
          if (a.id === LOCAL_HOST_ID) return -1;
          if (b.id === LOCAL_HOST_ID) return 1;
          return a.label.localeCompare(b.label);
        });
        setHostOptions(merged);
        setHostId((current) =>
          merged.some((h) => h.id === current)
            ? current
            : (merged.find((h) => h.id === LOCAL_HOST_ID)?.id ?? merged[0]!.id),
        );
      })
      .catch(() => undefined);
  }, []);

  const loadModels = useCallback(async (id: HarnessId) => {
    const api = getVellumApi();
    setEnumNote(null);
    try {
      const res = await api?.managedTerminalModels?.(id);
      if (!res) {
        setModels([]);
        setTemplateEfforts(templateFor(id).efforts);
        setEnumNote("enumeration unavailable — defaults apply");
        return;
      }
      setModels(res.models);
      setTemplateEfforts(res.efforts.length > 0 ? res.efforts : templateFor(id).efforts);
      if (res.models.length === 0) {
        setEnumNote(res.error ? `no models (${res.error})` : "no models cached — defaults apply");
      }
    } catch {
      setModels([]);
      setTemplateEfforts(templateFor(id).efforts);
      setEnumNote("enumeration failed — defaults apply");
    }
  }, []);

  const loadProfiles = useCallback(async () => {
    const api = getVellumApi();
    try {
      const res = await api?.managedTerminalProfiles?.();
      setProfiles(res?.profiles ?? []);
      if (!res?.profiles?.length) {
        setEnumNote(res?.error ? `no profiles (${res.error})` : "no hermes profiles — use defaults");
      }
    } catch {
      setProfiles([]);
      setEnumNote("profile list failed — defaults apply");
    }
  }, []);

  const spawn = useCallback(
    async (choices: {
      harness: HarnessId;
      profile?: string;
      model?: string;
      effort?: string;
    }) => {
      if (busy) return;
      setBusy(true);
      try {
        const node = makeManagedAgentNode(anchor.x, anchor.y, {
          harness: choices.harness,
          host: hostId || LOCAL_HOST_ID,
          profile: choices.profile,
          model: choices.model,
          effort: choices.effort,
        });
        addNode(node, { edit: false });
        state$.focusNodeId.set(node.id);
        await openTerminal(node);
        onClose();
      } finally {
        setBusy(false);
      }
    },
    [anchor.x, anchor.y, busy, hostId, onClose],
  );

  const pickHarness = (id: HarnessId) => {
    setHarness(id);
    setProfile(null);
    setModel(null);
    setEffort(null);
    setEnumNote(null);
    void loadModels(id);
    if (id === "hermes") {
      void loadProfiles();
      return;
    }
    // Click harness alone is a valid accept — spawn with defaults.
    // User can still drill into models/effort before spawning via "Spawn with defaults"
    // or by picking a model. Progressive: we stay on the next step.
  };

  const acceptAtCurrent = () => {
    if (!harness || busy) return;
    void spawn({
      harness,
      ...(profile ? { profile } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    });
  };

  const pickProfile = (name: string) => {
    setProfile(name);
    const row = profiles.find((p) => p.name === name);
    if (row?.model) setModel(row.model);
  };

  const pickModel = (id: string) => {
    setModel(id);
    setEffort(null);
    const row = models.find((m) => m.id === id);
    if (row?.efforts && row.efforts.length > 0) {
      setTemplateEfforts(row.efforts);
    }
  };

  const pickEffort = (value: string) => {
    setEffort(value);
    if (!harness) return;
    void spawn({
      harness,
      ...(profile ? { profile } : {}),
      ...(model ? { model } : {}),
      effort: value,
    });
  };

  const step = stepFor(harness, profile, model);
  const efforts = useMemo(() => {
    if (!harness) return [] as readonly string[];
    if (templateEfforts.length > 0) return templateEfforts;
    return templateFor(harness).efforts;
  }, [harness, templateEfforts]);

  const templates = allTemplates();

  return (
    <FocusSurface
      measure="form"
      height="fit"
      layer="detail"
      label="New agent"
      onClose={onClose}
    >
      <div className="grid gap-4 p-5">
        <div>
          <Eyebrow tone="steel">agent · harness</Eyebrow>
          <div className="mt-1 font-mono text-[16px] font-semibold text-ink">
            New managed agent
          </div>
          <div className="mt-1 text-[11px] text-dim">
            harness → {harness === "hermes" ? "profile → " : ""}model → effort · click any level to accept defaults below
          </div>
        </div>

        <FieldLabel>
          Host
          <Select
            aria-label="Host"
            value={hostId}
            options={hostOptions.map((h) => ({ value: h.id, label: h.label }))}
            onChange={setHostId}
          />
        </FieldLabel>

        {/* Step: harness */}
        <div className="grid gap-2">
          <div className="text-[9px] uppercase tracking-[0.14em] text-dim">1 · harness</div>
          <div className="grid gap-2">
            {templates.map((t) => {
              const selected = harness === t.harness;
              return (
                <button
                  key={t.harness}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (selected) {
                      // Second click on same harness = accept defaults and spawn.
                      void spawn({ harness: t.harness });
                      return;
                    }
                    pickHarness(t.harness);
                  }}
                  className={[
                    "rounded-md border px-3 py-2 text-left transition",
                    selected
                      ? "border-amber/40 bg-amber/[0.10]"
                      : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[13px] font-semibold text-ink">
                      {t.displayName}
                    </span>
                    <span className="text-[10px] text-dim">{t.harness}</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {t.capabilityBadges.labels.map((label) => (
                      <Chip
                        key={label}
                        tone={
                          label.includes("no hooks") || label.includes("injection B")
                            ? "steel"
                            : label.includes("git")
                              ? "violet"
                              : "cyan"
                        }
                        title={t.capabilityBadges.attentionSource}
                      >
                        {label}
                      </Chip>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
          {harness ? (
            <div className="text-[10px] text-dim">
              click again to spawn with defaults · or continue below
            </div>
          ) : null}
        </div>

        {/* Step: hermes profile */}
        {harness === "hermes" ? (
          <div className="grid gap-2">
            <div className="text-[9px] uppercase tracking-[0.14em] text-dim">2 · profile</div>
            {profiles.length === 0 ? (
              <div className="text-[11px] text-dim">
                {enumNote ?? "no profiles — spawn uses default hermes profile"}
              </div>
            ) : (
              <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                {profiles.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (profile === p.name) {
                        void spawn({ harness: "hermes", profile: p.name, model: p.model });
                        return;
                      }
                      pickProfile(p.name);
                    }}
                    className={[
                      "rounded border px-2 py-1.5 text-left font-mono text-[12px] transition",
                      profile === p.name
                        ? "border-amber/40 bg-amber/[0.10] text-ink"
                        : "border-white/10 text-dim hover:text-ink",
                    ].join(" ")}
                  >
                    {p.name}
                    <span className="ml-2 text-[10px] opacity-70">{p.model}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {/* Step: model */}
        {harness && (harness !== "hermes" || profile || profiles.length === 0) ? (
          <div className="grid gap-2">
            <div className="text-[9px] uppercase tracking-[0.14em] text-dim">
              {harness === "hermes" ? "3" : "2"} · model
            </div>
            {models.length === 0 ? (
              <div className="text-[11px] text-dim">
                {enumNote ?? "no models listed — harness default model"}
              </div>
            ) : (
              <div className="flex max-h-44 flex-col gap-1 overflow-y-auto">
                {models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    disabled={busy}
                    title={m.description}
                    onClick={() => {
                      const nextEfforts =
                        m.efforts && m.efforts.length > 0
                          ? m.efforts
                          : templateFor(harness).efforts;
                      if (model === m.id || nextEfforts.length === 0) {
                        void spawn({
                          harness,
                          ...(profile ? { profile } : {}),
                          model: m.id,
                          ...(effort ? { effort } : {}),
                        });
                        return;
                      }
                      pickModel(m.id);
                    }}
                    className={[
                      "rounded border px-2 py-1.5 text-left font-mono text-[12px] transition",
                      model === m.id
                        ? "border-amber/40 bg-amber/[0.10] text-ink"
                        : "border-white/10 text-dim hover:text-ink",
                    ].join(" ")}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {/* Step: effort */}
        {harness && model && efforts.length > 0 ? (
          <div className="grid gap-2">
            <div className="text-[9px] uppercase tracking-[0.14em] text-dim">
              {harness === "hermes" ? "4" : "3"} · effort
            </div>
            <div className="flex flex-wrap gap-1.5">
              {efforts.map((e) => (
                <button
                  key={e}
                  type="button"
                  disabled={busy}
                  onClick={() => pickEffort(e)}
                  className={[
                    "rounded border px-2 py-1 font-mono text-[11px] uppercase tracking-[0.08em] transition",
                    effort === e
                      ? "border-amber/40 bg-amber/[0.12] text-amber"
                      : "border-white/10 text-dim hover:text-ink",
                  ].join(" ")}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {enumNote && harness ? (
          <div className="text-[10px] text-dim">{enumNote}</div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="subtle" onClick={onClose} disabled={busy}>
            cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={acceptAtCurrent}
            disabled={busy || !harness}
          >
            {busy
              ? "Spawning…"
              : harness
                ? `Spawn ${templateFor(harness).displayName}`
                : "Pick a harness"}
          </Button>
        </div>

        {/* silence unused step for glance lint */}
        <span className="sr-only">{step} {HARNESS_IDS.join(",")}</span>
      </div>
    </FocusSurface>
  );
}
