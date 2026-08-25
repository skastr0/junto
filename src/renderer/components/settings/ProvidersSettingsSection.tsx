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
  MASKED_SECRET,
  PROVIDER_SECTION_KEYS,
  type ProviderSectionKey,
} from "@shared/settings";
import { patchSettings } from "../../lib/settings-state";
import { state$ } from "../../lib/state";
import { Eyebrow } from "../ui";

interface ProviderFieldSpec {
  readonly field: string;
  readonly label: string;
  readonly hint: string;
}

interface ProviderSpec {
  readonly id: ProviderSectionKey;
  readonly label: string;
  readonly blurb: string;
  readonly fields: ReadonlyArray<ProviderFieldSpec>;
}

/** Where each credential comes from - operator guidance, not marketing. */
const PROVIDER_SPECS: ReadonlyArray<ProviderSpec> = [
  {
    id: "openrouter",
    label: "OpenRouter",
    blurb: "Credits and API-key budget windows.",
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
    id: "synthetic",
    label: "Synthetic",
    blurb: "Quota lanes for synthetic.new plans.",
    fields: [
      {
        field: "apiKey",
        label: "API key",
        hint: "from the synthetic.new dashboard - takes precedence over SYNTHETIC_API_KEY",
      },
    ],
  },
  {
    id: "kimi",
    label: "Kimi",
    blurb: "Billing windows or Code API usage.",
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
    id: "devin",
    label: "Devin",
    blurb: "Live quota readouts from app.devin.ai.",
    fields: [
      {
        field: "bearerToken",
        label: "Bearer token",
        hint: "session bearer token from app.devin.ai requests - beats DEVIN_* env vars",
      },
      {
        field: "organizationId",
        label: "Organization ID (optional)",
        hint: "org slug or internal id for the x-cog-org-id header",
      },
    ],
  },
  {
    id: "opencodeGo",
    label: "OpenCode Go",
    blurb: "Zen rate-limit windows and local cost rows.",
    fields: [
      {
        field: "apiKey",
        label: "API key",
        hint: "zen key from opencode.ai - takes precedence over OPENCODE_API_KEY and auth.json",
      },
    ],
  },
  {
    id: "copilot",
    label: "Copilot",
    blurb: "GitHub Copilot quota snapshots.",
    fields: [
      {
        field: "token",
        label: "GitHub token",
        hint: "token with Copilot access - beats gh auth login and hosts.yml credentials",
      },
    ],
  },
  {
    id: "ollama",
    label: "Ollama Cloud",
    blurb: "Session/hourly/weekly usage from ollama.com.",
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
    id: "cursor",
    label: "Cursor",
    blurb: "Usage summary and event costs from cursor.com.",
    fields: [
      {
        field: "cookieHeader",
        label: "Cookie header",
        hint: "full Cookie header copied from cursor.com - beats CURSOR_COOKIE and app files",
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

  return (
    <div className="settings-section">
      <p className="settings-note" role="note">
        Credentials here are deliberate operator intent: each usage source
        checks its setting first, then environment variables, then local
        credential files. Values stay in this installation's database and are
        shown masked - Vellum Command never logs them.
      </p>
      {PROVIDER_SECTION_KEYS.map((key) => {
        const spec = PROVIDER_SPECS.find((candidate) => candidate.id === key);
        if (spec === undefined) return null;
        const section = providers?.[key];
        const configured = PROVIDER_SPECS.find((c) => c.id === key)?.fields.filter(
          (field) => {
            const record = section as Record<string, string | undefined> | undefined;
            return record !== undefined && record[field.field] !== undefined;
          },
        ).length ?? 0;
        return (
          <div key={key} className="settings-provider-card">
            <div className="settings-provider-head">
              <Eyebrow>{spec.label}</Eyebrow>
              <span className="settings-field__hint">
                {configured > 0 ? `${configured} configured` : spec.blurb}
              </span>
            </div>
            {spec.fields.map((fieldSpec) => (
              <SecretFieldRow
                key={fieldSpec.field}
                providerId={key}
                spec={fieldSpec}
                stored={(section as Record<string, string | undefined> | undefined)?.[
                  fieldSpec.field
                ]}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
