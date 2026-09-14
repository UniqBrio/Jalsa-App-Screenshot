/**
 * The ONLY place this project talks to an LLM.
 *
 * Permitted uses (BUILD_PLAN §1):
 *   (a) one-time manifest bootstrap
 *   (b) classifying genuinely new nav items during discovery
 *   (c) generating doc prose for modules that changed
 *
 * Never in the per-step execution loop. If you find yourself importing this
 * from flow-executor.ts, stop — determinism is the point.
 *
 * No SDK dependency: a plain fetch against the Messages API keeps the install
 * light and makes the "is the LLM in the hot path" question answerable by
 * grepping for this one file.
 */
import { env } from './env';
import { log } from './logger';

export interface LlmImage {
  /** base64-encoded PNG */
  base64: string;
}

export function llmAvailable(): boolean {
  return Boolean(env.llm.apiKey);
}

export async function askLlm(
  prompt: string,
  opts: { system?: string; images?: LlmImage[]; maxTokens?: number } = {},
): Promise<string | null> {
  if (!llmAvailable()) {
    log.warn('ANTHROPIC_API_KEY not set — skipping LLM step (this is optional, nothing breaks).');
    return null;
  }

  const content: unknown[] = [];
  for (const img of opts.images ?? []) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: img.base64 },
    });
  }
  content.push({ type: 'text', text: prompt });

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.llm.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.llm.model,
        max_tokens: opts.maxTokens ?? 2048,
        system: opts.system,
        messages: [{ role: 'user', content }],
      }),
    });

    if (!res.ok) {
      log.warn(`LLM call failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
      return null;
    }
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return (body.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n')
      .trim() || null;
  } catch (err) {
    log.warn(`LLM call errored: ${(err as Error).message}`);
    return null;
  }
}
