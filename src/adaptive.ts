import type { TaskRequest, LogFn } from "./types.js";
import type { Cluster } from "./cluster.js";
import { TaskRouter } from "./router.js";

export class AdaptiveRetry {
  private cluster: Cluster;
  private router: TaskRouter;
  private log: LogFn;
  private failureHistory: Array<{ type: string; slotId: string; ts: number }> = [];

  constructor(cluster: Cluster, router: TaskRouter, logFn?: LogFn) {
    this.cluster = cluster;
    this.router = router;
    this.log = logFn || (() => {});
  }

  async retryWithStrategy(
    request: TaskRequest,
    error: string,
    attempt: number,
    maxAttempts: number,
  ): Promise<{ content: string; success: boolean; fixed: boolean }> {
    const failureType = this.classifyError(error);
    const strategy = this.router.getRetryStrategy(failureType);

    this.failureHistory.push({ type: failureType, slotId: request.role, ts: Date.now() });

    this.log("INFO", `Adaptive retry: ${failureType} → ${strategy.slotId} (attempt ${attempt}/${strategy.maxAttempts})`);

    if (attempt >= strategy.maxAttempts) {
      this.log("WARN", `Max retries (${strategy.maxAttempts}) reached for ${failureType}`);
      return { content: "", success: false, fixed: false };
    }

    const backoff = strategy.backoffMs * attempt;
    if (backoff > 0) {
      this.log("INFO", `Backoff ${backoff}ms`);
      await new Promise(r => setTimeout(r, backoff));
    }

    if (attempt >= 2) {
      const escalated = this.router.escalate(request);
      const result = await this.cluster.execute(escalated);
      return { content: result.content, success: result.success, fixed: result.success };
    }

    const fixRequest: TaskRequest = {
      ...request,
      role: strategy.slotId === "fixer" ? "fixer" : request.role,
    };

    const result = await this.cluster.execute(fixRequest);
    return { content: result.content, success: result.success, fixed: result.success };
  }

  private classifyError(error: string): string {
    if (error.includes("TypeScript") || error.includes("tsc") || error.includes("TS2")) return "tsc";
    if (error.includes("test") || error.includes("FAIL") || error.includes("assert")) return "test";
    if (error.includes("build") || error.includes("tsup") || error.includes("rollup")) return "build";
    if (error.includes("secret") || error.includes("token") || error.includes("credential")) return "security";
    if (error.includes("timeout") || error.includes("ETIMEDOUT") || error.includes("120000")) return "timeout";
    return "unknown";
  }

  getRecentFailures(windowMs: number = 300_000): number {
    const cutoff = Date.now() - windowMs;
    return this.failureHistory.filter(f => f.ts > cutoff).length;
  }

  clearHistory() {
    this.failureHistory = [];
  }
}
