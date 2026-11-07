import { Effect, Option } from "effect";
import { LONG_TEXT_FILE } from "@shared/mail-text-bound";
import type { ContentRef } from "@shared/wire/content-ref";
import type { ContentOwner } from "./manifest";
import { ContentService } from "./service";

/**
 * Main's side of the mail text bound (`@shared/mail-text-bound`). A composer
 * sends text past its hint as a file, but only main measures the real row:
 * when the store refuses an operator mail as row_too_large, its text goes
 * into the content store as LONG_TEXT_FILE, held by the mail, and the mail
 * is written again carrying that file and `filesText` in its place.
 */

type Written<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly message: string; readonly details?: { readonly reason?: string } };

/**
 * Write a mail; if its row is too large and it has text, write it once more
 * with the text as a file. Answers the write, and the files the mail holds.
 */
export const writeMailCarryingText = <T, W extends Written<T>>(
  write: (text: string, attachments: ReadonlyArray<ContentRef>) => Effect.Effect<W>,
  mail: {
    readonly text: string;
    readonly attachments: ReadonlyArray<ContentRef>;
    readonly owner: ContentOwner;
    /** What the mail says once its text is a file. */
    readonly filesText: string;
  },
) =>
  Effect.gen(function* () {
    const first = yield* write(mail.text, mail.attachments);
    if (first.ok || first.details?.reason !== "row_too_large" || mail.text.trim() === "") {
      return { written: first, attachments: mail.attachments };
    }
    const content = yield* Effect.serviceOption(ContentService);
    if (Option.isNone(content)) return { written: first, attachments: mail.attachments };
    const stored = yield* Effect.result(
      content.value.put({
        source: Buffer.from(mail.text, "utf8"),
        mediaType: LONG_TEXT_FILE.mediaType,
        displayName: LONG_TEXT_FILE.name,
        owner: mail.owner,
      }),
    );
    if (stored._tag === "Failure") return { written: first, attachments: mail.attachments };
    const attachments = [...mail.attachments, stored.success.ref];
    return { written: yield* write(mail.filesText, attachments), attachments };
  });
