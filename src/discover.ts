import type { Pattern, RepoSource, LoopConfig } from "./types.js";
import { execSync } from "node:child_process";
import { context7Search, context7Docs } from "./morph.js";

const AREAS = [
  "Tool execution engine (parallel, streaming, cancellation, timeout, sandboxing)",
  "Context window management (compaction, summarization, token budgeting)",
  "Error handling and retry with exponential backoff and circuit breaker",
  "Permission and safety system (allow/deny rules, human-in-the-loop)",
  "Memory systems (conversation, episodic, semantic, long-term)",
  "Multi-agent orchestration (fork, delegate, merge, handoff, swarm)",
  "MCP integration (tool discovery, schema negotiation, lifecycle)",
  "Code editing (AST-aware, fuzzy matching, multi-file atomic edits)",
  "Streaming output (SSE, real-time tokens, progress indicators)",
  "Cost tracking and optimization (token counting, cache, budgets)",
  "Structured output (JSON schema, Zod, function calling, type safety)",
  "File system operations (sandboxing, watch, glob, grep, tree)",
  "Bash execution (timeout, capture, shell detection, env mgmt)",
  "Web browsing and content fetching (HTML parsing, markdown, caching)",
  "CLI UX (colors, spinners, prompts, config, completion)",
  "Testing (property-based, fuzzing, stress, snapshot, integration)",
  "Observability (structured logging, metrics, tracing, debug)",
  "Performance (lazy loading, memoization, pooling, workers)",
  "API design (builder pattern, middleware, plugins, hooks)",
  "Documentation (auto-generated, examples, guides, changelog)",
];

export function buildDiscoverPrompt(repo: RepoSource, config: LoopConfig, ctx7Content: string): string {
  const key = `${repo.owner}/${repo.repo}`;
  const areasList = AREAS.map((a, i) => `${i + 1}. ${a}`).join("\n");
  const ctx7Section = ctx7Content ? `\nCONTEXT7 DOCS:\n${ctx7Content}` : "";

  return `You are a senior architect extracting reusable design patterns from ${key}.

STEPS:
1. gh api repos/${repo.owner}/${repo.repo}/contents --jq '.[].name'
2. gh api repos/${repo.owner}/${repo.repo}/readme --jq '.content' | base64 -d
3. Explore src/, lib/, packages/ — read key files for agent/tool/pattern implementations
4. For each file: gh api repos/${repo.owner}/${repo.repo}/contents/<path> --jq '.download_url' && curl it

AREAS: ${areasList}
${ctx7Section}

OUTPUT: Write patterns as a JSON array to the output file:
[{"source":"${key}","category":"<category>","pattern_name":"<name>","description":"<what>","implementation":"<code details>","code_snippet":"<5-20 lines>","benefit":"<why>","priority":1-10,"complexity":"low|medium|high"}]

Find 5-20 patterns. Write the file.`;
}

export function buildAnalyzePrompt(patterns: Pattern[], repoPath: string): string {
  const summary = patterns.slice(-60).map((p) =>
    `[${p.priority}/10] ${p.pattern_name} (${p.source}, ${p.category}) — ${p.description}\n  ${(p.implementation || p.code_snippet || "").slice(0, 300)}`
  ).join("\n\n");

  return `Find gaps between the project at ${repoPath} and these patterns.

SOURCE: ${repoPath}/src, ${repoPath}/tests

PATTERNS:
${summary}

Read the source. Find TOP 5 gaps. Create concrete implementation plans.

OUTPUT: Write gaps as JSON:
[{"pattern_name":"...","source_repos":["..."],"category":"...","gap":"missing what","approach":"step-by-step with fn names","files_to_create":["src/x.ts"],"files_to_modify":["src/y.ts"],"tests_to_create":["tests/x.test.ts"],"estimated_loc":100,"priority":1-10}]

Focus on HIGH IMPACT changes.`;
}

export function buildImplementPrompt(gaps: Array<{ pattern_name: string; source_repos?: string[]; gap: string; approach: string; files_to_create?: string[]; files_to_modify?: string[]; tests_to_create?: string[] }>, repoPath: string): string {
  const details = gaps.map((g, i) =>
    `#${i + 1}: ${g.pattern_name}\n  Gap: ${g.gap}\n  Plan: ${g.approach}\n  Create: ${g.files_to_create?.join(", ")}\n  Modify: ${g.files_to_modify?.join(", ")}\n  Tests: ${g.tests_to_create?.join(", ")}`
  ).join("\n");

  return `Implement improvements to the project at ${repoPath}.

SOURCE: ${repoPath}/src | TESTS: ${repoPath}/tests

IMPROVEMENTS:
${details}

RULES:
- READ files before modifying
- Follow existing conventions (ESM, TypeScript strict, relative imports)
- NO comments unless complex logic
- EVERY feature needs tests
- Run tests after each: cd ${repoPath} && npm test
- Fix failures before continuing
- Run ALL at end: cd ${repoPath} && npm test
- NO .env files, API keys, tokens, secrets
- DO NOT modify .gitignore
- DO NOT add new npm dependencies unless absolutely necessary

IMPLEMENT ALL ${gaps.length} COMPLETELY.`;
}

export function buildFixPrompt(errors: string, repoPath: string, kind: "typescript" | "tests"): string {
  const verb = kind === "typescript" ? "Fix these TypeScript errors" : "Fix these failing tests";
  return `${verb} in the project at ${repoPath}:

${errors}

RULES:
- Read the files with errors first
- Fix issues minimally
- Run: cd ${repoPath} && ${kind === "typescript" ? "./node_modules/.bin/tsc --noEmit" : "npm test"} to verify
- Do NOT add new dependencies`;
}

export function getDefaultRepos(): RepoSource[] {
  return [
    { owner: "anthropics", repo: "claude-code", ctx7: "claude-code" },
    { owner: "paul-gauthier", repo: "aider", ctx7: "aider" },
    { owner: "cline", repo: "cline", ctx7: "cline" },
    { owner: "All-Hands-AI", repo: "OpenHands", ctx7: "openhands" },
    { owner: "openai", repo: "codex", ctx7: "codex" },
    { owner: "anthropics", repo: "model-context-protocol", ctx7: "mcp" },
    { owner: "openai", repo: "swarm", ctx7: undefined },
    { owner: "browser-use", repo: "browser-use", ctx7: undefined },
    { owner: "e2b-dev", repo: "code-interpreter", ctx7: undefined },
    { owner: "langgenius", repo: "dify", ctx7: "dify" },
    { owner: "upstash", repo: "context7", ctx7: "context7" },
    { owner: "jina-ai", repo: "reader", ctx7: undefined },
    { owner: "mendableai", repo: "firecrawl", ctx7: undefined },
    { owner: "intel", repo: "auto-gpt", ctx7: undefined },
    { owner: "wonderwhy-er", repo: "computer-use", ctx7: undefined },
  ];
}
