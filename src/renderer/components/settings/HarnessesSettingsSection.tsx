/**
 * Settings → Agents: scan installed harness CLIs and set spawn defaults.
 * Gated by HARNESS_SETTINGS_ENABLED (ship/prod off).
 */
import { use$ } from "@legendapp/state/react";
import { useCallback, useEffect, useState } from "react";
import type { HarnessId } from "@shared/managed-terminal-templates";
import { isSandboxGatedPermissionMode, templateFor } from "@shared/managed-terminal-templates";
import type {
  ManagedTerminalHarnessOption,
  ManagedTerminalModelOption,
} from "@shared/ipc";
import { harnessPrefsFor } from "@shared/settings";
import { HUE, INK } from "../../lib/theme";
import { state$ } from "../../lib/state";
import { patchSettings, resetSettings } from "../../lib/settings-state";
import { getJuntoApi } from "../../lib/junto-api";
import { Button, Select } from "../ui";

type HarnessScan = ManagedTerminalHarnessOption & {
  readonly models: readonly ManagedTerminalModelOption[];
  readonly efforts: readonly string[];
  readonly modelsError?: string;
};

const DEFAULT_OPTION = { value: "", label: "Product default" };

export function HarnessesSettingsSection() {
  const settings = use$(state$.settings);
  const [scan, setScan] = useState<readonly HarnessScan[] | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const api = getJuntoApi();
    if (!api?.managedTerminalHarnesses) {
      setError("Harness scan API unavailable.");
      setScan([]);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const { harnesses } = await api.managedTerminalHarnesses();
      const rows: HarnessScan[] = [];
      for (const row of harnesses) {
        let models: readonly ManagedTerminalModelOption[] = [];
        let efforts: readonly string[] = [];
        let modelsError: string | undefined;
        if (row.installed && api.managedTerminalModels) {
          try {
            const result = await api.managedTerminalModels(row.harness);
            models = result.models;
            efforts = result.efforts;
            modelsError = result.error;
          } catch (err) {
            modelsError =
              err instanceof Error ? err.message : "model scan failed";
          }
        }
        // Template efforts when enumeration is empty.
        if (efforts.length === 0) {
          try {
            efforts = templateFor(row.harness as HarnessId).efforts;
          } catch {
            /* unknown harness id — skip template */
          }
        }
        rows.push({ ...row, models, efforts, modelsError });
      }
      setScan(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setScan([]);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const patchHarness = (
    harness: string,
    patch: {
      enabled?: boolean;
      model?: string;
      effort?: string;
      permissionMode?: string;
    },
  ): void => {
    void patchSettings({
      harnesses: {
        byHarness: {
          [harness]: patch,
        },
      },
    });
  };

  return (
    <div className="settings-section" aria-label="Agent harness configuration">
      <div className="settings-profile-list__head">
        <span>Agent harnesses</span>
        <span>
          Scan this machine for installed agent CLIs, then set the default
          model, effort, and permission mode used when you place a seat. Leave
          fields on product default to keep cascade picker behaviour.
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 12 }}>
        <Button
          variant="chrome"
          size="sm"
          disabled={busy}
          onClick={() => void refresh()}
          aria-label="Rescan installed agent CLIs"
        >
          {busy ? "Scanning…" : "Rescan"}
        </Button>
        <Button
          variant="subtle"
          size="sm"
          disabled={busy}
          onClick={() => void resetSettings("harnesses")}
        >
          Reset agent defaults
        </Button>
      </div>

      {error ? (
        <p className="settings-note" style={{ color: HUE.crimson }} role="status">
          {error}
        </p>
      ) : null}

      {scan === null ? (
        <p className="settings-note">scanning installed agents…</p>
      ) : scan.length === 0 ? (
        <p className="settings-note">
          No feature-enabled harnesses in this build. Enable harness flags or
          use an all-on profile to configure seats.
        </p>
      ) : (
        <ul className="settings-harness-list" role="list">
          {scan.map((row) => {
            const prefs = harnessPrefsFor(settings, row.harness);
            const template = (() => {
              try {
                return templateFor(row.harness as HarnessId);
              } catch {
                return undefined;
              }
            })();
            const permissionModes =
              template?.defaultPermissionMode !== undefined
                ? [template.defaultPermissionMode]
                : [];
            // Known permission enums from templates (extend as harnesses expose them).
            const permissionOptions = uniqueStrings([
              ...permissionModes,
              ...(prefs.permissionMode ? [prefs.permissionMode] : []),
              "default",
              "acceptEdits",
              "plan",
              "bypassPermissions",
              "yolo",
              "normal",
            ]).filter(
              (mode) =>
                row.harness !== "devin" || !isSandboxGatedPermissionMode(mode),
            );

            return (
              <li
                key={row.harness}
                className="settings-harness-card"
                data-installed={row.installed ? "true" : "false"}
              >
                <div className="settings-harness-card__head">
                  <strong style={{ color: INK }}>{row.displayName}</strong>
                  <span className="settings-field__hint">
                    {row.installed
                      ? `CLI ${row.binary} — installed`
                      : `CLI ${row.binary} — not found on PATH`}
                  </span>
                </div>

                <label className="settings-field">
                  <span className="settings-field__label">
                    <span>Offer in palette</span>
                    <span className="settings-field__hint">
                      off hides this harness even when the CLI is installed
                    </span>
                  </span>
                  <span className="settings-field__control">
                    <input
                      type="checkbox"
                      checked={prefs.enabled !== false}
                      disabled={!row.installed}
                      aria-label={`Offer ${row.displayName} in palette`}
                      onChange={(event) =>
                        patchHarness(row.harness, {
                          enabled: event.target.checked,
                        })
                      }
                    />
                  </span>
                </label>

                <label className="settings-field">
                  <span className="settings-field__label">
                    <span>Default model</span>
                    {row.modelsError ? (
                      <span className="settings-field__hint" style={{ color: HUE.crimson }}>
                        {row.modelsError}
                      </span>
                    ) : null}
                  </span>
                  <span className="settings-field__control">
                    <Select
                      dense
                      disabled={!row.installed}
                      value={prefs.model ?? ""}
                      aria-label={`${row.displayName} default model`}
                      options={[
                        DEFAULT_OPTION,
                        ...row.models.map((m) => ({
                          value: m.id,
                          label: m.label,
                        })),
                        // Keep a saved custom id selectable even if scan missed it.
                        ...(prefs.model &&
                        !row.models.some((m) => m.id === prefs.model)
                          ? [{ value: prefs.model, label: prefs.model }]
                          : []),
                      ]}
                      onChange={(value) =>
                        patchHarness(row.harness, { model: value })
                      }
                    />
                  </span>
                </label>

                <label className="settings-field">
                  <span className="settings-field__label">
                    <span>Default effort</span>
                  </span>
                  <span className="settings-field__control">
                    <Select
                      dense
                      disabled={!row.installed || row.efforts.length === 0}
                      value={prefs.effort ?? ""}
                      aria-label={`${row.displayName} default effort`}
                      options={[
                        DEFAULT_OPTION,
                        ...row.efforts.map((e) => ({ value: e, label: e })),
                      ]}
                      onChange={(value) =>
                        patchHarness(row.harness, { effort: value })
                      }
                    />
                  </span>
                </label>

                <label className="settings-field">
                  <span className="settings-field__label">
                    <span>Default permission mode</span>
                  </span>
                  <span className="settings-field__control">
                    <Select
                      dense
                      disabled={!row.installed}
                      value={prefs.permissionMode ?? ""}
                      aria-label={`${row.displayName} default permission mode`}
                      options={[
                        DEFAULT_OPTION,
                        ...permissionOptions.map((p) => ({
                          value: p,
                          label: p,
                        })),
                      ]}
                      onChange={(value) =>
                        patchHarness(row.harness, { permissionMode: value })
                      }
                    />
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const uniqueStrings = (values: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const t = value.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
};
