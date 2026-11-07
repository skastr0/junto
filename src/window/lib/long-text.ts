import { useMemo } from "react";
import { LONG_TEXT_FILE, MAIL_TEXT_BOUND, textCarriage, type TextBound, type TextCarriage } from "@shared/mail-text-bound";
import { OPERATOR_ATTACHMENTS_MAX } from "@shared/operator-attachments";
import type { ContentRef } from "@shared/wire/content-ref";
import { uploadOperatorText } from "./operator-attachments";

/**
 * A composer's text past its bound goes as a file, attached
 * (`@shared/mail-text-bound`), and the composer says so before send. With
 * the tray already full there is no room for it, and the send waits.
 */
export type LongText = {
  readonly carriage: TextCarriage;
  /** What the composer shows while the text is past its bound. */
  readonly notice: string | undefined;
  /** Past the bound with no room for the file: nothing may be sent. */
  readonly blocked: boolean;
};

const boundWords = (bound: TextBound): string =>
  bound.characters !== undefined
    ? `${bound.characters.toLocaleString("en-US")} characters`
    : `${Math.floor(bound.bytes / 1024)} KB`;

export const longTextOf = (text: string, filesHeld: number, bound: TextBound = MAIL_TEXT_BOUND): LongText => {
  const carriage = textCarriage(text, bound);
  if (carriage.kind === "inline") return { carriage, notice: undefined, blocked: false };
  if (filesHeld >= OPERATOR_ATTACHMENTS_MAX) {
    return {
      carriage,
      notice: `Over ${boundWords(bound)}, so this goes as ${LONG_TEXT_FILE.name}, and the mail already carries ${OPERATOR_ATTACHMENTS_MAX} files: remove one to send`,
      blocked: true,
    };
  }
  return { carriage, notice: `Over ${boundWords(bound)}, so this goes as ${LONG_TEXT_FILE.name}, attached`, blocked: false };
};

export const useLongText = (text: string, filesHeld: number, bound: TextBound = MAIL_TEXT_BOUND): LongText =>
  useMemo(() => longTextOf(text, filesHeld, bound), [text, filesHeld, bound]);

/**
 * What a send carries: the text inline with the files, or, past the bound,
 * no text and the files with the text's own file last. Throws with main's
 * words when the file cannot be stored.
 */
export const carryText = async (
  canvasName: string,
  text: string,
  files: ReadonlyArray<ContentRef>,
  bound: TextBound = MAIL_TEXT_BOUND,
): Promise<{ readonly text: string; readonly files: ReadonlyArray<ContentRef> }> => {
  if (textCarriage(text, bound).kind === "inline") return { text, files };
  return { text: "", files: [...files, await uploadOperatorText(canvasName, text)] };
};
