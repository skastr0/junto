/**
 * How long a composer's text may travel inline, and what it becomes past
 * that: a file, attached, which travels as a content ref.
 *
 * A machine writes no row over COMMAND_ROW_MAX_BYTES (64 KiB, `exchange-bounds.ts`),
 * measured as the row's encoded JSON. A mail's row is its text plus an
 * envelope: ids, the sender's stamp and regions, a thread's subject, up to
 * OPERATOR_ATTACHMENTS_MAX file refs. MAIL_ENVELOPE_BYTES is room for all of
 * that at its longest, so a text inside MAIL_TEXT_INLINE_MAX_BYTES never makes
 * a row the machine refuses. The text is measured as the row measures it:
 * its UTF-8 bytes once JSON-escaped, so quotes, newlines and control
 * characters count at what they cost.
 */
import { COMMAND_ROW_MAX_BYTES } from "./resource-command";

/** Room in a mail's row for everything but its text. */
export const MAIL_ENVELOPE_BYTES = 16 * 1024;

/** The most text, as its row measures it, a mail carries inline. */
export const MAIL_TEXT_INLINE_MAX_BYTES = COMMAND_ROW_MAX_BYTES - MAIL_ENVELOPE_BYTES;

/** What a text past its bound is attached as. */
export const LONG_TEXT_FILE = { name: "message.md", mediaType: "text/markdown" } as const;

const utf8 = new TextEncoder();

/** A text's bytes inside a row: its JSON string, without the two quotes. */
export const mailTextBytes = (text: string): number => utf8.encode(JSON.stringify(text)).byteLength - 2;

/** How one composer bounds its text: by row bytes always, and by characters where its column holds fewer. */
export type TextBound = { readonly bytes: number; readonly characters?: number };

export const MAIL_TEXT_BOUND: TextBound = { bytes: MAIL_TEXT_INLINE_MAX_BYTES };

/** The text travels inline, or goes as LONG_TEXT_FILE. */
export type TextCarriage = { readonly kind: "inline" } | { readonly kind: "file"; readonly bytes: number };

export const textCarriage = (text: string, bound: TextBound = MAIL_TEXT_BOUND): TextCarriage => {
  const bytes = mailTextBytes(text);
  const overCharacters = bound.characters !== undefined && text.length > bound.characters;
  return bytes > bound.bytes || overCharacters ? { kind: "file", bytes: utf8.encode(text).byteLength } : { kind: "inline" };
};
