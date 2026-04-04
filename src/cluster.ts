import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSlot, AgentRole, ClusterConfig, ClusterStats, LogFn, TaskRequest, TaskResult } from "./types.js";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

function defaultLog(level: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${level}] ${msg}`);
}

export class Cluster {
  private config: ClusterConfig;
  private log: LogFn;
  private stats: ClusterStats;
  private slotMap: Map<string, AgentSlot>;
  private roleMap: Map<AgentRole, AgentSlot[]>;

  constructor(config: ClusterConfig, logFn?: LogFn) {
    this.config = {
      ollamaUrl: DEFAULT_OLLAMA_URL,
      maxParallel: 4,
      requestTimeoutMs: 180_000,
      retryAttempts: 2,
      retryBackoffMs: 3000,
      ...config,
    };
    this.log = logFn || defaultLog;
    this.slotMap = new Map();
    this.roleMap = new Map();
    for (const slot of this.config.slots) {
      this.slotMap.set(slot.id, slot);
      const existing = this.roleMap.get(slot.role) || [];
      existing.push(slot);
      this.roleMap.set(slot.role, existing);
    }
    this.stats = {
      totalRequests: 0,
      totalTokens: 0,
      totalDurationMs: 0,
      bySlot: {},
      consensusHits: 0,
      consensusMisses: 0,
      speculativeAccepted: 0,
      speculativeRejected: 0,
    };
    for (const slot of this.config.slots) {
      this.stats.bySlot[slot.id] = { requests: 0, tokens: 0, errors: 0 };
    }
  }

  getSlots(): AgentSlot[] { return [...this.config.slots]; }
  getSlot(id: string): AgentSlot | undefined { return this.slotMap.get(id); }
  getSlotsByRole(role: AgentRole): AgentSlot[] { return this.roleMap.get(role) || []; }
  getConfig(): ClusterConfig { return { ...this.config }; }
  getStats(): ClusterStats { return { ...this.stats, bySlot: { ...this.stats.bySlot } }; }

  async execute(request: TaskRequest, slotId?: string): Promise<TaskResult> {
    const slot = slotId ? this.slotMap.get(slotId) : this.selectSlot(request.role);
    if (!slot) throw new Error(`No slot found for role=${request.role}${slotId ? ` id=${slotId}` : ""}`);

    const startTime = Date.now();
    let lastError = "";
    for (let attempt = 0; attempt <= (this.config.retryAttempts || 2); attempt++) {
      if (attempt > 0) {
        this.log("WARN", `Retry ${attempt} on ${slot.id} (${slot.model})`);
        await new Promise(r => setTimeout(r, (this.config.retryBackoffMs || 3000) * attempt));
      }
      try {
        const result = await this.callOllama(slot, request);
        this.recordSuccess(slot.id, result, Date.now() - startTime);
        return result;
      } catch (e: any) {
        lastError = e.message;
        this.log("ERROR", `${slot.id} error: ${e.message.slice(0, 200)}`);
      }
    }
    this.recordError(slot.id);
    return {
      slotId: slot.id, model: slot.model, role: request.role,
      content: "", durationMs: Date.now() - startTime, success: false, error: lastError,
    };
  }

  async executeParallel(requests: TaskRequest[]): Promise<TaskResult[]> {
    const limited = requests.slice(0, this.config.maxParallel || 4);
    this.log("INFO", `Parallel execution: ${limited.length} tasks`);
    const results = await Promise.all(limited.map(r => this.execute(r)));
    return results;
  }

  async executeFanOut(baseRequest: TaskRequest, role: AgentRole, count?: number): Promise<TaskResult[]> {
    const slots = this.getSlotsByRole(role);
    const n = count || slots.length;
    const requests: TaskRequest[] = [];
    for (let i = 0; i < n && i < slots.length; i++) {
      requests.push({ ...baseRequest, role });
    }
    return this.executeParallel(requests);
  }

  private selectSlot(role: AgentRole): AgentSlot | undefined {
    const slots = this.roleMap.get(role);
    if (!slots || slots.length === 0) return undefined;
    if (slots.length === 1) return slots[0];
    const sorted = [...slots].sort((a, b) =>
      (this.stats.bySlot[a.id]?.requests || 0) - (this.stats.bySlot[b.id]?.requests || 0)
    );
    return sorted[0];
  }

  private async callOllama(slot: AgentSlot, request: TaskRequest): Promise<TaskResult> {
    const url = `${slot.ollamaUrl || this.config.ollamaUrl}/api/chat`;
    const body: any = {
      model: slot.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      stream: false,
      options: {
        num_predict: request.maxTokens || slot.maxTokens || 4096,
        temperature: request.temperature ?? slot.temperature ?? 0.3,
        top_p: 0.95,
        top_k: 64,
      },
    };
    if (request.jsonMode) {
      body.format = "json";
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs || 180_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json() as any;
    const content = data.message?.content || "";
    const tokensIn = data.prompt_eval_count || 0;
    const tokensOut = data.eval_count || 0;

    return {
      slotId: slot.id, model: slot.model, role: request.role,
      content, tokensIn, tokensOut,
      durationMs: 0, success: true,
    };
  }

  private recordSuccess(slotId: string, result: TaskResult, durationMs: number) {
    this.stats.totalRequests++;
    this.stats.totalTokens += (result.tokensIn || 0) + (result.tokensOut || 0);
    this.stats.totalDurationMs += durationMs;
    const s = this.stats.bySlot[slotId];
    if (s) { s.requests++; s.tokens += (result.tokensIn || 0) + (result.tokensOut || 0); }
  }

  private recordError(slotId: string) {
    const s = this.stats.bySlot[slotId];
    if (s) { s.requests++; s.errors++; }
  }

  resetStats() {
    this.stats = {
      totalRequests: 0, totalTokens: 0, totalDurationMs: 0, bySlot: {},
      consensusHits: 0, consensusMisses: 0, speculativeAccepted: 0, speculativeRejected: 0,
    };
    for (const slot of this.config.slots) {
      this.stats.bySlot[slot.id] = { requests: 0, tokens: 0, errors: 0 };
    }
  }

  static defaultCluster(ollamaUrl?: string): ClusterConfig {
    const url = ollamaUrl || DEFAULT_OLLAMA_URL;
    return {
      ollamaUrl: url,
      maxParallel: 4,
      slots: [
        { id: "planner", model: "gemma4:31b", role: "planner", ollamaUrl: url, temperature: 0.3 },
        { id: "impl-1", model: "gemma4:26b", role: "implementer", ollamaUrl: url, temperature: 0.3 },
        { id: "impl-2", model: "gemma4:26b", role: "reviewer", ollamaUrl: url, temperature: 0.3 },
        { id: "impl-3", model: "gemma4:26b", role: "attacker", ollamaUrl: url, temperature: 0.4 },
        { id: "fixer", model: "gemma4:e4b", role: "fixer", ollamaUrl: url, temperature: 0.2 },
        { id: "clerk", model: "gemma4:e2b", role: "clerk", ollamaUrl: url, temperature: 0.2 },
      ],
    };
  }
}
