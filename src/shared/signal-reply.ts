/**
 * How a signal's reply is ruled (0.11/07, N1): the one rule main applies when
 * the operator hands work in, and the one the pane applies as it fills, so
 * the meter and the ruling can never disagree.
 *
 * A `work` signal stays open until its reply meets its form. A document is
 * ruled by the words its markdown holds, by `signalWordCount` (the one word
 * rule); proof is ruled by its words and by the addresses it carries, each
 * admitted as the wire admits a link. `text` asks for nothing but words, and
 * the ordinary answer path rules it.
 */
import { Schema } from "effect";
import { ARTIFACT_MAX_DOCUMENT_LENGTH } from "./artifact";
import { ULID_PATTERN } from "./ulid";
import { signalWordCount } from "./word-count";
import { ContentRef } from "./wire/content-ref";
import {
  AGENT_SIGNAL_MAX_DETAIL_LENGTH,
  admitLinkUrl,
  type SignalForm,
} from "./wire/agent-signals";

/** The most addresses one piece of proof carries. */
export const SIGNAL_PROOF_LINKS_MAX = 20;

/**
 * What the operator hands in, as the window sends it: a document's markdown,
 * or proof's words, addresses and files. `replyId` is the window's own id for
 * one hand-in, and it is the write's op id, so sending it twice writes one
 * document.
 */
export const SignalReply = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("artifact"),
    markdown: Schema.String,
    replyId: Schema.String.check(Schema.isPattern(ULID_PATTERN)),
  }),
  Schema.Struct({
    kind: Schema.Literal("proof"),
    text: Schema.String,
    links: Schema.Array(Schema.String).check(Schema.isMaxLength(SIGNAL_PROOF_LINKS_MAX)),
    files: Schema.optionalKey(Schema.Array(ContentRef)),
    replyId: Schema.String.check(Schema.isPattern(ULID_PATTERN)),
  }),
]);
export type SignalReply = typeof SignalReply.Type;

export type SignalReplyRuling =
  | { readonly ok: true; readonly words: number }
  | { readonly ok: false; readonly message: string };

const refused = (message: string): SignalReplyRuling => ({ ok: false, message });

/**
 * The form's condition against a reply. A reply of another kind than the form
 * asks for is refused first: a document answers no proof, and proof answers
 * no document.
 */
export const ruleSignalReply = (form: SignalForm, reply: SignalReply): SignalReplyRuling => {
  switch (form.kind) {
    case "artifact": {
      if (reply.kind !== "artifact") return refused("this signal asks for a document; write it in the signal");
      if (reply.markdown.length > ARTIFACT_MAX_DOCUMENT_LENGTH) {
        return refused(`a document holds ${ARTIFACT_MAX_DOCUMENT_LENGTH} characters`);
      }
      const words = signalWordCount(reply.markdown);
      return words >= form.minWords
        ? { ok: true, words }
        : refused(
            form.minWords <= 1
              ? "the document is empty"
              : `the document holds ${words} ${words === 1 ? "word" : "words"} of ${form.minWords}`,
          );
    }
    case "proof": {
      if (reply.kind !== "proof") return refused("this signal asks for proof: its words with links or files");
      const text = reply.text.trim();
      if (text === "") return refused("proof needs a sentence saying what it shows");
      if (text.length > AGENT_SIGNAL_MAX_DETAIL_LENGTH) {
        return refused(`proof's words hold at most ${AGENT_SIGNAL_MAX_DETAIL_LENGTH} characters`);
      }
      if (reply.links.length > SIGNAL_PROOF_LINKS_MAX) return refused(`proof carries at most ${SIGNAL_PROOF_LINKS_MAX} links`);
      for (const link of reply.links) {
        const admitted = admitLinkUrl(link);
        if (!admitted.ok) return refused(`${link}: ${admitted.reason}.`);
      }
      return { ok: true, words: signalWordCount(text) };
    }
    case "secret":
      // The vault (N5) rules a secret's reply: a value never rides here.
      return refused("this signal asks for a secret, and the vault answers it, not a reply");
    case "text": {
      if (reply.kind === "artifact") return refused("this signal asks for a reply, not a document");
      const text = reply.text.trim();
      return text === "" ? refused("write a reply first") : { ok: true, words: signalWordCount(text) };
    }
  }
};
