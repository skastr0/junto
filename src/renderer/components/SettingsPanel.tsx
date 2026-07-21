import { use$ } from "@legendapp/state/react";
import { RotateCcw, Settings2, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type {
  BrowserProfileInfo,
  CanvasPullResult,
  HostsConfigureRemoteResult,
  HostsOpResult,
  HostsTestResult,
  VellumBrowserApi,
} from "@shared/ipc";
import type { SettingsSectionKey } from "@shared/settings";
import { state$ } from "../lib/state";
import { closeSettings, patchSettings, resetSettings } from "../lib/settings-state";
import {
  ALERT_SFX_IDS,
  SFX_LABELS,
  playAlert,
  sfxIdToClipKey,
  type AlertSfxId,
} from "../lib/sfx";
import { DIM, HUE, INK } from "../lib/theme";
import { getVellumApi } from "../lib/vellum-api";
import { HostServeCatalog } from "./HostServeCatalog";
import "./settings-panel.css";

/** Settings sections: prefs sections + hosts (hosts is not a SettingsSectionKey). */
type PanelSection = SettingsSectionKey | "hosts";

const SECTIONS: ReadonlyArray<{ key: PanelSection; label: string; blurb: string }> = [
  { key: "station", label: "Station", blurb: "Command Center or Remote role" },
  { key: "appearance", label: "Appearance", blurb: "theme, density, motion" },
  { key: "canvas", label: "Canvas", blurb: "defaults for the portfolio field" },
  { key: "hosts", label: "Hosts", blurb: "fleet + Tailscale services" },
  { key: "audio", label: "Audio", blurb: "RTS alert SFX mute and levels" },
  { key: "kernel", label: "Kernel", blurb: "pulse retention and debug" },
  { key: "browser", label: "Browser", blurb: "surface and warm-session limits" },
  { key: "advanced", label: "Advanced", blurb: "startup and recovery prefs" },
];

type HostRow = NonNullable<HostsOpResult["hosts"]>[number];

const emptyHostDraft = (): {
  id: string;
  label: string;
  endpoint: string;
  herdr: boolean;
  hermes: boolean;
  hermesId: string;
} => ({
  id: "",
  label: "",
  endpoint: "",
  herdr: true,
  hermes: true,
  hermesId: "",
});

function FieldRow({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="settings-field">
      <span className="settings-field__label">
        <span>{label}</span>
        {hint ? <span className="settings-field__hint">{hint}</span> : null}
      </span>
      <span className="settings-field__control">{children}</span>
    </label>
  );
}

function AppearanceSection() {
  const appearance = use$(state$.settings.appearance);
  return (
    <div className="settings-section">
      <FieldRow label="Theme" hint="deep-field is the house look">
        <select
          value={appearance.theme}
          aria-label="Theme"
          onChange={(event) =>
            void patchSettings({
              appearance: { theme: event.target.value as "deep-field" | "system" },
            })
          }
        >
          <option value="deep-field">deep-field</option>
          <option value="system">system</option>
        </select>
      </FieldRow>
      <FieldRow label="Density" hint="spacing of chrome and cards">
        <select
          value={appearance.density}
          aria-label="Density"
          onChange={(event) =>
            void patchSettings({
              appearance: { density: event.target.value as "comfortable" | "compact" },
            })
          }
        >
          <option value="comfortable">comfortable</option>
          <option value="compact">compact</option>
        </select>
      </FieldRow>
      <FieldRow label="Reduce motion" hint="honor reduced motion for UI chrome">
        <input
          type="checkbox"
          checked={appearance.reduceMotion}
          aria-label="Reduce motion"
          onChange={(event) =>
            void patchSettings({ appearance: { reduceMotion: event.target.checked } })
          }
        />
      </FieldRow>
    </div>
  );
}

function CanvasSection() {
  const canvas = use$(state$.settings.canvas);
  return (
    <div className="settings-section">
      <FieldRow label="Default canvas" hint="opened when no last-canvas preference applies">
        <input
          type="text"
          value={canvas.defaultCanvas}
          placeholder="e.g. portfolio"
          aria-label="Default canvas"
          onChange={(event) =>
            void patchSettings({ canvas: { defaultCanvas: event.target.value } })
          }
        />
      </FieldRow>
      <FieldRow label="Show minimap" hint="reserved for future canvas chrome">
        <input
          type="checkbox"
          checked={canvas.showMinimap}
          aria-label="Show minimap"
          onChange={(event) =>
            void patchSettings({ canvas: { showMinimap: event.target.checked } })
          }
        />
      </FieldRow>
      <FieldRow label="Fit on open" hint="frame the full graph when a canvas loads">
        <input
          type="checkbox"
          checked={canvas.fitOnOpen}
          aria-label="Fit on open"
          onChange={(event) =>
            void patchSettings({ canvas: { fitOnOpen: event.target.checked } })
          }
        />
      </FieldRow>
    </div>
  );
}

function KernelSection() {
  const kernel = use$(state$.settings.kernel);
  return (
    <div className="settings-section">
      <FieldRow label="Pulse log retention" hint="entries kept in kernel debug dump (5–500)">
        <input
          type="number"
          min={5}
          max={500}
          value={kernel.pulseLogRetention}
          aria-label="Pulse log retention"
          onChange={(event) => {
            const value = Number(event.target.value);
            if (!Number.isFinite(value)) return;
            void patchSettings({ kernel: { pulseLogRetention: Math.floor(value) } });
          }}
        />
      </FieldRow>
      <FieldRow label="Verbose debug" hint="extra kernel detail in doctor/debug paths">
        <input
          type="checkbox"
          checked={kernel.debugVerbose}
          aria-label="Verbose debug"
          onChange={(event) =>
            void patchSettings({ kernel: { debugVerbose: event.target.checked } })
          }
        />
      </FieldRow>
    </div>
  );
}

function BrowserSection() {
  const browser = use$(state$.settings.browser);
  const [profiles, setProfiles] = useState<ReadonlyArray<BrowserProfileInfo>>([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [selectedProfile, setSelectedProfile] = useState<string>();
  const [confirmation, setConfirmation] = useState("");
  const [wipeBusy, setWipeBusy] = useState(false);
  const [wipeNotice, setWipeNotice] = useState<{
    readonly kind: "success" | "error";
    readonly message: string;
  }>();
  type BrowserApi = ReturnType<typeof getVellumApi> & Partial<VellumBrowserApi>;

  const loadProfiles = useCallback(async () => {
    const api = getVellumApi() as BrowserApi | undefined;
    if (!api?.browserProfiles) {
      setProfilesLoading(false);
      setWipeNotice({ kind: "error", message: "Browser profile API unavailable." });
      return;
    }
    setProfilesLoading(true);
    try {
      const result = await api.browserProfiles();
      if (result.ok && result.data) {
        setProfiles(result.data);
      } else {
        setWipeNotice({ kind: "error", message: result.message ?? "Could not read profiles." });
      }
    } catch {
      setWipeNotice({ kind: "error", message: "Could not read profiles." });
    } finally {
      setProfilesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const wipeSelectedProfile = async () => {
    if (!selectedProfile || confirmation !== selectedProfile || wipeBusy) return;
    const api = getVellumApi() as BrowserApi | undefined;
    if (!api?.browserWipeProfile) {
      setWipeNotice({ kind: "error", message: "Browser profile wipe API unavailable." });
      return;
    }
    setWipeBusy(true);
    setWipeNotice(undefined);
    try {
      const result = await api.browserWipeProfile({
        profileId: selectedProfile,
        confirmation,
      });
      if (!result.ok || !result.data) {
        setWipeNotice({ kind: "error", message: result.message ?? "Profile wipe failed." });
        return;
      }
      setWipeNotice({
        kind: "success",
        message: result.data.recovery === "complete"
          ? `Profile ${result.data.profileId} wiped. Storage removal is complete.`
          : `Profile ${result.data.profileId} is isolated. Restart Vellum to finish disk removal.`,
      });
      setSelectedProfile(undefined);
      setConfirmation("");
      if (result.data.recovery === "complete") await loadProfiles();
    } catch {
      setWipeNotice({ kind: "error", message: "Profile wipe failed." });
    } finally {
      setWipeBusy(false);
    }
  };

  return (
    <div className="settings-section">
      {/* maxVisibleSurfaces is retained in config for compatibility but no longer
          gates the workbench (tabs + keep-alive). Warm sessions are the real cap. */}
      <FieldRow label="Max warm sessions" hint="concurrent warm browser pages (hard ceiling 32)">
        <input
          type="number"
          min={1}
          max={32}
          value={browser.maxWarmSessions}
          aria-label="Max warm sessions"
          onChange={(event) => {
            const value = Number(event.target.value);
            if (!Number.isFinite(value)) return;
            void patchSettings({ browser: { maxWarmSessions: Math.floor(value) } });
          }}
        />
      </FieldRow>
      <div className="settings-profile-list" aria-label="Browser profiles">
        <div className="settings-profile-list__head">
          <span>Profiles</span>
          <span>Wiping removes cookies, site storage, and sessions for one profile.</span>
        </div>
        {profilesLoading ? <p className="settings-note">loading profiles…</p> : null}
        {!profilesLoading && profiles.length === 0 ? (
          <p className="settings-note">No browser profiles available.</p>
        ) : null}
        {profiles.map((profile) => (
          <div key={profile.id} className="settings-profile-row">
            <span>
              <strong>{profile.label ?? profile.id}</strong>
              <small>{profile.id}{profile.default ? " · default" : ""}</small>
            </span>
            <button
              type="button"
              className="settings-profile-wipe"
              disabled={profiles.length <= 1 || wipeBusy}
              onClick={() => {
                setSelectedProfile(profile.id);
                setConfirmation("");
                setWipeNotice(undefined);
              }}
            >
              wipe…
            </button>
          </div>
        ))}
      </div>
      {selectedProfile ? (
        <div className="settings-wipe-confirm" role="group" aria-label={`Confirm wipe ${selectedProfile}`}>
          <strong>Wipe profile {selectedProfile}</strong>
          <p>Type <code>{selectedProfile}</code> to confirm. This cannot be undone.</p>
          <input
            type="text"
            value={confirmation}
            autoComplete="off"
            spellCheck={false}
            aria-label={`Type ${selectedProfile} to confirm profile wipe`}
            onChange={(event) => setConfirmation(event.target.value)}
          />
          <div>
            <button
              type="button"
              className="settings-profile-wipe settings-profile-wipe--confirm"
              disabled={confirmation !== selectedProfile || wipeBusy}
              onClick={() => void wipeSelectedProfile()}
            >
              {wipeBusy ? "wiping…" : "Wipe profile"}
            </button>
            <button
              type="button"
              className="settings-profile-cancel"
              disabled={wipeBusy}
              onClick={() => {
                setSelectedProfile(undefined);
                setConfirmation("");
              }}
            >
              cancel
            </button>
          </div>
        </div>
      ) : null}
      {wipeNotice ? (
        <p
          className={wipeNotice.kind === "error" ? "settings-error" : "settings-success"}
          role={wipeNotice.kind === "error" ? "alert" : "status"}
        >
          {wipeNotice.message}
        </p>
      ) : null}
    </div>
  );
}

function AdvancedSection() {
  const advanced = use$(state$.settings.advanced);
  return (
    <div className="settings-section">
      <FieldRow label="Open last canvas" hint="resume the previous surface on launch">
        <input
          type="checkbox"
          checked={advanced.openLastCanvas}
          aria-label="Open last canvas"
          onChange={(event) =>
            void patchSettings({ advanced: { openLastCanvas: event.target.checked } })
          }
        />
      </FieldRow>
    </div>
  );
}

function HostsSection() {
  const station = use$(state$.settings.station);
  const isCommandCenter = station.role === "command-center";
  const [hosts, setHosts] = useState<ReadonlyArray<HostRow>>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    readonly kind: "success" | "error";
    readonly message: string;
  }>();
  const [draft, setDraft] = useState(emptyHostDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testDetail, setTestDetail] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const api = getVellumApi();
    if (!api?.hostsList) {
      setLoading(false);
      setNotice({ kind: "error", message: "Hosts API unavailable." });
      return;
    }
    setLoading(true);
    try {
      const result = await api.hostsList();
      if (result.ok && result.hosts) {
        setHosts(result.hosts);
        setNotice(undefined);
      } else {
        setNotice({ kind: "error", message: result.message ?? "Could not load hosts." });
      }
    } catch (error) {
      setNotice({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const beginEdit = (host: HostRow) => {
    if (host.kind === "local") return;
    setEditingId(host.id);
    setDraft({
      id: host.id,
      label: host.label,
      endpoint: host.endpoint ?? "",
      herdr: host.capabilities.includes("herdr"),
      hermes: host.capabilities.includes("hermes"),
      hermesId: host.hermesId ?? "",
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(emptyHostDraft());
  };

  const saveHost = async () => {
    const api = getVellumApi();
    if (!api?.hostsUpsert) {
      setNotice({ kind: "error", message: "Hosts API unavailable." });
      return;
    }
    const id = draft.id.trim();
    const label = draft.label.trim() || id;
    const endpoint = draft.endpoint.trim();
    if (!id || !endpoint) {
      setNotice({ kind: "error", message: "Host id and SSH endpoint are required." });
      return;
    }
    if (!draft.herdr && !draft.hermes) {
      setNotice({ kind: "error", message: "Enable at least one capability (Herdr or Hermes)." });
      return;
    }
    if (id === "local") {
      setNotice({ kind: "error", message: "Id \"local\" is reserved." });
      return;
    }
    const capabilities: Array<"herdr" | "hermes"> = [];
    if (draft.herdr) capabilities.push("herdr");
    if (draft.hermes) capabilities.push("hermes");

    setBusy(true);
    try {
      const result = await api.hostsUpsert({
        id,
        label,
        kind: "remote",
        endpoint,
        capabilities,
        ...(draft.hermesId.trim() ? { hermesId: draft.hermesId.trim() } : {}),
      });
      if (result.ok && result.hosts) {
        setHosts(result.hosts);
        setNotice({
          kind: "success",
          message: editingId ? `Updated ${id}.` : `Added ${id}.`,
        });
        cancelEdit();
      } else {
        setNotice({ kind: "error", message: result.message ?? "Save failed." });
      }
    } catch (error) {
      setNotice({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const removeHost = async (id: string) => {
    const api = getVellumApi();
    if (!api?.hostsRemove) return;
    if (!window.confirm(`Remove remote host “${id}”?`)) return;
    setBusy(true);
    try {
      const result = await api.hostsRemove(id);
      if (result.ok && result.hosts) {
        setHosts(result.hosts);
        setNotice({ kind: "success", message: `Removed ${id}.` });
        if (editingId === id) cancelEdit();
      } else {
        setNotice({ kind: "error", message: result.message ?? "Remove failed." });
      }
    } catch (error) {
      setNotice({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const testHost = async (id: string) => {
    const api = getVellumApi();
    if (!api?.hostsTest) return;
    setBusy(true);
    setTestDetail((prev) => ({ ...prev, [id]: "testing…" }));
    try {
      const result: HostsTestResult = await api.hostsTest(id);
      setTestDetail((prev) => ({
        ...prev,
        [id]: result.detail || (result.ok ? "ok" : result.message ?? "failed"),
      }));
      setNotice({
        kind: result.ok ? "success" : "error",
        message: result.ok ? `${id}: connection ok` : `${id}: ${result.detail || result.message}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTestDetail((prev) => ({ ...prev, [id]: message }));
      setNotice({ kind: "error", message });
    } finally {
      setBusy(false);
    }
  };

  const configureAsRemote = async (id: string) => {
    const api = getVellumApi();
    if (!api?.hostsConfigureRemote) {
      setNotice({ kind: "error", message: "Configure Remote API unavailable." });
      return;
    }
    setBusy(true);
    setTestDetail((prev) => ({ ...prev, [id]: "configuring as Remote…" }));
    try {
      const result: HostsConfigureRemoteResult = await api.hostsConfigureRemote(id);
      setTestDetail((prev) => ({
        ...prev,
        [id]: result.detail || (result.ok ? "configured" : result.message ?? "failed"),
      }));
      setNotice({
        kind: result.ok ? "success" : "error",
        message: result.ok
          ? `${id}: Remote configured`
          : `${id}: ${result.detail || result.message}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTestDetail((prev) => ({ ...prev, [id]: message }));
      setNotice({ kind: "error", message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-section">
      <p className="settings-note">
        Remote hosts are user-authored — nothing is hard-coded for a particular machine.
        Use an SSH config <code>Host</code> alias, <code>user@hostname</code>, or an IPv6
        literal. Configure custom ports in <code>~/.ssh/config</code>. Agent keys for Hermes
        use the host id (or optional hermes id). Expand <strong>Services</strong> on a host to
        list Tailscale Serve / SVC URLs and open them as canvas page nodes.
        {isCommandCenter
          ? " On Command Center, Configure as Remote stamps that machine’s station role over SSH."
          : ""}
      </p>

      {loading ? (
        <p className="settings-note">Loading hosts…</p>
      ) : (
        <ul className="settings-host-list" aria-label="Configured hosts">
          {hosts.map((host) => (
            <li key={host.id} className="settings-host-card">
              <div className="settings-host-card__head">
                <strong>{host.label}</strong>
                <span className="settings-host-card__meta">
                  {host.kind === "local" ? "local" : host.endpoint}
                  {" · "}
                  {host.capabilities.join(", ")}
                  {host.hermesId ? ` · hermes ${host.hermesId}` : ""}
                </span>
              </div>
              <div className="settings-host-card__actions">
                <button
                  type="button"
                  className="settings-panel__ghost"
                  disabled={busy}
                  onClick={() => void testHost(host.id)}
                >
                  test
                </button>
                {host.kind === "remote" ? (
                  <>
                    {isCommandCenter ? (
                      <button
                        type="button"
                        className="settings-panel__ghost"
                        disabled={busy}
                        title="Write station.role=remote to this host’s ~/.vellum/settings.json over SSH"
                        onClick={() => void configureAsRemote(host.id)}
                      >
                        Configure as Remote
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="settings-panel__ghost"
                      disabled={busy}
                      onClick={() => beginEdit(host)}
                    >
                      edit
                    </button>
                    <button
                      type="button"
                      className="settings-panel__ghost settings-host-card__danger"
                      disabled={busy}
                      onClick={() => void removeHost(host.id)}
                    >
                      remove
                    </button>
                  </>
                ) : null}
              </div>
              {testDetail[host.id] ? (
                <p className="settings-host-card__test" role="status">
                  {testDetail[host.id]}
                </p>
              ) : null}
              <HostServeCatalog hostId={host.id} hostLabel={host.label} />
            </li>
          ))}
        </ul>
      )}

      <div className="settings-host-form" aria-label={editingId ? "Edit host" : "Add remote host"}>
        <h3 className="settings-host-form__title">
          {editingId ? `Edit ${editingId}` : "Add remote host"}
        </h3>
        <FieldRow label="Host id" hint="stable product id (not a leading dash)">
          <input
            type="text"
            value={draft.id}
            disabled={busy || editingId !== null}
            placeholder="e.g. studio"
            aria-label="Host id"
            onChange={(event) => setDraft((d) => ({ ...d, id: event.target.value }))}
          />
        </FieldRow>
        <FieldRow label="Display name" hint="shown in UI chrome">
          <input
            type="text"
            value={draft.label}
            disabled={busy}
            placeholder="optional — defaults to id"
            aria-label="Display name"
            onChange={(event) => setDraft((d) => ({ ...d, label: event.target.value }))}
          />
        </FieldRow>
        <FieldRow label="SSH endpoint" hint="alias, user@host, or IPv6; ports via ~/.ssh/config">
          <input
            type="text"
            value={draft.endpoint}
            disabled={busy}
            placeholder="e.g. studio or ops@10.0.0.5"
            aria-label="SSH endpoint"
            onChange={(event) => setDraft((d) => ({ ...d, endpoint: event.target.value }))}
          />
        </FieldRow>
        <FieldRow label="Capabilities" hint="which product surfaces use this host">
          <span className="settings-host-caps">
            <label>
              <input
                type="checkbox"
                checked={draft.herdr}
                disabled={busy}
                aria-label="Herdr capability"
                onChange={(event) => setDraft((d) => ({ ...d, herdr: event.target.checked }))}
              />
              Herdr
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.hermes}
                disabled={busy}
                aria-label="Hermes capability"
                onChange={(event) => setDraft((d) => ({ ...d, hermes: event.target.checked }))}
              />
              Hermes
            </label>
          </span>
        </FieldRow>
        <FieldRow
          label="Hermes agent-key id"
          hint="optional override for agent keys (defaults to host id)"
        >
          <input
            type="text"
            value={draft.hermesId}
            disabled={busy || !draft.hermes}
            placeholder="optional"
            aria-label="Hermes agent-key id"
            onChange={(event) => setDraft((d) => ({ ...d, hermesId: event.target.value }))}
          />
        </FieldRow>
        <div className="settings-host-form__actions">
          <button
            type="button"
            className="settings-panel__ghost"
            disabled={busy}
            onClick={() => void saveHost()}
          >
            {editingId ? "Save changes" : "Add host"}
          </button>
          {editingId ? (
            <button type="button" className="settings-panel__ghost" disabled={busy} onClick={cancelEdit}>
              cancel
            </button>
          ) : null}
        </div>
      </div>

      {notice ? (
        <p
          className={notice.kind === "error" ? "settings-error" : "settings-success"}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.message}
        </p>
      ) : null}
    </div>
  );
}

function AudioSection() {
  const audio = use$(state$.settings.audio);
  return (
    <div className="settings-section">
      <p className="settings-note">
        Space / ` cycles the attention queue (permission → blocked → herdr done → orphan).
        Each clip can be muted or leveled independently.
      </p>
      <FieldRow label="Mute all alerts" hint="master mute for the RTS SFX pack">
        <input
          type="checkbox"
          checked={audio.muted}
          aria-label="Mute all alerts"
          onChange={(event) => void patchSettings({ audio: { muted: event.target.checked } })}
        />
      </FieldRow>
      <FieldRow label="Master volume" hint="scales every clip (0–100%)">
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(audio.masterVolume * 100)}
          aria-label="Master volume"
          disabled={audio.muted}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (!Number.isFinite(value)) return;
            void patchSettings({ audio: { masterVolume: Math.min(1, Math.max(0, value / 100)) } });
          }}
        />
        <span className="settings-field__hint" style={{ marginLeft: 8 }}>
          {Math.round(audio.masterVolume * 100)}%
        </span>
      </FieldRow>
      {ALERT_SFX_IDS.map((id: AlertSfxId) => {
        const key = sfxIdToClipKey(id);
        const clip = audio.clips[key];
        return (
          <div key={id} className="settings-sfx-row">
            <FieldRow label={SFX_LABELS[id]} hint={id === "cycle" ? "played on Space / `" : `rising-edge · ${id}`}>
              <span className="settings-sfx-controls">
                <label className="settings-sfx-enable">
                  <input
                    type="checkbox"
                    checked={clip.enabled}
                    aria-label={`Enable ${SFX_LABELS[id]}`}
                    disabled={audio.muted}
                    onChange={(event) =>
                      void patchSettings({
                        audio: { clips: { [key]: { enabled: event.target.checked } } },
                      })
                    }
                  />
                  on
                </label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(clip.volume * 100)}
                  aria-label={`${SFX_LABELS[id]} volume`}
                  disabled={audio.muted || !clip.enabled}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    void patchSettings({
                      audio: {
                        clips: { [key]: { volume: Math.min(1, Math.max(0, value / 100)) } },
                      },
                    });
                  }}
                />
                <button
                  type="button"
                  className="settings-sfx-preview"
                  disabled={audio.muted || !clip.enabled}
                  onClick={() => playAlert(id)}
                >
                  play
                </button>
              </span>
            </FieldRow>
          </div>
        );
      })}
    </div>
  );
}

function StationSection() {
  const station = use$(state$.settings.station);
  const role = station.role;
  const roleLabel =
    role === "command-center"
      ? "Command Center"
      : role === "remote"
        ? "Remote"
        : "Not set (complete onboarding)";
  const [pullBusy, setPullBusy] = useState(false);
  const [pullDetail, setPullDetail] = useState<string | null>(null);

  const onPullCanvases = useCallback(async () => {
    const api = getVellumApi();
    if (!api?.pullCanvases) {
      setPullDetail("Pull unavailable — preload bridge missing pullCanvases");
      return;
    }
    setPullBusy(true);
    setPullDetail(null);
    try {
      const result: CanvasPullResult = await api.pullCanvases();
      setPullDetail(result.detail);
    } catch (error) {
      setPullDetail(error instanceof Error ? error.message : String(error));
    } finally {
      setPullBusy(false);
    }
  }, []);

  return (
    <div className="settings-section">
      <FieldRow
        label="Role"
        hint="User-selected only. Changing role is deliberate — never auto-detected."
      >
        <span style={{ color: INK, fontSize: 13 }}>{roleLabel}</span>
      </FieldRow>
      <FieldRow label="This station host id" hint="Must match a host registry id (usually local)">
        <input
          type="text"
          value={station.hostId}
          aria-label="Station host id"
          onChange={(event) => {
            const value = event.target.value.trim();
            if (value.length === 0) return;
            void patchSettings({ station: { hostId: value } });
          }}
        />
      </FieldRow>
      {role === "remote" ? (
        <FieldRow
          label="Command Center ref"
          hint="Host id or SSH target this Remote pulls from"
        >
          <input
            type="text"
            value={station.commandCenterRef}
            aria-label="Command Center reachability"
            onChange={(event) =>
              void patchSettings({ station: { commandCenterRef: event.target.value } })
            }
          />
        </FieldRow>
      ) : null}
      {role === "remote" ? (
        <FieldRow
          label="Canvas pull"
          hint="Replace local canvases with full copies from the Command Center (read-only)"
        >
          <button
            type="button"
            className="settings-panel__ghost"
            disabled={pullBusy || station.commandCenterRef.trim().length === 0}
            aria-label="Pull canvases from Command Center"
            onClick={() => void onPullCanvases()}
          >
            {pullBusy ? "Pulling…" : "Pull from Command Center"}
          </button>
        </FieldRow>
      ) : null}
      {role === "remote" && pullDetail ? (
        <p className="settings-note" style={{ color: DIM }} role="status">
          {pullDetail}
        </p>
      ) : null}
      <FieldRow
        label="Prefer supervised runtime"
        hint="LaunchAgent KeepAlive — recommended for Remote 24×7"
      >
        <input
          type="checkbox"
          checked={station.supervisedPreferred}
          aria-label="Prefer supervised runtime"
          onChange={(event) =>
            void patchSettings({ station: { supervisedPreferred: event.target.checked } })
          }
        />
      </FieldRow>
      <FieldRow label="Change role" hint="Clears role and reopens the station gate">
        <button
          type="button"
          className="settings-panel__ghost"
          onClick={() =>
            void patchSettings({
              station: { role: "", commandCenterRef: "" },
            })
          }
        >
          Reset role (re-onboard)
        </button>
      </FieldRow>
      <p className="settings-note" style={{ color: DIM }}>
        Canvas authoring is human-only on the Command Center. Agents never write the canvas.
        Remote is a capability host for this machine only.
      </p>
    </div>
  );
}

function SectionBody({ section }: { readonly section: PanelSection }) {
  switch (section) {
    case "station":
      return <StationSection />;
    case "appearance":
      return <AppearanceSection />;
    case "canvas":
      return <CanvasSection />;
    case "hosts":
      return <HostsSection />;
    case "audio":
      return <AudioSection />;
    case "kernel":
      return <KernelSection />;
    case "browser":
      return <BrowserSection />;
    case "advanced":
      return <AdvancedSection />;
  }
}

export function SettingsPanel() {
  const open = use$(state$.settingsOpen);
  const loading = use$(state$.settingsLoading);
  const error = use$(state$.settingsError);
  const version = use$(state$.settings.version);
  const [section, setSection] = useState<PanelSection>("appearance");

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSettings();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;

  const meta = SECTIONS.find((item) => item.key === section)!;

  return createPortal(
    <div className="settings-surface" role="dialog" aria-modal="true" aria-label="Settings">
      <button
        type="button"
        className="settings-surface__backdrop"
        aria-label="Close settings"
        tabIndex={-1}
        onClick={closeSettings}
      />
      <div className="settings-panel" onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-panel__header">
          <div className="settings-panel__title">
            <Settings2 size={16} style={{ color: HUE.amber }} />
            <div>
              <div className="settings-panel__eyebrow">station / prefs</div>
              <strong style={{ color: INK }}>Settings</strong>
            </div>
          </div>
          <div className="settings-panel__header-actions">
            {section !== "hosts" ? (
              <button
                type="button"
                className="settings-panel__ghost"
                title={`Reset ${meta.label} to defaults`}
                aria-label={`Reset ${meta.label}`}
                onClick={() => void resetSettings(section)}
              >
                <RotateCcw size={14} />
                <span>reset section</span>
              </button>
            ) : null}
            <button
              type="button"
              className="settings-panel__close"
              aria-label="Close settings"
              onClick={closeSettings}
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="settings-panel__body">
          <nav className="settings-nav" aria-label="Settings sections">
            {SECTIONS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`settings-nav__item${section === item.key ? " is-active" : ""}`}
                aria-current={section === item.key ? "page" : undefined}
                onClick={() => setSection(item.key)}
              >
                <span className="settings-nav__label">{item.label}</span>
                <span className="settings-nav__blurb">{item.blurb}</span>
              </button>
            ))}
          </nav>
          <div className="settings-content">
            <div className="settings-content__head">
              <h2>{meta.label}</h2>
              <p>{meta.blurb}</p>
            </div>
            {loading ? <p className="settings-note">loading…</p> : <SectionBody section={section} />}
            {error ? (
              <p className="settings-error" role="alert">
                {error}
              </p>
            ) : null}
            <p className="settings-foot" style={{ color: DIM }}>
              document v{version} · ~/.vellum/settings.json
            </p>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
