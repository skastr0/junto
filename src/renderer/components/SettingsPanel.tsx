import { use$ } from "@legendapp/state/react";
import { RotateCcw, Search, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { BrowserProfileInfo, JuntoBrowserApi } from "@shared/ipc";
import { DEFAULT_INTERFACE_SCALE, INTERFACE_SCALES, interfaceScaleOf, type SettingsSectionKey } from "@shared/settings";
import {
  AUDIO_ENABLED,
  BROWSER_ENABLED,
  DEV_TOOLS_ENABLED,
  FLEET_UI_ENABLED,
  HARNESS_SETTINGS_ENABLED,
  HERMES_INTEGRATION_ENABLED,
  LIVE_OVERSEER_ENABLED,
  USAGE_ENABLED,
  experimentalFeatureKeys,
} from "@shared/features";
import { ExperimentalSettingsSection } from "./settings/ExperimentalSettingsSection";
import { FieldRow } from "./settings/FieldRow";
import { searchSettings, settingsIndex, type SettingHit } from "./settings/search-index";
import { CompanionSettingsSection } from "./settings/CompanionSettingsSection";
import { HarnessesSettingsSection } from "./settings/HarnessesSettingsSection";
import { ProvidersSettingsSection } from "./settings/ProvidersSettingsSection";
import { KeyboardSettingsSection } from "./settings/KeyboardSettingsSection";
import { QuickRepliesSettingsSection } from "./settings/QuickRepliesSettingsSection";
import { NotificationSettingsSection } from "./settings/NotificationSettingsSection";
import { OffboardSettingsSection } from "./settings/OffboardSettingsSection";
import { SoundSettingsSection } from "./settings/SoundSettingsSection";
import { TerminalSettingsSection } from "./settings/TerminalSettingsSection";
import {
  decodeStateBackupId,
  type StateBackupId,
  type StateBackupInventoryEntry,
} from "@shared/state-recovery";
import { isCommandCenterFleetUi } from "../lib/canvas-boot";
import { state$ } from "../lib/state";
import {
  closeSettings,
  patchSettings,
  resetSettings,
  setStationTopology,
} from "../lib/settings-state";
import { openIntro } from "../lib/first-run-intro";
import {
  checkForUpdates,
  restartAndInstallUpdate,
  updateState$,
} from "../lib/update-state";
import { HUE, INK, themeFor } from "../lib/theme";
import { getJuntoApi } from "../lib/junto-api";
import { FocusSurface } from "./FocusSurface";
import { Button, ConfirmDialog, Eyebrow, IconButton, Input, OverlayHeader, Select } from "./ui";
import "./settings-panel.css";

/**
 * Settings sections: preferences, the app update panel, and the experimental
 * features (stored under advanced, shown on their own tab).
 */
type PanelSection = SettingsSectionKey | "updates" | "experimental" | "companion";

const PROVIDERS_SECTION_ENABLED =
  USAGE_ENABLED || LIVE_OVERSEER_ENABLED || HERMES_INTEGRATION_ENABLED;

/** The section list's groups, in the order they are listed. */
const SECTION_GROUPS = ["You", "Agents", "App"] as const;
type SectionGroup = (typeof SECTION_GROUPS)[number];

type SectionItem = {
  readonly key: PanelSection;
  readonly group: SectionGroup;
  readonly label: string;
  readonly blurb: string;
};

const SECTIONS: ReadonlyArray<SectionItem> = [
  { key: "appearance", group: "You", label: "Appearance", blurb: "" },
  { key: "terminal", group: "You", label: "Terminal", blurb: "scrolling, font, and accessibility" },
  { key: "keyboard", group: "You", label: "Keyboard shortcuts", blurb: "every shortcut, and the keys you chose" },
  ...(AUDIO_ENABLED
    ? [{ key: "audio", group: "You", label: "Sound", blurb: "levels for each kind of sound, and a preview" } as const]
    : []),
  {
    key: "notifications",
    group: "You",
    label: "Notifications",
    blurb: "what reaches you while Junto is in the background",
  },
  { key: "feed", group: "Agents", label: "Quick replies", blurb: "one-click answers for agents waiting on you" },
  { key: "offboard", group: "Agents", label: "Offboard", blurb: "when an idle agent's session is ended for it" },
  ...(HARNESS_SETTINGS_ENABLED
    ? [
        {
          key: "harnesses",
          group: "Agents",
          label: "Agents",
          blurb: "scan CLIs and set spawn defaults per harness",
        } as const,
      ]
    : []),
  // Usage credentials, the voice provider, and Hermes host access. Each is
  // flag-gated inside the section; with all three off there is nothing to show.
  ...(PROVIDERS_SECTION_ENABLED
    ? [
        {
          key: "providers",
          group: "Agents",
          label: "Providers",
          blurb: USAGE_ENABLED
            ? "usage credentials: API keys, tokens, cookies"
            : "access to outside providers",
        } as const,
      ]
    : []),
  { key: "companion", group: "Agents", label: "Companion", blurb: "answer your agents from your phone" },
  { key: "updates", group: "App", label: "Updates", blurb: "check and install app updates" },
  ...(BROWSER_ENABLED
    ? [{ key: "browser", group: "App", label: "Browser", blurb: "surface and warm-session limits" } as const]
    : []),
  // Machine/station topology is fleet-adjacent (host id, supervised runtime).
  ...(FLEET_UI_ENABLED
    ? [{ key: "station", group: "App", label: "Machine", blurb: "this installation" } as const]
    : []),
  // Built and in the app, off until turned on here. Absent when this build
  // ships nothing experimental.
  ...(experimentalFeatureKeys().length > 0
    ? [
        {
          key: "experimental",
          group: "App",
          label: "Experimental",
          blurb: "built, not yet fully available",
        } as const,
      ]
    : []),
  {
    key: "advanced",
    group: "App",
    label: "Advanced",
    blurb: DEV_TOOLS_ENABLED
      ? "startup, recovery, developer tools"
      : "startup and recovery",
  },
];

/** Prefer first nav item when Machine is fleet-gated out. */
const DEFAULT_SETTINGS_SECTION: PanelSection = FLEET_UI_ENABLED
  ? "station"
  : "appearance";

/**
 * Supervisor preference tradeoffs. Checkbox only records intent — install is
 * separate (packaged supervised install / app:install:supervised). See
 * assessSupervisedRuntime + ensureSupervised handoff.
 */
const SUPERVISED_RUNTIME_HELP =
  "Records whether this installation prefers a platform supervisor " +
  "(macOS LaunchAgent; Linux Remote systemd user unit) to own the long-running " +
  "process — auto-restart after crashes and keep-alive across logout/reboot. " +
  "This toggle does not install or remove the supervisor; install supervised " +
  "startup via the packaged installer or `bun run app:install:supervised`. " +
  "Doctor warns if preference and actual LaunchAgent/unit state disagree. " +
  "Tradeoff: supervised is more durable for a Command Center or Remote left " +
  "running unattended; unsupervised is simpler for local development and " +
  "attaching a debugger.";

type ThemeChoice = "system" | "dark" | "bright";

/** Mini in-button palette so the choice is the preview — no extra copy block. */
function ThemeModePreview({ mode }: { readonly mode: "dark" | "bright" }) {
  const palette = themeFor(mode);
  return (
    <span
      className="settings-theme-preview"
      aria-hidden
      style={{
        background: palette.ground,
        borderColor: palette.stroke,
      }}
    >
      <span
        className="settings-theme-preview__raise"
        style={{ background: palette.raise, borderColor: palette.stroke }}
      >
        <span
          className="settings-theme-preview__ink"
          style={{ background: palette.ink }}
        />
        <span
          className="settings-theme-preview__amber"
          style={{ background: palette.amber }}
        />
      </span>
    </span>
  );
}

function ThemeModeButton({
  choice,
  label,
  active,
  onSelect,
}: {
  readonly choice: ThemeChoice;
  readonly label: string;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={label}
      className={`settings-theme-mode${active ? " is-active" : ""}`}
      onClick={onSelect}
    >
      {choice === "system" ? (
        <span className="settings-theme-preview settings-theme-preview--split" aria-hidden>
          <span className="settings-theme-preview__half">
            <ThemeModePreview mode="dark" />
          </span>
          <span className="settings-theme-preview__half">
            <ThemeModePreview mode="bright" />
          </span>
        </span>
      ) : (
        <ThemeModePreview mode={choice} />
      )}
      <span className="settings-theme-mode__label">{label}</span>
    </button>
  );
}

function AppearanceSection() {
  const appearance = use$(state$.settings.appearance);
  const modes = [
    { key: "system" as const, label: "Auto" },
    { key: "dark" as const, label: "Dark" },
    { key: "bright" as const, label: "Bright" },
  ];
  const agentAppearance = appearance.agentAppearance ?? "follow";
  const interfaceScale = interfaceScaleOf({ appearance });
  return (
    <div className="settings-section">
      <div className="settings-theme-modes" role="radiogroup" aria-label="Theme">
        {modes.map((mode) => (
          <ThemeModeButton
            key={mode.key}
            choice={mode.key}
            label={mode.label}
            active={appearance.theme === mode.key}
            onSelect={() =>
              void patchSettings({ appearance: { theme: mode.key } })
            }
          />
        ))}
      </div>
      <div style={{ marginTop: 20 }}>
        <Eyebrow>Interface size</Eyebrow>
        <p id="settings-interface-size-hint" className="settings-field__hint" style={{ marginTop: 6 }}>
          Makes everything in Junto larger or smaller together: text, buttons and spacing. The canvas keeps its own zoom.
        </p>
        <div
          role="radiogroup"
          aria-label="Interface size"
          aria-describedby="settings-interface-size-hint"
          style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}
        >
          {INTERFACE_SCALES.map((scale) => {
            const active = interfaceScale === scale;
            return (
              <button
                key={scale}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={`${String(scale)} percent${scale === DEFAULT_INTERFACE_SCALE ? ", standard" : ""}`}
                data-testid={`interface-size-${String(scale)}`}
                className={`settings-theme-mode${active ? " is-active" : ""}`}
                style={{ padding: "8px 14px" }}
                onClick={() => void patchSettings({ appearance: { interfaceScale: scale } })}
              >
                <span className="settings-theme-mode__label">{scale}%</span>
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ marginTop: 20 }}>
        <Eyebrow>Managed agent appearance</Eyebrow>
        <div
          role="radiogroup"
          aria-label="Managed agent appearance"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginTop: 10,
          }}
        >
          {(
            [
              {
                key: "follow" as const,
                label: "Follow Junto",
                hint: "Recommended. Terminals use Junto colours and the live appearance protocol.",
              },
              {
                key: "agent" as const,
                label: "Use agent theme",
                hint: "Do not re-paint mid-session over agent colours. Either way, a seat starts exactly as the harness would when you run it yourself.",
              },
            ] as const
          ).map((opt) => {
            const active = agentAppearance === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                role="radio"
                aria-checked={active}
                className={`settings-theme-mode${active ? " is-active" : ""}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  textAlign: "left",
                  padding: "10px 12px",
                  gap: 4,
                }}
                onClick={() =>
                  void patchSettings({
                    appearance: { agentAppearance: opt.key },
                  })
                }
              >
                <span className="settings-theme-mode__label">{opt.label}</span>
                <span className="settings-field__hint">{opt.hint}</span>
              </button>
            );
          })}
        </div>
      </div>
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
  type BrowserApi = ReturnType<typeof getJuntoApi> & Partial<JuntoBrowserApi>;

  const loadProfiles = useCallback(async () => {
    const api = getJuntoApi() as BrowserApi | undefined;
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
    const api = getJuntoApi() as BrowserApi | undefined;
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
          : `Profile ${result.data.profileId} is isolated. Restart Junto to finish disk removal.`,
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
              <small>{profile.id}{profile.default ? " - default" : ""}</small>
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
      const api = getJuntoApi();
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
    const api = getJuntoApi();
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
      <FieldRow
        group
        label="Introduction"
        hint="the short tour from first launch: what Junto is, how to start an agent, and why macOS may name Junto"
      >
        <Button
          size="sm"
          onClick={() => {
            closeSettings();
            openIntro();
          }}
        >
          show again
        </Button>
      </FieldRow>
      {DEV_TOOLS_ENABLED ? (
        <FieldRow
          label="Logs explorer"
          hint="show the developer logs panel in the top bar"
        >
          <input
            type="checkbox"
            checked={advanced.logsExplorer}
            aria-label="Logs explorer"
            onChange={(event) => {
              const enabled = event.target.checked;
              void patchSettings({ advanced: { logsExplorer: enabled } });
              if (!enabled) state$.observabilityOpen.set(false);
            }}
          />
        </FieldRow>
      ) : null}
      <FieldRow
        label="Agent tool directories"
        hint="extra directories searched for agent CLIs, one per line. Detection and launch share this list. No login shell is run."
      >
        <textarea
          className="settings-tool-directories"
          aria-label="Agent tool directories"
          rows={3}
          spellCheck={false}
          defaultValue={(advanced.toolDirectories ?? []).join("\n")}
          key={(advanced.toolDirectories ?? []).join("\n")}
          onBlur={(event) => {
            const next = event.target.value
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0);
            void patchSettings({ advanced: { toolDirectories: next } });
          }}
        />
      </FieldRow>
      {usesAppleLoginItems ? (
        <FieldRow label="Start Junto at login" hint="macOS Login Items">
          <input type="checkbox" checked={openAtLogin} disabled={loginItemLoading || loginItemBusy} aria-label="Start Junto at login" onChange={(event) => void onToggleLoginItem(event.target.checked)} />
        </FieldRow>
      ) : startupProvider === "systemd-supervision" ? (
        <FieldRow group label="Startup" hint="Remotes on Linux run as a systemd user service.">
          <span className="settings-field__value" aria-label="Systemd user supervision">systemd user</span>
        </FieldRow>
      ) : (
        <FieldRow group label="Startup" hint="Not available on this platform.">
          <span className="settings-field__value">unavailable</span>
        </FieldRow>
      )}
      {loginItemError ? (
        <p className="settings-note" style={{ color: HUE.crimson }} role="alert">
          {loginItemError}
        </p>
      ) : null}
      <StateRecoveryControls />
    </div>
  );
}

function InstallationFacts() {
  const status = use$(updateState$.status);
  const station = use$(state$.settings.station);
  const install = status.install;
  const platformLabel =
    install === undefined
      ? "—"
      : DEV_TOOLS_ENABLED
        ? `${install.platform}/${install.arch} - electron ${install.electronVersion}`
        : `${install.platform}/${install.arch}`;
  const buildLabel =
    install === undefined
      ? "—"
      : install.packaged
        ? `packaged - ${install.providerKind} updater`
        : "development";
  const feedLabel =
    install?.feedUrl !== undefined && install.feedUrl.length > 0
      ? install.feedUrl
      : install?.packaged
        ? "no feed for this platform"
        : "—";

  return (
    <div className="settings-install-facts" aria-label="Installation identity">
      <div className="settings-install-facts__head">
        <span>Installation</span>
        <span>
          {DEV_TOOLS_ENABLED
            ? "App version and release provenance. Check for updates lives under Updates."
            : "App version and platform for this installation."}
        </span>
      </div>
      <FieldRow group label="App version" hint="currently running Junto">
        <span style={{ color: INK, fontSize: "var(--text-body-lg)" }}>{status.currentVersion}</span>
      </FieldRow>
      {DEV_TOOLS_ENABLED ? (
        <FieldRow group label="Build" hint="packaged vs development">
          <span style={{ color: INK, fontSize: "var(--text-body-lg)" }}>{buildLabel}</span>
        </FieldRow>
      ) : null}
      <FieldRow
        group
        label="Platform"
        hint={DEV_TOOLS_ENABLED ? "OS, architecture, Electron runtime" : "OS and architecture"}
      >
        <span style={{ color: INK, fontSize: "var(--text-body-lg)" }}>{platformLabel}</span>
      </FieldRow>
      {DEV_TOOLS_ENABLED ? (
        <>
          <FieldRow group label="Update feed" hint="packaged release channel only">
            <span
              className="settings-mono-value"
              style={{ color: INK, fontSize: "var(--text-body-lg)" }}
              title={install?.feedUrl}
            >
              {feedLabel}
            </span>
          </FieldRow>
          <FieldRow group label="Host id" hint="this machine across the fleet">
            <span style={{ color: INK, fontSize: "var(--text-body-lg)" }}>
              {station.hostId.length > 0 ? station.hostId : "—"}
            </span>
          </FieldRow>
          <FieldRow group label="Data location" hint="where Junto stores its data">
            <span className="settings-mono-value" style={{ color: INK, fontSize: "var(--text-body-lg)" }}>
              ~/.junto/state/junto.db
            </span>
          </FieldRow>
        </>
      ) : null}
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
      <FieldRow group label="Installed version" hint="currently running Junto">
        <span style={{ color: INK, fontSize: "var(--text-body-lg)" }}>{status.currentVersion}</span>
      </FieldRow>
      <FieldRow group label="Application updates" hint={summary}>
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
        <p className="settings-note" style={{ color: HUE.crimson }} role="alert">
          {localError ?? status.error?.message}
        </p>
      ) : null}
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
  return `${timestamp} UTC - ${formatBackupBytes(backup.bytes)} - schema ${backup.schemaVersion}`;
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
    const api = getJuntoApi();
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
        message: "Junto could not read verified state backups.",
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
    const api = getJuntoApi();
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
        message: "Junto could not export the verified state backup.",
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
          group
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

function StationSection() {
  const station = use$(state$.settings.station);
  const fleet = use$(state$.settings.fleet);
  // Fleet UI: host identity, managed installs, and supervisor preference.
  // Command Center–driven, not a free-form Settings form.
  if (!FLEET_UI_ENABLED || !isCommandCenterFleetUi(station.role)) return null;
  return (
    <div className="settings-section" data-testid="settings-machine-section">
      <FieldRow
        group
        label="This machine's host id"
        hint="How this installation is identified across the fleet"
      >
        <span style={{ color: INK, fontSize: "var(--text-body-lg)" }}>{station.hostId}</span>
      </FieldRow>
      <FieldRow
        label="Allow remote managed installs"
        hint="Deploy and update Junto on enrolled Remotes. Off until you opt in; an old default-on value is not treated as consent."
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
      <FieldRow
        label="Prefer supervised runtime"
        hint="Preference only — does not install the supervisor"
        help={SUPERVISED_RUNTIME_HELP}
      >
        <input
          type="checkbox"
          checked={station.supervisedPreferred}
          aria-label="Prefer supervised runtime"
          disabled={station.role !== "command-center" && station.role !== ""}
          onChange={(event) =>
            void setStationTopology({
              supervisedPreferred: event.target.checked,
            })
          }
        />
      </FieldRow>
      <p className="settings-note" role="note">
        Supervisor install is separate from this checkbox. Packaged installs can
        enable LaunchAgent/systemd; Doctor reports when preference and actual
        supervisor state disagree.
      </p>
    </div>
  );
}

function SectionBody({ section }: { readonly section: PanelSection }) {
  switch (section) {
    case "appearance":
      return <AppearanceSection />;
    case "terminal":
      return <TerminalSettingsSection />;
    case "feed":
      return <QuickRepliesSettingsSection />;
    case "keyboard":
      return <KeyboardSettingsSection />;
    case "notifications":
      return <NotificationSettingsSection />;
    case "offboard":
      return <OffboardSettingsSection />;
    case "station":
      return <StationSection />;
    case "updates":
      return <UpdatesSection />;
    case "audio":
      return AUDIO_ENABLED ? <SoundSettingsSection /> : null;
    case "browser":
      return BROWSER_ENABLED ? <BrowserSection /> : null;
    case "harnesses":
      return HARNESS_SETTINGS_ENABLED ? <HarnessesSettingsSection /> : null;
    case "providers":
      return PROVIDERS_SECTION_ENABLED ? <ProvidersSettingsSection /> : null;
    case "experimental":
      return <ExperimentalSettingsSection />;
    case "companion":
      return <CompanionSettingsSection />;
    case "advanced":
      return <AdvancedSection />;
    case "kernel":
    case "canvas":
      return null;
  }
}

/**
 * Sections the header's reset acts on. The rest either store nothing here
 * (updates, experimental, companion) or are refused by main (Machine).
 */
const resettableSection = (section: PanelSection): SettingsSectionKey | undefined =>
  section === "updates" || section === "experimental" || section === "companion" || section === "station"
    ? undefined
    : section;

/** How long a setting stays marked after search brought it into view. */
const FOUND_MARK_MS = 1_800;

export function SettingsPanel() {
  const open = use$(state$.settingsOpen);
  const loading = use$(state$.settingsLoading);
  const error = use$(state$.settingsError);
  const [section, setSection] = useState<PanelSection>(DEFAULT_SETTINGS_SECTION);
  // The section a reset was asked for, until the operator answers.
  const [resetAsk, setResetAsk] = useState<SettingsSectionKey | undefined>(undefined);
  const [resetting, setResetting] = useState(false);
  const [query, setQuery] = useState("");
  const [activeHit, setActiveHit] = useState(0);
  // The setting search just opened, until its row is found and marked.
  const [found, setFound] = useState<string | undefined>(undefined);
  const contentRef = useRef<HTMLDivElement>(null);
  const resultsId = useId();

  const stationRole = use$(state$.settings.station.role);
  const sections = useMemo(
    () => SECTIONS.filter((item) => item.key !== "station" || isCommandCenterFleetUi(stationRole)),
    [stationRole],
  );
  const hits = useMemo(
    () =>
      searchSettings(
        settingsIndex(sections.map((item) => item.key)),
        Object.fromEntries(sections.map((item) => [item.key, item.label])),
        query,
      ),
    [sections, query],
  );

  // Bring the found setting's row into view and mark it for a moment.
  useEffect(() => {
    if (found === undefined || loading) return;
    const row = Array.from(
      contentRef.current?.querySelectorAll<HTMLElement>("[data-setting]") ?? [],
    ).find((element) => element.dataset.setting === found);
    if (!row) {
      contentRef.current?.scrollTo({ top: 0 });
      setFound(undefined);
      return;
    }
    row.scrollIntoView({ block: "center" });
    row.dataset.found = "";
    const timer = window.setTimeout(() => {
      delete row.dataset.found;
      setFound(undefined);
    }, FOUND_MARK_MS);
    return () => {
      window.clearTimeout(timer);
      delete row.dataset.found;
    };
  }, [found, section, loading]);

  if (!open) return null;

  // Fleet-gated Machine may be absent — always render a nav-visible section.
  const activeSection: PanelSection = sections.some((item) => item.key === section)
    ? section
    : (sections[0]?.key ?? "appearance");
  const meta =
    sections.find((item) => item.key === activeSection) ?? sections[0]!;
  const resettable = resettableSection(activeSection);
  const searching = query.trim().length > 0;
  const shownHit = Math.min(activeHit, Math.max(0, hits.length - 1));
  const hitId = (index: number): string => `${resultsId}-${String(index)}`;

  const openHit = (hit: SettingHit): void => {
    setSection(hit.section as PanelSection);
    setQuery("");
    setActiveHit(0);
    setFound(hit.name);
  };

  return (
    <FocusSurface
      measure="terminal"
      height="immersive"
      label="Settings"
      panelClassName="settings-panel"
      onClose={closeSettings}
    >
      <OverlayHeader
        className="settings-panel__header"
        eyebrow="Junto"
        title="Settings"
        actions={
          <>
            {resettable && !searching ? (
              <Button
                variant="subtle"
                size="sm"
                title={`Reset ${meta.label} to defaults`}
                aria-label={`Reset ${meta.label}`}
                onClick={() => setResetAsk(resettable)}
              >
                <RotateCcw size={12} aria-hidden />
                reset {meta.label}
              </Button>
            ) : null}
            <IconButton className="settings-panel__close" aria-label="Close settings" onClick={closeSettings}>
              <X size={15} />
            </IconButton>
          </>
        }
      />

      <div className="settings-panel__body">
        <div className="settings-side">
          <div className="settings-search">
            <Search size={13} aria-hidden className="settings-search__glyph" />
            <Input
              // Opening Settings puts the keyboard in search.
              data-autofocus=""
              type="search"
              role="combobox"
              className="settings-search__input"
              placeholder="Search settings"
              aria-label="Search settings"
              aria-expanded={searching}
              aria-controls={resultsId}
              aria-activedescendant={searching && hits.length > 0 ? hitId(shownHit) : undefined}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveHit(0);
              }}
              onKeyDown={(event) => {
                if (!searching) return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  if (hits.length === 0) return;
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  setActiveHit((shownHit + step + hits.length) % hits.length);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const hit = hits[shownHit];
                  if (hit) openHit(hit);
                } else if (event.key === "Escape") {
                  // Escape clears the search first; the next one closes Settings.
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery("");
                }
              }}
            />
          </div>
          <nav className="settings-nav" aria-label="Settings sections">
            {SECTION_GROUPS.map((group) => {
              const items = sections.filter((item) => item.group === group);
              if (items.length === 0) return null;
              return (
                <div key={group} className="settings-nav__group" role="group" aria-label={group}>
                  <div className="settings-nav__group-label" aria-hidden>
                    {group}
                  </div>
                  {items.map((item) => {
                    const current = !searching && activeSection === item.key;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        className={`settings-nav__item${current ? " is-active" : ""}`}
                        aria-current={current ? "page" : undefined}
                        onClick={() => {
                          setQuery("");
                          setSection(item.key);
                        }}
                      >
                        <span className="settings-nav__label">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </nav>
        </div>
        <div className="settings-content" ref={contentRef}>
          {/* Always mounted, so the search field can name it. */}
          <div
            id={resultsId}
            role="listbox"
            aria-label="Settings found"
            className="settings-page settings-results"
            hidden={!searching}
          >
            {searching ? (
              <>
                <div className="settings-content__head">
                  <h2>
                    {hits.length === 0
                      ? "No setting found"
                      : `${String(hits.length)} ${hits.length === 1 ? "setting" : "settings"}`}
                  </h2>
                  <p>
                    {hits.length === 0
                      ? "Try a setting's name, a word from its description, or the name of a page."
                      : "Enter opens the marked one."}
                  </p>
                </div>
                {hits.map((hit, index) => (
                  <button
                    key={`${hit.section}:${hit.name}`}
                    id={hitId(index)}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === shownHit}
                    className="settings-result"
                    onMouseMove={() => setActiveHit(index)}
                    onClick={() => openHit(hit)}
                  >
                    <span className="settings-result__name">{hit.name}</span>
                    <span className="settings-result__page">{hit.sectionLabel}</span>
                    <span className="settings-result__about">{hit.description}</span>
                  </button>
                ))}
              </>
            ) : null}
          </div>
          {searching ? null : (
            <div className="settings-page">
              <div className="settings-content__head">
                <h2>{meta.label}</h2>
                {meta.blurb ? <p>{meta.blurb}</p> : null}
              </div>
              {loading ? (
                <p className="settings-note">loading…</p>
              ) : (
                <SectionBody section={activeSection} />
              )}
              {error ? (
                <p className="settings-error" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          )}
        </div>
      </div>
      {resetAsk ? (
        <ConfirmDialog
          title={`Reset ${meta.label}?`}
          confirmLabel={`Reset ${meta.label}`}
          busy={resetting}
          testId="settings-reset-confirm"
          onCancel={() => setResetAsk(undefined)}
          onConfirm={() => {
            setResetting(true);
            void resetSettings(resetAsk).finally(() => {
              setResetting(false);
              setResetAsk(undefined);
            });
          }}
        >
          {resetAsk === "providers" ? (
            <p>Every stored provider key is deleted and must be entered again. The other Providers settings go back to their defaults.</p>
          ) : (
            <p>Every setting in {meta.label} goes back to its default.</p>
          )}
          <p>This cannot be undone.</p>
        </ConfirmDialog>
      ) : null}
    </FocusSurface>
  );
}
