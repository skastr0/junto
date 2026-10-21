import { Result, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { BROWSER_MAX_COMMENT_TEXT_BYTES, ControlErrorTag, controlError } from "../src/shared/browser-control";
import { WorkErrorBody } from "../src/shared/work-control";
import { browserErrorBody } from "../src/cli/core/browser-errors";
import { browserRequestBody, parseBox } from "../src/cli/commands/browser";
import {
  BROWSER_COMMAND_NAMES,
  browserCapabilities,
  browserSchemas,
  type BrowserCommandName,
} from "../src/cli/commands/browser-contract";
import { allSchemas, commandCapabilities, renderSchemaContract } from "../src/cli/core/discovery";
import { BROWSER_ENABLED } from "../src/shared/features";

describe("browser errors as work errors", () => {
  it("maps every control tag to a WorkErrorBody that keeps the tag as its reason", () => {
    for (const tag of ControlErrorTag.literals) {
      const body = browserErrorBody(controlError(tag, `the ${tag} case`));
      expect(Result.isSuccess(Schema.decodeUnknownResult(WorkErrorBody)(body)), tag).toBe(true);
      expect(body.message).toBe(`the ${tag} case`);
      expect(body.details?.reason).toBe(tag);
      expect(typeof body.details?.retryable).toBe("boolean");
    }
  });

  it("names the app being down, a missing page, and a bad input plainly", () => {
    expect(browserErrorBody(controlError("runtime_down", "x"))).toMatchObject({
      type: "RuntimeDown",
      details: { retryable: true },
    });
    expect(browserErrorBody(controlError("not_found", "x")).type).toBe("UnknownTarget");
    expect(browserErrorBody(controlError("bad_request", "x")).type).toBe("InputError");
    expect(browserErrorBody(controlError("unauthorized", "x")).type).toBe("AuthError");
    expect(browserErrorBody(controlError("timeout", "x"))).toMatchObject({
      type: "Timeout",
      details: { retryable: true },
    });
  });
});

describe("browser request bodies", () => {
  it("sends a tab only when one is named", () => {
    expect(browserRequestBody("shot", { sessionId: "s1", tab: "tab-2" })).toEqual(
      Result.succeed({ sessionId: "s1", tab: "tab-2" }),
    );
    expect(browserRequestBody("shot", { sessionId: "s1", tab: undefined })).toEqual(
      Result.succeed({ sessionId: "s1" }),
    );
    expect(browserRequestBody("doctor", {})).toEqual(Result.succeed(undefined));
  });

  it("refuses a bad session id, a bad tab, or a field the command does not take", () => {
    for (const [name, fields] of [
      ["goto", { sessionId: "bad id", url: "https://example.com/" }],
      ["eval", { sessionId: "s1", code: "1", tab: "" }],
      ["close", { sessionId: "s1", tab: "tab-2" }],
      ["doctor", { extra: "x" }],
    ] as const) {
      const result = browserRequestBody(name, fields);
      expect(Result.isFailure(result), name).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("InputError");
        expect(result.failure.next_step).toBe(`junto schema show browser.${name}`);
      }
    }
  });

  it("sends a comment as its session, box, text and named tab", () => {
    const rect = { x: 10, y: 20.5, w: 300, h: 40 };
    expect(browserRequestBody("comment", { sessionId: "s1", tab: "t2", rect, text: "too tight" })).toEqual(
      Result.succeed({ sessionId: "s1", tab: "t2", rect, text: "too tight" }),
    );
    expect(browserRequestBody("comment", { sessionId: "s1", tab: undefined, rect, text: "too tight" })).toEqual(
      Result.succeed({ sessionId: "s1", rect, text: "too tight" }),
    );
    for (const fields of [
      { sessionId: "s1", text: "no box" },
      { sessionId: "s1", rect },
      { sessionId: "s1", rect: { x: 1, y: 2, w: 3 }, text: "three sides" },
      { sessionId: "s1", rect: { x: 1, y: 2, w: 3, h: Number.NaN }, text: "not finite" },
      { sessionId: "s1", rect, text: "" },
      { sessionId: "s1", rect, text: "é".repeat(BROWSER_MAX_COMMENT_TEXT_BYTES / 2 + 1) },
    ]) {
      const result = browserRequestBody("comment", fields);
      expect(Result.isFailure(result), JSON.stringify(fields).slice(0, 80)).toBe(true);
    }
    expect(browserRequestBody("comment", { sessionId: "s1", rect, text: "é".repeat(BROWSER_MAX_COMMENT_TEXT_BYTES / 2) })).toEqual(
      Result.succeed({ sessionId: "s1", rect, text: "é".repeat(BROWSER_MAX_COMMENT_TEXT_BYTES / 2) }),
    );
  });

  it("reads --box as four numbers x,y,w,h, and refuses anything else", () => {
    expect(parseBox("10,20,300,40")).toEqual(Result.succeed({ x: 10, y: 20, w: 300, h: 40 }));
    expect(parseBox(" 1.5, 2 ,3,4 ")).toEqual(Result.succeed({ x: 1.5, y: 2, w: 3, h: 4 }));
    for (const box of ["", "1,2,3", "1,2,3,4,5", "1,,3,4", "a,2,3,4", "1,2,3,Infinity"]) {
      const result = parseBox(box);
      expect(Result.isFailure(result), box).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.path).toBe("box");
        expect(result.failure.next_step).toBe("junto schema show browser.comment");
      }
    }
  });

  it("takes only the commands the contract names", () => {
    expectTypeOf<Parameters<typeof browserRequestBody>[0]>().toEqualTypeOf<BrowserCommandName>();
    const retired = () =>
      // @ts-expect-error a retired command is not a browser command
      browserRequestBody("station", {});
    void retired;
  });
});

describe("browser discovery", () => {
  it("has one schema and one capability per command, each id the command's words", () => {
    expect(browserSchemas.map((schema) => schema.command_id)).toEqual(
      BROWSER_COMMAND_NAMES.map((name) => `browser.${name}`),
    );
    expect(browserCapabilities.map((capability) => capability.command_id)).toEqual(
      BROWSER_COMMAND_NAMES.map((name) => `browser.${name}`),
    );
    for (const schema of browserSchemas) {
      expect(schema.command.startsWith(schema.command_id.replace(".", " "))).toBe(true);
    }
  });

  it("shows a comment's box edges as finite numbers only, as the route takes them", () => {
    const comment = browserSchemas.find((schema) => schema.command_id === "browser.comment");
    expect(comment).toBeDefined();
    const rect = (renderSchemaContract(comment!).schema as { properties: { rect: unknown } }).properties.rect;
    expect(rect).toEqual({
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
      required: ["x", "y", "w", "h"],
      additionalProperties: false,
    });
    expect(JSON.stringify(rect)).not.toMatch(/Infinity|NaN/u);
  });

  it("is listed exactly when this build has the browser", () => {
    const listed = (ids: ReadonlyArray<string>) => ids.filter((id) => id.startsWith("browser."));
    const expected = BROWSER_ENABLED ? BROWSER_COMMAND_NAMES.map((name) => `browser.${name}`) : [];
    expect(listed(allSchemas.map((schema) => schema.command_id))).toEqual(expected);
    expect(listed(commandCapabilities.map((capability) => capability.command_id))).toEqual(expected);
  });
});
