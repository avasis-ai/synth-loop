import { describe, it, expect } from "vitest";
import { scanDiff, generateHardenedGitignore } from "../src/security.js";

describe("scanDiff", () => {
  it("passes clean diff", () => {
    const result = scanDiff('diff --git a/src/index.ts b/src/index.ts\n+export function hello() {}', ["src/index.ts"]);
    expect(result.safe).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("blocks API keys", () => {
    const result = scanDiff('+const key = "sk-abc123456789012345678901234567890"', []);
    expect(result.safe).toBe(false);
    expect(result.issues[0].type).toBe("blocked_pattern");
  });

  it("blocks GitHub PATs", () => {
    const result = scanDiff('+token: "ghp_abc1234567890123456789012345678901234"', []);
    expect(result.safe).toBe(false);
  });

  it("blocks Context7 keys", () => {
    const result = scanDiff('+key: "ctx7sk-abc1234567890123456"', []);
    expect(result.safe).toBe(false);
  });

  it("blocks npm tokens", () => {
    const result = scanDiff('+authToken=npm_abc1234567890123456789012345678901234', []);
    expect(result.safe).toBe(false);
  });

  it("blocks Bearer tokens", () => {
    const result = scanDiff('+Authorization: Bearer abc123456789012345678901234', []);
    expect(result.safe).toBe(false);
  });

  it("blocks AWS keys", () => {
    const result = scanDiff('+key: "AKIAIOSFODNN7EXAMPLE"', []);
    expect(result.safe).toBe(false);
  });

  it("blocks PRIVATE KEY", () => {
    const result = scanDiff("-----BEGIN PRIVATE KEY-----", []);
    expect(result.safe).toBe(false);
  });

  it("blocks .env files", () => {
    const result = scanDiff("", [".env", "credentials.json", "src/index.ts"]);
    expect(result.safe).toBe(false);
    expect(result.issues).toHaveLength(2);
  });

  it("blocks .pem files", () => {
    const result = scanDiff("", ["cert.pem", "key.key", "config.ts"]);
    expect(result.safe).toBe(false);
    expect(result.issues).toHaveLength(2);
  });

  it("blocks credentials.json", () => {
    const result = scanDiff("", ["credentials.json"]);
    expect(result.safe).toBe(false);
  });

  it("blocks .npmrc", () => {
    const result = scanDiff("", [".npmrc"]);
    expect(result.safe).toBe(false);
  });

  it("allows normal code changes", () => {
    const result = scanDiff(
      '+export function add(a: number, b: number): number { return a + b; }\n+const x = 42;',
      ["src/math.ts", "tests/math.test.ts"],
    );
    expect(result.safe).toBe(true);
  });
});

describe("generateHardenedGitignore", () => {
  it("returns a string with .env blocked", () => {
    const gitignore = generateHardenedGitignore();
    expect(gitignore).toContain(".env");
    expect(gitignore).toContain("*.key");
    expect(gitignore).toContain("*.pem");
    expect(gitignore).toContain("credentials*");
    expect(gitignore).toContain(".npmrc");
    expect(gitignore).toContain("node_modules/");
  });
});
