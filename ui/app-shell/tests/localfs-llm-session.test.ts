/**
 * LLM session integration tests — LocalFS + real API
 *
 * Tests single-turn, multi-turn (context retention), and concurrent sessions.
 * Each conversation is written to the real filesystem for offline inspection.
 *
 * Required env var:
 *   MINDOS_LLM_APIKEY          — API key (sk-ant-* for Anthropic, sk-* for OpenAI)
 *
 * Optional overrides:
 *   MINDOS_LLM_AUTH_TOKEN      — Bearer token for proxy auth (skips apiKey check)
 *   MINDOS_LLM_PROVIDER        — 'anthropic' | 'openai'  (autodetected if omitted)
 *   MINDOS_LLM_MODEL           — model name  (default: haiku / gpt-4o-mini)
 *   MINDOS_LLM_BASE_URL        — custom endpoint
 *
 * After running, browse tests/test_vfsroot/llm-session/ to inspect saved transcripts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { LLMDriver } from '@itookit/driver-llm';
import type { ChatMessage } from '@itookit/llm-context';
import {
    setupLocalVFS, type LocalTestVFS,
} from './helpers-localfs';

// ── Config detection ───────────────────────────────────────────────────────────

type Provider = 'anthropic' | 'openai';

interface LLMConfig {
    provider:  Provider;
    apiKey:    string;
    model:     string;
    baseURL?:  string;
    headers?:  Record<string, string>;
}

function detectConfig(): LLMConfig | null {
    // Bearer-token proxy (takes priority — apiKey is a placeholder)
    if (process.env.MINDOS_LLM_AUTH_TOKEN) {
        const provider: Provider = (process.env.MINDOS_LLM_PROVIDER as Provider) ?? 'anthropic';
        return {
            provider,
            apiKey:  'proxy-bearer-auth',
            model:   process.env.MINDOS_LLM_MODEL ?? defaultModel(provider),
            baseURL: process.env.MINDOS_LLM_BASE_URL,
            headers: { Authorization: `Bearer ${process.env.MINDOS_LLM_AUTH_TOKEN}` },
        };
    }
    const apiKey = process.env.MINDOS_LLM_APIKEY;
    if (!apiKey) return null;

    const provider: Provider = process.env.MINDOS_LLM_PROVIDER as Provider
        ?? (apiKey.startsWith('sk-ant-') ? 'anthropic' : 'openai');

    return {
        provider,
        apiKey,
        model:   process.env.MINDOS_LLM_MODEL ?? defaultModel(provider),
        baseURL: process.env.MINDOS_LLM_BASE_URL,
    };
}

function defaultModel(provider: Provider): string {
    return provider === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-4o-mini';
}

const cfg = detectConfig();

// ── Helpers ────────────────────────────────────────────────────────────────────

function extractText(response: Awaited<ReturnType<LLMDriver['chat']['create']>>): string {
    if ('choices' in response) return (response.choices[0]?.message.content ?? '').trim();
    return '';
}

/**
 * Send one user message, return the assistant reply.
 * Handles both non-streaming and accumulates a full string.
 */
async function send(
    driver: LLMDriver,
    history: ChatMessage[],
    userText: string,
    maxTokens = 128,
): Promise<{ reply: string; history: ChatMessage[] }> {
    const messages: ChatMessage[] = [...history, { role: 'user', content: userText }];
    const response = await driver.chat.create({ messages, stream: false, maxTokens });
    const reply = extractText(response);
    const next: ChatMessage[] = [...messages, { role: 'assistant', content: reply }];
    return { reply, history: next };
}

/**
 * Stream one user message, return the accumulated full reply.
 */
async function sendStream(
    driver: LLMDriver,
    history: ChatMessage[],
    userText: string,
    maxTokens = 128,
): Promise<{ reply: string; history: ChatMessage[] }> {
    const messages: ChatMessage[] = [...history, { role: 'user', content: userText }];
    const stream = await driver.chat.create({ messages, stream: true, maxTokens });
    let reply = '';
    for await (const chunk of stream) {
        reply += chunk.choices[0]?.delta.content ?? '';
    }
    reply = reply.trim();
    const next: ChatMessage[] = [...messages, { role: 'assistant', content: reply }];
    return { reply, history: next };
}

