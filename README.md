# synth-loop

> The AI that upgrades itself. Point it at any codebase and it runs forever, getting smarter with every cycle.

```bash
npx @avasis-ai/synth-loop run ./my-project --auto-publish --self-upgrade
```

One command. That's it. synth-loop will:

1. Scrape the best open-source AI agent frameworks (Claude Code, Aider, Cline, Codex, OpenHands, MCP, Swarm, and more)
2. Extract their design patterns, architectures, and implementation techniques
3. Analyze your codebase for gaps
4. Write the improvements
5. Run tests, fix errors automatically
6. Scan for leaked secrets before every push
7. Commit, push, publish to npm
8. Reinstall its own new version — then use its improved self for the next cycle

This is recursive self-improvement. The snake eats its own tail and grows stronger.

[![npm version](https://img.shields.io/npm/v/@avasis-ai/synth-loop?logo=osi)](https://www.npmjs.com/package/@avasis-ai/synth-loop)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-Welcome-brightgreen.svg)](https://github.com/avasis-ai/synth-loop/pulls)

## How It Works

```
  DISCOVER          ANALYZE          IMPLEMENT         VERIFY           PUBLISH
+-----------+    +------------+    +-------------+   +-----------+   +-----------+
|  15 OSS   |    |   Compare  |    |  Write code |   |  tsc/test |   |  git push |
|  repos     |--->|   patterns |-->|  changes    |-->|  auto-fix |-->|  npm pub  |
|  Context7  |    |   rank gaps |    |  add tests  |   |  security |   |  version  |
|  GitHub    |    |   plan impl |    |  follow conv|   |  scan     |   |  bump    |
+-----------+    +------------+    +-------------+   +-----------+   +-----------+
       ^                                                                       |
       |                              SELF-UPGRADE                               |
       +--------------------- reinstall own new version ----------------------+
```

Each cycle scans one repo from a curated list of 15 world-class open-source projects. Patterns accumulate across cycles. The analysis phase compares all discovered patterns against your codebase, ranking gaps by impact. The top 3 are implemented, tested, and published.

After publishing, synth-loop reinstalls itself with its own new version. The next cycle runs with whatever improvements it just made to itself. This is the bootstrapping loop.

## Quick Start

### Prerequisites

- Node.js 22+
- Ollama running locally with a capable model (qwen3-coder-next:79B recommended)
- A GitHub repo with tests that pass

### Install

```bash
npm install @avasis-ai/synth-loop
```

### Run

```bash
# Basic — dry run, no push
npx @avasis-ai/synth-loop run ./my-project

# Full autonomous mode — push, publish, self-upgrade
npx @avasis-ai/synth-loop run ./my-project --auto-publish --self-upgrade

# With Context7 docs for richer pattern discovery
npx @avasis-ai/synth-loop run ./my-project --context7 YOUR_CTX7_KEY

# Custom model and timing
npx @avasis-ai/synth-loop run ./my-project --model qwen3.5:35b --sleep 300000
```

### Standalone Tools

```bash
# Scan your git diff for leaked secrets
npx @avasis-ai/synth-loop secure ./my-project

# Generate a hardened .gitignore
npx @avasis-ai/synth-loop gitignore ./my-project
```

## Architecture

synth-loop is built on top of [SynthCode](https://github.com/avasis-ai/synthcode), an open-source AI agent framework. Each phase of the loop runs as a SynthCode agent — an LLM with access to bash, file read/write, glob, grep, and git tools.

### The Seven Phases

| Phase | What happens |
|-------|-------------|
| **Discover** | Scrapes an OSS repo via GitHub API. Fetches Context7 docs if available. Extracts 5-20 design patterns. |
| **Analyze** | Compares all accumulated patterns against your source code. Identifies the top 3 highest-impact gaps. |
| **Implement** | An agent writes TypeScript code changes, new files, and tests following your project's conventions. |
| **Secure** | Scans the git diff for API keys, tokens, secrets, credentials, private keys, and .env files. Blocks push if found. |
| **Verify** | Runs `tsc --noEmit`, `npm test`, `npm run build`. If anything fails, spawns a fix agent automatically. |
| **Publish** | Bumps version, commits with detailed message, pushes to GitHub, optionally publishes to npm. |
| **Self-Upgrade** | Reinstalls its own package at the new version. The next cycle runs with improved capabilities. |

### Repos Scanned

| Repo | Focus |
|------|-------|
| anthropics/claude-code | Claude Code official agent |
| paul-gauthier/aider | Aider AI coding assistant |
| cline/cline | Cline autonomous agent |
| All-Hands-AI/OpenHands | OpenHands agent framework |
| openai/codex | OpenAI Codex CLI agent |
| anthropics/model-context-protocol | MCP protocol SDK |
| openai/swarm | Multi-agent orchestration |
| browser-use/browser-use | Browser automation |
| e2b-dev/code-interpreter | Sandboxed execution |
| langgenius/dify | AI app platform |
| upstash/context7 | Context7 MCP server |
| jina-ai/reader | Content extraction |
| mendableai/firecrawl | Web scraping |
| intel/auto-gpt | Autonomous agent |
| wonderwhy-er/computer-use | Computer use agent |

## Security

synth-loop treats security as non-negotiable. Every diff is scanned before pushing:

- **API keys** — GitHub PATs, npm tokens, Context7 keys, AWS keys, Bearer tokens
- **Secrets** — passwords, private keys, credentials files
- **Sensitive files** — .env, .pem, .key, .pfx, .npmrc, service-account.json
- **Hardened .gitignore** — generated automatically, blocks all known sensitive patterns

If anything is detected, the push is blocked and the cycle rolls back.

## Programmatic API

```typescript
import { SynthLoop } from "@avasis-ai/synth-loop";

const loop = new SynthLoop({
  repoPath: "./my-project",
  model: "qwen3-coder-next:latest",
  context7Key: process.env.CTX7_KEY,
  autoPublish: true,
  selfUpgrade: true,
});

loop.start();
```

## What Makes This Different

| | CI/CD | Copilot | Devin | synth-loop |
|---|-------|---------|-------|------------|
| Autonomous | No | No | Yes | Yes |
| Self-improving | No | No | No | Yes |
| Open source | Yes | No | No | Yes |
| Works offline | No | No | No | Yes |
| Zero config | No | No | No | Yes |
| Scans other repos | No | No | No | Yes |
| Recursive bootstrapping | No | No | No | Yes |
| Costs per month | $0-20 | $10-100 | $500+ | $0 (your hardware) |

## The Ouroboros Pattern

The name comes from the ouroboros — the snake eating its own tail. In software, this means a system that can modify its own source code, test the changes, deploy them, and then use the improved version for the next iteration.

This is not science fiction. It's running right now on a workstation with an RTX PRO 6000 Blackwell, continuously upgrading [SynthCode](https://github.com/avasis-ai/synthcode) by learning from the best open-source agent frameworks in the world.

Every cycle, the tool gets better at upgrading itself. The improvements compound.

## License

MIT
