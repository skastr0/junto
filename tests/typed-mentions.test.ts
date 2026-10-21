import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { mentionHref, mentionLinksOf, type MentionRef } from "../src/shared/mention";
import { asNodeId } from "../src/shared/physics/schema";
import { linkTypedMentions, typedMentionsOf } from "../src/shared/typed-mentions";

const names = (text: string) => typedMentionsOf(text).map((mention) => mention.name);

describe("typedMentionsOf: the @name tokens a writer typed", () => {
  it("finds names at the start, after spaces and after opening punctuation, by offset", () => {
    const text = "@cli-lead see (@product-feed), and \"@pty_lead\"";
    expect(typedMentionsOf(text)).toEqual([
      { name: "cli-lead", start: 0, end: 9 },
      { name: "product-feed", start: 15, end: 28 },
      { name: "pty_lead", start: 36, end: 45 },
    ]);
    for (const { name, start, end } of typedMentionsOf(text)) expect(text.slice(start, end)).toBe(`@${name}`);
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
});

const seat = (id: string): MentionRef => ({ kind: "seat", nodeId: asNodeId(id) });

describe("linkTypedMentions: each @name rewritten to its mention link", () => {
  const seats: Record<string, string> = { "cli-lead": "agent-01LEAD", "product-feed": "agent-01FEED" };
  const resolve = (name: string) =>
    seats[name] === undefined ? Result.fail(`unknown ${name}`) : Result.succeed({ ref: seat(seats[name]!), label: `@${name}` });

  it("rewrites each name in place to the link, and nothing else", () => {
    const linked = linkTypedMentions("@cli-lead, ask @product-feed about `@cli-lead`.", "factory", resolve);
    const lead = `[@cli-lead](${mentionHref(seat("agent-01LEAD"), "factory")})`;
    const feed = `[@product-feed](${mentionHref(seat("agent-01FEED"), "factory")})`;
    expect(linked).toEqual(Result.succeed(`${lead}, ask ${feed} about \`@cli-lead\`.`));
    expect(mentionLinksOf(Result.getOrThrow(linked)).map((link) => link.target.nodeId)).toEqual(["agent-01LEAD", "agent-01FEED"]);
  });

  it("leaves a text without names exactly as it was, and is stable on its own output", () => {
    const text = "no names here, ops@junto.dev";
    expect(linkTypedMentions(text, "factory", resolve)).toEqual(Result.succeed(text));
    const once = Result.getOrThrow(linkTypedMentions("@cli-lead", "factory", resolve));
    expect(linkTypedMentions(once, "factory", resolve)).toEqual(Result.succeed(once));
  });

  it("asks once per name, and refuses with the first name's refusal in text order", () => {
    const asked: string[] = [];
    const counting = (name: string) => {
      asked.push(name);
      return resolve(name);
    };
    expect(Result.isSuccess(linkTypedMentions("@cli-lead @cli-lead", "factory", counting))).toBe(true);
    expect(asked).toEqual(["cli-lead"]);
    expect(linkTypedMentions("@cli-lead @ghost @nobody", "factory", resolve)).toEqual(Result.fail("unknown ghost"));
  });
});
