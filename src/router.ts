import type { TaskRequest, TaskType, RetryStrategy, AgentRole, LogFn } from "./types.js";
import type { Cluster } from "./cluster.js";

interface ComplexityScore {
  type: TaskType;
  complexity: "low" | "medium" | "high";
  role: AgentRole;
  reason: string;
}

const COMPLEXITY_RULES: ComplexityScore[] = [
  { type: "analyze", complexity: "high", role: "planner", reason: "Analysis requires deep reasoning across many patterns" },
  { type: "plan", complexity: "high", role: "planner", reason: "Planning requires architectural reasoning" },
  { type: "implement", complexity: "medium", role: "implementer", reason: "Implementation is guided by a plan" },
  { type: "review", complexity: "medium", role: "reviewer", reason: "Review needs careful code reading" },
  { type: "attack", complexity: "medium", role: "attacker", reason: "Adversarial review needs creative thinking" },
  { type: "security", complexity: "medium", role: "reviewer", reason: "Security review needs careful analysis" },
  { type: "fix_tsc", complexity: "low", role: "fixer", reason: "Type fixes are usually mechanical" },
  { type: "fix_test", complexity: "low", role: "fixer", reason: "Test fixes are usually mechanical" },
  { type: "fix_build", complexity: "low", role: "fixer", reason: "Build fixes are usually mechanical" },
  { type: "commit", complexity: "low", role: "clerk", reason: "Commit messages are templated" },
];

const RETRY_STRATEGIES: RetryStrategy[] = [
  { failureType: "tsc", slotId: "fixer", maxAttempts: 3, backoffMs: 2000 },
  { failureType: "test", slotId: "fixer", maxAttempts: 3, backoffMs: 2000 },
  { failureType: "build", slotId: "fixer", maxAttempts: 2, backoffMs: 3000 },
  { failureType: "security", slotId: "reviewer", maxAttempts: 1, backoffMs: 0 },
  { failureType: "review", slotId: "planner", maxAttempts: 2, backoffMs: 5000 },
  { failureType: "timeout", slotId: "fixer", maxAttempts: 2, backoffMs: 10000 },
  { failureType: "unknown", slotId: "fixer", maxAttempts: 2, backoffMs: 3000 },
];

export class TaskRouter {
  private cluster: Cluster;
  private log: LogFn;

  constructor(cluster: Cluster, logFn?: LogFn) {
    this.cluster = cluster;
    this.log = logFn || (() => {});
  }

  route(request: TaskRequest): TaskRequest {
    const rule = COMPLEXITY_RULES.find(r => r.type === request.type);
    if (rule) {
      request.role = rule.role;
      this.log("INFO", `Routed ${request.type} → ${rule.role} (${rule.complexity}: ${rule.reason})`);
    }
    return request;
  }

  getRetryStrategy(failureType: string): RetryStrategy {
    return RETRY_STRATEGIES.find(s => s.failureType === failureType) || RETRY_STRATEGIES[RETRY_STRATEGIES.length - 1];
  }

  escalate(request: TaskRequest): TaskRequest {
    const escalation: Partial<Record<AgentRole, AgentRole>> = {
      fixer: "implementer",
      implementer: "planner",
      reviewer: "planner",
      attacker: "planner",
    };
    const nextRole = escalation[request.role] || "planner";
    this.log("INFO", `Escalating ${request.role} → ${nextRole}`);
    return { ...request, role: nextRole };
  }

  selectSlotForRole(role: AgentRole): string | undefined {
    const slots = this.cluster.getSlotsByRole(role);
    if (!slots.length) return undefined;
    const stats = this.cluster.getStats();
    const sorted = [...slots].sort((a, b) =>
      (stats.bySlot[a.id]?.requests || 0) - (stats.bySlot[b.id]?.requests || 0)
    );
    return sorted[0].id;
  }
}
