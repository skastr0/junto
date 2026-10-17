/**
 * Mail admission: the harness domain's say on whether mail may be typed into
 * a seat now. It asks `admitCommand` for a `DeliverMail` in mail's follow-up
 * mode and turns a refusal into the hold the mailbox already tells.
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
import { MAIL_FOLLOW_UP_MODE, type FollowUpMode } from "../../../../shared/managed-terminal-templates";

export type MailAdmission =
  | { readonly _tag: "Admitted"; readonly support: Exclude<CommandSupport, { level: "none" }> }
  | { readonly _tag: "Held"; readonly reason: Extract<ComposerHold, "dialog"> | SeatMailHold }
  /** The seat's process has exited: there is nothing to type into. */
  | { readonly _tag: "Lost" };

const MAIL_MODE: Readonly<Record<FollowUpMode, MailMode>> = {
  steering: "steer",
  queue: "queue",
};

/** The mode mail asks for. A running turn takes it as a steer. */
export const MAIL_MODE_ASKED: MailMode = MAIL_MODE[MAIL_FOLLOW_UP_MODE];

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
  const admitted = admitCommand(snapshot, capabilities, {
    _tag: "DeliverMail",
    text: "",
    mode: MAIL_MODE_ASKED,
  });
  if (Result.isSuccess(admitted)) return { _tag: "Admitted", support: admitted.success };
  const refusal = admitted.failure;
  if (refusal._tag === "CommandUnsupportedError") return { _tag: "Held", reason: "unsupported" };
  return heldBy(snapshot.status);
};
