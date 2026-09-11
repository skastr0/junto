import { useState, type FormEvent } from "react";
import { productHostCapabilities } from "@shared/features";
import { refreshFleet } from "../../lib/fleet-state";
import { getVellumCommandApi } from "../../lib/vellum-api";
import { Button, FieldLabel, Input } from "../ui";

type Capability = "browser" | "terminal" | "hermes";

const ALL_CAPABILITIES: ReadonlyArray<{ readonly id: Capability; readonly label: string }> = [
  { id: "terminal", label: "terminal" },
  { id: "browser", label: "browser" },
  { id: "hermes", label: "hermes" },
];

/** Feature-visible enrollment options. Durable host capability decode stays wider. */
export const fleetEnrollCapabilities = (): ReadonlyArray<{
  readonly id: Capability;
  readonly label: string;
}> => {
  const visible = new Set(
    productHostCapabilities(
      ALL_CAPABILITIES.map((capability) => capability.id),
    ),
  );
  return ALL_CAPABILITIES.filter((capability) => visible.has(capability.id));
};

export const defaultFleetEnrollCapabilities = (): ReadonlyArray<Capability> =>
  productHostCapabilities(["terminal", "browser"]);

/** Host ids must be option-safe: leading alnum, then [A-Za-z0-9._-]. */
const slugifyHostId = (label: string): string => {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return slug || "host";
};

/**
 * Add / enroll-a-host form. Shared by the "Add host" header action (blank) and
 * discovery "Enroll this machine" (pre-filled from a discovered peer).
 */
export function FleetHostForm({
  initialLabel = "",
  initialEndpoint = "",
  onClose,
}: {
  readonly initialLabel?: string;
  readonly initialEndpoint?: string;
  readonly onClose: () => void;
}) {
  const [label, setLabel] = useState(initialLabel);
  const [endpoint, setEndpoint] = useState(initialEndpoint);
  const [capabilities, setCapabilities] = useState<ReadonlyArray<Capability>>(
    defaultFleetEnrollCapabilities,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const toggleCapability = (capability: Capability) => {
    setCapabilities((prev) =>
      prev.includes(capability) ? prev.filter((item) => item !== capability) : [...prev, capability],
    );
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const api = getVellumCommandApi();
    const upsert = api?.hostsUpsert;
    if (!upsert) {
      setError("Hosts API unavailable.");
      return;
    }
    const trimmedLabel = label.trim();
    const trimmedEndpoint = endpoint.trim();
    if (!trimmedLabel || !trimmedEndpoint) {
      setError("Label and SSH endpoint are required.");
      return;
    }
    if (capabilities.length === 0) {
      setError("Enable at least one host capability.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await upsert({
        id: slugifyHostId(trimmedLabel),
        label: trimmedLabel,
        kind: "remote",
        sshEndpoint: trimmedEndpoint,
        capabilities: [...capabilities],
      });
      if (result.ok) {
        await refreshFleet();
        onClose();
      } else {
        setError(result.message ?? "Save failed.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fleet-form-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="fleet-form"
        role="dialog"
        aria-modal="true"
        aria-label="Add remote host"
        onSubmit={(event) => void submit(event)}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <div className="fleet-form__title">{initialLabel ? "Enroll this machine" : "Add remote host"}</div>
        <FieldLabel>
          label
          <Input
            autoFocus
            aria-label="Host label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="remote-a"
          />
        </FieldLabel>
        <FieldLabel>
          ssh endpoint
          <Input
            aria-label="Host endpoint"
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder="user@host or ssh config alias"
          />
        </FieldLabel>
        <FieldLabel>
          capabilities
          <div className="fleet-form__capabilities" role="group" aria-label="Host capabilities">
            {fleetEnrollCapabilities().map(({ id, label: capabilityLabel }) => (
              <Button
                key={id}
                size="xs"
                variant={capabilities.includes(id) ? "primary" : "chrome"}
                aria-pressed={capabilities.includes(id)}
                onClick={() => toggleCapability(id)}
              >
                {capabilityLabel}
              </Button>
            ))}
          </div>
        </FieldLabel>
        {error ? (
          <p className="fleet-form__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="fleet-form__actions">
          <Button size="sm" variant="subtle" onClick={onClose}>
            cancel
          </Button>
          <Button size="sm" variant="primary" type="submit" disabled={busy}>
            {busy ? "saving…" : "save host"}
          </Button>
        </div>
      </form>
    </div>
  );
}
