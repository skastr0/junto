import { use$ } from "@legendapp/state/react";
import { RotateCcw, Settings2, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type {
  BrowserProfileInfo,
  HostsConfigureRemoteResult,
  HostsOpResult,
  HostsTestResult,
  VellumBrowserApi,
} from "@shared/ipc";
import type { LinuxHostCapabilityObservation } from "@shared/linux-host-capabilities";
import type { SettingsSectionKey } from "@shared/settings";
import {
  decodeStateBackupId,
  type StateBackupId,
  type StateBackupInventoryEntry,
} from "@shared/state-recovery";
import { presentLinuxHostCapabilities } from "../lib/linux-host-capability-presentation";
import { state$ } from "../lib/state";
import {
  closeSettings,
  patchSettings,
  resetSettings,
  setStationTopology,
} from "../lib/settings-state";
import {
  checkForUpdates,
  restartAndInstallUpdate,
  updateState$,
} from "../lib/update-state";
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
import { LinuxHostCapabilities } from "./LinuxHostCapabilities";
import { LicenseSection } from "./license";
import { Button, Select } from "./ui";
import "./settings-panel.css";

/** Settings sections: prefs sections + non-prefs panels (hosts/license/updates). */
type PanelSection = SettingsSectionKey | "hosts" | "license" | "updates";

const SECTIONS: ReadonlyArray<{ key: PanelSection; label: string; blurb: string }> = [
  { key: "station", label: "Machine", blurb: "Command Center or Remote role" },
  { key: "updates", label: "Updates", blurb: "check and install app updates" },
  { key: "appearance", label: "Appearance", blurb: "theme, density, motion" },
  { key: "canvas", label: "Canvas", blurb: "defaults for the portfolio field" },
  { key: "hosts", label: "Hosts", blurb: "fleet + network services" },
  { key: "audio", label: "Audio", blurb: "RTS alert SFX mute and levels" },
  { key: "license", label: "License", blurb: "access, billing, and this installation" },
  { key: "kernel", label: "Kernel", blurb: "debug verbosity" },
  { key: "browser", label: "Browser", blurb: "surface and warm-session limits" },
  { key: "advanced", label: "Advanced", blurb: "startup and recovery prefs" },
];

type HostRow = NonNullable<HostsOpResult["hosts"]>[number];

const emptyHostDraft = (): {
  id: string;
  label: string;
  endpoint: string;
  terminal: boolean;
  browser: boolean;
  herdr: boolean;
  hermes: boolean;
  hermesId: string;
} => ({
  id: "",
  label: "",
  endpoint: "",
  terminal: true,
  browser: false,
  // Per-host opt-in: a new host does not claim the herdr binary by default.
  herdr: false,
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
        <Select
          dense
          value={appearance.theme}
          aria-label="Theme"
          options={[
            { value: "deep-field", label: "deep-field" },
            { value: "system", label: "system" },
          ]}
          onChange={(value) =>
            void patchSettings({
              appearance: { theme: value as "deep-field" | "system" },
            })
          }
        />
      </FieldRow>
      <FieldRow label="Density" hint="spacing of chrome and cards">
        <Select
          dense
          value={appearance.density}
          aria-label="Density"
          options={[
            { value: "comfortable", label: "comfortable" },
            { value: "compact", label: "compact" },
          ]}
          onChange={(value) =>
            void patchSettings({
              appearance: { density: value as "comfortable" | "compact" },
            })
          }
        />
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
          placeholder="e.g. factory"
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
          : `Profile ${result.data.profileId} is isolated. Restart Vellum Command to finish disk removal.`,
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
  const [openAtLogin, setOpenAtLogin] = useState(false);
  const [loginItemLoading, setLoginItemLoading] = useState(true);
  const [loginItemError, setLoginItemError] = useState<string | undefined>();
  const [loginItemBusy, setLoginItemBusy] = useState(false);
  const [startupProvider, setStartupProvider] = useState<"apple-login-items" | "systemd-supervision" | "unsupported">();

  // OS is source of truth — read real getLoginItemSettings on every open; never assume.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const api = getVellumApi();
      if (!api?.loginItemGet) {
        if (!cancelled) {
          setLoginItemLoading(false);
          setLoginItemError("Login item API unavailable.");
        }
        return;
      }
      setLoginItemLoading(true);
      try {
        const result = await api.loginItemGet();
        if (cancelled) return;
        setStartupProvider(result.provider);
        if (result.ok && result.state) {
          setOpenAtLogin(result.state.openAtLogin);
          setLoginItemError(undefined);
        } else {
          setLoginItemError(result.message ?? "Could not read login item state.");
        }
      } catch (error) {
        if (!cancelled) {
          setLoginItemError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) setLoginItemLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const onToggleLoginItem = async (next: boolean) => {
    const api = getVellumApi();
    if (!api?.loginItemSet) {
      setLoginItemError("Login item API unavailable.");
      return;
    }
    setLoginItemBusy(true);
    try {
      const result = await api.loginItemSet(next);
      if (result.ok && result.state) {
        setOpenAtLogin(result.state.openAtLogin);
        setLoginItemError(undefined);
      } else {
        setLoginItemError(result.message ?? "Could not update login item.");
      }
    } catch (error) {
      setLoginItemError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoginItemBusy(false);
    }
  };

  const usesAppleLoginItems = startupProvider === undefined || startupProvider === "apple-login-items";

  return (
    <div className="settings-section">
      <InstallationFacts />
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
      {usesAppleLoginItems ? (
        <FieldRow label="Start Vellum Command at login" hint="macOS Login Items">
          <input type="checkbox" checked={openAtLogin} disabled={loginItemLoading || loginItemBusy} aria-label="Start Vellum Command at login" onChange={(event) => void onToggleLoginItem(event.target.checked)} />
        </FieldRow>
      ) : startupProvider === "systemd-supervision" ? (
        <FieldRow label="Startup" hint="Remotes on Linux run as a systemd user service.">
          <span className="settings-field__value" aria-label="Systemd user supervision">systemd user</span>
        </FieldRow>
      ) : (
        <FieldRow label="Startup" hint="Not available on this platform.">
          <span className="settings-field__value">unavailable</span>
        </FieldRow>
      )}
      {loginItemError ? (
        <p className="settings-note" style={{ color: HUE.crimson }} role="status">
          {loginItemError}
        </p>
      ) : null}
      <StateRecoveryControls />
    </div>
  );
}

function InstallationFacts() {
  const status = use$(updateState$.status);
  const settingsVersion = use$(state$.settings.version);
  const station = use$(state$.settings.station);
  const install = status.install;
  const platformLabel =
    install === undefined
      ? "—"
      : `${install.platform}/${install.arch} · electron ${install.electronVersion}`;
  const buildLabel =
    install === undefined
      ? "—"
      : install.packaged
        ? `packaged · ${install.providerKind} updater`
        : "development (self-update disabled)";
  const feedLabel =
    install?.feedUrl !== undefined && install.feedUrl.length > 0
      ? install.feedUrl
      : install?.packaged
        ? "no feed for this platform"
        : "n/a in development builds";

  return (
    <div className="settings-install-facts" aria-label="Installation identity">
      <div className="settings-install-facts__head">
        <span>Installation</span>
        <span>
          App version and release provenance. Check for updates lives under
          Updates.
        </span>
      </div>
      <FieldRow label="App version" hint="running Vellum Command build">
        <span style={{ color: INK, fontSize: 13 }}>{status.currentVersion}</span>
      </FieldRow>
      <FieldRow label="Build" hint="packaged vs development">
        <span style={{ color: INK, fontSize: 13 }}>{buildLabel}</span>
      </FieldRow>
      <FieldRow label="Platform" hint="OS, architecture, Electron runtime">
        <span style={{ color: INK, fontSize: 13 }}>{platformLabel}</span>
      </FieldRow>
      <FieldRow label="Update feed" hint="packaged release channel only">
        <span
          className="settings-mono-value"
          style={{ color: INK, fontSize: 12 }}
          title={install?.feedUrl}
        >
          {feedLabel}
        </span>
      </FieldRow>
      <FieldRow label="Host id" hint="this machine across the fleet">
        <span style={{ color: INK, fontSize: 13 }}>
          {station.hostId.length > 0 ? station.hostId : "—"}
        </span>
      </FieldRow>
      <FieldRow label="Settings schema" hint="prefs document version in vellum.db">
        <span style={{ color: INK, fontSize: 13 }}>v{settingsVersion}</span>
      </FieldRow>
      <FieldRow label="State store" hint="sole durable product database">
        <span className="settings-mono-value" style={{ color: INK, fontSize: 12 }}>
          ~/.vellum/state/vellum.db
        </span>
      </FieldRow>
    </div>
  );
}

function UpdatesSection() {
  const status = use$(updateState$.status);
  const busy = use$(updateState$.busy);
  const [localError, setLocalError] = useState<string | undefined>();

  const summary = (() => {
    switch (status.phase) {
      case "checking":
        return "checking for updates…";
      case "available":
        return status.available
          ? `update ${status.available.version} available`
          : "update available";
      case "downloading": {
        const percent =
          status.progress !== undefined
            ? Math.round(status.progress.percent)
            : undefined;
        return percent === undefined
          ? "downloading update…"
          : `downloading ${percent}%`;
      }
      case "ready":
        return status.available
          ? `ready to install ${status.available.version}`
          : "ready to install";
      case "installing":
        return "installing…";
      case "error":
        return status.error?.message ?? "update check failed";
      default:
        return status.lastCheckedAt
          ? `last checked ${status.lastCheckedAt.slice(0, 19).replace("T", " ")} UTC`
          : `running ${status.currentVersion} — check for a newer release`;
    }
  })();

  const showRestart =
    status.phase === "ready" || status.phase === "installing";

  return (
    <div className="settings-section">
      <FieldRow label="Installed version" hint="currently running Vellum Command">
        <span style={{ color: INK, fontSize: 13 }}>{status.currentVersion}</span>
      </FieldRow>
      <FieldRow label="Application updates" hint={summary}>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="chrome"
            size="sm"
            disabled={busy || status.phase === "installing"}
            aria-label="Check for updates"
            onClick={() => {
              setLocalError(undefined);
              void checkForUpdates()
                .then((next) => {
                  if (next?.phase === "error" && next.error) {
                    setLocalError(next.error.message);
                  }
                })
                .catch((error: unknown) => {
                  setLocalError(
                    error instanceof Error ? error.message : String(error),
                  );
                });
            }}
          >
            Check for updates
          </Button>
          {showRestart ? (
            <Button
              variant="primary"
              size="sm"
              disabled={busy && status.phase === "installing"}
              aria-label="Restart and install update"
              onClick={() => {
                setLocalError(undefined);
                void restartAndInstallUpdate().catch((error: unknown) => {
                  setLocalError(
                    error instanceof Error ? error.message : String(error),
                  );
                });
              }}
            >
              {status.phase === "installing"
                ? "Installing…"
                : status.available
                  ? `Restart to install ${status.available.version}`
                  : "Restart to install"}
            </Button>
          ) : null}
        </div>
      </FieldRow>
      {localError || (status.phase === "error" && status.error) ? (
        <p className="settings-note" style={{ color: HUE.crimson }} role="status">
          {localError ?? status.error?.message}
        </p>
      ) : null}
      <p className="settings-note">
        Packaged installs contact the Vellum Command release server. Dev builds cannot
        self-update. No update telemetry is sent. Full install provenance is
        under Advanced.
      </p>
    </div>
  );
}

const formatBackupBytes = (bytes: number): string => {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) {
    return `${Math.ceil(bytes / 1_024)} KiB`;
  }
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
};

const backupOptionLabel = (
  backup: StateBackupInventoryEntry,
): string => {
  const modified = new Date(backup.modifiedAtEpochMs);
  const timestamp = Number.isNaN(modified.getTime())
    ? "unknown date"
    : modified.toISOString().slice(0, 16).replace("T", " ");
  return `${timestamp} UTC · ${formatBackupBytes(backup.bytes)} · schema ${backup.schemaVersion}`;
};

function StateRecoveryControls() {
  const [backups, setBackups] = useState<
    ReadonlyArray<StateBackupInventoryEntry>
  >([]);
  const [selectedId, setSelectedId] =
    useState<StateBackupId>();
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{
    readonly kind: "status" | "success" | "error";
    readonly message: string;
  }>();

  const loadBackups = useCallback(async () => {
    const api = getVellumApi();
    if (!api?.stateBackupsList) {
      setLoading(false);
      setNotice({
        kind: "error",
        message: "State backup inventory is unavailable.",
      });
      return;
    }
    setLoading(true);
    try {
      const result = await api.stateBackupsList();
      if (result.outcome === "error") {
        setBackups([]);
        setSelectedId(undefined);
        setNotice({ kind: "error", message: result.message });
        return;
      }
      const verified = [...result.backups].sort(
        (left, right) =>
          right.modifiedAtEpochMs - left.modifiedAtEpochMs,
      );
      setBackups(verified);
      setSelectedId((current) =>
        current !== undefined &&
        verified.some((backup) => backup.id === current)
          ? current
          : verified[0]?.id,
      );
      setNotice(undefined);
    } catch {
      setBackups([]);
      setSelectedId(undefined);
      setNotice({
        kind: "error",
        message: "Vellum Command could not read verified state backups.",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);

  const exportSelected = async () => {
    if (selectedId === undefined || exporting) return;
    const api = getVellumApi();
    if (!api?.stateBackupExport) {
      setNotice({
        kind: "error",
        message: "State backup export is unavailable.",
      });
      return;
    }
    setExporting(true);
    setNotice(undefined);
    try {
      const result = await api.stateBackupExport(selectedId);
      if (result.outcome === "canceled") {
        setNotice({
          kind: "status",
          message: "Backup export canceled.",
        });
      } else if (result.outcome === "error") {
        setNotice({ kind: "error", message: result.message });
      } else {
        setNotice({
          kind: "success",
          message: `${result.fileName} was exported and verified.`,
        });
      }
    } catch {
      setNotice({
        kind: "error",
        message: "Vellum Command could not export the verified state backup.",
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div
      className="settings-profile-list"
      aria-label="State backup recovery"
    >
      <div className="settings-profile-list__head">
        <span>Verified retained backups</span>
        <span>
          Export creates a new SQLite copy for portability and evidence.
          It cannot restore or replace this installation.
        </span>
      </div>
      {loading ? (
        <p className="settings-note">verifying retained backups…</p>
      ) : backups.length === 0 ? (
        <p className="settings-note">
          No verified retained backups are available.
        </p>
      ) : (
        <FieldRow
          label="Backup"
          hint="schema, size, and creation time"
        >
          <Select
            dense
            value={selectedId ?? ""}
            aria-label="Verified state backup"
            options={backups.map((backup) => ({
              value: backup.id,
              label: backupOptionLabel(backup),
            }))}
            onChange={(value) => {
              try {
                setSelectedId(decodeStateBackupId(value));
                setNotice(undefined);
              } catch {
                setSelectedId(undefined);
                setNotice({
                  kind: "error",
                  message: "The selected state backup is invalid.",
                });
              }
            }}
          />
        </FieldRow>
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="subtle"
          disabled={loading || exporting}
          onClick={() => void loadBackups()}
        >
          Refresh
        </Button>
        <Button
          variant="primary"
          disabled={
            loading || exporting || selectedId === undefined
          }
          onClick={() => void exportSelected()}
        >
          {exporting ? "Exporting…" : "Export backup…"}
        </Button>
      </div>
      {notice ? (
        <p
          className={
            notice.kind === "error"
              ? "settings-error"
              : notice.kind === "success"
                ? "settings-success"
                : "settings-note"
          }
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.message}
        </p>
      ) : null}
    </div>
  );
}

function HostsSection() {
  const station = use$(state$.settings.station);
  const fleet = use$(state$.settings.fleet);
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
  const [linuxCapabilities, setLinuxCapabilities] = useState<
    Record<string, LinuxHostCapabilityObservation>
  >({});

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
      endpoint: host.sshEndpoint ?? "",
      terminal: host.capabilities.includes("terminal"),
      browser: host.capabilities.includes("browser"),
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
    if (!draft.terminal && !draft.browser && !draft.herdr && !draft.hermes) {
      setNotice({ kind: "error", message: "Enable at least one host capability." });
      return;
    }
    if (id === "local") {
      setNotice({ kind: "error", message: "Id \"local\" is reserved." });
      return;
    }
    const capabilities: Array<"browser" | "terminal" | "herdr" | "hermes"> = [];
    if (draft.terminal) capabilities.push("terminal");
    if (draft.browser) capabilities.push("browser");
    if (draft.herdr) capabilities.push("herdr");
    if (draft.hermes) capabilities.push("hermes");

    setBusy(true);
    try {
      const result = await api.hostsUpsert({
        id,
        label,
        kind: "remote",
        sshEndpoint: endpoint,
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
      setLinuxCapabilities((previous) => {
        const next = { ...previous };
        if (result.linuxCapabilities === undefined) delete next[id];
        else next[id] = result.linuxCapabilities;
        return next;
      });
      setTestDetail((prev) => ({
        ...prev,
        [id]: result.detail || (result.ok ? "ok" : result.message ?? "failed"),
      }));
      const presentation =
        result.linuxCapabilities === undefined
          ? undefined
          : presentLinuxHostCapabilities(result.linuxCapabilities);
      const reachable = result.reachability !== "unreachable";
      const coreReady = presentation?.coreStatus === "ready";
      const healthy =
        reachable && (presentation === undefined ? result.ok : coreReady);
      setNotice({
        kind: healthy ? "success" : "error",
        message:
          presentation !== undefined && reachable
            ? `${id}: ${presentation.summary}`
            : result.ok
              ? `${id}: connection ok`
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
      <FieldRow
        label="Allow remote managed installs"
        hint="Fleet kill-switch for deploying Vellum Command to enrolled Remotes. Off by default; main re-gates every invoke."
      >
        <input
          type="checkbox"
          checked={fleet.remoteManagedInstalls}
          aria-label="Allow remote managed installs"
          onChange={(event) =>
            void patchSettings({
              fleet: { remoteManagedInstalls: event.target.checked },
            })
          }
        />
      </FieldRow>
      <p className="settings-note">
        Use an SSH config <code>Host</code> alias, <code>user@hostname</code>, or an IPv6
        literal. Configure custom ports in <code>~/.ssh/config</code>. Agent keys for Hermes
        use the host id (or optional hermes id). Expand <strong>Services</strong> on a host to
        list its served URLs and open them as canvas pages.
        {isCommandCenter
          ? " On Command Center: Deploy Remote installs/updates Vellum Command on macOS Remotes over SSH when managed installs are allowed. Linux managed deploy is not available in this release. Enroll fresh Remote is for a target that already has a station role staged."
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
                  {host.kind === "local" ? "local" : host.sshEndpoint}
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
                        title="Set up a machine as a Remote once the package is installed — never overwrites an existing role"
                        onClick={() => void configureAsRemote(host.id)}
                      >
                        Enroll fresh Remote
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
              {linuxCapabilities[host.id] ? (
                <LinuxHostCapabilities
                  observation={linuxCapabilities[host.id]}
                  compact
                />
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
                checked={draft.terminal}
                disabled={busy}
                aria-label="Terminal capability"
                onChange={(event) => setDraft((d) => ({ ...d, terminal: event.target.checked }))}
              />
              Terminal
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.browser}
                disabled={busy}
                aria-label="Browser capability"
                onChange={(event) => setDraft((d) => ({ ...d, browser: event.target.checked }))}
              />
              Browser
            </label>
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
        Space / ` cycles actionable node states (blocked first, then attention).
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
        : "Not set yet";
  return (
    <div className="settings-section">
      <FieldRow
        label="Role"
        hint="Chosen during setup"
      >
        <span style={{ color: INK, fontSize: 13 }}>{roleLabel}</span>
      </FieldRow>
      <FieldRow
        label="This machine's host id"
        hint="How this machine is identified across the fleet"
      >
        <span style={{ color: INK, fontSize: 13 }}>{station.hostId}</span>
      </FieldRow>
      {role === "remote" ? (
        <FieldRow
          label="Agent host id"
          hint="Hermes identity installed by the Command Center"
        >
          <span style={{ color: INK, fontSize: 13 }}>
            {station.agentHostId}
          </span>
        </FieldRow>
      ) : null}
      {role === "command-center" ? (
        <FieldRow
          label="Prefer supervised runtime"
          hint="Keep this Command Center alive under the platform supervisor"
        >
          <input
            type="checkbox"
            checked={station.supervisedPreferred}
            aria-label="Prefer supervised runtime"
            onChange={(event) =>
              void setStationTopology({
                supervisedPreferred: event.target.checked,
              })
            }
          />
        </FieldRow>
      ) : null}
      {role === "remote" ? (
        <FieldRow
          label="Configuration authority"
          hint="Remote identity cannot be changed locally"
        >
          <span className="settings-note" style={{ color: DIM }}>
            Managed by the paired Command Center
          </span>
        </FieldRow>
      ) : null}
      {station.role === "" ? (
        <FieldRow
          label="Configuration"
          hint="This machine has no role yet"
        >
          <span className="settings-note" style={{ color: DIM }}>
            Set this machine up as a Command Center, or enroll it from an existing one
          </span>
        </FieldRow>
      ) : (
        <FieldRow
          label="Changing role"
          hint="Roles can't be changed from Settings"
        >
          <span className="settings-note" style={{ color: DIM }}>
            {station.role === "remote"
              ? "This machine's role is managed by its paired Command Center."
              : "Handing the Command Center role to another machine is a separate, explicit operation."}
          </span>
        </FieldRow>
      )}
    </div>
  );
}

function SectionBody({ section }: { readonly section: PanelSection }) {
  switch (section) {
    case "station":
      return <StationSection />;
    case "updates":
      return <UpdatesSection />;
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
    case "license": {
      const api = getVellumApi();
      return api
        ? <LicenseSection api={api} />
        : <p className="settings-error">License service is unavailable.</p>;
    }
  }
}

export function SettingsPanel() {
  const open = use$(state$.settingsOpen);
  const loading = use$(state$.settingsLoading);
  const error = use$(state$.settingsError);
  const settingsVersion = use$(state$.settings.version);
  const appVersion = use$(updateState$.status.currentVersion);
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
              <div className="settings-panel__eyebrow">vellum command</div>
              <strong style={{ color: INK }}>Settings</strong>
            </div>
          </div>
          <div className="settings-panel__header-actions">
            {section !== "hosts" && section !== "license" && section !== "updates" ? (
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
              Vellum Command {appVersion} · settings schema v{settingsVersion} ·
              ~/.vellum/state/vellum.db
            </p>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
