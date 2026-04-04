import { Agent, OllamaProvider } from "@avasis-ai/synthcode";
import {
  BashTool, FileReadTool, FileWriteTool, FileEditTool, GlobTool, GrepTool,
} from "@avasis-ai/synthcode/tools";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import type {
  LoopConfig, LoopState, CycleResult, Pattern, Gap,
  VerifyResult, SecurityResult,
} from "./types.js";
import { scanDiff } from "./security.js";
import {
  buildDiscoverPrompt, buildAnalyzePrompt, buildImplementPrompt, buildFixPrompt,
  getDefaultRepos,
} from "./discover.js";
import { context7Search, context7Docs, hasMorphKey, hasContext7Key } from "./morph.js";

const DEFAULT_CONFIG: Required<Omit<LoopConfig, "repoPath">> = {
  model: "qwen3-coder-next:latest",
  provider: "ollama",
  repos: getDefaultRepos(),
  context7Key: undefined as unknown as string,
  morphApiKey: undefined as unknown as string,
  cycleSleepMs: 60_000,
  maxConsecutiveFailures: 5,
  maxTurns: 60,
  autoFix: true,
  autoPublish: false,
  selfUpgrade: false,
  dryRun: false,
};

export type LogFn = (level: string, msg: string) => void;

function defaultLog(level: string, msg: string) {
  const ts = new Date().toISOString();
  const line = `${ts} [${level}] ${msg}`;
  console.log(line);
}

export class SynthLoop {
  private config: Required<LoopConfig>;
  private state: LoopState;
  private log: LogFn;
  private dataDir: string;
  private backupsDir: string;