/** Save a conversation transcript to the VFS module dir for offline inspection. */
async function saveTranscript(vfs: LocalTestVFS, name: string, history: ChatMessage[]): Promise<void> {
    const path = join(vfs.moduleDir, `${name}.json`);
    await fsp.writeFile(path, JSON.stringify(history, null, 2), 'utf-8');
}

// ── Test suite ─────────────────────────────────────────────────────────────────

describe.skipIf(!cfg)(
    `LLM session — ${cfg?.provider ?? '?'} / ${cfg?.model ?? '?'} — MINDOS_LLM_APIKEY`,
    () => {
        let driver: LLMDriver;
        let vfs: LocalTestVFS;

        beforeAll(async () => {
            driver = new LLMDriver({
                provider:   cfg!.provider,
                apiKey:     cfg!.apiKey,
                model:      cfg!.model,
                apiBaseUrl: cfg!.baseURL,
                headers:    cfg!.headers,
            });

            // VFS with LocalFSBackend — transcripts written here for inspection
            vfs = await setupLocalVFS('llm-session');
            console.log(`[llm-session] transcripts → ${vfs.moduleDir}`);
        });

        afterAll(async () => { await vfs.dispose(); });

        // ── 1. Single session ─────────────────────────────────────────────────

        it('single session — returns a non-empty reply', async () => {
            const { reply, history } = await send(
                driver, [],
                'Reply with exactly the single word: PONG',
                16,
            );

            console.log('[single]', reply);
            await saveTranscript(vfs, 'single-session', history);

            expect(reply.length).toBeGreaterThan(0);
            expect(reply.toLowerCase()).toContain('pong');
        });

        // ── 2. Multi-turn session — context retention ─────────────────────────

        it('multi-turn — model retains context across rounds', async () => {
            // Round 1: establish a fact
            let r = await send(driver, [], 'My name is Alice. Reply with only: OK', 8);
            console.log('[multi t1]', r.reply);

            // Round 2: ask an unrelated question (tests context isn't dropped)
            r = await send(r.history, 'What city is the Eiffel Tower in? One word.', 8);
            console.log('[multi t2]', r.reply);

            // Round 3: ask about the established fact
            r = await send(r.history, 'What is my name? Reply with only the name.', 8);
            console.log('[multi t3]', r.reply);

            await saveTranscript(vfs, 'multi-turn-session', r.history);

            expect(r.reply.toLowerCase()).toContain('alice');
        });

        // ── 3. Streaming single session ───────────────────────────────────────

        it('streaming — accumulates chunks into full reply', async () => {
            const { reply, history } = await sendStream(
                driver, [],
                'Count from 1 to 5, one number per line.',
                48,
            );

            console.log('[stream]', reply);
            await saveTranscript(vfs, 'streaming-session', history);

            for (const n of ['1', '2', '3', '4', '5']) {
                expect(reply).toContain(n);
            }
        });

        // ── 4. Concurrent sessions ────────────────────────────────────────────

        it('concurrent — three independent sessions complete successfully', async () => {
            const tasks = [
                send(driver, [], 'Reply with only the word: ALPHA', 8),
                send(driver, [], 'Reply with only the word: BETA',  8),
                send(driver, [], 'Reply with only the word: GAMMA', 8),
            ];

            const results = await Promise.all(tasks);

            for (const [i, { reply, history }] of results.entries()) {
                console.log(`[concurrent #${i + 1}]`, reply);
                await saveTranscript(vfs, `concurrent-session-${i + 1}`, history);
                expect(reply.length).toBeGreaterThan(0);
            }

            expect(results[0].reply.toLowerCase()).toContain('alpha');
            expect(results[1].reply.toLowerCase()).toContain('beta');
            expect(results[2].reply.toLowerCase()).toContain('gamma');
        });

        // ── 5. Multi-turn streaming ───────────────────────────────────────────

        it('multi-turn streaming — context retained over streamed rounds', async () => {
            let r = await sendStream(driver, [], 'My lucky number is 42. Reply with only: GOT IT', 8);
            console.log('[mts t1]', r.reply);

            r = await sendStream(r.history, 'What is my lucky number? Reply with only the number.', 8);
            console.log('[mts t2]', r.reply);

            await saveTranscript(vfs, 'multi-turn-streaming', r.history);

            expect(r.reply).toContain('42');
        });
    },
);
