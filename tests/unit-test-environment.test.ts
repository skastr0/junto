import { describe, expect, it } from "vitest";
import { unitTestEnvironment } from "../scripts/unit-test-environment";

describe("unit-test credential isolation", () => {
  it.each([
    "OP_SERVICE_ACCOUNT_TOKEN", "OP_CONNECT_TOKEN", "OP_SESSION", "OP_SESSION_example",
    "OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    "DATABASE_PASSWORD", "CLIENT_SECRET", "SSH_AUTH_SOCK", "PRIVATE_KEY",
    "QUASAR_INGEST_TOKEN", "lowercase_api_key",
  ])("does not pass inherited %s to a test process", (name) => {
    const ambient = { PATH: "/test/bin", [name]: "synthetic-credential" };
    expect(unitTestEnvironment(ambient)).toEqual({ PATH: "/test/bin" });
    expect(ambient[name]).toBe("synthetic-credential");
  });

  it("keeps platform paths and test flags without modifying the caller", () => {
    const ambient = { PATH: "/test/bin", HOME: "/test/home", TMPDIR: "/test/tmp", CI: "1", JUNTO_TEST_FEATURE_PROFILE: "all-on" };
    expect(unitTestEnvironment(ambient)).toEqual(ambient);
  });

  it("removes credentials embedded in proxy URLs and preserves a plain proxy", () => {
    expect(unitTestEnvironment({
      HTTPS_PROXY: "https://test-user:synthetic-password@example.invalid",
      http_proxy: "http://test-user@example.invalid",
      ALL_PROXY: "http://example.invalid:8080",
    })).toEqual({ ALL_PROXY: "http://example.invalid:8080" });
  });
});
