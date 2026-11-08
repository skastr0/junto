import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { mentionHref, mentionLinksOf, type MentionRef } from "../src/shared/mention";
import { asNodeId } from "../src/shared/physics/schema";
import { linkMentionTokens, matchTypedMention, typedMentionsOf, type TypedMention } from "../src/shared/typed-mentions";

const names = (text: string) => typedMentionsOf(text).flatMap((mention) => (mention.kind === "at" ? [mention.name] : []));
const typed = (text: string) =>
  typedMentionsOf(text).map((mention) =>
    matchTypedMention(mention, { at: (at) => `@${at.name}`, number: (number) => `#${number.number}`, hash: (hash) => `#${hash.name}` }),
  );

describe("typedMentionsOf: the @name tokens a writer typed", () => {
  it("finds names at the start, after spaces and after opening punctuation, by offset", () => {
    const text = "@cli-lead see (@product-feed), and \"@pty_lead\"";
    expect(typedMentionsOf(text)).toEqual([
      { kind: "at", name: "cli-lead", start: 0, end: 9 },
      { kind: "at", name: "product-feed", start: 15, end: 28 },
      { kind: "at", name: "pty_lead", start: 36, end: 45 },
    ]);
    for (const { start, end } of typedMentionsOf(text)) expect(text.slice(start, end).startsWith("@")).toBe(true);
  });

  it("ends a name before trailing punctuation, and keeps inner dots and dashes", () => {
    expect(names("thanks @cli-lead. Also @a.b, @c-d! @e?")).toEqual(["cli-lead", "a.b", "c-d", "e"]);
  });

  it("reads letters beyond ASCII", () => {
    expect(names("olá @joão")).toEqual(["joão"]);
  });

  it("leaves emails, handles on a host, escaped @ and a bare @ alone", () => {
    expect(names("mail ops@junto.dev or a+b@x.io")).toEqual([]);
    expect(names("@user@host.social")).toEqual([]);
    expect(names("\\@cli-lead is literal")).toEqual([]);
    expect(names("@ alone, @- and @.")).toEqual([]);
  });

  it("leaves @ inside inline code spans, of any backtick run", () => {
    expect(names("run `junto msg send @cli-lead` then ``a ` @b`` and @c")).toEqual(["c"]);
    expect(names("an unclosed ` keeps @d")).toEqual(["d"]);
  });

  it("leaves @ inside fenced code blocks", () => {
    expect(names("```sh\n@cli-lead\n```\n@after\n~~~\n@tilde\n~~~")).toEqual(["after"]);
    expect(names("```\n@open to the end")).toEqual([]);
  });

  it("leaves text that is already a link alone: markdown links, autolinks and URLs", () => {
    expect(names("[@cli-lead](junto://canvas/factory?node=agent-1) and @x")).toEqual(["x"]);
    expect(names("[docs](https://x.dev/@cli-lead) <https://x.dev/@y> https://x.dev/@z junto://canvas/f?node=@w")).toEqual([]);
  });

  it("finds #42 as a task number and #name as a title, in text order with @names", () => {
    const text = "@cli-lead: #42 blocks #spec-v2. (#7)";
    expect(typedMentionsOf(text)).toEqual([
      { kind: "at", name: "cli-lead", start: 0, end: 9 },
      { kind: "number", number: 42, start: 11, end: 14 },
      { kind: "hash", name: "spec-v2", start: 22, end: 30 },
      { kind: "number", number: 7, start: 33, end: 35 },
    ]);
  });

  it("leaves # alone in words, entities, headings, escapes, mixed tokens, code and links", () => {
    expect(typed("C# and a#b, &#42; and &#x2A;")).toEqual([]);
    expect(typed("# Heading\n## Sub")).toEqual([]);
    expect(typed("\\#42 is literal, ##3 too, #42abc and #_x are not tokens")).toEqual([]);
    expect(typed("`#42` and ```\n#7\n``` and [#9](https://x.dev/#9) https://x.dev/#frag")).toEqual([]);
    expect(typed("#42, #spec. #a.b!")).toEqual(["#42", "#spec", "#a.b"]);
  });
});

