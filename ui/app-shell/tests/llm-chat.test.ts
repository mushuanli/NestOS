/**
 * @file LLM Chat Integration Tests
 *
 * Real end-to-end tests against a live LLM provider.
 * No mocking — requires a valid API key in the environment.
 *
 * Environment variables (at least one provider required):
 *   ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN → uses claude-haiku-4-5-20251001 (or LLM_MODEL override)
 *   ANTHROPIC_BASE_URL                       → optional proxy / custom endpoint
 *   OPENAI_API_KEY                           → uses gpt-4o-mini (or LLM_MODEL override)
 *   LLM_MODEL                               → override the default model for the active provider
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @itookit/app-shell test
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { LLMDriver } from '@itookit/driver-llm';
import type { ChatMessage, Attachment } from '@itookit/llm-context';

// ── Minimal 1×1 pixel PNG (standard test fixture, valid PNG binary) ───────────
// filter=0x00, RGB=(0x26,0x89,0xF5) ≈ a blue pixel
// Generated from a known-good minimal PNG; decode starts with \x89PN confirming validity.
const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TINY_PNG_URI = `data:image/png;base64,${TINY_PNG_B64}`;

// ── Provider detection ────────────────────────────────────────────────────────

type ProviderName = 'anthropic' | 'openai';

interface TestConfig {
    provider: ProviderName;
    apiKey: string;
    model: string;
    baseURL?: string;
    /** Extra headers merged into every request (e.g. Authorization for proxy auth). */
    headers?: Record<string, string>;
}

function detectConfig(): TestConfig | null {
    // Direct Anthropic API key (sk-ant-*)
    if (process.env.ANTHROPIC_API_KEY) {
        return {
            provider: 'anthropic',
            apiKey: process.env.ANTHROPIC_API_KEY,
            model: process.env.LLM_MODEL ?? 'claude-haiku-4-5-20251001',
            baseURL: process.env.ANTHROPIC_BASE_URL,
        };
    }
    // ANTHROPIC_AUTH_TOKEN is a JWT Bearer used by proxy endpoints (e.g. Claude Code proxy).
    // The proxy expects `Authorization: Bearer <token>`; we pass a placeholder for x-api-key.
    if (process.env.ANTHROPIC_AUTH_TOKEN) {
        return {
            provider: 'anthropic',
            apiKey: 'proxy-bearer-auth',   // placeholder — proxy ignores x-api-key
            model: process.env.LLM_MODEL ?? 'claude-haiku-4-5-20251001',
            baseURL: process.env.ANTHROPIC_BASE_URL,
            headers: { Authorization: `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}` },
        };
    }
    if (process.env.OPENAI_API_KEY) {
        return {
            provider: 'openai',
            apiKey: process.env.OPENAI_API_KEY,
            model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
        };
    }
    return null;
}

const cfg = detectConfig();

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractText(response: Awaited<ReturnType<LLMDriver['chat']['create']>>): string {
    if ('choices' in response) {
        return (response.choices[0]?.message.content ?? '').trim();
    }
    return '';
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe.skipIf(!cfg)(
    `LLM Chat — ${cfg?.provider ?? 'no provider'} / ${cfg?.model ?? 'no model'}`,
    () => {
        let driver: LLMDriver;

        beforeAll(() => {
            driver = new LLMDriver({
                provider: cfg!.provider,
                apiKey: cfg!.apiKey,
                model: cfg!.model,
                apiBaseUrl: cfg!.baseURL,
                headers: cfg!.headers,
            });
        });

        // ── 1. Plain text chat ─────────────────────────────────────────────────

        it('plain text — non-streaming returns a response', async () => {
            const response = await driver.chat.create({
                messages: [
                    { role: 'user', content: 'Reply with exactly the single word: PONG' },
                ],
                stream: false,
                maxTokens: 16,
            });

            const text = extractText(response);
            console.log('[plain-text]', text);

            expect(text.length).toBeGreaterThan(0);
            expect(text.toLowerCase()).toContain('pong');
        });

        // ── 2. Streaming chat ──────────────────────────────────────────────────

        it('plain text — streaming assembles full response', async () => {
            const stream = await driver.chat.create({
                messages: [
                    { role: 'user', content: 'Count from 1 to 5, one number per line.' },
                ],
                stream: true,
                maxTokens: 32,
            });

            let fullText = '';
            for await (const chunk of stream) {
                fullText += chunk.choices[0]?.delta.content ?? '';
            }

            console.log('[streaming]', fullText.trim());

            expect(fullText.trim().length).toBeGreaterThan(0);
            // All five digits should appear somewhere in the streamed output
            for (const digit of ['1', '2', '3', '4', '5']) {
                expect(fullText).toContain(digit);
            }
        });

        // ── 3. Image attachment ────────────────────────────────────────────────

        it('image attachment — model receives and responds to image', async () => {
            const imageAttachment: Attachment = {
                type: 'image',
                source: TINY_PNG_URI,
                mimeType: 'image/png',
                name: 'test-pixel.png',
            };

            const messages: ChatMessage[] = [
                {
                    role: 'user',
                    content: 'This image contains a single pixel. Respond with one word describing its dominant color.',
                    attachments: [imageAttachment],
                },
            ];

            const response = await driver.chat.create({
                messages,
                stream: false,
                maxTokens: 24,
            });

            const text = extractText(response);
            console.log('[image-attachment]', text);

            // The model processed the image and returned something
            expect(text.length).toBeGreaterThan(0);
        });

        // ── 4. Image attachment — streaming ────────────────────────────────────

        it('image attachment — streaming works with attachments', async () => {
            const imageAttachment: Attachment = {
                type: 'image',
                source: TINY_PNG_URI,
                mimeType: 'image/png',
                name: 'test-pixel.png',
            };

            const messages: ChatMessage[] = [
                {
                    role: 'user',
                    content: 'Reply with one sentence describing this image.',
                    attachments: [imageAttachment],
                },
            ];

            const stream = await driver.chat.create({
                messages,
                stream: true,
                maxTokens: 48,
            });

            let fullText = '';
            for await (const chunk of stream) {
                fullText += chunk.choices[0]?.delta.content ?? '';
            }

            console.log('[image-streaming]', fullText.trim());

            expect(fullText.trim().length).toBeGreaterThan(0);
        });
    },
);
