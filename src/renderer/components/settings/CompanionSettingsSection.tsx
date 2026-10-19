/**
 * Settings → Companion: answer agents from a phone.
 *
 * Three things, top to bottom: whether this Mac can be reached (Remote Login,
 * Tailscale or the local network), pairing a phone (a QR that lives ten
 * minutes), and the phones already paired, each with when it was last seen
 * and Remove. Main owns every step (keys, authorized_keys, the registry); this
 * surface only asks and shows. The QR carries a one-time key, so it is held in
 * component state only and dropped as soon as it is done with. When the first
 * phone pairs, it asks once whether Junto opens at login. A paired phone whose
 * line is gone from authorized_keys says so, with Restore and Remove; Junto
 * never puts a line back without that click.
 */
import { useCallback, useEffect, useState } from "react";
import type { CompanionDeviceRecord, CompanionKeyRestore, CompanionPairStart, CompanionStatus } from "@shared/companion-devices";
import { COMPANION_PAIRING_TTL_MS } from "@shared/companion-protocol";
import { getJuntoApi } from "../../lib/junto-api";
import { answerOpenAtLogin, openAtLoginOfferVisible } from "../../lib/open-at-login-offer";
import { state$ } from "../../lib/state";
import { Button, StatusDot } from "../ui";
import "./companion-settings.css";

type Pairing = Extract<CompanionPairStart, { readonly ok: true }>;

const ago = (then: number | undefined, now: number): string => {
  if (then === undefined) return "not yet";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
};

const countdown = (until: number, now: number): string => {
  // The clock ticks once a second, so right after the QR appears it can lag
  // main's stamp; the code never has more than its ten minutes left.
  const left = Math.min(COMPANION_PAIRING_TTL_MS / 1000, Math.max(0, Math.floor((until - now) / 1000)));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
};

/** Ticks once a second while `active`, for countdowns and "ago" labels. */
const useNow = (active: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
};

function Readiness({
  status,
  checking,
  onCheck,
}: {
  readonly status: CompanionStatus | undefined;
  readonly checking: boolean;
  readonly onCheck: () => void;
}) {
  if (status === undefined) return <p className="companion-note">Checking this Mac…</p>;
  if (!status.available) {
    return <p className="companion-note">Phones pair with the Command Center, not with a Remote.</p>;
  }
  const reach = status.tailscale?.name ?? status.tailscale?.address;
  return (
    <ul className="companion-checks" aria-label="Pairing readiness">
      <li>
        <StatusDot tone={status.remoteLogin === "on" ? "green" : "amber"} />
        <div>
          <span className="companion-checks__title">
            Remote Login {status.remoteLogin === "on" ? "is on" : "is off"}
          </span>
          {status.remoteLogin === "off" ? (
            <span className="companion-checks__hint">
              Your phone connects to this Mac through it. Turn it on in System Settings, General, Sharing, then check
              again.
            </span>
          ) : null}
        </div>
      </li>
      <li>
        <StatusDot tone={reach ? "green" : "dim"} />
        <div>
          <span className="companion-checks__title">
            {reach ? `Reachable anywhere through Tailscale as ${reach}` : "Reachable on this network"}
          </span>
          <span className="companion-checks__hint">
            {reach
              ? "Your phone also tries this Mac's local name when it is on the same Wi-Fi."
              : `Install Tailscale on this Mac and your phone to reach it away from ${status.hosts[0] ?? "this network"}.`}
          </span>
        </div>
      </li>
      {!status.juntoCommand || !status.hostKey ? (
        <li>
          <StatusDot tone="amber" />
          <div>
            <span className="companion-checks__title">
              {!status.juntoCommand ? "The junto command is missing" : "This Mac has no SSH host key yet"}
            </span>
            <span className="companion-checks__hint">
              {!status.juntoCommand
                ? "Reinstall Junto from the official download; the phone runs it when it connects."
                : "Turning on Remote Login creates it."}
            </span>
          </div>
        </li>
      ) : null}
      <li className="companion-checks__action">
        <Button size="xs" variant="subtle" onClick={onCheck} disabled={checking}>
          {checking ? "checking…" : "check again"}
        </Button>
      </li>
    </ul>
  );
}

