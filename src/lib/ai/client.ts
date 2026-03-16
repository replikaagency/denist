import OpenAI from 'openai';
import { AppError } from '@/lib/errors';

let instance: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (instance) return instance;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new AppError('AI_ERROR', 'OPENAI_API_KEY is not configured.');
  }

  instance = new OpenAI({ apiKey });
  return instance;
}
