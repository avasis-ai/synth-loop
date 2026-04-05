import type { ClusterConfig, AgentSlot, TaskRequest, TaskResult, LogFn } from "./types.js";

const DEFAULT_BASE = "http://localhost:11434/v1";

interface ProviderSlot {
  model: string;
  role: "planner" | "worker" | "reviewer" | "drafter";
  baseURL?: string;
  maxTokens?: number;
  temperature?: number;
}

type Complexity = "simple" | "medium" | "complex";

function classifyComplexity(request: TaskRequest): Complexity {
  const text = request.system + request.user;
  const tokenEst = text.length / 4;
  if (tokenEst > 5000 || request.type === "analyze" || request.type === "plan") return "complex";
  if (tokenEst > 1000 || request.type === "implement" || request.type === "review") return "medium";
  return "simple";
}

function stripThinking(text: string): string {
  return text
    .replace(/<think[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<channel>thought[\s\S]*?<channel|>/gi, "")
    .replace(/\[Thinking[^\]]*\]/gi, "")
    .trim();
}

export class ClusterProviderBridge {
  private baseURL: string;
  private slots: ProviderSlot[];
  private timeoutMs: number;
  private log: LogFn;
  private stats: { requests: number; tokensIn: number; tokensOut: number; errors: number };

  constructor(config?: { baseURL?: string; timeoutMs?: number; slots?: ProviderSlot[] }, logFn?: LogFn) {
    this.baseURL = config?.baseURL || DEFAULT_BASE;
    this.timeoutMs = config?.timeoutMs || 180_000;
    this.log = logFn || (() => {});
    this.slots = config?.slots || [
      { model: "gemma4:e4b", role: "planner", baseURL: this.baseURL, temperature: 0.3 },
      { model: "gemma4:e4b", role: "worker", baseURL: this.baseURL, temperature: 0.3 },
      { model: "gemma4:e4b", role: "worker", baseURL: this.baseURL, temperature: 0.35 },
      { model: "gemma4:e4b", role: "reviewer", baseURL: this.baseURL, temperature: 0.3 },
      { model: "gemma4:e4b", role: "drafter", baseURL: this.baseURL, temperature: 0.3 },
    ];
    this.stats = { requests: 0, tokensIn: 0, tokensOut: 0, errors: 0 };
  }

  getStats() { return { ...this.stats }; }

