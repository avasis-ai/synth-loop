import { describe, it, expect } from "vitest";
import { getDefaultRepos } from "../src/discover.js";
import { generateHardenedGitignore } from "../src/security.js";
import { Cluster } from "../src/cluster.js";
import { TaskRouter } from "../src/router.js";
import { ConsensusEngine } from "../src/consensus.js";
import { SpeculativeExecutor } from "../src/speculative.js";
import { AdaptiveRetry } from "../src/adaptive.js";
import type { ClusterConfig, TaskRequest } from "../src/types.js";

const testClusterConfig: ClusterConfig = {
  ollamaUrl: "http://localhost:11434",
  maxParallel: 2,
  requestTimeoutMs: 5000,
  retryAttempts: 0,
  slots: [
    { id: "planner", model: "gemma4:e2b", role: "planner", ollamaUrl: "http://localhost:11434" },
    { id: "impl", model: "gemma4:e2b", role: "implementer", ollamaUrl: "http://localhost:11434" },
    { id: "reviewer", model: "gemma4:e2b", role: "reviewer", ollamaUrl: "http://localhost:11434" },
    { id: "fixer", model: "gemma4:e2b", role: "fixer", ollamaUrl: "http://localhost:11434" },
  ],
};

describe("Cluster", () => {
  it("initializes with config", () => {
    const cluster = new Cluster(testClusterConfig);
    expect(cluster.getSlots()).toHaveLength(4);
    expect(cluster.getSlot("planner")).toBeDefined();
    expect(cluster.getSlot("nonexistent")).toBeUndefined();
  });

  it("groups slots by role", () => {
    const cluster = new Cluster(testClusterConfig);
    expect(cluster.getSlotsByRole("planner")).toHaveLength(1);
    expect(cluster.getSlotsByRole("nonexistent")).toHaveLength(0);
  });

  it("provides default cluster config", () => {
    const config = Cluster.defaultCluster();
    expect(config.slots).toHaveLength(6);
    expect(config.slots[0].role).toBe("planner");
    expect(config.slots[0].model).toBe("gemma4:31b");
  });

  it("tracks stats", () => {
    const cluster = new Cluster(testClusterConfig);
    const stats = cluster.getStats();
    expect(stats.totalRequests).toBe(0);
    expect(stats.bySlot["planner"]).toBeDefined();
  });

  it("resets stats", () => {
    const cluster = new Cluster(testClusterConfig);
    cluster.resetStats();
    expect(cluster.getStats().totalRequests).toBe(0);
  });
});

describe("TaskRouter", () => {
  it("routes analyze to planner", () => {
    const cluster = new Cluster(testClusterConfig);
    const router = new TaskRouter(cluster);
    const request: TaskRequest = { type: "analyze", role: "fixer", system: "", user: "" };
    const routed = router.route(request);
    expect(routed.role).toBe("planner");
  });

  it("routes fix_tsc to fixer", () => {
    const cluster = new Cluster(testClusterConfig);
    const router = new TaskRouter(cluster);
    const request: TaskRequest = { type: "fix_tsc", role: "planner", system: "", user: "" };
    const routed = router.route(request);
    expect(routed.role).toBe("fixer");
  });

  it("routes commit to clerk", () => {
    const cluster = new Cluster(testClusterConfig);
    const router = new TaskRouter(cluster);
    const request: TaskRequest = { type: "commit", role: "planner", system: "", user: "" };
    const routed = router.route(request);
    expect(routed.role).toBe("clerk");
  });

  it("escalates fixer to implementer", () => {
    const cluster = new Cluster(testClusterConfig);
    const router = new TaskRouter(cluster);
    const request: TaskRequest = { type: "fix_tsc", role: "fixer", system: "", user: "" };
    const escalated = router.escalate(request);
    expect(escalated.role).toBe("implementer");
  });

  it("escalates implementer to planner", () => {
    const cluster = new Cluster(testClusterConfig);
    const router = new TaskRouter(cluster);
    const request: TaskRequest = { type: "implement", role: "implementer", system: "", user: "" };
    const escalated = router.escalate(request);
    expect(escalated.role).toBe("planner");
  });

  it("gets retry strategy by failure type", () => {
    const cluster = new Cluster(testClusterConfig);
    const router = new TaskRouter(cluster);
    const tsc = router.getRetryStrategy("tsc");
    expect(tsc.slotId).toBe("fixer");
    expect(tsc.maxAttempts).toBeGreaterThan(0);
  });

  it("returns unknown strategy for unrecognized failures", () => {
    const cluster = new Cluster(testClusterConfig);
    const router = new TaskRouter(cluster);
    const unknown = router.getRetryStrategy("something_weird");
    expect(unknown.failureType).toBe("unknown");
  });
});

describe("ConsensusEngine", () => {
  it("initializes with cluster", () => {
    const cluster = new Cluster(testClusterConfig);
    const engine = new ConsensusEngine(cluster, 0.6);
    expect(engine).toBeDefined();
  });
});

describe("SpeculativeExecutor", () => {
  it("initializes with cluster", () => {
    const cluster = new Cluster(testClusterConfig);
    const executor = new SpeculativeExecutor(cluster);
    expect(executor).toBeDefined();
  });
});

describe("AdaptiveRetry", () => {
  it("classifies TypeScript errors", async () => {
    const cluster = new Cluster(testClusterConfig);
    const router = new TaskRouter(cluster);
    const retry = new AdaptiveRetry(cluster, router);
    const strategy = router.getRetryStrategy("tsc");
    expect(strategy.failureType).toBe("tsc");
    expect(strategy.slotId).toBe("fixer");
    expect(strategy.maxAttempts).toBeGreaterThan(0);
  });

  it("classifies test errors", async () => {
    const cluster = new Cluster(testClusterConfig);
    const router = new TaskRouter(cluster);
    const retry = new AdaptiveRetry(cluster, router);
    const strategy = router.getRetryStrategy("test");
    expect(strategy.failureType).toBe("test");
    expect(strategy.maxAttempts).toBeGreaterThan(0);
  });

  it("tracks failure history", () => {
    const cluster = new Cluster(testClusterConfig);
    const router = new TaskRouter(cluster);
    const retry = new AdaptiveRetry(cluster, router);
    expect(retry.getRecentFailures()).toBe(0);
    retry.clearHistory();
    expect(retry.getRecentFailures()).toBe(0);
  });
});

describe("getDefaultRepos", () => {
  it("returns 15 repos", () => {
    const repos = getDefaultRepos();
    expect(repos).toHaveLength(15);
  });

  it("includes key repos", () => {
    const repos = getDefaultRepos();
    const keys = repos.map((r) => `${r.owner}/${r.repo}`);
    expect(keys).toContain("anthropics/claude-code");
    expect(keys).toContain("paul-gauthier/aider");
    expect(keys).toContain("cline/cline");
    expect(keys).toContain("openai/codex");
  });

  it("all repos have owner and repo", () => {
    const repos = getDefaultRepos();
    for (const r of repos) {
      expect(r.owner).toBeTruthy();
      expect(r.repo).toBeTruthy();
    }
  });
});
