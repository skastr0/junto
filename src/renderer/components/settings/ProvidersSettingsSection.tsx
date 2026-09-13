/**
 * Settings -> Providers: operator-configured usage credentials.
 *
 * One card per configurable provider. Every field is a secret input with a
 * reveal toggle; values write through settingsPatch like any other settings
 * section, so the StateEngine row stays the only copy. The renderer never
 * receives raw secrets: main projects them through redactProvidersForIpc,
 * so a configured field reads back as MASKED_SECRET ("********"). Commit
 * rules mirror the Terminal section - nothing partial is ever sent:
 *   - blur / Enter commits the typed value (trimmed)
 *   - an emptied field clears the stored secret
 *   - an untouched masked row is never sent back, so it cannot clobber
 *     the stored value
 */
import { use$ } from "@legendapp/state/react";
import { useEffect, useState } from "react";
import { Eye, EyeOff, X } from "lucide-react";
import {
  LIVE_SETTINGS_BOUNDS,
  LIVE_VOICE_USD_PER_MINUTE,
  MASKED_SECRET,
  liveCallLimitSeconds,
  liveSettings,
  type ProviderSectionKey,
} from "@shared/settings";
import { HERMES_INTEGRATION_ENABLED, LIVE_OVERSEER_ENABLED } from "@shared/features";
import { type NativeUsageProvider } from "@shared/usage";
import { patchSettings } from "../../lib/settings-state";
import { state$ } from "../../lib/state";
import { Button, Eyebrow, IconButton, Input } from "../ui";

function LiveProviderCard() {
  const settings = use$(state$.settings);
  const live = liveSettings(settings);
  const configured = settings.providers?.openai?.apiKeyConfigured === true;
  const [apiKey, setApiKey] = useState("");
  const [backendModel, setBackendModel] = useState(live.backendModel);
  const [maxCallMinutes, setMaxCallMinutes] = useState(String(live.maxCallMinutes));
  const [maxVoiceCostUsd, setMaxVoiceCostUsd] = useState(String(live.maxVoiceCostUsd));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setBackendModel(live.backendModel);
    setMaxCallMinutes(String(live.maxCallMinutes));
    setMaxVoiceCostUsd(String(live.maxVoiceCostUsd));
  }, [live.backendModel, live.maxCallMinutes, live.maxVoiceCostUsd]);

  return (
    <form
      className="settings-provider-card"
      aria-label="GPT-Live settings"
      onSubmit={(event) => {
        event.preventDefault();
        if (saving) return;
        setSaving(true);
        void patchSettings({
          live: {
            backendModel: backendModel.trim(),
            maxCallMinutes: Number(maxCallMinutes),
            maxVoiceCostUsd: Number(maxVoiceCostUsd),
          },
          ...(apiKey.trim() === "" ? {} : {
            providers: { openai: { apiKey: apiKey.trim() } },
          }),
        }).then((saved) => {
          if (saved) setApiKey("");
        }).finally(() => setSaving(false));
      }}
    >
      <div className="settings-provider-head">
        <span className="settings-provider-field__text">
          <Eyebrow>OpenAI live conversation</Eyebrow>
          <span className="settings-field__hint">GPT-Live-1 voice with a separate backend reasoning model.</span>
        </span>
        <span className="text-[10px] text-dim" role="status">
          {configured ? "API key configured" : "API key needed"}
        </span>
      </div>
      <p className="settings-provider-access">
        Bring your own OpenAI API key. A call starts only when you choose Start live conversation.
        Voice costs ${LIVE_VOICE_USD_PER_MINUTE.toFixed(2)} per minute, plus backend usage.
      </p>
      <label className="settings-provider-field">
        <span className="settings-provider-field__text">
          <span className="settings-provider-field__label">OpenAI API key</span>
          <span className="settings-field__hint">Saved in this installation's credential vault. The saved key cannot be revealed here.</span>
        </span>
        <span className="settings-provider-field__control">
          <Input
            type="password"
            aria-label="OpenAI API key"
            autoComplete="off"
            spellCheck={false}
            maxLength={8192}
            placeholder={configured ? "Enter replacement key" : "sk-..."}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          {configured ? (
            <IconButton
              aria-label="Clear OpenAI API key"
              title="Clear stored OpenAI API key"
              disabled={saving}
              onClick={() => {
                setSaving(true);
                void patchSettings({ providers: { openai: { apiKey: "" } } })
                  .then((saved) => { if (saved) setApiKey(""); })
                  .finally(() => setSaving(false));
              }}
            ><X size={13} aria-hidden /></IconButton>
          ) : null}
        </span>
      </label>
      <label className="settings-provider-field">
        <span className="settings-provider-field__text">
          <span className="settings-provider-field__label">Backend model</span>
          <span className="settings-field__hint">An OpenAI model that supports structured tool calls. Voice remains GPT-Live-1.</span>
        </span>
        <span className="settings-provider-field__control">
          <Input aria-label="Live backend model" required maxLength={200}
            value={backendModel} onChange={(event) => setBackendModel(event.target.value)} />
        </span>
      </label>
      <label className="settings-provider-field">
        <span className="settings-provider-field__text">
          <span className="settings-provider-field__label">Maximum call minutes</span>
          <span className="settings-field__hint">Automatically ends the call at this duration.</span>
        </span>
        <span className="settings-provider-field__control">
          <Input type="number" aria-label="Maximum call minutes" required step={1}
            min={LIVE_SETTINGS_BOUNDS.maxCallMinutes.min} max={LIVE_SETTINGS_BOUNDS.maxCallMinutes.max}
            value={maxCallMinutes} onChange={(event) => setMaxCallMinutes(event.target.value)} />
        </span>
      </label>
      <label className="settings-provider-field">
        <span className="settings-provider-field__text">
          <span className="settings-provider-field__label">Voice limit per call (USD)</span>
          <span className="settings-field__hint">Ends the call at this voice estimate. Backend token charges are separate.</span>
        </span>
        <span className="settings-provider-field__control">
          <Input type="number" aria-label="Voice limit per call in USD" required step="0.01"
            min={LIVE_SETTINGS_BOUNDS.maxVoiceCostUsd.min} max={LIVE_SETTINGS_BOUNDS.maxVoiceCostUsd.max}
            value={maxVoiceCostUsd} onChange={(event) => setMaxVoiceCostUsd(event.target.value)} />
        </span>
      </label>
      <div className="flex items-center justify-between gap-4">
        <span className="settings-field__hint">
          Current limit: {liveCallLimitSeconds(live) / 60} minutes. A new call bills at least 15 seconds.
        </span>
        <Button type="submit" disabled={saving}>{saving ? "Saving" : "Save live settings"}</Button>
      </div>
    </form>
  );
}

