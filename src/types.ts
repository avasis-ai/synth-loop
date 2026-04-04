export interface LoopConfig {
  repoPath: string;
  model: string;
  provider?: string;
  repos: RepoSource[];
  context7Key?: string;
  morphApiKey?: string;
  cycleSleepMs?: number;
  maxConsecutiveFailures?: number;
  maxTurns?: number;
  autoFix?: boolean;
  autoPublish?: boolean;
  selfUpgrade?: boolean;
  dryRun?: boolean;
}

export interface RepoSource {
  owner: string;
  repo: string;
  ctx7?: string;
}

export interface Pattern {
  source: string;
  category: string;
  pattern_name: string;
  description: string;
  implementation: string;
  code_snippet?: string;
  benefit: string;
  priority: number;
  complexity: "low" | "medium" | "high";
}

export interface Gap {
  pattern_name: string;
  source_repos: string[];
  category: string;
  gap: string;
  approach: string;
  files_to_create: string[];
  files_to_modify: string[];
  tests_to_create: string[];
  estimated_loc: number;
  priority: number;
}

export interface VerifyResult {
  tsc: boolean;
  tests: boolean;
  build: boolean;
  passCount: number;
  failCount: number;
  allGreen: boolean;
}

export interface CycleResult {
  cycle: number;
  status: "success" | "failed";
  version?: string;
  patterns?: number;
  gaps?: number;
  improvements?: string[];
  tests?: number;
  error?: string;
  duration_s: number;
}

export interface LoopState {
  cycle: number;
  consecutiveFailures: number;
  totalImprovements: number;
  totalFailed: number;
  reposScanned: string[];
  patternsDiscovered: number;
  version: string;
  lastCommit: string | null;
  lastPublishedVersion: string | null;
}

export interface SecurityIssue {
  type: "blocked_file" | "blocked_pattern";
  detail: string;
}

export interface SecurityResult {
  safe: boolean;
  issues: SecurityIssue[];
}
