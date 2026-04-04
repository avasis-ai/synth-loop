import { SynthLoop } from "./loop.js";
import { scanDiff, generateHardenedGitignore } from "./security.js";
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const command = args[0];

function printUsage() {
  console.log(`
synth-loop — The AI that upgrades itself

USAGE:
  synth-loop run [repo-path]          Start the self-improvement loop
  synth-loop secure [repo-path]       Scan for leaked secrets
  synth-loop gitignore [repo-path]    Generate hardened .gitignore

OPTIONS:
  --model <model>        Ollama model (default: qwen3-coder-next:latest)
  --context7 <key>       Context7 API key
  --sleep <ms>           Sleep between cycles (default: 60000)
  --max-failures <n>     Max consecutive failures before backoff (default: 5)
  --max-turns <n>        Max agent turns per phase (default: 60)
  --no-auto-fix          Disable TypeScript/test auto-fix
  --auto-publish         Enable npm publish after each cycle
  --self-upgrade         Reinstall own package after publish
  --dry-run              Skip git push and npm publish
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

if (command === "run") {
  const loop = new SynthLoop({
    repoPath,
    model: getArg("--model") || "qwen3-coder-next:latest",
    context7Key: getArg("--context7"),
    cycleSleepMs: parseInt(getArg("--sleep") || "60000"),
    maxConsecutiveFailures: parseInt(getArg("--max-failures") || "5"),
    maxTurns: parseInt(getArg("--max-turns") || "60"),
    autoFix: !hasFlag("--no-auto-fix"),
    autoPublish: hasFlag("--auto-publish"),
    selfUpgrade: hasFlag("--self-upgrade"),
    dryRun: hasFlag("--dry-run"),
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
