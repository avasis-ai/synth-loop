import { describe, it, expect } from "vitest";
import { getDefaultRepos } from "../src/discover.js";
import { generateHardenedGitignore } from "../src/security.js";

describe("getDefaultRepos", () => {
  it("returns 15 repos", () => {
    const repos = getDefaultRepos();
    expect(repos).toHaveLength(15);
  });

  it("includes key repos", () => {
    const repos = getDefaultRepos();
    const keys = repos.map((r) => `${r.owner}/${r.repo}`);
    expect(keys).toContain("anthropics/claude-code");
    expect(keys).toContain("paul-gauthier/aider");
    expect(keys).toContain("cline/cline");
    expect(keys).toContain("openai/codex");
    expect(keys).toContain("anthropics/model-context-protocol");
  });

  it("has context7 hints for some repos", () => {
    const repos = getDefaultRepos();
    const withCtx7 = repos.filter((r) => r.ctx7);
    expect(withCtx7.length).toBeGreaterThan(0);
  });

  it("all repos have owner and repo", () => {
    const repos = getDefaultRepos();
    for (const r of repos) {
      expect(r.owner).toBeTruthy();
      expect(r.repo).toBeTruthy();
    }
  });
});
