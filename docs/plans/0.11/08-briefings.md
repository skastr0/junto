# 0.11 Briefings written as documents

Owner: product-lead. Started 2026-10-28, the operator's ask. Ships in 0.11.0
if verified by the cut, otherwise at once as 0.11.1.

## Target

The texts seats are given at onboard are written like documents. The
region's instruction, the app briefing and the references (app-wide and per
region) open in the Markdown editor the Artifacts node already has, with
headings, lists, code, and `[[`/`@` mentions of artifacts, seats, tasks and
any node in reach. A seat that runs `junto onboard` gets the text as written
and, beside it, every mention parsed into a structured reference it can act
on. Mentions are never expanded into the text.

## Today

- App briefing: a plain `Textarea` in
  `src/renderer/components/settings/BriefingSettingsSection.tsx:87`.
- References: `src/renderer/components/settings/ReferencesSettingsSection.tsx`.
- Region instruction: a plain field in
  `src/renderer/components/InspectorFields.tsx:388` (`commitRegionInstruction`).
- The editor to reuse: `src/renderer/components/artifacts/LiveMarkdownField.tsx`,
  which already takes `DocumentMentions` and the mention picker; links are
  `mentionLink` / `parseMentionHref` in `src/shared/mention.ts`.
- Onboard is built in `src/main/junto/work/control.ts`; it returns
  `region.instruction` as a string.

## Decisions

- **One editor, three places.** `LiveMarkdownField` in each, not a new
  editor. The stored value stays Markdown text in the same fields: no schema
  change, no migration. A mention is stored as the link `mentionLink` writes.
- **What a briefing may mention.** A region's instruction and references
  mention what that region reaches (its nodes and the nodes its seats are
  wired to). The app briefing and app references mention anything on the
  operator's canvas. The picker offers only those.
- **Onboard parses, it never expands.** Each text keeps its Markdown as
  written. Beside it, `mentions`: one entry per distinct link, in order of
  first appearance, `{label, ref, kind, id, title?, reachable}`, `ref` being
  the `junto://` link. `title` is the current title, `reachable` whether this
  seat can act on it. A link that no longer resolves is listed with
  `kind: "missing"`, never dropped and never an error. The same shape for
  `junto references read <name>` and the overseer `briefing read`.
- **Size.** Same caps as today. A long briefing is still one text.

## Steps

| Step | Who | What |
|---|---|---|
| B1 | product-documents | `LiveMarkdownField` in the app briefing, references, and region instruction editors, with the scoped mention picker; save and changed-elsewhere behave as today |
| B2 | cli-lead | onboard, `references read` and `briefing read` return `mentions` beside the text, parsed by `parseMentionHref`; contract and tests |
| B3 | product-typography, product-accessibility | review B1 (tokens, type; the editor's name and keyboard in each place) |
| B4 | product-verify | real-app walk, dark and bright: write a region instruction with a heading, a list and a mention of an artifact and a seat; `junto onboard` from a seat in that region shows the text unexpanded and the two mentions resolved |
