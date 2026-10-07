/**
 * Settings → Agents: scan installed harness CLIs and set spawn defaults.
 * Gated by HARNESS_SETTINGS_ENABLED (ship/prod off).
 */
import { use$ } from "@legendapp/state/react";
import { useCallback, useEffect, useState } from "react";
import type { HarnessId } from "@shared/managed-terminal-templates";
import {
  isHarnessId,
  isSandboxGatedPermissionMode,
  templateFor,
} from "@shared/managed-terminal-templates";
import {
  formatExtraArgs,
  parseExtraArgsText,
  sanitizeExtraArgs,
  type HarnessHelpFlag,
} from "@shared/launch-extra-args";
import type {
  ManagedTerminalHarnessOption,
  ManagedTerminalModelOption,
} from "@shared/ipc";
import { harnessPrefsFor } from "@shared/settings";
import { HUE_TEXT, INK } from "../../lib/theme";
import { state$ } from "../../lib/state";
import { patchSettings, resetSettings } from "../../lib/settings-state";
import { getJuntoApi } from "../../lib/junto-api";
import { Button, Input, Select } from "../ui";
import { FieldRow } from "./FieldRow";

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
      extraArgs?: readonly string[];
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
        <p className="settings-note" style={{ color: HUE_TEXT.crimson }} role="status">
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

                <FieldRow label="Offer in palette" hint="off hides this harness even when the CLI is installed">
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
                </FieldRow>

                <FieldRow
                  group
                  label="Default model"
                  {...(row.modelsError ? { hint: <span style={{ color: HUE_TEXT.crimson }}>{row.modelsError}</span> } : {})}
                >
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
                </FieldRow>

                <FieldRow group label="Default effort">
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
                </FieldRow>

                <FieldRow group label="Default permission mode">
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
                </FieldRow>

                {isHarnessId(row.harness) ? (
                  <ExtraArgsField
                    harness={row.harness}
                    displayName={row.displayName}
                    disabled={!row.installed}
                    stored={prefs.extraArgs}
                    onCommit={(extraArgs) => patchHarness(row.harness, { extraArgs })}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Extra arguments every new seat of this harness starts with, plus the
 * options the installed harness lists so they can be picked instead of
 * remembered. Commits on blur; an existing seat keeps its own arguments and
 * is edited from the seat (Start parameters).
 */
function ExtraArgsField({
  harness,
  displayName,
  disabled,
  stored,
  onCommit,
}: {
  readonly harness: HarnessId;
  readonly displayName: string;
  readonly disabled: boolean;
  readonly stored: readonly string[] | undefined;
  readonly onCommit: (extraArgs: readonly string[]) => void;
}) {
  const storedText = formatExtraArgs(stored);
  const [text, setText] = useState(storedText);
  const [flags, setFlags] = useState<readonly HarnessHelpFlag[] | null>(null);
  useEffect(() => {
    setText(storedText);
  }, [storedText]);
  const sanitized = sanitizeExtraArgs(harness, parseExtraArgsText(text));

  const commit = (next: string): void => {
    const args = sanitizeExtraArgs(harness, parseExtraArgsText(next)).args;
    if (formatExtraArgs(args) !== storedText) onCommit(args);
  };
  const loadFlags = (): void => {
    if (flags !== null) return;
    const load = getJuntoApi()?.managedTerminalFlags?.(harness);
    if (!load) {
      setFlags([]);
      return;
    }
    void load.then((result) => setFlags(result.flags)).catch(() => setFlags([]));
  };
  const add = (flag: HarnessHelpFlag): void => {
    const addition = flag.value ? `${flag.flag} ` : flag.flag;
    const next = text.trim().length > 0 ? `${text.trim()} ${addition}` : addition;
    setText(next);
    if (!flag.value) commit(next);
  };

  return (
    <div className="settings-field">
      <span className="settings-field__label">
        <span>Default extra arguments</span>
      </span>
      <span className="settings-field__control">
        <Input
          value={text}
          disabled={disabled}
          placeholder="--flag value"
          aria-label={`${displayName} default extra arguments`}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => commit(text)}
        />
        {sanitized.rejected.map((item, index) => (
          <span key={`${item.token}-${index}`} className="settings-field__hint" role="alert">
            {item.token} is left out: {item.reason}.
          </span>
        ))}
        {disabled ? null : (
          <details onToggle={(event) => (event.currentTarget.open ? loadFlags() : undefined)}>
            <summary className="settings-field__hint">Options {displayName} accepts</summary>
            {flags === null ? (
              <span className="settings-field__hint">Reading the installed harness…</span>
            ) : flags.length === 0 ? (
              <span className="settings-field__hint">The installed harness listed no options.</span>
            ) : (
              <ul className="settings-harness-flags" aria-label={`${displayName} options`}>
                {flags.map((flag) => (
                  <li key={flag.flag}>
                    <button type="button" title={`Add ${flag.flag}`} onClick={() => add(flag)}>
                      <code>
                        {[flag.flag, ...flag.aliases].join(", ")}
                        {flag.value ? ` ${flag.value}` : ""}
                      </code>
                      <span>{flag.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </details>
        )}
      </span>
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
