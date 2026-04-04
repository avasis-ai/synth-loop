import type { LoopConfig } from "./types.js";

const MORPH_BASE = "https://api.morphllm.com/v1";

interface FastApplyRequest {
  instructions: string;
  originalCode: string;
  codeEdit: string;
}

interface FastApplyResponse {
  merged: string;
  diff?: string;
  error?: string;
}

export async function morphFastApply(
  apiKey: string,
  request: FastApplyRequest,
): Promise<FastApplyResponse> {
  const prompt = `<instruction>${request.instructions}</instruction>\n<code>${request.originalCode}</code>\n<update>${request.codeEdit}</update>`;

  const res = await fetch(`${MORPH_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "morph-v3-fast",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return { merged: request.originalCode, error: `Morph API ${res.status}: ${err}` };
  }

  const data: any = await res.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    return { merged: request.originalCode, error: "No response from Morph" };
  }

  return { merged: content };
}

export function context7Search(query: string, key: string): Promise<Array<{ id: string; title: string }>> {
  const url = `https://context7.com/api/v2/libs/search?query=${encodeURIComponent(query)}&limit=5`;
  return fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
  })
    .then((r) => r.json() as Promise<any>)
    .then((d) => (d.results || []).map((r: any) => ({ id: r.id, title: r.title })))
    .catch(() => []);
}

export function context7Docs(libId: string, query: string, key: string): Promise<{ content?: string } | null> {
  const url = `https://context7.com/api/v2/libs/${encodeURIComponent(libId)}/docs?query=${encodeURIComponent(query)}&tokens=8000`;
  return fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
  })
    .then((r) => r.json() as Promise<any>)
    .catch(() => null);
}

export function hasMorphKey(config: LoopConfig): boolean {
  return !!config.morphApiKey && config.morphApiKey.length > 10;
}

export function hasContext7Key(config: LoopConfig): boolean {
  return !!config.context7Key && config.context7Key.length > 10;
}