interface ProviderFieldSpec {
  readonly field: string;
  readonly label: string;
  readonly hint: string;
}

interface ProviderSpec {
  readonly source: NativeUsageProvider;
  readonly credentials?: ProviderSectionKey;
  readonly label: string;
  readonly blurb: string;
  readonly access: string;
  readonly fields: ReadonlyArray<ProviderFieldSpec>;
}

/** Where each credential comes from - operator guidance, not marketing. */
const PROVIDER_SPECS: ReadonlyArray<ProviderSpec> = [
  {
    source: "claude",
    label: "Claude",
    blurb: "Plan windows from Claude OAuth.",
    access: "May read ~/.claude credentials and ask macOS Keychain, then contact Anthropic.",
    fields: [],
  },
  {
    source: "codex",
    label: "Codex",
    blurb: "ChatGPT plan limits.",
    access: "May read ~/.codex/auth.json and contact OpenAI.",
    fields: [],
  },
  {
    source: "copilot",
    credentials: "copilot",
    label: "Copilot",
    blurb: "GitHub Copilot quota snapshots.",
    access: "May run gh auth token or read ~/.config/gh/hosts.yml, then contact GitHub.",
    fields: [
      {
        field: "token",
        label: "GitHub token",
        hint: "token with Copilot access - beats gh auth login and hosts.yml credentials",
      },
    ],
  },
  {
    source: "cursor",
    credentials: "cursor",
    label: "Cursor",
    blurb: "Usage summary and event costs from cursor.com.",
    access: "May read Cursor's local app database for its login cookie, then contact Cursor.",
    fields: [
      {
        field: "cookieHeader",
        label: "Cookie header",
        hint: "full Cookie header copied from cursor.com - avoids reading Cursor app files",
      },
    ],
  },
  {
    source: "devin",
    credentials: "devin",
    label: "Devin",
    blurb: "Live quota readouts from app.devin.ai.",
    access: "May inspect Chrome profile local storage for a Devin session, then contact Devin.",
    fields: [
      {
        field: "bearerToken",
        label: "Bearer token",
        hint: "session bearer token from app.devin.ai requests - avoids reading Chrome profiles",
      },
      {
        field: "organizationId",
        label: "Organization ID (optional)",
        hint: "org slug or internal id for the x-cog-org-id header",
      },
    ],
  },
  {
    source: "grok",
    label: "Grok",
    blurb: "Grok usage and local session totals.",
    access: "May read ~/.grok credentials and recent session history, then contact xAI.",
    fields: [],
  },
  {
    source: "hermes",
    label: "Hermes usage",
    blurb: "Local Hermes session totals, refreshed every five minutes.",
    access: "May enumerate ~/.hermes/profiles and query local profile state databases. This does not run hermes CLI commands or reach enrolled hosts.",
    fields: [],
  },
  {
    source: "kimi",
    credentials: "kimi",
    label: "Kimi",
    blurb: "Billing windows or Code API usage.",
    access: "May read ~/.kimi-code credentials, then contact Kimi.",
    fields: [
      {
        field: "authToken",
        label: "Web session token",
        hint: "KIMI_AUTH_TOKEN-style token from www.kimi.com/code/console",
      },
      {
        field: "apiKey",
        label: "Code API key",
        hint: "api.kimi.com coding key - checked when no session token is set",
      },
    ],
  },
  {
    source: "ollama",
    credentials: "ollama",
    label: "Ollama Cloud",
    blurb: "Session, hourly, and weekly usage from ollama.com.",
    access: "Uses configured or environment credentials, then contacts Ollama Cloud.",
    fields: [
      {
        field: "sessionCookie",
        label: "Session cookie",
        hint: "raw Cookie header copied from ollama.com after sign-in",
      },
      {
        field: "apiKey",
        label: "API key (identity only)",
        hint: "ollama.com API key - verifies identity; no quota surface exists",
      },
    ],
  },
  {
    source: "opencode-go",
    credentials: "opencodeGo",
    label: "OpenCode Go",
    blurb: "Zen rate-limit windows and local cost rows.",
    access: "May read OpenCode credentials and query its local usage database, then contact OpenCode.",
    fields: [
      {
        field: "apiKey",
        label: "API key",
        hint: "zen key from opencode.ai - avoids reading OpenCode auth.json",
      },
    ],
  },
  {
    source: "openrouter",
    credentials: "openrouter",
    label: "OpenRouter",
    blurb: "Credits and API-key budget windows.",
    access: "May read ~/.openrouter or ~/.config/openrouter API keys, then contact OpenRouter.",
    fields: [
      {
        field: "apiKey",
        label: "API key",
        hint: "sk-or-v1 key from openrouter.ai/keys - beats OPENROUTER_API_KEY and key files",
      },
      {
        field: "managementApiKey",
        label: "Management key (optional)",
        hint: "openrouter.ai/credits provisioning key - enables per-model spend history",
      },
    ],
  },
  {
    source: "antigravity",
    label: "Antigravity",
    blurb: "Gemini/Antigravity local usage.",
    access: "May read ~/.gemini conversations and inspect running process command lines and ports.",
    fields: [],
  },
  {
    source: "synthetic",
    credentials: "synthetic",
    label: "Synthetic",
    blurb: "Quota lanes for synthetic.new plans.",
    access: "Uses configured or environment credentials, then contacts Synthetic.",
    fields: [
      {
        field: "apiKey",
        label: "API key",
        hint: "from the synthetic.new dashboard - takes precedence over SYNTHETIC_API_KEY",
      },
    ],
  },
];

