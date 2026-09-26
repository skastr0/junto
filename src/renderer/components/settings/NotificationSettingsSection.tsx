/**
 * Settings -> Notifications: whether Junto reaches the operator while it is
 * in the background, which needs do, and what the Dock shows. Each switch
 * writes one field through settingsPatch. The test banner is also where
 * macOS asks for permission, so the question comes when the operator asks
 * for it, never at launch.
 */
import { use$ } from "@legendapp/state/react";
import { useEffect, useState } from "react";
import { AUDIO_ENABLED } from "@shared/features";
import { notificationSettings, type NotificationPatch } from "@shared/settings";
import { getJuntoApi } from "../../lib/junto-api";
import { patchSettings } from "../../lib/settings-state";
import { state$ } from "../../lib/state";
import { Button, Switch } from "../ui";

type Kind = "blocked" | "needsYou" | "failed" | "done";

const KINDS: ReadonlyArray<{ readonly key: Kind; readonly title: string; readonly hint: string }> = [
  { key: "blocked", title: "Blocked", hint: "An agent is stuck and cannot go on without you." },
  {
    key: "needsYou",
    title: "Needs you",
    hint: "An agent asked a question, wants a decision, or is waiting at a prompt.",
  },
  { key: "failed", title: "Stopped", hint: "An agent's process ended with an error." },
  {
    key: "done",
    title: "Finished",
    hint: "An agent finished and you have not looked yet. These wait a few seconds and arrive together.",
  },
];

const save = (patch: NotificationPatch): void => {
  void patchSettings({ notifications: patch });
};

function Row({
  id,
  title,
  hint,
  checked,
  disabled = false,
  inset = false,
  onChange,
}: {
  readonly id: string;
  readonly title: string;
  readonly hint: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly inset?: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  const quiet = disabled || !checked;
  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 border-b border-stroke py-3.5 ${inset ? "pl-5" : ""}`}
      data-testid={id}
      data-on={checked ? "true" : "false"}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <label
          htmlFor={id}
          className={`cursor-pointer text-[14px] ${inset ? "font-medium" : "font-semibold"} ${quiet ? "text-dim" : "text-ink"}`}
        >
          {title}
        </label>
        <p className="m-0 max-w-[58ch] text-[12px] leading-[1.5] text-dim">{hint}</p>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

type TestState = { readonly phase: "idle" | "sending" } | { readonly phase: "sent" | "failed"; readonly message: string };
type Delivery = "unknown" | "allowed" | "blocked";

export function NotificationSettingsSection() {
  const prefs = use$(() => notificationSettings(state$.settings.get()));
  const [test, setTest] = useState<TestState>({ phase: "idle" });
  const [delivery, setDelivery] = useState<Delivery>("unknown");
  const api = getJuntoApi();
  const mac = api?.platform === "darwin";

  const readDelivery = (): void => {
    void api
      ?.notificationsDelivery?.()
      .then((status) => setDelivery(status.state))
      .catch(() => undefined);
  };
  // What macOS last said, read when the tab opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(readDelivery, []);

  const sendTest = async (): Promise<void> => {
    if (!api?.notificationsTest) {
      setTest({ phase: "failed", message: "This build cannot show notifications." });
      return;
    }
    setTest({ phase: "sending" });
    const result = await api
      .notificationsTest()
      .catch(() => ({ ok: false, message: "The notification could not be shown." }));
    setTest({
      phase: result.ok ? "sent" : "failed",
      message: result.message ?? (result.ok ? "Sent." : "The notification could not be shown."),
    });
    readDelivery();
  };

  return (
    <div className="settings-section" data-testid="settings-notifications-section">
      <p className="m-0 max-w-[62ch] text-[12px] leading-[1.5] text-dim">
        A notification says which agent needs you and why; click it to open that agent. Nothing is sent
        while you are looking at Junto.{AUDIO_ENABLED ? " Each one plays its sound, set in Sound." : ""}
      </p>

      <div className="flex flex-col border-t border-stroke">
        <Row
          id="notify-master"
          title="Send notifications"
          hint={prefs.enabled ? "For each kind switched on below." : "Junto sends none. The badge still counts."}
          checked={prefs.enabled}
          onChange={(enabled) => save({ enabled })}
        />
        {KINDS.map((kind) => (
          <Row
            key={kind.key}
            id={`notify-${kind.key}`}
            title={kind.title}
            hint={kind.hint}
            checked={prefs[kind.key]}
            disabled={!prefs.enabled}
            inset
            onChange={(on) => save({ [kind.key]: on })}
          />
        ))}
      </div>

      {mac ? (
        <div className="flex flex-col">
          <h3 className="m-0 border-b border-stroke pb-2 text-[12px] font-semibold text-dim">Dock</h3>
          <div className="flex flex-col">
            <Row
              id="notify-badge"
              title="Badge"
              hint="How many agents are waiting on you, on the Junto icon. It counts down as you answer."
              checked={prefs.badge}
              onChange={(badge) => save({ badge })}
            />
            <Row
              id="notify-bounce"
              title="Bounce when blocked"
              hint="The icon bounces once when an agent is blocked."
              checked={prefs.bounce}
              disabled={!prefs.enabled || !prefs.blocked}
              onChange={(bounce) => save({ bounce })}
            />
          </div>
        </div>
      ) : null}

      {delivery === "blocked" ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-stroke py-3" role="status">
          <p className="m-0 max-w-[52ch] text-[13px] leading-[1.5] text-ink">
            macOS is not showing Junto's notifications, so none of the above reaches you yet.
          </p>
          {mac && api?.notificationsOpenSystemSettings ? (
            <Button variant="chrome" size="sm" onClick={() => void api.notificationsOpenSystemSettings?.()}>
              Open Notification settings
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="chrome"
          size="md"
          disabled={test.phase === "sending"}
          onClick={() => void sendTest()}
          data-testid="notify-test"
        >
          Send a test notification
        </Button>
        {test.phase === "sent" || test.phase === "failed" ? (
          <span
            role="status"
            className={`text-[12px] leading-[1.5] ${test.phase === "failed" ? "text-ink" : "text-dim"}`}
          >
            {test.message}
          </span>
        ) : test.phase === "sending" ? (
          <span role="status" className="text-[12px] leading-[1.5] text-dim">
            Waiting for macOS…
          </span>
        ) : null}
      </div>
    </div>
  );
}