  private async callModel(slot: ProviderSlot, system: string, user: string, maxTokens?: number, extraOpts?: Record<string, unknown>): Promise<{ content: string; tokensIn: number; tokensOut: number }> {
    const url = (slot.baseURL || this.baseURL) + "/chat/completions";
    const body: any = {
      model: slot.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: false,
      max_tokens: maxTokens || slot.maxTokens || 4096,
      temperature: slot.temperature || 0.3,
      ...extraOpts,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Provider ${slot.model} error ${res.status}: ${text.slice(0, 200)}`);
    }

    const data: any = await res.json();
    return {
      content: stripThinking(data.choices?.[0]?.message?.content || ""),
      tokensIn: data.usage?.prompt_tokens || 0,
      tokensOut: data.usage?.completion_tokens || 0,
    };
  }

  async draftVerify(request: TaskRequest): Promise<TaskResult> {
    const drafters = this.slots.filter(s => s.role === "drafter");
    const workers = this.slots.filter(s => s.role === "worker");
    const reviewers = this.slots.filter(s => s.role === "reviewer");

    const drafter = drafters[0] || workers[0] || this.slots[0];
    const worker = workers[0] || this.slots[0];

    const draft = await this.safeCall(drafter, request);
    if (!draft) {
      const fb = await this.safeCall(worker, request);
      if (!fb) throw new Error("Draft-verify: all models failed");
      return fb;
    }

    if (!reviewers.length || draft.content.length < 50) return draft;

    const verifyUser = `${request.user}\n\nDRAFT RESPONSE:\n${draft.content.slice(0, 6000)}\n\nReview this draft. If correct, return it exactly. If errors, fix them. Return ONLY final text.`;
    const verified = await this.safeCall(reviewers[0], { ...request, user: verifyUser });

    if (!verified) return draft;

    const aWords = new Set(draft.content.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const bWords = new Set(verified.content.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const inter = [...aWords].filter(w => bWords.has(w)).length;
    const union = new Set([...aWords, ...bWords]).size;
    const similarity = union > 0 ? inter / union : 0;

    return similarity > 0.7 ? draft : verified;
  }

  async debate(request: TaskRequest, rounds: number = 1): Promise<TaskResult> {
    const workers = this.slots.filter(s => s.role === "worker");
    const planners = this.slots.filter(s => s.role === "planner");

    let currentContent = "";
    for (let round = 0; round < rounds; round++) {
      const slot = workers[round % workers.length] || workers[0] || this.slots[0];
      const user = round === 0
        ? request.user
        : `${request.user}\n\nPREVIOUS ATTEMPT (Round ${round}):\n${currentContent.slice(0, 4000)}\n\nImprove this. Fix issues.`;
      const result = await this.safeCall(slot, { ...request, user });
      if (result) currentContent = result.content;
    }

    if (!currentContent) throw new Error("Debate: all models failed");

    if (planners.length && workers.length > 1) {
      const candidates: TaskResult[] = [];
      for (const w of workers) {
        const c = await this.safeCall(w, request);
        if (c && c.content.length > 30) candidates.push(c);
      }

      if (candidates.length > 1) {
        const arbUser = `Select best response or synthesize better one. Return ONLY final text.\n\nTASK:\n${request.user.slice(0, 2000)}\n\nCANDIDATES:\n${candidates.map((c, i) => `--- Candidate ${i + 1} (${c.model}) ---\n${c.content.slice(0, 3000)}`).join("\n\n")}`;
        const arbitrated = await this.safeCall(planners[0], { ...request, user: arbUser });
        if (arbitrated && arbitrated.content.length > 20) return arbitrated;
      }
    }

    return {
      slotId: "debate", model: "cluster", role: request.role,
      content: currentContent, durationMs: 0, success: true,
    };
  }

  async execute(request: TaskRequest, strategy?: "draft-verify" | "debate" | "single"): Promise<TaskResult> {
    const complexity = classifyComplexity(request);
    const useStrategy = strategy || (complexity === "complex" ? "debate" : complexity === "medium" ? "draft-verify" : "single");

    if (useStrategy === "debate") return this.debate(request, 1);
    if (useStrategy === "draft-verify") return this.draftVerify(request);

    const slot = this.slots.find(s => s.role === "worker") || this.slots.find(s => s.role === "drafter") || this.slots[0];
    const result = await this.safeCall(slot!, request);
    if (!result) throw new Error("Single execution failed");
    return result;
  }

  private async safeCall(slot: ProviderSlot, request: TaskRequest): Promise<TaskResult | null> {
    try {
      const start = Date.now();
      const result = await this.callModel(slot, request.system, request.user, request.maxTokens);
      this.stats.requests++;
      this.stats.tokensIn += result.tokensIn;
      this.stats.tokensOut += result.tokensOut;
      return {
        slotId: slot.role, model: slot.model, role: request.role,
        content: result.content, tokensIn: result.tokensIn, tokensOut: result.tokensOut,
        durationMs: Date.now() - start, success: true,
      };
    } catch (e: any) {
      this.stats.errors++;
      this.log("ERROR", `Provider ${slot.model} (${slot.role}): ${e.message.slice(0, 200)}`);
      return null;
    }
  }

  static fromSynthCodeClusterConfig(clusterConfig: ClusterConfig): ClusterProviderBridge {
    const url = clusterConfig.ollamaUrl || DEFAULT_BASE;
    const slots: ProviderSlot[] = clusterConfig.slots.map(s => ({
      model: s.model,
      role: s.role === "implementer" ? "worker" :
           s.role === "attacker" ? "reviewer" :
           s.role === "fixer" ? "reviewer" :
           s.role === "clerk" ? "drafter" :
           s.role as "planner" | "worker" | "reviewer" | "drafter",
      baseURL: url,
      maxTokens: s.maxTokens,
      temperature: s.temperature,
    }));
    return new ClusterProviderBridge({ baseURL: url, slots });
  }
}
