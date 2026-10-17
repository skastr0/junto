/**
 * Settings > Name and startup, for the machine chosen in the sidebar: its
 * label from the machine list and whether it prefers a supervised runtime.
 * The name pinned at setup never changes, so this page offers no rename. The
 * machine's own core answers and writes it (lib/machine-settings-source.ts);
 * a machine no channel reaches yet says why.
 */
import { use$ } from "@legendapp/state/react";
import { Result } from "effect";
import { useEffect, useState } from "react";
import type { MachineRecord, MachineSettingsUnavailableError } from "@shared/machine-settings";
import { INK } from "../../lib/theme";
import { state$ } from "../../lib/state";
import { machineSettingsSource } from "../../lib/machine-settings-source";
import { useSettingsMachine } from "../../lib/settings-machine";
import { FieldRow } from "./FieldRow";

/**
 * Supervised runtime help. The preference only records intent; install is
 * separate (packaged supervised install / app:install:supervised). See
 * assessSupervisedRuntime + ensureSupervised handoff.
 */
const SUPERVISED_RUNTIME_HELP =
  "Records whether this installation prefers a platform supervisor " +
  "(a macOS LaunchAgent) to own the long-running " +
  "process — auto-restart after crashes and keep-alive across logout/reboot. " +
  "This toggle does not install or remove the supervisor; install supervised " +
  "startup via the packaged installer or `bun run app:install:supervised`. " +
  "Doctor warns if preference and actual LaunchAgent state disagree. " +
  "Tradeoff: supervised is more durable for a machine left running " +
  "unattended; unsupervised is simpler for local development and attaching " +
  "a debugger.";

type RecordRead =
  | { readonly state: "unread" }
  | { readonly state: "answered"; readonly record: MachineRecord }
  | { readonly state: "refused"; readonly error: MachineSettingsUnavailableError };

export function MachineSettingsSection() {
  const machine = useSettingsMachine();
  // The window's own core answers this machine; a change it saved is a reason to read again.
  const own = use$(state$.settings.machine);
  const [read, setRead] = useState<RecordRead>({ state: "unread" });
  const [writeError, setWriteError] = useState("");

  useEffect(() => {
    let current = true;
    void machineSettingsSource()
      .record(machine.name)
      .then((answer) => {
        if (!current) return;
        setRead(
          Result.isSuccess(answer) ? { state: "answered", record: answer.success } : { state: "refused", error: answer.failure },
        );
      });
    return () => {
      current = false;
    };
  }, [machine.name, own]);

  const record = read.state === "answered" ? read.record : undefined;
  const whose = machine.isThisMachine ? "this machine" : machine.label;

  return (
    <div className="settings-section" data-testid="settings-machine-section" data-machine={machine.name}>
      {read.state === "refused" ? (
        <p className="settings-note" role="status">
          No record from {machine.label}: {read.error.message}
        </p>
      ) : null}
      {writeError ? (
        <p className="settings-note" role="alert">
          Not saved on {machine.label}: {writeError}
        </p>
      ) : null}
      <FieldRow group label="Name" hint={`What your machines list calls ${whose}.`}>
        <span style={{ color: INK, fontSize: "var(--text-body-lg)" }}>{machine.label}</span>
      </FieldRow>
      <FieldRow
        label="Prefer supervised runtime"
        hint="A preference. It does not install the supervisor."
        help={SUPERVISED_RUNTIME_HELP}
      >
        <input
          type="checkbox"
          checked={record?.supervisedPreferred ?? false}
          disabled={record === undefined}
          aria-label="Prefer supervised runtime"
          onChange={(event) => {
            setWriteError("");
            void machineSettingsSource()
              .writeRecord(machine.name, { supervisedPreferred: event.target.checked })
              .then((answer) => {
                if (Result.isSuccess(answer)) setRead({ state: "answered", record: answer.success });
                else setWriteError(answer.failure.message);
              });
          }}
        />
      </FieldRow>
    </div>
  );
}
