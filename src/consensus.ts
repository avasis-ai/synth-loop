import type { TaskRequest, TaskResult, ConsensusResult, LogFn } from "./types.js";
import type { Cluster } from "./cluster.js";

export class ConsensusEngine {
  private cluster: Cluster;
  private log: LogFn;
  private minAgreement: number;

  constructor(cluster: Cluster, minAgreement?: number, logFn?: LogFn) {
    this.cluster = cluster;
    this.minAgreement = minAgreement || 0.6;
    this.log = logFn || (() => {});
  }

  async majorityVote(request: TaskRequest, count: number): Promise<ConsensusResult> {
    const slots = this.cluster.getSlotsByRole(request.role);
    if (slots.length < count) {
      this.log("WARN", `Not enough slots for majority vote: ${slots.length} < ${count}`);
      const result = await this.cluster.execute(request);
      return { agreed: true, content: result.content, votes: [result], confidence: 1.0 };
    }

    this.log("INFO", `Majority vote: ${count} agents for ${request.type}`);
    const requests = Array.from({ length: count }, (_, i) => ({
      ...request,
      temperature: 0.3 + i * 0.1,
    }));

    const votes = await this.cluster.executeParallel(requests);
    const valid = votes.filter((v: TaskResult) => v.success && v.content.length > 50);

    if (valid.length === 0) {
      return { agreed: false, content: "", votes, confidence: 0 };
    }

    if (valid.length === 1) {
      this.log("INFO", `Only 1 valid vote, accepting`);
      return { agreed: true, content: valid[0].content, votes, confidence: 0.3 };
    }

    const similarity = this.computeSimilarity(valid);
    this.log("INFO", `Vote similarity: ${(similarity * 100).toFixed(0)}%`);

    if (similarity >= this.minAgreement) {
      this.cluster.getStats().consensusHits++;
      const best = valid.sort((a: TaskResult, b: TaskResult) => b.content.length - a.content.length)[0];
      return { agreed: true, content: best.content, votes: valid, confidence: similarity };
    }

    this.cluster.getStats().consensusMisses++;
    return await this.arbitrate(request, valid);
  }

  async debate(request: TaskRequest, rounds: number): Promise<ConsensusResult> {
    const implSlots = this.cluster.getSlotsByRole("implementer");
    const reviewerSlots = this.cluster.getSlotsByRole("reviewer");
    if (!implSlots.length || !reviewerSlots.length) {
      const result = await this.cluster.execute(request);
      return { agreed: true, content: result.content, votes: [result], confidence: 0.5 };
    }

    this.log("INFO", `Debate: ${rounds} rounds with ${implSlots.length} implementers + ${reviewerSlots.length} reviewers`);

    let currentContent = "";
    for (let round = 0; round < rounds; round++) {
      const implRequest: TaskRequest = {
        ...request,
        role: "implementer",
        user: currentContent
          ? `${request.user}\n\nPREVIOUS ATTEMPT (Round ${round}):\n${currentContent.slice(0, 2000)}\n\nIMPROVE THIS. Fix any issues identified by reviewers.`
          : request.user,
      };
      const implResult = await this.cluster.execute(implRequest, implSlots[0].id);
      if (!implResult.success) continue;
      currentContent = implResult.content;

      const reviewRequest: TaskRequest = {
        type: "review",
        role: "reviewer",
        system: "You are a strict code reviewer. Find bugs, type errors, missing exports, and logic issues. Be concise. Return JSON: {\"approved\":boolean,\"issues\":[\"issue1\",\"issue2\"],\"score\":0-10}",
        user: `Review this code:\n\n${currentContent.slice(0, 4000)}`,
        jsonMode: true,
      };
      const reviewResult = await this.cluster.execute(reviewRequest, reviewerSlots[0].id);
      if (!reviewResult.success) continue;

      try {
        const review = JSON.parse(reviewResult.content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim());
        this.log("INFO", `Round ${round + 1}: score=${review.score} approved=${review.approved} issues=${(review.issues || []).length}`);
        if (review.approved && review.score >= 7) {
          return { agreed: true, content: currentContent, votes: [implResult, reviewResult], confidence: review.score / 10 };
        }
      } catch {}
    }

    return { agreed: true, content: currentContent, votes: [], confidence: 0.5 };
  }

  async arbitrate(request: TaskRequest, candidates: TaskResult[]): Promise<ConsensusResult> {
    const plannerSlot = this.cluster.getSlotsByRole("planner")[0];
    if (!plannerSlot) {
      const best = candidates.sort((a: TaskResult, b: TaskResult) => b.content.length - a.content.length)[0];
      return { agreed: true, content: best.content, votes: candidates, confidence: 0.4 };
    }

    this.log("INFO", `Arbitration: planner reviews ${candidates.length} candidates`);

    const candidateSummaries = candidates.map((c, i) =>
      `CANDIDATE ${i + 1} (${c.model}, ${c.content.length} chars):\n${c.content.slice(0, 1000)}`
    ).join("\n\n---\n\n");

    const arbRequest: TaskRequest = {
      type: "analyze",
      role: "planner",
      system: "You are a senior arbitrator. Review the candidates and select the best one, or synthesize a better answer. Return JSON: {\"selected\":0-9,\"reason\":\"why\",\"content\":\"the best final answer\"}",
      user: `${request.user}\n\nCANDIDATES:\n${candidateSummaries}`,
      jsonMode: true,
    };

    const arbResult = await this.cluster.execute(arbRequest, plannerSlot.id);
    if (!arbResult.success) {
      const best = candidates.sort((a: TaskResult, b: TaskResult) => b.content.length - a.content.length)[0];
      return { agreed: false, content: best.content, votes: candidates, confidence: 0.3 };
    }

    try {
      const arb = JSON.parse(arbResult.content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim());
      this.log("INFO", `Arbitrator selected candidate ${arb.selected + 1}: ${arb.reason?.slice(0, 100)}`);
      return {
        agreed: true,
        content: arb.content || candidates[Math.min(arb.selected, candidates.length - 1)]?.content || "",
        votes: candidates,
        confidence: 0.7,
        arbitrator: arbResult,
      };
    } catch {
      const best = candidates.sort((a: TaskResult, b: TaskResult) => b.content.length - a.content.length)[0];
      return { agreed: false, content: best.content, votes: candidates, confidence: 0.3 };
    }
  }

  private computeSimilarity(results: TaskResult[]): number {
    if (results.length < 2) return 1.0;
    let matches = 0;
    let total = 0;
    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        total++;
        const a = results[i].content.toLowerCase();
        const b = results[j].content.toLowerCase();
        const aWords = new Set(a.split(/\s+/));
        const bWords = new Set(b.split(/\s+/));
        const intersection = [...aWords].filter(w => bWords.has(w)).length;
        const union = new Set([...aWords, ...bWords]).size;
        matches += union > 0 ? intersection / union : 0;
      }
    }
    return total > 0 ? matches / total : 0;
  }
}
