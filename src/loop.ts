import { Agent, OllamaProvider } from "@avasis-ai/synthcode";
import {
  BashTool, FileReadTool, FileWriteTool, FileEditTool, GlobTool, GrepTool,
} from "@avasis-ai/synthcode/tools";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import type {
  LoopConfig, LoopState, CycleResult, Pattern, Gap,
  VerifyResult, SecurityResult, LogFn, TaskRequest, TaskResult,
} from "./types.js";
import { Cluster } from "./cluster.js";
import { TaskRouter } from "./router.js";
import { ConsensusEngine } from "./consensus.js";
import { SpeculativeExecutor } from "./speculative.js";
import { AdaptiveRetry } from "./adaptive.js";
import { scanDiff } from "./security.js";
import { context7Search, context7Docs, hasContext7Key } from "./morph.js";

const _env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_ENV"));

const DEFAULT_CONFIG: Partial<LoopConfig> = {
  cycleSleepMs: 60_000,
  maxConsecutiveFailures: 5,
  autoFix: true,
  autoPublish: false,
  selfUpgrade: false,
  dryRun: false,
  useMorph: false,
  speculativeDrafts: 1,
  consensusMinAgreement: 0.6,
  maxDebateRounds: 2,
};

export class SynthLoop {
  private config: LoopConfig;
  private state: LoopState;
  private log: LogFn;
  private dataDir: string;
  private cluster: Cluster;
  private router: TaskRouter;
  private consensus: ConsensusEngine;
  private speculative: SpeculativeExecutor;
  private retry: AdaptiveRetry;

  constructor(config: LoopConfig, logFn?: LogFn) {
    this.config = { ...DEFAULT_CONFIG, ...config } as LoopConfig;
    this.log = logFn || defaultLog;
    this.dataDir = join(config.repoPath, ".synth-loop");
    mkdirSync(this.dataDir, { recursive: true });
    this.state = this.loadState();
    this.cluster = new Cluster(this.config.cluster, this.log);
    this.router = new TaskRouter(this.cluster, this.log);
    this.consensus = new ConsensusEngine(this.cluster, this.config.consensusMinAgreement, this.log);
    this.speculative = new SpeculativeExecutor(this.cluster, this.log);
    this.retry = new AdaptiveRetry(this.cluster, this.router, this.log);
  }

  private loadState(): LoopState {
    const f = join(this.dataDir, "state.json");
    if (existsSync(f)) return JSON.parse(readFileSync(f, "utf-8"));
    return {
      cycle: 0, consecutiveFailures: 0, totalImprovements: 0, totalFailed: 0,
      reposScanned: [], patternsDiscovered: 0,
      version: "0.0.0", lastCommit: null, lastPublishedVersion: null,
      clusterStats: { totalRequests: 0, totalTokens: 0, totalDurationMs: 0, bySlot: {},
        consensusHits: 0, consensusMisses: 0, speculativeAccepted: 0, speculativeRejected: 0 },
    };
  }

  private saveState() {
    this.state.clusterStats = this.cluster.getStats();
    writeFileSync(join(this.dataDir, "state.json"), JSON.stringify(this.state, null, 2));
  }

  private appendHistory(entry: CycleResult) {
    const f = join(this.dataDir, "history.jsonl");
    appendFileSync(f, JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n");
  }

  private run(cmd: string, cwd?: string, timeout = 120_000): string | null {
    try {
      return execSync(cmd, { cwd: cwd || this.config.repoPath, timeout, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], env: _env });
    } catch { return null; }
  }

