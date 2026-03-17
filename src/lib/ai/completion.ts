import { getOpenAIClient } from './client';
import { AppError } from '@/lib/errors';

export interface LLMCallResult {
  text: string;
  model: string;
  tokensUsed: number;
  latencyMs: number;
  finishReason: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const MAX_RETRIES = 1;

/**
 * Thin wrapper around OpenAI chat completions.
 * Returns raw JSON string — no parsing, no side-effects, no tool handling.
 */
export async function callLLM(
  systemPrompt: string,
  messages: ChatMessage[],
): Promise<LLMCallResult> {
  const openai = getOpenAIClient();
  const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  const startedAt = Date.now();

  const apiMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model,
        messages: apiMessages,
        response_format: { type: 'json_object' },
        temperature: 0.4,
        max_tokens: 1200,
      });

      const choice = response.choices[0];
      const latencyMs = Date.now() - startedAt;

      return {
        text: choice.message.content ?? '{}',
        model,
        tokensUsed: response.usage?.total_tokens ?? 0,
        latencyMs,
        finishReason: choice.finish_reason ?? 'stop',
      };
    } catch (err) {
      lastError = err;
      const isServerError =
        err instanceof Error && 'status' in err && (err as { status: number }).status >= 500;
      if (!isServerError || attempt >= MAX_RETRIES) break;
    }
  }

  throw AppError.ai(
    'LLM call failed after retries',
    lastError instanceof Error ? lastError.message : lastError,
  );
}
