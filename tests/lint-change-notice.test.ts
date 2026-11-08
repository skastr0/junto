import { describe, expect, it } from "vitest";
import { RuleTester } from "oxlint/plugins-dev";
import plugin, { coarseNotice, noticeVerdict } from "../lint/junto-plugin";

describe("change notices", () => {
  it("report a notice or emitter that carries only where, never what", () => {
    expect(coarseNotice("notice", "ResourceChangedPush", ["channel", "canvasName"])).toMatch(/^ResourceChangedPush carries only channel, canvasName/u);
    expect(coarseNotice("emitter", "noteMachinesChanged", [])).toMatch(/^noteMachinesChanged takes only nothing/u);
    expect(coarseNotice("notice", "ResourceChangedPush", ["channel", "canvasName", "nodeIds"])).toBeUndefined();
    // A notice that carries the changed data, not ids, also names what changed.
    expect(coarseNotice("notice", "SquadsChanged", ["squads"])).toBeUndefined();
    // Members this rule cannot read (a spread) are never guessed at.
    expect(coarseNotice("notice", "ThreadChangedPush", undefined)).toBeUndefined();
  });

  it("let the ledger hold today's debt, and only shrink", () => {
    const known = new Set(["src/a.ts#MentionChanged"]);
    expect(noticeVerdict("notice", "src/a.ts", "MentionChanged", ["canvasName"], known)).toBeUndefined();
    expect(noticeVerdict("notice", "src/a.ts", "MentionChanged", ["canvasName", "nodeIds"], known)).toBe(
      "MentionChanged now names what changed: drop src/a.ts#MentionChanged from the known list of junto/change-names-its-subject in .oxlintrc.json",
    );
    // The ledger holds a declaration in its file: the same name elsewhere is judged on its own.
    expect(noticeVerdict("notice", "src/b.ts", "MentionChanged", ["canvasName"], known)).toMatch(/^MentionChanged carries only canvasName/u);
    expect(noticeVerdict("notice", "src/a.ts", "OtherChanged", ["canvasName"], known)).toMatch(/^OtherChanged carries only canvasName/u);
  });
});

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
const tester = new RuleTester();
const rule = plugin.rules["change-names-its-subject"];
const TS = "/repo/src/a.ts";
const ledger = [{ root: "/repo", known: ["src/a.ts#MentionChanged"] }] as never;
tester.run("junto/change-names-its-subject", rule as never, {
  valid: [
    { filename: TS, code: "export const ResourceChangedPush = Schema.Struct({ channel: Schema.String, canvasName: Schema.String, nodeIds: Schema.optionalKey(Schema.Array(Schema.String)) });" },
    { filename: TS, code: "export type ThreadChanged = { readonly canvasName: string; readonly subjectIds: ReadonlyArray<string> };" },
    { filename: TS, code: "export const noteAutomationsChanged = (canvasName: string, nodeId: string): void => {};" },
    { filename: TS, code: "export const MentionChanged = Schema.Struct({ canvasName: Schema.String });", options: ledger },
    { filename: TS, code: "type Changed = { readonly canvasName: string };" },
    { filename: TS, code: "export const Pushed = Schema.Struct({ canvasName: Schema.String });" },
    { filename: TS, code: "export const ThreadChangedPush = Schema.Struct({ ...Base.fields, kind: Schema.String });" },
  ],
  invalid: [
    {
      filename: TS,
      code: "export const ResourceChangedPush = Schema.Struct({ channel: Schema.String, canvasName: Schema.String });",
      errors: [{ message: "ResourceChangedPush carries only channel, canvasName: name what changed (an optional ids field, absent meaning the whole scope), or every reader re-reads the scope on each write" }],
    },
    {
      filename: TS,
      code: "export interface ArtifactLinksChanged { readonly canvasName: string }",
      errors: [{ message: "ArtifactLinksChanged carries only canvasName: name what changed (an optional ids field, absent meaning the whole scope), or every reader re-reads the scope on each write" }],
    },
    {
      filename: TS,
      code: "export function noteThreadChanged(kind: string, canvasName: string): void {}\nexport const noteMachinesChanged = (): void => {};",
      errors: [
        { message: "noteThreadChanged takes only kind, canvasName: pass what changed (ids, absent meaning the whole scope), or every listener re-reads the scope on each call" },
        { message: "noteMachinesChanged takes only nothing: pass what changed (ids, absent meaning the whole scope), or every listener re-reads the scope on each call" },
      ],
    },
    {
      filename: TS,
      code: "export const MentionChanged = Schema.Struct({ canvasName: Schema.String, nodeIds: Schema.Array(Schema.String) });",
      options: ledger,
      errors: [{ message: "MentionChanged now names what changed: drop src/a.ts#MentionChanged from the known list of junto/change-names-its-subject in .oxlintrc.json" }],
    },
  ],
});
