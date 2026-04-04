#!/usr/bin/env node
import { SynthLoop } from "./loop.js";
import { Cluster } from "./cluster.js";
import { getDefaultRepos } from "./discover.js";
import { scanDiff, generateHardenedGitignore } from "./security.js";
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const command = args[0];

function printUsage() {
  console.log(`
synth-loop v2 — Multi-Agent Cluster Orchestrator

USAGE:
  synth-loop run [repo-path]          Start the cluster loop
  synth-loop secure [repo-path]       Scan for leaked secrets
  synth-loop gitignore [repo-path]    Generate hardened .gitignore

CLUSTER OPTIONS:
  --ollama <url>        Ollama API URL (default: http://localhost:11434)
  --planner <model>     Planner model (default: gemma4:31b)
  --worker <model>      Worker model (default: gemma4:26b)
  --fixer <model>       Fixer model (default: gemma4:e4b)
  --clerk <model>       Clerk model (default: gemma4:e2b)
  --drafts <n>          Speculative drafts per task (default: 1)
  --debate <n>          Debate rounds for implementation (default: 2)
  --consensus <pct>     Min agreement threshold 0-1 (default: 0.6)

LOOP OPTIONS:
  --context7 <key>       Context7 API key
  --sleep <ms>           Sleep between cycles (default: 60000)
  --max-failures <n>     Max consecutive failures before backoff (default: 5)
  --no-auto-fix          Disable TypeScript/test auto-fix
  --auto-publish         Enable npm publish after each cycle
  --self-upgrade         Reinstall own package after publish
  --dry-run              Skip git push and npm publish
  --use-morph            Use MorphLLM API instead of local cluster
`);
}

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

const repoPath = resolve(args.find((a) => !a.startsWith("--")) || ".");
const ollamaUrl = getArg("--ollama") || "http://localhost:11434";
const plannerModel = getArg("--planner") || "gemma4:31b";
const workerModel = getArg("--worker") || "gemma4:26b";
const fixerModel = getArg("--fixer") || "gemma4:e4b";
const clerkModel = getArg("--clerk") || "gemma4:e2b";

if (command === "run") {
  const clusterConfig = Cluster.defaultCluster(ollamaUrl);
  if (getArg("--planner")) clusterConfig.slots[0].model = plannerModel;
  if (getArg("--worker")) {
    clusterConfig.slots[1].model = workerModel;
    clusterConfig.slots[2].model = workerModel;
    clusterConfig.slots[3].model = workerModel;
  }
  if (getArg("--fixer")) clusterConfig.slots[4].model = fixerModel;
  if (getArg("--clerk")) clusterConfig.slots[5].model = clerkModel;

  const loop = new SynthLoop({
    repoPath,
    cluster: clusterConfig,
    context7Key: getArg("--context7"),
    cycleSleepMs: parseInt(getArg("--sleep") || "60000"),
    maxConsecutiveFailures: parseInt(getArg("--max-failures") || "5"),
    autoFix: !hasFlag("--no-auto-fix"),
    autoPublish: hasFlag("--auto-publish"),
    repos: getDefaultRepos(),
    selfUpgrade: hasFlag("--self-upgrade"),
    dryRun: hasFlag("--dry-run"),
    useMorph: hasFlag("--use-morph"),
    speculativeDrafts: parseInt(getArg("--drafts") || "1"),
    consensusMinAgreement: parseFloat(getArg("--consensus") || "0.6"),
    maxDebateRounds: parseInt(getArg("--debate") || "2"),
  });
  loop.start();
} else if (command === "secure") {
  const diff = execSync("git diff HEAD 2>/dev/null; git diff --cached HEAD 2>/dev/null", {
    cwd: repoPath, encoding: "utf-8",
  });
  const files = execSync("git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null", {
    cwd: repoPath, encoding: "utf-8",
  });
  const result = scanDiff(diff, files.split("\n").filter(Boolean));
  if (result.safe) {
    console.log("No secrets/tokens/keys detected in diff.");
  } else {
    console.error("SECURITY ISSUES FOUND:");
    for (const issue of result.issues) {
      console.error(`  [${issue.type}] ${issue.detail}`);
    }
    process.exit(1);
  }
} else if (command === "gitignore") {
  const gitignorePath = resolve(repoPath, ".gitignore");
  writeFileSync(gitignorePath, generateHardenedGitignore());
  console.log(`Generated hardened .gitignore at ${gitignorePath}`);
} else {
  printUsage();
  process.exit(command ? 1 : 0);
}
