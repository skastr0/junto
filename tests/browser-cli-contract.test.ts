import { Result, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { ControlErrorTag, controlError } from "../src/shared/browser-control";
import { WorkErrorBody } from "../src/shared/work-control";
import { browserErrorBody } from "../src/cli/core/browser-errors";
import { browserRequestBody } from "../src/cli/commands/browser";
import {
  BROWSER_COMMAND_NAMES,
  browserCapabilities,
  browserSchemas,
  type BrowserCommandName,
} from "../src/cli/commands/browser-contract";
import { allSchemas, commandCapabilities } from "../src/cli/core/discovery";
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

  it("is listed exactly when this build has the browser", () => {
    const listed = (ids: ReadonlyArray<string>) => ids.filter((id) => id.startsWith("browser."));
    const expected = BROWSER_ENABLED ? BROWSER_COMMAND_NAMES.map((name) => `browser.${name}`) : [];
    expect(listed(allSchemas.map((schema) => schema.command_id))).toEqual(expected);
    expect(listed(commandCapabilities.map((capability) => capability.command_id))).toEqual(expected);
  });
});