/**
 * Secret input row. Draft mirrors the Terminal section pattern: the durable
 * value shows until typing starts, commit happens on blur / Enter, Escape
 * abandons the edit.
 */
function SecretFieldRow({
  providerId,
  spec,
  stored,
}: {
  readonly providerId: ProviderSectionKey;
  readonly spec: ProviderFieldSpec;
  readonly stored: string | undefined;
}) {
  const [draft, setDraft] = useState<string>();
  const [revealed, setRevealed] = useState(false);
  // A landed patch ends the edit: the (masked) durable value returns.
  useEffect(() => setDraft(undefined), [stored]);

  const commit = async (): Promise<void> => {
    if (draft === undefined) return;
    const next = draft.trim();
    setDraft(undefined);
    if (next === MASKED_SECRET) return;
    if (next === (stored ?? "")) return;
    await patchSettings({ providers: { [providerId]: { [spec.field]: next } } });
  };

  const configured = stored !== undefined && stored.length > 0;
  return (
    <div className="settings-provider-field" role="group" aria-label={spec.label}>
      <span className="settings-provider-field__text">
        <span className="settings-provider-field__label">{spec.label}</span>
        <span className="settings-field__hint">{spec.hint}</span>
      </span>
      <span className="settings-provider-field__control">
        <input
          type={revealed ? "text" : "password"}
          className="settings-provider-input"
          autoComplete="off"
          spellCheck={false}
          aria-label={spec.label}
          placeholder={configured ? MASKED_SECRET : "not set"}
          value={draft ?? ""}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commit();
            } else if (event.key === "Escape") {
              setDraft(undefined);
            }
          }}
        />
        <button
          type="button"
          className="settings-provider-reveal"
          aria-label={revealed ? `Hide ${spec.label}` : `Reveal ${spec.label}`}
          title={revealed ? "Hide value" : "Reveal draft"}
          onClick={() => setRevealed((value) => !value)}
        >
          {revealed ? <EyeOff size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
        </button>
        {configured ? (
          <button
            type="button"
            className="settings-provider-clear"
            aria-label={`Clear ${spec.label}`}
            title="Clear stored value"
            onClick={() =>
              void patchSettings({
                providers: { [providerId]: { [spec.field]: "" } },
              })
            }
          >
            <X size={13} aria-hidden />
          </button>
        ) : null}
      </span>
    </div>
  );
}

