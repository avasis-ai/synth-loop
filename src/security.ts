import type { SecurityResult, SecurityIssue } from "./types.js";

const BLOCKED_PATTERNS = [
  /api[_-]?key\s*[:=]\s*['"][^'"]{10,}/i,
  /secret\s*[:=]\s*['"][^'"]{10,}/i,
  /token\s*[:=]\s*['"][^'"]{10,}/i,
  /password\s*[:=]\s*['"][^'"]{10,}/i,
  /Bearer\s+[a-zA-Z0-9_\-\.]{20,}/i,
  /ghp_[a-zA-Z0-9]{30,}/,
  /npm_[a-zA-Z0-9]{30,}/,
  /ctx7sk-[a-zA-Z0-9\-]{16,}/,
  /rpa_[a-zA-Z0-9]{30,}/,
  /rps_[a-zA-Z0-9]{30,}/,
  /sk-[a-zA-Z0-9]{30,}/,
  /AKIA[A-Z0-9]{16}/,
  /PRIVATE\s+KEY/i,
];

const BLOCKED_EXTENSIONS = [".key", ".pem", ".p12", ".pfx", ".env"];
const BLOCKED_NAMES = [
  "id_rsa", "id_ed25519", "credentials.json",
  "service-account.json", ".npmrc", "vault.json", "secrets.json",
];

export function scanDiff(diff: string, files: string[]): SecurityResult {
  const issues: SecurityIssue[] = [];

  for (const f of files) {
    const base = f.split("/").pop() || "";
    if (BLOCKED_EXTENSIONS.some((ext) => base.endsWith(ext)) || BLOCKED_NAMES.includes(base)) {
      issues.push({ type: "blocked_file", detail: f });
    }
  }

  for (const pat of BLOCKED_PATTERNS) {
    const m = diff.match(pat);
    if (m) issues.push({ type: "blocked_pattern", detail: m[0].slice(0, 50) });
  }

  return { safe: issues.length === 0, issues };
}

export function generateHardenedGitignore(): string {
  return `node_modules/
dist/
*.tsbuildinfo
.DS_Store
coverage/
.env
.env.*
!.env.example
*.key
*.pem
*.p12
*.pfx
credentials*
secrets*
vault*
id_rsa*
id_ed25519*
.npmrc
service-account*.json
*.log
`;
}
