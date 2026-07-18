import { use$ } from "@legendapp/state/react";
import { RotateCcw, Settings2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
import "./settings-panel.css";

const SECTIONS: ReadonlyArray<{ key: SettingsSectionKey; label: string; blurb: string }> = [
  { key: "appearance", label: "Appearance", blurb: "theme, density, motion" },
  { key: "canvas", label: "Canvas", blurb: "defaults for the portfolio field" },
  { key: "audio", label: "Audio", blurb: "RTS alert SFX mute and levels" },
  { key: "kernel", label: "Kernel", blurb: "pulse retention and debug" },
  { key: "browser", label: "Browser", blurb: "surface and warm-session limits" },
  { key: "advanced", label: "Advanced", blurb: "startup and recovery prefs" },
];

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
  return (
    <div className="settings-section">
      <FieldRow label="Max visible surfaces" hint="dock slots (hard ceiling 8)">
        <input
          type="number"
          min={1}
          max={8}
          value={browser.maxVisibleSurfaces}
          aria-label="Max visible surfaces"
          onChange={(event) => {
            const value = Number(event.target.value);
            if (!Number.isFinite(value)) return;
            void patchSettings({ browser: { maxVisibleSurfaces: Math.floor(value) } });
          }}
        />
      </FieldRow>
      <FieldRow label="Max warm sessions" hint="warm WebContents pool (hard ceiling 32)">
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
      <p className="settings-note">
        Profile registry (personal/work partitions) stays under browser profiles — not here.
      </p>
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

function AudioSection() {
  const audio = use$(state$.settings.audio);
  return (
    <div className="settings-section">
      <p className="settings-note">
        Space / ` cycles the attention queue (permission → blocked → herdr done → booth → orphan).
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

function SectionBody({ section }: { readonly section: SettingsSectionKey }) {
  switch (section) {
    case "appearance":
      return <AppearanceSection />;
    case "canvas":
      return <CanvasSection />;
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
  const [section, setSection] = useState<SettingsSectionKey>("appearance");

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
