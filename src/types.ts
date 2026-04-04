export interface AgentSlot {
  id: string;
  model: string;
  role: AgentRole;
  ollamaUrl: string;
  maxTokens?: number;
  temperature?: number;
}

export type AgentRole =
  | "planner"
  | "implementer"
  | "reviewer"
  | "attacker"
  | "fixer"
  | "clerk";

export interface ClusterConfig {
  slots: AgentSlot[];
  ollamaUrl?: string;
  maxParallel?: number;
  requestTimeoutMs?: number;
  retryAttempts?: number;
  retryBackoffMs?: number;
}

export interface LoopConfig {
  repoPath: string;
  cluster: ClusterConfig;
  repos: RepoSource[];
  context7Key?: string;
  morphApiKey?: string;
  cycleSleepMs?: number;
  maxConsecutiveFailures?: number;
  autoFix?: boolean;
  autoPublish?: boolean;
  selfUpgrade?: boolean;
  packageName?: string;
  dryRun?: boolean;
  useMorph?: boolean;
  speculativeDrafts?: number;
  consensusMinAgreement?: number;
  maxDebateRounds?: number;
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

export interface TaskRequest {
  type: TaskType;
  role: AgentRole;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

export type TaskType =
  | "analyze"
  | "implement"
  | "review"
  | "attack"
  | "fix_tsc"
  | "fix_test"
  | "fix_build"
  | "security"
  | "commit"
  | "plan";

export interface TaskResult {
  slotId: string;
  model: string;
  role: AgentRole;
  content: string;
  tokensIn?: number;
  tokensOut?: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface ConsensusResult {
  agreed: boolean;
  content: string;
  votes: TaskResult[];
  confidence: number;
  arbitrator?: TaskResult;
}

export interface SpeculativeResult {
  accepted: boolean;
  draft: TaskResult;
  verification?: TaskResult;
  final: string;
  savedTokens: number;
}

export interface RetryStrategy {
  failureType: "tsc" | "test" | "build" | "security" | "review" | "timeout" | "unknown";
  slotId: string;
  maxAttempts: number;
  backoffMs: number;
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
  phases?: Record<string, number>;
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
  clusterStats: ClusterStats;
}

export interface ClusterStats {
  totalRequests: number;
  totalTokens: number;
  totalDurationMs: number;
  bySlot: Record<string, { requests: number; tokens: number; errors: number }>;
  consensusHits: number;
  consensusMisses: number;
  speculativeAccepted: number;
  speculativeRejected: number;
}

export interface SecurityIssue {
  type: "blocked_file" | "blocked_pattern";
  detail: string;
}

export interface SecurityResult {
  safe: boolean;
  issues: SecurityIssue[];
}

export type LogFn = (level: string, msg: string) => void;