  constructor(config: LoopConfig, logFn?: LogFn) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.log = logFn || defaultLog;
    this.dataDir = join(config.repoPath, ".synth-loop");
    this.backupsDir = join(this.dataDir, "backups");
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.backupsDir, { recursive: true });
    this.state = this.loadState();
  }

  private loadState(): LoopState {
    const f = join(this.dataDir, "state.json");
    if (existsSync(f)) return JSON.parse(readFileSync(f, "utf-8"));
    return {
      cycle: 0, consecutiveFailures: 0, totalImprovements: 0, totalFailed: 0,
      reposScanned: [], patternsDiscovered: 0,
      version: "0.0.0", lastCommit: null, lastPublishedVersion: null,
    };
  }

  private saveState() {
    writeFileSync(join(this.dataDir, "state.json"), JSON.stringify(this.state, null, 2));
  }

  private appendHistory(entry: CycleResult) {
    const f = join(this.dataDir, "history.jsonl");
    appendFileSync(f, JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n");
  }

  private run(cmd: string, cwd?: string, timeout = 120_000): string | null {
    try {
      return execSync(cmd, { cwd: cwd || this.config.repoPath, timeout, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return null;
    }
  }

  private backup(): string {
    const d = join(this.backupsDir, `v${Date.now()}`);
    this.run(`cp -r ${this.config.repoPath} ${d}`, undefined, 60_000);
    return d;
  }

  private rollback(bak: string) {
    this.log("WARN", `Rolling back from ${bak}`);
    this.run(`rm -rf ${this.config.repoPath} && cp -r ${bak} ${this.config.repoPath}`, undefined, 60_000);
    this.run("npm install --silent", this.config.repoPath);
  }

  private async makeAgent(maxTurns?: number): Promise<Agent> {
    const turns = maxTurns || this.config.maxTurns;
    const provider = new OllamaProvider({ model: this.config.model });
    return new Agent({
      model: provider,
      tools: [BashTool, FileReadTool, FileWriteTool, FileEditTool, GlobTool, GrepTool],
      maxTurns: turns,
    });
  }

  getState(): LoopState { return { ...this.state }; }

  getConfig(): Required<LoopConfig> { return { ...this.config }; }

  async discover(): Promise<Pattern[]> {
    const unscanned = this.config.repos.filter(
      (r) => !this.state.reposScanned.includes(`${r.owner}/${r.repo}`),
    );
    if (!unscanned.length) {
      this.state.reposScanned = [];
      unscanned.push(...this.config.repos);
    }

    const repo = unscanned[0];
    const key = `${repo.owner}/${repo.repo}`;
    this.log("INFO", `Scanning ${key}`);

    let ctx7Content = "";
    if (repo.ctx7 && this.config.context7Key) {
      const hits = await context7Search(repo.ctx7, this.config.context7Key);
      if (hits.length) {
        this.log("INFO", `Context7: ${hits.length} libs for ${repo.ctx7}`);
        const docs = await context7Docs(hits[0].id, "architecture patterns agent tool core", this.config.context7Key);
        if (docs?.content) ctx7Content = docs.content;
      }
    }

    const agent = await this.makeAgent();
    const pFile = join(this.dataDir, `patterns-${key.replace("/", "-")}.json`);
    const prompt = buildDiscoverPrompt(repo, this.config, ctx7Content);

    try {
      await agent.chat(prompt);
      this.state.reposScanned.push(key);
      if (existsSync(pFile)) {
        const patterns: Pattern[] = JSON.parse(readFileSync(pFile, "utf-8"));
        if (Array.isArray(patterns) && patterns.length > 0) {
          this.state.patternsDiscovered += patterns.length;
          this.log("INFO", `Extracted ${patterns.length} patterns from ${key}`);
          return patterns;
        }
      }
      this.log("WARN", "No valid patterns file");
    } catch (e: any) {
      this.log("ERROR", `Discovery: ${e.message}`);
    }
    return [];
  }

  async analyze(allPatterns: Pattern[]): Promise<Gap[]> {
    this.log("INFO", `Analyzing ${allPatterns.length} patterns`);
    const agent = await this.makeAgent(50);
    const gapFile = join(this.dataDir, "gaps.json");
    const prompt = buildAnalyzePrompt(allPatterns, this.config.repoPath);

    try {
      await agent.chat(prompt);
      if (existsSync(gapFile)) {
        const gaps: Gap[] = JSON.parse(readFileSync(gapFile, "utf-8"));
        if (Array.isArray(gaps) && gaps.length > 0) {
          const top = gaps.sort((a, b) => (b.priority || 5) - (a.priority || 5)).slice(0, 3);
          this.log("INFO", `Found ${gaps.length} gaps, top ${top.length}`);
          return top;
        }
      }
    } catch (e: any) {
      this.log("ERROR", `Analysis: ${e.message}`);
    }
    return [];
  }

  async implement(gaps: Gap[]): Promise<boolean> {
    this.log("INFO", `Implementing ${gaps.length} improvements`);
    const agent = await this.makeAgent(80);
    const prompt = buildImplementPrompt(gaps, this.config.repoPath);
    try {
      await agent.chat(prompt);
      this.log("INFO", "Implementation done");
      return true;
    } catch (e: any) {
      this.log("ERROR", `Implement: ${e.message}`);
      return false;
    }
  }

  secure(): SecurityResult {
    this.log("INFO", "Security scan");
    const diff = this.run("git diff HEAD 2>/dev/null; git diff --cached HEAD 2>/dev/null") || "";
    const files = this.run("git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null") || "";
    const fileList = files.split("\n").filter(Boolean);
    const result = scanDiff(diff, fileList);
    if (result.safe) {
      this.log("INFO", "Security: PASS");
    } else {
      this.log("ERROR", `Security: FAIL — ${result.issues.map((i) => i.detail).join("; ")}`);
    }
    return result;
  }

  async verify(): Promise<VerifyResult> {
    this.log("INFO", "Verify");
    this.run("npm install --silent", this.config.repoPath);

    let tscPass = this.run("./node_modules/.bin/tsc --noEmit", this.config.repoPath) !== null;

    if (!tscPass && this.config.autoFix) {
      this.log("WARN", "TypeScript errors — auto-fixing");
      const errors = this.run("./node_modules/.bin/tsc --noEmit 2>&1", this.config.repoPath) || "unknown";
      const agent = await this.makeAgent(30);
      await agent.chat(buildFixPrompt(errors, this.config.repoPath, "typescript"));
      this.run("npm install --silent", this.config.repoPath);
      tscPass = this.run("./node_modules/.bin/tsc --noEmit", this.config.repoPath) !== null;
      this.log(tscPass ? "INFO" : "ERROR", `TypeScript auto-fix: ${tscPass ? "PASS" : "STILL FAIL"}`);
    }

    let tests = this.run("npm test", this.config.repoPath) || "";
    let testsPass = tests.includes("passed");
    let passCount = tests.match(/(\d+)\s+passed/)?.[1] ? parseInt(tests.match(/(\d+)\s+passed/)![1]) : 0;
    let failCount = tests.match(/(\d+)\s+failed/)?.[1] ? parseInt(tests.match(/(\d+)\s+failed/)![1]) : 0;

    if (!testsPass && tscPass && this.config.autoFix) {
      this.log("WARN", "Tests failing — auto-fixing");
      const agent = await this.makeAgent(30);
      await agent.chat(buildFixPrompt(tests, this.config.repoPath, "tests"));
      this.run("npm install --silent", this.config.repoPath);
      tests = this.run("npm test", this.config.repoPath) || "";
      testsPass = tests.includes("passed");
      passCount = tests.match(/(\d+)\s+passed/)?.[1] ? parseInt(tests.match(/(\d+)\s+passed/)![1]) : passCount;
      failCount = tests.match(/(\d+)\s+failed/)?.[1] ? parseInt(tests.match(/(\d+)\s+failed/)![1]) : failCount;
    }

    const buildPass = this.run("npm run build", this.config.repoPath) !== null;
    const allGreen = tscPass && testsPass && buildPass;
    this.log(allGreen ? "INFO" : "ERROR", `Verify: tsc=${tscPass} tests=${passCount}p/${failCount}f build=${buildPass}`);
    return { tsc: tscPass, tests: testsPass, build: buildPass, passCount, failCount, allGreen };
  }

  async publish(gaps: Gap[]): Promise<boolean> {
    this.log("INFO", "Publish");
    const diff = this.run("git diff --stat");
    if (!diff?.trim()) { this.log("INFO", "No changes"); return false; }

    if (this.config.dryRun) {
      this.log("INFO", "Dry run — skipping publish");
      return false;
    }

    this.run("npm version patch --no-git-tag-version");
    const newVer = this.run("node -p \"require('./package.json').version\"")?.trim() || "unknown";
    const names = gaps.map((g) => g.pattern_name).join(", ");
    const sources = [...new Set(gaps.flatMap((g) => g.source_repos || []))].join(", ");

    this.run("git add -A");
    this.run(`git commit -m "feat: ${names}\\n\\nPatterns from: ${sources}\\n\\nSynthLoop cycle #${this.state.cycle}"`);

    let push = this.run("git push origin main");
    if (!push) {
      this.log("WARN", "Push failed — pull rebase");
      this.run("git pull --rebase origin main");
      push = this.run("git push origin main");
    }

    if (push && this.config.autoPublish) {
      this.run("npm publish --access public");
      this.log("INFO", `Published v${newVer}`);
    }

    if (push) {
      const commit = this.run("git log -1 --oneline")?.trim() ?? null;
      this.log("INFO", `Pushed: ${commit}`);
      this.state.version = newVer;
      this.state.lastCommit = commit;
      this.state.lastPublishedVersion = newVer;
      this.state.totalImprovements += gaps.length;
      this.state.consecutiveFailures = 0;
      return true;
    }
    this.log("ERROR", "Push failed");
    return false;
  }

  async selfUpgrade(): Promise<void> {
    if (!this.config.selfUpgrade || !this.state.lastPublishedVersion) return;
    this.log("INFO", `Self-upgrade to v${this.state.lastPublishedVersion}`);
    this.run(`npm install ${this.config.selfUpgrade ? `@avasis-ai/synth-loop@${this.state.lastPublishedVersion}` : ""}`, join(this.config.repoPath, ".."));
  }

  async runCycle(): Promise<CycleResult> {
    this.state.cycle++;
    const start = Date.now();
    this.log("INFO", `\n${"=".repeat(50)}`);
    this.log("INFO", `CYCLE #${this.state.cycle} | Upgrades: ${this.state.totalImprovements} | Fails: ${this.state.totalFailed}`);
    this.log("INFO", `${"=".repeat(50)}`);

    const bak = this.backup();

    try {
      const patterns = await this.discover();
      if (!patterns.length) {
        this.saveState();
        return { cycle: this.state.cycle, status: "success", duration_s: Math.round((Date.now() - start) / 1000) };
      }

      const allFile = join(this.dataDir, "all-patterns.json");
      const existing: Pattern[] = existsSync(allFile) ? JSON.parse(readFileSync(allFile, "utf-8")) : [];
      existing.push(...patterns);
      writeFileSync(allFile, JSON.stringify(existing, null, 2));

      const gaps = await this.analyze(existing);
      if (!gaps.length) {
        this.saveState();
        return { cycle: this.state.cycle, status: "success", duration_s: Math.round((Date.now() - start) / 1000) };
      }

      if (!(await this.implement(gaps))) throw new Error("Implementation failed");
      if (!this.secure().safe) throw new Error("Security scan blocked");

      const vr = await this.verify();
      if (!vr.allGreen) throw new Error(`Verify failed: tsc=${vr.tsc} tests=${vr.tests}`);

      const published = await this.publish(gaps);
      if (published) await this.selfUpgrade();

      const result: CycleResult = {
        cycle: this.state.cycle, status: "success", version: this.state.version,
        patterns: patterns.length, gaps: gaps.length,
        improvements: gaps.map((g) => g.pattern_name), tests: vr.passCount,
        duration_s: Math.round((Date.now() - start) / 1000),
      };
      this.appendHistory(result);
      return result;
    } catch (e: any) {
      this.log("ERROR", `Cycle #${this.state.cycle}: ${e.message}`);
      this.state.consecutiveFailures++;
      this.state.totalFailed++;
      this.rollback(bak);

      const result: CycleResult = {
        cycle: this.state.cycle, status: "failed", error: e.message,
        duration_s: Math.round((Date.now() - start) / 1000),
      };
      this.appendHistory(result);

      if (this.state.consecutiveFailures >= this.config.maxConsecutiveFailures) {
        this.log("ERROR", `${this.config.maxConsecutiveFailures} failures — 10min backoff`);
        await new Promise((r) => setTimeout(r, 600_000));
        this.state.consecutiveFailures = 0;
      }
      return result;
    } finally {
      this.saveState();
    }
  }

  async start(): Promise<void> {
    this.log("INFO", "SynthLoop starting...");
    this.log("INFO", `Model: ${this.config.model} | Repo: ${this.config.repoPath}`);
    this.log("INFO", `Repos: ${this.config.repos.length} | Context7: ${this.config.context7Key ? "connected" : "no key"}`);
    this.log("INFO", `Auto-fix: ${this.config.autoFix} | Auto-publish: ${this.config.autoPublish} | Self-upgrade: ${this.config.selfUpgrade}`);
    this.log("INFO", `Resuming: cycle #${this.state.cycle}, ${this.state.totalImprovements} upgrades`);

    while (true) {
      await this.runCycle();
      await new Promise((r) => setTimeout(r, this.config.cycleSleepMs));
    }
  }

  stop(): void {
    this.log("INFO", "SynthLoop stopped");
    process.exit(0);
  }
}