/** How long "Link copied" stays up. */
const COPIED_NOTE_MS = 4_000;

function PairingPanel({
  pairing,
  now,
  onCancel,
}: {
  readonly pairing: Pairing;
  readonly now: number;
  readonly onCancel: () => void;
}) {
  const expired = now >= pairing.expiresAt;
  const [copiedAt, setCopiedAt] = useState<number | undefined>();
  const [copyFailed, setCopyFailed] = useState(false);
  const copy = async () => {
    // Main writes the clipboard; the link itself never reaches this window.
    const result = await getJuntoApi()?.companionPairCopyLink?.(pairing.deviceId);
    setCopyFailed(result?.ok !== true);
    setCopiedAt(result?.ok === true ? Date.now() : undefined);
  };
  const showCopied = copiedAt !== undefined && now - copiedAt < COPIED_NOTE_MS;
  return (
    <div className="companion-pairing" data-testid="companion-pairing">
      <div className="companion-pairing__qr" aria-hidden={expired}>
        {expired ? (
          <span className="companion-pairing__expired">expired</span>
        ) : (
          <img
            alt="Pairing code for the Junto phone app"
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairing.qrSvg)}`}
          />
        )}
      </div>
      <div className="companion-pairing__text">
        <strong>Scan this with the Junto app on your phone.</strong>
        <p>
          The code works once, for this phone only.{" "}
          {expired ? "It expired; pair again for a new one." : `It expires in ${countdown(pairing.expiresAt, now)}.`}
        </p>
        <div className="companion-pairing__actions">
          {!expired ? (
            <Button size="sm" onClick={() => void copy()}>
              Copy link
            </Button>
          ) : null}
          <Button size="sm" variant="subtle" onClick={onCancel}>
            {expired ? "close" : "cancel"}
          </Button>
        </div>
        {showCopied ? (
          <p className="companion-pairing__copied" role="status">
            Link copied. Paste it on your phone; it works once, and Junto clears it from the clipboard when pairing ends.
          </p>
        ) : copyFailed ? (
          <p className="companion-pairing__copied" role="status">
            This code is no longer valid. Pair again for a new one.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Asked once, right after the first phone pairs: the phone reaches this Mac
 * only while Junto runs. Nothing changes until the operator answers yes.
 */
export function OpenAtLoginOffer({ onAnswered }: { readonly onAnswered: () => void }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ readonly text: string; readonly failed: boolean } | undefined>();
  const answer = async (open: boolean) => {
    setBusy(true);
    const result = await answerOpenAtLogin(open);
    setBusy(false);
    if (!result.ok) {
      setOutcome({ text: `${result.message} You can turn it on in Settings, Advanced, Start Junto at login.`, failed: true });
      return;
    }
    if (!open) {
      onAnswered();
      return;
    }
    setOutcome({ text: "Junto opens when you log in. Change it in Settings, Advanced.", failed: false });
  };
  if (outcome) {
    return (
      <div className="companion-offer" data-testid="companion-open-at-login">
        <p className="companion-note" role={outcome.failed ? "alert" : "status"}>
          {outcome.text}
        </p>
        <Button size="xs" variant="subtle" onClick={onAnswered}>
          done
        </Button>
      </div>
    );
  }
  return (
    <div className="companion-offer" data-testid="companion-open-at-login" role="group" aria-labelledby="companion-offer-title">
      <div className="companion-offer__text">
        <span id="companion-offer-title" className="companion-checks__title">
          Open Junto when you log in?
        </span>
        <span className="companion-checks__hint">
          Your phone reaches this Mac only while Junto is running. Opening at login keeps it answering after a restart.
        </span>
      </div>
      <div className="companion-pairing__actions">
        <Button size="sm" variant="primary" onClick={() => void answer(true)} disabled={busy}>
          Open at login
        </Button>
        <Button size="sm" variant="subtle" onClick={() => void answer(false)} disabled={busy}>
          not now
        </Button>
      </div>
    </div>
  );
}

/** What a failed Restore says, by its closed reason. */
const RESTORE_FAILURE_COPY: Record<CompanionKeyRestore["failed"][number]["reason"], string> = {
  missing: "The phone's key could not be restored.",
  damaged: "The key Junto kept for this phone is damaged. Remove it and pair it again.",
  symlink: "authorized_keys is a symbolic link, so Junto will not replace it.",
  io: "authorized_keys could not be written.",
  "junto-path": "The junto command's path cannot be used in authorized_keys. Reinstall Junto from the official download.",
};

export const restoreMessage = (result: CompanionKeyRestore | undefined): string | undefined => {
  if (result === undefined) return "The phone could not be restored.";
  if (result.ok) return undefined;
  if (result.message) return result.message;
  const reason = result.failed[0]?.reason;
  return reason === undefined ? "The phone could not be restored." : RESTORE_FAILURE_COPY[reason];
};

export function PhoneRow({
  device,
  now,
  onRemove,
  onRestore,
}: {
  readonly device: CompanionDeviceRecord;
  readonly now: number;
  readonly onRemove: (deviceId: string) => void;
  readonly onRestore: (deviceId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const missing = device.state === "paired" && device.key !== undefined;
  return (
    <li className="companion-phone" data-testid="companion-phone">
      <div className="companion-phone__text">
        <span className="companion-phone__name">{device.name || "Phone"}</span>
        <span className="companion-phone__meta">
          last seen {ago(device.lastSeenAt, now)}
          {device.pairedAt !== undefined ? `, paired ${ago(device.pairedAt, now)}` : ""}
        </span>
        {missing ? (
          <span className="companion-phone__key" role="status">
            {device.key === "damaged"
              ? "This phone's key is no longer in authorized_keys, and the key Junto kept for it is damaged. Remove it and pair it again."
              : "This phone's key is no longer in authorized_keys."}
          </span>
        ) : null}
      </div>
      {!confirming && device.key === "missing" && device.state === "paired" ? (
        <div className="companion-phone__confirm">
          <Button size="xs" onClick={() => onRestore(device.deviceId)} aria-label={`Restore ${device.name || "phone"}`}>
            Restore
          </Button>
          <Button size="xs" variant="subtle" onClick={() => setConfirming(true)} aria-label={`Remove ${device.name || "phone"}`}>
            remove
          </Button>
        </div>
      ) : confirming ? (
        <div className="companion-phone__confirm">
          <span>It stops reaching this Mac at once.</span>
          <Button size="xs" variant="danger" onClick={() => onRemove(device.deviceId)}>
            remove
          </Button>
          <Button size="xs" variant="subtle" onClick={() => setConfirming(false)}>
            keep
          </Button>
        </div>
      ) : (
        <Button size="xs" variant="subtle" onClick={() => setConfirming(true)} aria-label={`Remove ${device.name || "phone"}`}>
          remove
        </Button>
      )}
    </li>
  );
}

export function CompanionSettingsSection() {
  const [status, setStatus] = useState<CompanionStatus | undefined>();
  const [checking, setChecking] = useState(false);
  const [devices, setDevices] = useState<ReadonlyArray<CompanionDeviceRecord>>([]);
  const [pairing, setPairing] = useState<Pairing | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const [justPaired, setJustPaired] = useState<string | undefined>();
  const [restoreError, setRestoreError] = useState<string | undefined>();
  // Decided once, when the first phone pairs; closed once answered.
  const [offerOpenAtLogin, setOfferOpenAtLogin] = useState(false);
  const now = useNow(pairing !== undefined || devices.length > 0);

  const check = useCallback(async () => {
    const api = getJuntoApi();
    if (!api?.companionStatus) return;
    setChecking(true);
    try {
      setStatus(await api.companionStatus());
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    const api = getJuntoApi();
    void check();
    void api?.companionDevices?.().then(setDevices, () => undefined);
    return api?.onCompanionDevicesChanged?.(setDevices);
  }, [check]);

  // The pending phone finished pairing: drop the QR (and its key) at once.
  useEffect(() => {
    if (!pairing) return;
    const done = devices.find((device) => device.deviceId === pairing.deviceId && device.state === "paired");
    if (done) {
      setPairing(undefined);
      setJustPaired(done.name || "Your phone");
      const first = devices.every((device) => device.deviceId === done.deviceId || device.state !== "paired");
      if (first) {
        void getJuntoApi()?.loginItemGet?.().then(
          (loginItem) =>
            setOfferOpenAtLogin(
              openAtLoginOfferVisible({
                firstPhone: true,
                settingsReady: state$.settingsReady.peek(),
                offered: state$.settings.advanced.openAtLoginOffered.peek(),
                loginItem,
              }),
            ),
          () => undefined,
        );
      }
    }
  }, [devices, pairing]);

  const pair = async () => {
    const api = getJuntoApi();
    if (!api?.companionPairStart) return;
    setMessage(undefined);
    setJustPaired(undefined);
    const started = await api.companionPairStart();
    if (started.ok) setPairing(started);
    else setMessage(started.message);
  };

  const cancel = () => {
    const pending = pairing;
    setPairing(undefined);
    if (pending && Date.now() < pending.expiresAt) void getJuntoApi()?.companionPairCancel?.(pending.deviceId);
  };

  const remove = async (deviceId: string) => {
    const result = await getJuntoApi()?.companionDeviceRemove?.(deviceId);
    if (result && !result.ok) setMessage(result.message ?? "The phone could not be removed.");
  };

  const restore = async (target: string) => {
    setRestoreError(undefined);
    const result = await getJuntoApi()?.companionDeviceRestore?.(target);
    setRestoreError(restoreMessage(result));
  };

  const paired = devices.filter((device) => device.state === "paired");
  const restorable = paired.filter((device) => device.key === "missing");
  const canPair = status?.available === true && status.remoteLogin === "on" && status.juntoCommand && status.hostKey;

  return (
    <div className="settings-section companion-settings">
      <p className="companion-lead">
        Answer agents from your phone, straight to this Mac over your own network.
      </p>

      <Readiness status={status} checking={checking} onCheck={() => void check()} />

      <section className="companion-block" aria-labelledby="companion-pair-title">
        <h3 id="companion-pair-title" className="companion-block__title">
          Pair a phone
        </h3>
        {pairing ? (
          <PairingPanel pairing={pairing} now={now} onCancel={cancel} />
        ) : (
          <div className="companion-block__row">
            <Button variant="primary" size="sm" onClick={() => void pair()} disabled={!canPair}>
              Pair a phone
            </Button>
            <span className="companion-note">
              {justPaired
                ? `${justPaired} is paired.`
                : canPair
                  ? "Shows a code to scan with the Junto app."
                  : "Available once this Mac is reachable."}
            </span>
          </div>
        )}
        {offerOpenAtLogin ? <OpenAtLoginOffer onAnswered={() => setOfferOpenAtLogin(false)} /> : null}
        {message ? (
          <p className="companion-error" role="alert">
            {message}
          </p>
        ) : null}
      </section>

      <section className="companion-block" aria-labelledby="companion-phones-title">
        <h3 id="companion-phones-title" className="companion-block__title">
          Paired phones
        </h3>
        {restorable.length > 1 ? (
          <div className="companion-block__row">
            <Button size="sm" onClick={() => void restore("all")}>
              Restore all
            </Button>
            <span className="companion-note">{restorable.length} phones lost their keys in authorized_keys.</span>
          </div>
        ) : null}
        {paired.length === 0 ? (
          <p className="companion-note">No phone yet.</p>
        ) : (
          <ul className="companion-phones">
            {paired.map((device) => (
              <PhoneRow
                key={device.deviceId}
                device={device}
                now={now}
                onRemove={(id) => void remove(id)}
                onRestore={(id) => void restore(id)}
              />
            ))}
          </ul>
        )}
        {restoreError ? (
          <p className="companion-error" role="alert">
            {restoreError}
          </p>
        ) : null}
      </section>
    </div>
  );
}
