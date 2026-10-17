/**
 * Mail admission: the harness domain's say on whether mail may be typed into
 * a seat now. It asks `admitCommand` for a `DeliverMail` in the mode the
 * seat's harness declares and turns a refusal into the hold the mailbox
 * already tells. The mode decides the Enters a running turn gets
 * (`mailSubmits`).
 *
 * Admission sits in front of the composer gate, never in place of it: an
 * admitted seat still holds on a draft or an unreadable box, and a refused one
 * holds whatever its composer reads. Each rule it replaces, and where it lived,
 * is in `docs/harness-domain-mail.md`.
 *
 * No verdict while the seat has no projected snapshot or its harness declares
 * no capabilities, so delivery behaves as it did before the projection. A seat
 * of unknown status is admitted, and its composer decides, as before.
 */
import { Result } from "effect";
import {
  admitCommand,
  type CommandSupport,
  type HarnessCapabilities,
  type MailMode,
  type SeatSnapshot,
  type SeatStatus,
} from "../../../../shared/harness-domain";
import type { SeatMailHold } from "../../../../shared/mail-hold";
import type { ComposerHold } from "../../../../shared/composer-availability";
import {
  HARNESS_FOLLOW_UP,
  isHarnessId,
  MAIL_FOLLOW_UP_MODE,
  type FollowUpMode,
} from "../../../../shared/managed-terminal-templates";

export type MailAdmission =
  | {
      readonly _tag: "Admitted";
      readonly support: Exclude<CommandSupport, { level: "none" }>;
      /** How a running turn takes it; an idle seat takes any mode as a prompt. */
      readonly mode: MailMode;
    }
  | { readonly _tag: "Held"; readonly reason: Extract<ComposerHold, "dialog"> | SeatMailHold }
  /** The seat's process has exited: there is nothing to type into. */
  | { readonly _tag: "Lost" };

const MAIL_MODE: Readonly<Record<FollowUpMode, MailMode>> = {
  steering: "steer",
  queue: "queue",
};

/** The mode mail asks for. A running turn takes it as a steer. */
export const MAIL_MODE_ASKED: MailMode = MAIL_MODE[MAIL_FOLLOW_UP_MODE];

/**
 * Mail's modes, first choice first: a steer, or a queued follow-up on a
 * harness that declares no steering. Mail never interrupts a turn.
 */
const MAIL_MODES: readonly MailMode[] = [MAIL_MODE_ASKED, "queue"];

/** The first of mail's modes the harness declares, or the one mail asks for. */
export const mailModeFor = (capabilities: HarnessCapabilities): MailMode =>
  MAIL_MODES.find((mode) => capabilities.commands[mode === "steer" ? "mailSteer" : "mailQueue"].level !== "none") ??
  MAIL_MODE_ASKED;

/**
 * Enters after the paste. An idle seat, or a harness with no template, is one.
 * A running turn takes the mode's submit; a harness with no distinct queue
 * submit queues on its steering key (`HARNESS_FOLLOW_UP`).
 */
export const mailSubmits = (harness: string | undefined, mode: MailMode, seatIdle: boolean): 1 | 2 => {
  if (seatIdle || harness === undefined || !isHarnessId(harness)) return 1;
  const followUp = HARNESS_FOLLOW_UP[harness];
  return (mode === "queue" ? followUp.queue ?? followUp.steering : followUp.steering).submits;
};

const heldBy = (status: SeatStatus): MailAdmission => {
  switch (status._tag) {
    case "Exited":
      return { _tag: "Lost" };
    case "Blocked":
      return {
        _tag: "Held",
        reason:
          status.reason._tag === "UsageLimit" || status.reason._tag === "Error" ? "stopped" : "dialog",
      };
    default:
      // Starting, and Working while it compacts or retries. A starting seat
      // has not read ready yet, so mail readiness holds it before this does.
      return { _tag: "Held", reason: "busy" };
  }
};

export const admitMail = (
  snapshot: SeatSnapshot | undefined,
  capabilities: HarnessCapabilities | undefined,
): MailAdmission | undefined => {
  if (snapshot === undefined || capabilities === undefined) return undefined;
  const mode = mailModeFor(capabilities);
  const admitted = admitCommand(snapshot, capabilities, { _tag: "DeliverMail", text: "", mode });
  if (Result.isSuccess(admitted)) return { _tag: "Admitted", support: admitted.success, mode };
  const refusal = admitted.failure;
  if (refusal._tag === "CommandUnsupportedError") return { _tag: "Held", reason: "unsupported" };
  return heldBy(snapshot.status);
};