export function ProvidersSettingsSection() {
  const providers = use$(state$.settings.providers);
  const enabledSources = new Set(providers?.enabledSources ?? []);
  const hermesHostSnapshots = providers?.hermesHostSnapshots === true;

  const setSourceEnabled = (source: NativeUsageProvider, enabled: boolean) => {
    void patchSettings({
      providers: {
        sourceAccess: { source, enabled },
      },
    });
  };

  return (
    <div className="settings-section">
      {LIVE_OVERSEER_ENABLED && <LiveProviderCard />}
      <p className="settings-note" role="note">
        Provider access is off by default. Enable only a source you want
        Vellum Command to read. Usage sources refresh every five minutes.
        Hermes host snapshots, when separately enabled, poll every minute.
        Each card names the local data and network access it may use. Stored
        values stay in this installation's credential vault, are shown masked, and are
        never logged.
      </p>
      {PROVIDER_SPECS.map((spec) => {
        const section = spec.credentials === undefined
          ? undefined
          : providers?.[spec.credentials];
        const configured = spec.fields.filter(
          (field) => {
            const record = section as Record<string, string | undefined> | undefined;
            return record !== undefined && record[field.field] !== undefined;
          },
        ).length ?? 0;
        return (
          <div key={spec.source} className="settings-provider-card">
            <div className="settings-provider-head">
              <span className="settings-provider-field__text">
                <Eyebrow>{spec.label}</Eyebrow>
                <span className="settings-field__hint">{spec.blurb}</span>
              </span>
              <label className="settings-provider-enable">
                <span>{enabledSources.has(spec.source) ? "access on" : "access off"}</span>
                <input
                  type="checkbox"
                  checked={enabledSources.has(spec.source)}
                  aria-label={`Allow ${spec.label} usage access`}
                  onChange={(event) => setSourceEnabled(spec.source, event.target.checked)}
                />
              </label>
            </div>
            <p className="settings-provider-access">{spec.access}</p>
            {configured > 0 ? (
              <span className="settings-field__hint">{configured} credential fields configured</span>
            ) : null}
            {spec.fields.map((fieldSpec) => (
              <SecretFieldRow
                key={fieldSpec.field}
                providerId={spec.credentials!}
                spec={fieldSpec}
                stored={(section as Record<string, string | undefined> | undefined)?.[
                  fieldSpec.field
                ]}
              />
            ))}
          </div>
        );
      })}
      {HERMES_INTEGRATION_ENABLED ? (
        <div className="settings-provider-card">
          <div className="settings-provider-head">
            <span className="settings-provider-field__text">
              <Eyebrow>Hermes host snapshots</Eyebrow>
              <span className="settings-field__hint">
                Local and enrolled-host Hermes profile listing, every minute.
              </span>
            </span>
            <label className="settings-provider-enable">
              <span>{hermesHostSnapshots ? "access on" : "access off"}</span>
              <input
                type="checkbox"
                checked={hermesHostSnapshots}
                aria-label="Allow Hermes host snapshot access"
                onChange={(event) =>
                  void patchSettings({
                    providers: { hermesHostSnapshots: event.target.checked },
                  })
                }
              />
            </label>
          </div>
          <p className="settings-provider-access">
            May run local and enrolled-host SSH `hermes profile list` and
            `hermes version`, and collect remote profile metadata. Distinct
            from Hermes usage above. Polls every one minute while enabled.
          </p>
        </div>
      ) : null}
    </div>
  );
}