const seat = (id: string): MentionRef => ({ kind: "seat", nodeId: asNodeId(id) });

describe("linkMentionTokens: each @name rewritten to its mention link", () => {
  const seats: Record<string, string> = { "cli-lead": "agent-01LEAD", "product-feed": "agent-01FEED" };
  const byName = (name: string) =>
    seats[name] === undefined ? Result.fail(`unknown ${name}`) : Result.succeed({ ref: seat(seats[name]!), label: `@${name}` });
  const resolve = (token: TypedMention) => byName(token.kind === "at" ? token.name : `#${token.kind}`);

  it("rewrites each name in place to the link, and nothing else", () => {
    const linked = linkMentionTokens("@cli-lead, ask @product-feed about `@cli-lead`.", "factory", resolve);
    const lead = `[@cli-lead](${mentionHref(seat("agent-01LEAD"), "factory")})`;
    const feed = `[@product-feed](${mentionHref(seat("agent-01FEED"), "factory")})`;
    expect(linked).toEqual(Result.succeed(`${lead}, ask ${feed} about \`@cli-lead\`.`));
    expect(mentionLinksOf(Result.getOrThrow(linked)).map((link) => link.target.nodeId)).toEqual(["agent-01LEAD", "agent-01FEED"]);
  });

  it("leaves a text without names exactly as it was, and is stable on its own output", () => {
    const text = "no names here, ops@junto.dev";
    expect(linkMentionTokens(text, "factory", resolve)).toEqual(Result.succeed(text));
    const once = Result.getOrThrow(linkMentionTokens("@cli-lead", "factory", resolve));
    expect(linkMentionTokens(once, "factory", resolve)).toEqual(Result.succeed(once));
  });

  it("asks once per name, and refuses with the first name's refusal in text order", () => {
    const asked: string[] = [];
    const counting = (token: TypedMention) => {
      asked.push(token.kind === "at" ? token.name : token.kind);
      return resolve(token);
    };
    expect(Result.isSuccess(linkMentionTokens("@cli-lead @cli-lead", "factory", counting))).toBe(true);
    expect(asked).toEqual(["cli-lead"]);
    expect(linkMentionTokens("@cli-lead @ghost @nobody", "factory", resolve)).toEqual(Result.fail("unknown ghost"));
  });
});

describe("linkMentionTokens: every token rewritten, by a resolver that handles each kind", () => {
  const TASK = "01M5ESSJRFWT6RVS5HMWMGJXGD";
  const resolve = (token: TypedMention) =>
    matchTypedMention(token, {
      at: (at) => (at.name === "cli-lead" ? Result.succeed({ ref: seat("agent-01LEAD"), label: "@cli-lead" }) : Result.fail(`unknown @${at.name}`)),
      number: (number) =>
        number.number === 42
          ? Result.succeed({ ref: { kind: "task", nodeId: asNodeId("board"), taskId: TASK } as MentionRef, label: "#42 fix tabs" })
          : Result.fail(`no task #${number.number}`),
      hash: (hash) => Result.fail(`no title #${hash.name}`),
    });

  it("rewrites @names and task numbers to their links", () => {
    const linked = Result.getOrThrow(linkMentionTokens("@cli-lead take #42, and #42 again", "factory", resolve));
    expect(mentionLinksOf(linked).map((link) => link.label)).toEqual(["@cli-lead", "#42 fix tabs", "#42 fix tabs"]);
    expect(linkMentionTokens(linked, "factory", resolve)).toEqual(Result.succeed(linked));
  });

  it("refuses with the first token that does not resolve", () => {
    expect(linkMentionTokens("#42 then #9 then #spec", "factory", resolve)).toEqual(Result.fail("no task #9"));
  });
});