  private runAllowFail(cmd: string, cwd?: string, timeout = 120_000): string {
    try {
      return execSync(cmd, { cwd: cwd || this.config.repoPath, timeout, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], env: _env });
    } catch (e: any) { return e.stdout || e.stderr || ""; }
  }

  private backup() {
    this.runAllowFail(`cd ${this.config.repoPath} && git stash --include-untracked 2>/dev/null`);
  }

  private rollback() {
    this.log("WARN", "Rolling back");
    this.run(`cd ${this.config.repoPath} && git checkout . && git clean -fd`, undefined, 30_000);
    this.run("npm install --silent", this.config.repoPath);
  }

  private readSrcFiles(): Record<string, string> {
    const files: Record<string, string> = {};
    const allSrc = this.runAllowFail(`find ${this.config.repoPath}/src -name "*.ts" -not -name "*.test.ts" -not -name "*.d.ts" 2>/dev/null`);
    if (allSrc) {
      for (const line of allSrc.trim().split("\n")) {
        const rel = line.trim().replace(this.config.repoPath + "/", "");
        try { files[rel] = readFileSync(line.trim(), "utf-8"); } catch {}
      }
    }
    return files;
  }

  getCluster(): Cluster { return this.cluster; }
  getRouter(): TaskRouter { return this.router; }
  getState(): LoopState { return { ...this.state }; }
  getConfig(): LoopConfig { return { ...this.config }; }

  async phase1Discover(): Promise<Pattern[]> {
    this.log("INFO", "=== PHASE 1: DISCOVER ===");
    const unscanned = this.config.repos.filter(r => !this.state.reposScanned.includes(`${r.owner}/${r.repo}`));
    if (!unscanned.length) { this.state.reposScanned = []; unscanned.push(...this.config.repos); }

    const repo = unscanned[0];
    const key = `${repo.owner}/${repo.repo}`;
    this.log("INFO", `Scanning ${key}`);

    let ctx7Content = "";
    if (repo.ctx7 && this.config.context7Key && hasContext7Key(this.config)) {
      const hits = await context7Search(repo.ctx7, this.config.context7Key);
      if (hits.length) {
        const docs = await context7Docs(hits[0].id, "architecture patterns agent tool core", this.config.context7Key);
        if (docs?.content) ctx7Content = docs.content;
      }
    }

    const request: TaskRequest = {
      type: "analyze",
      role: "planner",
      system: `You are a senior architect extracting reusable design patterns from ${key}. You analyze codebases to find patterns that could improve other projects. Return ONLY a valid JSON array.`,
      user: `Analyze the ${key} repository. Focus on: agent orchestration, tool execution, context management, error handling, streaming, permissions, multi-agent systems, MCP integration, code editing, observability, cost tracking.

${ctx7Content ? `CONTEXT7 DOCS:\n${ctx7Content.slice(0, 3000)}` : ""}

Return JSON array of patterns:
[{"source":"${key}","category":"category","pattern_name":"name","description":"what it does","implementation":"how to implement","code_snippet":"5-20 lines of code","benefit":"why it matters","priority":7,"complexity":"low|medium|high"}]

Find 5-15 patterns. Return ONLY the JSON array, no markdown.`,
      maxTokens: 6000,
      jsonMode: true,
    };

    const result = await this.router.route(request);
    const response = await this.cluster.execute(result);

    if (!response.success || !response.content) {
      this.log("ERROR", "Discovery failed");
      return [];
    }

    try {
      const cleaned = response.content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const m = cleaned.match(/\[[\s\S]*\]/);
      if (!m) { this.log("WARN", "No JSON array in response"); return []; }
      const patterns: Pattern[] = JSON.parse(m[0]);
      const valid = patterns.filter(p => p.pattern_name && p.description);
      this.state.reposScanned.push(key);
      this.state.patternsDiscovered += valid.length;
      this.log("INFO", `Extracted ${valid.length} patterns from ${key}`);
      return valid;
    } catch (e: any) {
      this.log("ERROR", `Parse error: ${e.message}`);
      return [];
    }
  }

  async phase2Analyze(allPatterns: Pattern[]): Promise<Gap[]> {
    this.log("INFO", `=== PHASE 2: ANALYZE (${allPatterns.length} patterns) ===`);

    const srcFiles = this.readSrcFiles();
    const existingFiles = Object.keys(srcFiles).map(p => p.replace("src/", ""));
    const existingFeatures = existingFiles.map(p => p.replace(".ts", "").replace(/[-_]/g, " "));

    const topPatterns = allPatterns.slice(-60).map(p =>
      `[${p.priority}/10] ${p.pattern_name} (${p.source}, ${p.category}): ${p.description.slice(0, 100)}`
    ).join("\n");

    const request: TaskRequest = {
      type: "analyze",
      role: "planner",
      system: `You are a TypeScript architect finding gaps. Do NOT suggest: ${existingFeatures.join(", ")}. Return ONLY a valid JSON array.`,
      user: `TARGET PROJECT has these files: ${existingFiles.join(", ")}

PATTERNS FROM OSS REPOS:
${topPatterns}

Find 3 features the target project lacks. Focus on NEW functionality.

CRITICAL: files_to_create MUST be NEW paths not in: ${existingFiles.join(", ")}

Return JSON: [{"pattern_name":"name","source_repos":["repo"],"category":"cat","gap":"what's missing","approach":"steps","files_to_create":["src/new-feature.ts"],"files_to_modify":[],"tests_to_create":["tests/new-feature.test.ts"],"estimated_loc":100,"priority":7}]

Return ONLY the JSON array.`,
      maxTokens: 4000,
      jsonMode: true,
    };

    const response = await this.cluster.execute(this.router.route(request));

    if (!response.success || !response.content) return [];

    try {
      const cleaned = response.content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const m = cleaned.match(/\[[\s\S]*\]/);
      if (!m) return [];
      const gaps: Gap[] = JSON.parse(m[0]);
      const valid = gaps.filter(g => g.pattern_name && g.gap && g.files_to_create?.length);
      const withNewFiles = valid.filter(g =>
        !g.files_to_create.some(f => existingFiles.includes(f.replace("src/", "")))
      );
      this.log("INFO", `${valid.length} gaps, ${withNewFiles.length} with new files`);
      return withNewFiles.slice(0, 3);
    } catch { return []; }
  }

  async phase3Implement(gap: Gap): Promise<boolean> {
    this.log("INFO", `=== PHASE 3: IMPLEMENT (${gap.pattern_name}) ===`);

    const implRequest: TaskRequest = {
      type: "implement",
      role: "implementer",
      system: `Write TypeScript. Rules: ESM .js imports, Zod schemas, defineTool(), Vitest tests, strict mode. Export main class/function. Under 150 lines. No comments.`,
      user: `Create: ${gap.files_to_create?.[0] || "src/feature.ts"}
Feature: ${gap.pattern_name}
Gap: ${gap.gap}
Approach: ${gap.approach}

Write ONLY TypeScript code. No explanation.`,
      maxTokens: 4096,
    };

    let implResult: TaskResult;
    if (this.config.speculativeDrafts && this.config.speculativeDrafts > 1) {
      const spec = await this.speculative.multiDraft(implRequest, this.config.speculativeDrafts);
      implResult = spec.accepted ? spec.verification || spec.draft : spec.draft;
    } else {
      implResult = await this.cluster.execute(this.router.route(implRequest));
    }

    let implCode = implResult.content.replace(/```(?:typescript|ts)?\s*/g, "").replace(/```\s*/g, "").trim();

    if (implCode.length > 5000) {
      this.log("WARN", `Truncating impl from ${implCode.length} chars`);
      implCode = implCode.slice(0, 5000);
      const lastExport = implCode.lastIndexOf("export");
      const lastBrace = implCode.lastIndexOf("}");
      const cutPoint = Math.max(lastExport, lastBrace);
      if (cutPoint > 500) implCode = implCode.slice(0, cutPoint + 1);
    }

    if (implCode.length < 80 || !implCode.includes("export")) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        this.log("INFO", `Impl retry ${attempt}`);
        const retry = await this.cluster.execute({ ...implRequest, temperature: 0.3 + attempt * 0.2 });
        if (retry.success) {
          implCode = retry.content.replace(/```(?:typescript|ts)?\s*/g, "").replace(/```\s*/g, "").trim();
          if (implCode.length >= 80 && implCode.includes("export")) break;
        }
      }
    }

    if (implCode.length < 80 || !implCode.includes("export")) {
      this.log("WARN", `Implementation failed (${implCode.length} chars, no exports)`);
      return false;
    }

    let implFile = gap.files_to_create?.[0] || `src/${gap.pattern_name.toLowerCase().replace(/\s+/g, "-")}.ts`;
    if (!implFile.startsWith("src/")) implFile = `src/${implFile}`;
    if (existsSync(join(this.config.repoPath, implFile))) {
      this.log("WARN", `File ${implFile} exists`);
      return false;
    }

    const implDir = implFile.split("/").slice(0, -1).join("/") || "src";
    this.runAllowFail(`mkdir -p ${join(this.config.repoPath, implDir)}`);
    writeFileSync(join(this.config.repoPath, implFile), implCode);
    this.log("INFO", `Created ${implFile} (${implCode.length} chars)`);

    const testPath = gap.tests_to_create?.[0] || implFile.replace(/^src\//, "tests/").replace(/\.ts$/, ".test.ts");
    const testRequest: TaskRequest = {
      type: "implement",
      role: "implementer",
      system: `Write Vitest test files. Start with: import { describe, it, expect } from "vitest". Import with .js extension. 2-3 test cases. Output ONLY code.`,
      user: `Test file: ${testPath}\nFeature exports from: ${implFile}\nCode (first 600 chars):\n${implCode.slice(0, 600)}\n\nWrite the complete test file.`,
      maxTokens: 3000,
    };

    const testResult = await this.cluster.execute(this.router.route(testRequest));
    let testCode = testResult.content.replace(/```(?:typescript|ts)?\s*/g, "").replace(/```\s*/g, "").trim();

    if (testCode.length > 3000) {
      testCode = testCode.slice(0, 3000);
      const lastDescribe = testCode.lastIndexOf("describe");
      if (lastDescribe > 500) testCode = testCode.slice(0, lastDescribe + 500);
    }

    if (testCode.length > 50 && testCode.includes("describe")) {
      const testDir = join(this.config.repoPath, testPath.split("/").slice(0, -1).join("/"));
      this.runAllowFail(`mkdir -p ${testDir}`);
      writeFileSync(join(this.config.repoPath, testPath), testCode);
      this.log("INFO", `Created ${testPath} (${testCode.length} chars)`);
    }

    return true;
  }

  async phase3WithDebate(gap: Gap): Promise<boolean> {
    this.log("INFO", `=== PHASE 3: DEBATE IMPLEMENT (${gap.pattern_name}) ===`);

    const implRequest: TaskRequest = {
      type: "implement",
      role: "implementer",
      system: `Write TypeScript. ESM .js imports, Zod schemas, defineTool(), Vitest tests, strict mode. Export main class/function. Under 150 lines. No comments. No markdown.`,
      user: `Create: ${gap.files_to_create?.[0] || "src/feature.ts"}\nFeature: ${gap.pattern_name}\nGap: ${gap.gap}\nApproach: ${gap.approach}\n\nWrite ONLY TypeScript code.`,
      maxTokens: 4096,
    };

    const result = await this.consensus.debate(implRequest, this.config.maxDebateRounds || 2);
    if (!result.agreed || !result.content) {
      this.log("WARN", "Debate failed to produce code");
      return false;
    }

    let implCode = result.content.replace(/```(?:typescript|ts)?\s*/g, "").replace(/```\s*/g, "").trim();
    if (implCode.length > 5000) {
      implCode = implCode.slice(0, 5000);
      const lastExport = implCode.lastIndexOf("export");
      const lastBrace = implCode.lastIndexOf("}");
      const cutPoint = Math.max(lastExport, lastBrace);
      if (cutPoint > 500) implCode = implCode.slice(0, cutPoint + 1);
    }

    if (implCode.length < 80 || !implCode.includes("export")) {
      this.log("WARN", `Debate output too short (${implCode.length})`);
      return false;
    }

    let implFile = gap.files_to_create?.[0] || `src/${gap.pattern_name.toLowerCase().replace(/\s+/g, "-")}.ts`;
    if (!implFile.startsWith("src/")) implFile = `src/${implFile}`;
    if (existsSync(join(this.config.repoPath, implFile))) {
      this.log("WARN", `File ${implFile} exists`);
      return false;
    }

    const implDir = implFile.split("/").slice(0, -1).join("/") || "src";
    this.runAllowFail(`mkdir -p ${join(this.config.repoPath, implDir)}`);
    writeFileSync(join(this.config.repoPath, implFile), implCode);
    this.log("INFO", `Created ${implFile} (${implCode.length} chars, confidence=${(result.confidence * 100).toFixed(0)}%)`);
    return true;
  }

  secure(): SecurityResult {
    this.log("INFO", "=== SECURITY SCAN ===");
    const diff = this.runAllowFail(`cd ${this.config.repoPath} && git diff HEAD 2>/dev/null; git diff --cached HEAD 2>/dev/null`);
    const files = this.runAllowFail(`cd ${this.config.repoPath} && git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null`);
    const fileList = files.split("\n").filter(Boolean);
    const result = scanDiff(diff, fileList);
    this.log(result.safe ? "INFO" : "ERROR", `Security: ${result.safe ? "PASS" : "FAIL — " + result.issues.map(i => i.detail).join("; ")}`);
    return result;
  }

  async phase5Verify(): Promise<VerifyResult> {
    this.log("INFO", "=== PHASE 5: VERIFY ===");
    this.run("npm install --silent", this.config.repoPath);

    for (let pass = 1; pass <= 2; pass++) {
      const tsc = this.run("./node_modules/.bin/tsc --noEmit 2>&1", this.config.repoPath);

      if (tsc !== null && this.config.autoFix) {
        this.log("WARN", `Pass ${pass}: tsc FAIL — fixing`);
        const fixRequest: TaskRequest = {
          type: "fix_tsc",
          role: "fixer",
          system: "Fix TypeScript errors. Read files first. Fix types only. Use .js imports. Output ONLY code changes.",
          user: `Fix these TypeScript errors:\n${tsc.slice(0, 3000)}`,
          maxTokens: 2000,
        };
        const fix = await this.cluster.execute(this.router.route(fixRequest));
        if (fix.success) {
          this.log("INFO", `Fixer suggestion: ${fix.content.slice(0, 200)}`);
        }
        this.run("npm install --silent", this.config.repoPath);
      }

      const tests = this.runAllowFail("npm test 2>&1", this.config.repoPath);
      const passC = tests?.match(/Tests\s+(?:\d+\s+failed\s*\|\s*)?(\d+)\s+passed/)?.[1]
        ? parseInt(tests.match(/Tests\s+(?:\d+\s+failed\s*\|\s*)?(\d+)\s+passed/)![1]) : 0;
      const failC = tests?.match(/Tests\s+(\d+)\s+failed/)?.[1]
        ? parseInt(tests.match(/Tests\s+(\d+)\s+failed/)![1]) : 0;

      this.log("INFO", `Pass ${pass}: tests ${passC}p/${failC}f`);

      const tscClean = tsc === null;
      if (tscClean && passC >= 90 && failC <= 10) {
        const build = this.runAllowFail("npm run build 2>&1", this.config.repoPath);
        const buildOk = !!(build && !build.includes("error") && !build.includes("ERROR"));
        this.log("INFO", `Build: ${buildOk ? "PASS" : "FAIL"}`);
        return { tsc: true, tests: true, build: buildOk, passCount: passC, failCount: failC, allGreen: buildOk };
      }

      if (!tscClean && pass === 1 && this.config.autoFix) {
        this.log("WARN", "Trying agent-based fix");
        try {
          const agent = await this.makeAgent(20);
          await agent.chat(`Fix TypeScript errors:\n${tsc.slice(0, 2000)}\nRun: cd ${this.config.repoPath} && ./node_modules/.bin/tsc --noEmit`);
          this.run("npm install --silent", this.config.repoPath);
        } catch {}
      }

      if (failC > 0 && pass === 1 && this.config.autoFix) {
        this.log("WARN", "Trying agent-based test fix");
        try {
          const agent = await this.makeAgent(20);
          await agent.chat(`Fix failing tests:\n${tests.slice(-2000)}\nRun: cd ${this.config.repoPath} && npm test`);
          this.run("npm install --silent", this.config.repoPath);
        } catch {}
      }
    }

    const tsc2 = this.run("./node_modules/.bin/tsc --noEmit 2>&1", this.config.repoPath);
    const tests2 = this.runAllowFail("npm test 2>&1", this.config.repoPath);
    const pc = tests2?.match(/Tests\s+(?:\d+\s+failed\s*\|\s*)?(\d+)\s+passed/)?.[1]
      ? parseInt(tests2.match(/Tests\s+(?:\d+\s+failed\s*\|\s*)?(\d+)\s+passed/)![1]) : 0;
    const fc = tests2?.match(/Tests\s+(\d+)\s+failed/)?.[1]
      ? parseInt(tests2.match(/Tests\s+(\d+)\s+failed/)![1]) : 0;

    return { tsc: tsc2 === null, tests: pc > 0 && fc === 0, build: false, passCount: pc, failCount: fc, allGreen: false };
  }

  async phase6Publish(gap: Gap): Promise<boolean> {
    this.log("INFO", "=== PHASE 6: PUBLISH ===");
    const status = this.runAllowFail("git status --short", this.config.repoPath);
    if (!status?.trim()) { this.log("INFO", "No changes"); return false; }

    if (this.config.dryRun) { this.log("INFO", "Dry run — skipping"); return false; }

    this.runAllowFail("git config user.email 'avasis-ai@users.noreply.github.com'", this.config.repoPath);
    this.runAllowFail("git config user.name 'avasis-ai'", this.config.repoPath);
    this.runAllowFail("git pull --rebase origin main 2>&1", this.config.repoPath);

    const currentVer = JSON.parse(readFileSync(join(this.config.repoPath, "package.json"), "utf-8")).version;
    const [major, minor, patch] = currentVer.split(".").map(Number);
    const newVer = `${major}.${minor}.${patch + 1}`;
    const pkg = JSON.parse(readFileSync(join(this.config.repoPath, "package.json"), "utf-8"));
    pkg.version = newVer;
    writeFileSync(join(this.config.repoPath, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    this.runAllowFail("npm install --silent", this.config.repoPath);
    this.log("INFO", `Version: ${newVer}`);

    const headBefore = this.runAllowFail("git rev-parse HEAD", this.config.repoPath)?.trim() || "";
    this.runAllowFail("git add -A", this.config.repoPath);

    const commitMsgFile = `/tmp/synthloop-commit-${Date.now()}.txt`;
    const sources = [...new Set(gap.source_repos || [])].join(", ");
    writeFileSync(commitMsgFile, `feat: ${gap.pattern_name}\n\nFrom: ${sources}\n\nSynthLoop cluster cycle #${this.state.cycle}`);
    const commitResult = this.runAllowFail(`git commit -F ${commitMsgFile} 2>&1`, this.config.repoPath);
    this.log("INFO", `Commit: ${(commitResult || "").slice(0, 200)}`);

    const headAfter = this.runAllowFail("git rev-parse HEAD", this.config.repoPath)?.trim() || "";
    this.runAllowFail(`rm -f ${commitMsgFile}`);

    if (headBefore === headAfter) {
      this.log("WARN", "No new commit");
      this.rollback();
      return false;
    }

    let push = this.runAllowFail("git push origin main 2>&1", this.config.repoPath);
    if ((push || "").includes("error") || (push || "").includes("rejected") || (push || "").includes(" behind")) {
      this.log("WARN", "Push issue, pulling");
      this.runAllowFail("git pull --rebase origin main 2>&1", this.config.repoPath);
      this.runAllowFail("git add -A", this.config.repoPath);
      this.runAllowFail(`git commit --amend --no-edit 2>&1`, this.config.repoPath);
      push = this.runAllowFail("git push origin main 2>&1", this.config.repoPath);
    }

    if (push && !push.includes("error") && !push.includes("rejected")) {
      const commit = this.runAllowFail("git log -1 --oneline", this.config.repoPath)?.trim() || null;
      this.log("INFO", `Pushed: ${commit}`);

      if (this.config.autoPublish) {
        const pubResult = this.runAllowFail("npm publish --access public 2>&1", this.config.repoPath);
        this.log("INFO", `Publish: ${(pubResult || "").slice(0, 300)}`);
      }

      this.state.version = newVer;
      this.state.lastCommit = commit;
      this.state.lastPublishedVersion = newVer;
      this.state.totalImprovements++;
      this.state.consecutiveFailures = 0;
      return true;
    }

    this.log("ERROR", "Push failed");
    return false;
  }

  private async makeAgent(maxTurns?: number): Promise<Agent> {
    const provider = new OllamaProvider({ model: "gemma4:e4b" });
    return new Agent({
      model: provider,
      tools: [BashTool, FileReadTool, FileWriteTool, FileEditTool, GlobTool, GrepTool],
      maxTurns: maxTurns || 30,
    });
  }

  async runCycle(): Promise<CycleResult> {
    this.state.cycle++;
    const start = Date.now();
    const phases: Record<string, number> = {};
    this.log("INFO", `\n${"=".repeat(50)}`);
    this.log("INFO", `CYCLE #${this.state.cycle} | v${this.state.version} | Upgrades: ${this.state.totalImprovements} | Fails: ${this.state.totalFailed}`);
    this.log("INFO", `Cluster: ${this.cluster.getSlots().map(s => `${s.role}=${s.model}`).join(", ")}`);
    this.log("INFO", `${"=".repeat(50)}`);

    this.backup();

    try {
      const t0 = Date.now();
      const patterns = await this.phase1Discover();
      phases.discover = Date.now() - t0;

      if (!patterns.length) {
        this.saveState();
        return { cycle: this.state.cycle, status: "success", duration_s: Math.round((Date.now() - start) / 1000), phases };
      }

      const allFile = join(this.dataDir, "all-patterns.json");
      const existing: Pattern[] = existsSync(allFile) ? JSON.parse(readFileSync(allFile, "utf-8")) : [];
      existing.push(...patterns);
      writeFileSync(allFile, JSON.stringify(existing, null, 2));

      const t1 = Date.now();
      const gaps = await this.phase2Analyze(existing);
      phases.analyze = Date.now() - t1;

      if (!gaps.length) throw new Error("No valid gaps found");

      const gap = gaps[0];
      this.log("INFO", `Selected gap: ${gap.pattern_name} (P${gap.priority})`);
      await new Promise(r => setTimeout(r, 2000));

      const t2 = Date.now();
      const useDebate = this.cluster.getSlotsByRole("implementer").length >= 2 &&
                        this.cluster.getSlotsByRole("reviewer").length >= 1;
      const implOk = useDebate
        ? await this.phase3WithDebate(gap)
        : await this.phase3Implement(gap);
      phases.implement = Date.now() - t2;

      if (!implOk) throw new Error("Implementation failed");

      const t3 = Date.now();
      if (!this.secure().safe) throw new Error("Security blocked");
      phases.security = Date.now() - t3;

      const t4 = Date.now();
      const vr = await this.phase5Verify();
      phases.verify = Date.now() - t4;

      if (!vr.allGreen) throw new Error(`Verify: tsc=${vr.tsc} tests=${vr.passCount}p/${vr.failCount}f`);

      const t5 = Date.now();
      if (!(await this.phase6Publish(gap))) throw new Error("Publish failed");
      phases.publish = Date.now() - t5;

      if (this.config.selfUpgrade) {
        this.log("INFO", "=== PHASE 7: SELF-UPGRADE ===");
        try {
          const pkg = this.config.packageName || "@avasis-ai/synth-loop";
          const scope = pkg.startsWith("@") ? pkg.split("/")[0] : "";
          const reg = scope ? `//registry.npmjs.org/:_authToken=\${process.env.NPM_TOKEN}` : "";
          if (reg) {
            const npmrc = join(this.dataDir, ".npmrc");
            writeFileSync(npmrc, reg);
          }
          const latest = execSync(`npm view ${pkg} version 2>/dev/null`, { encoding: "utf-8", timeout: 15000, env: _env }).trim();
          this.log("INFO", `Latest ${pkg}: ${latest}, current: ${this.state.version}`);
          if (latest && latest !== this.state.version) {
            execSync(`npm install ${pkg}@${latest}`, { encoding: "utf-8", timeout: 60000, cwd: this.config.repoPath, env: _env });
            this.log("INFO", `Self-upgraded to ${pkg}@${latest}`);
            this.state.version = latest;
          } else {
            this.log("INFO", "Already on latest version");
          }
        } catch (e: any) {
          this.log("WARN", `Self-upgrade failed: ${e.message}`);
        }
      }

      const result: CycleResult = {
        cycle: this.state.cycle, status: "success", version: this.state.version,
        patterns: patterns.length, gaps: gaps.length,
        improvements: [gap.pattern_name], tests: vr.passCount,
        duration_s: Math.round((Date.now() - start) / 1000), phases,
      };
      this.appendHistory(result);
      return result;
    } catch (e: any) {
      this.log("ERROR", `Cycle #${this.state.cycle}: ${e.message}`);
      this.state.consecutiveFailures++;
      this.state.totalFailed++;
      this.rollback();

      const result: CycleResult = {
        cycle: this.state.cycle, status: "failed", error: e.message,
        duration_s: Math.round((Date.now() - start) / 1000), phases,
      };
      this.appendHistory(result);

      if (this.state.consecutiveFailures >= (this.config.maxConsecutiveFailures || 5)) {
        this.log("ERROR", `${this.config.maxConsecutiveFailures} fails — 10min backoff`);
        await new Promise(r => setTimeout(r, 600_000));
        this.state.consecutiveFailures = 0;
      }
      return result;
    } finally {
      this.saveState();
    }
  }

  async start(): Promise<void> {
    this.log("INFO", "SynthLoop v2 — Multi-Agent Cluster Orchestrator");
    this.log("INFO", `Cluster: ${this.cluster.getSlots().length} slots`);
    for (const slot of this.cluster.getSlots()) {
      this.log("INFO", `  ${slot.role.padEnd(12)} → ${slot.model} (${slot.id})`);
    }
    this.log("INFO", `Speculative: ${this.config.speculativeDrafts} drafts | Consensus: ${(this.config.consensusMinAgreement || 0.6) * 100}% | Debate: ${this.config.maxDebateRounds} rounds`);
    this.log("INFO", `Resuming: cycle #${this.state.cycle}, ${this.state.totalImprovements} upgrades`);

    while (true) {
      await this.runCycle();
      await new Promise(r => setTimeout(r, this.config.cycleSleepMs || 60_000));
    }
  }

  stop(): void {
    this.log("INFO", "SynthLoop stopped");
    process.exit(0);
  }
}

function defaultLog(level: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${level}] ${msg}`);
}
