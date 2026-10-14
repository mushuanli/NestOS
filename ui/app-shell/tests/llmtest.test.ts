/**
 * @file llmtest — DEFAULT_AGENTS[LLM_DEFAULT_ID] integration tests (OpenAI)
 *
 * Real end-to-end tests using the default agent config from constants.ts.
 * No mocking — requires a valid OPENAI_API_KEY in the environment.
 *
 * Run:
 *   OPENAI_API_KEY=sk-... pnpm --filter @itookit/app-shell test --reporter=verbose
 *
 * Optional overrides:
 *   LLM_MODEL=gpt-4o   (default: gpt-4o-mini)
 *   OPENAI_BASE_URL     custom endpoint / proxy
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { LLMDriver } from '@itookit/driver-llm';
import { createMindosLlmPresets } from '@itookit/kernel-adapters/llm/presets';
import type { ChatMessage, Attachment } from '@itookit/llm-context';

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Minimal 1×1 blue pixel PNG (valid binary, ~68 bytes)
const BLUE_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const BLUE_PNG_URI = `data:image/png;base64,${BLUE_PNG_B64}`;

// Minimal 1×1 red pixel PNG
const RED_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=';
const RED_PNG_URI = `data:image/png;base64,${RED_PNG_B64}`;

// Public small image URL (stable CDN, no auth required)
const PUBLIC_IMAGE_URL = 'https://www.gstatic.com/webp/gallery/1.sm.jpg';

// Text document fixtures (used inline in message content — OpenAI Chat Completions
// does not support { type:'file' } content parts; text must be embedded as text)
const TEXT_CONTENT = 'The capital of France is Paris. The answer to life is 42.';
const JSON_CONTENT = JSON.stringify({ name: 'Alice', score: 99, city: 'Tokyo' });
const MD_CONTENT = '# Report\n\nProject: **Phoenix**. Status: complete. Owner: Bob.';

// ── Config ────────────────────────────────────────────────────────────────────

const apiKey = process.env.OPENAI_API_KEY ?? '';
const model = process.env.LLM_MODEL ?? 'gpt-4o-mini';
const baseURL = process.env.OPENAI_BASE_URL;

// Pull the default agent definition from constants
const defaultAgentDef = createMindosLlmPresets().agents!.find(a => a.id === 'default')!;
const systemPrompt = defaultAgentDef.config.systemPrompt;

// ── Helpers ───────────────────────────────────────────────────────────────────

function toText(response: Awaited<ReturnType<LLMDriver['chat']['create']>>): string {
    if ('choices' in response) {
        return (response.choices[0]?.message.content ?? '').trim();
    }
    return '';
}

async function collectStream(stream: AsyncIterable<any>): Promise<string> {
    let text = '';
    for await (const chunk of stream) {
        text += chunk.choices[0]?.delta.content ?? '';
    }
    return text.trim();
}

function imageAttachment(source: string, name = 'img.png'): Attachment {
    return { type: 'image', source, mimeType: 'image/png', name };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!apiKey)(
    `DEFAULT_AGENTS[default] — OpenAI / ${model}`,
    () => {
        let driver: LLMDriver;

        beforeAll(() => {
            expect(defaultAgentDef, 'DEFAULT_AGENTS must contain the default agent').toBeDefined();

            driver = new LLMDriver({
                provider: 'openai',
                apiKey,
                model,
                apiBaseUrl: baseURL,
            });
        });

        // ── 1. System prompt ──────────────────────────────────────────────────

        describe('system prompt', () => {
            it('default agent system prompt is loaded from constants', () => {
                expect(systemPrompt).toBeTruthy();
                expect(typeof systemPrompt).toBe('string');
            });

            it('non-streaming — system prompt is applied', async () => {
                const response = await driver.chat.create({
                    messages: [
                        { role: 'system', content: systemPrompt! },
                        { role: 'user', content: 'Reply with exactly: READY' },
                    ],
                    stream: false,
                    maxTokens: 16,
                });

                const text = toText(response);
                console.log('[system-prompt]', text);

                expect(text.length).toBeGreaterThan(0);
                expect(text.toLowerCase()).toContain('ready');
            });

            it('streaming — system prompt is applied', async () => {
                const stream = await driver.chat.create({
                    messages: [
                        { role: 'system', content: systemPrompt! },
                        { role: 'user', content: 'Count 1 to 3, digits only, comma-separated.' },
                    ],
                    stream: true,
                    maxTokens: 24,
                });

                const text = await collectStream(stream);
                console.log('[system-prompt-stream]', text);

                expect(text).toContain('1');
                expect(text).toContain('2');
                expect(text).toContain('3');
            });
        });

        // ── 2. Image attachments ──────────────────────────────────────────────

        describe('image attachment', () => {
            it('single image — base64 data URI, non-streaming', async () => {
                const messages: ChatMessage[] = [{
                    role: 'user',
                    content: 'This is a single-pixel image. Reply with one word for its color.',
                    attachments: [imageAttachment(BLUE_PNG_URI, 'blue.png')],
                }];

                const response = await driver.chat.create({ messages, stream: false, maxTokens: 16 });
                const text = toText(response);
                console.log('[img-base64]', text);

                expect(text.length).toBeGreaterThan(0);
            });

            it('single image — base64 data URI, streaming', async () => {
                const messages: ChatMessage[] = [{
                    role: 'user',
                    content: 'Describe this image in one sentence.',
                    attachments: [imageAttachment(BLUE_PNG_URI)],
                }];

                const stream = await driver.chat.create({ messages, stream: true, maxTokens: 48 });
                const text = await collectStream(stream);
                console.log('[img-stream]', text);

                expect(text.length).toBeGreaterThan(0);
            });

            it('image from public URL source', async () => {
                const messages: ChatMessage[] = [{
                    role: 'user',
                    content: 'What is in this image? One sentence.',
                    attachments: [{
                        type: 'image',
                        source: PUBLIC_IMAGE_URL,
                        name: 'remote.jpg',
                    }],
                }];

                const response = await driver.chat.create({ messages, stream: false, maxTokens: 48 });
                const text = toText(response);
                console.log('[img-url]', text);

                expect(text.length).toBeGreaterThan(0);
            });

            it('multiple images in one message', async () => {
                const messages: ChatMessage[] = [{
                    role: 'user',
                    content: 'I am sending two images. Reply with: "received N images" where N is the count.',
                    attachments: [
                        imageAttachment(BLUE_PNG_URI, 'img1.png'),
                        imageAttachment(RED_PNG_URI, 'img2.png'),
                    ],
                }];

                const response = await driver.chat.create({ messages, stream: false, maxTokens: 24 });
                const text = toText(response);
                console.log('[multi-img]', text);

                expect(text.length).toBeGreaterThan(0);
                expect(text).toMatch(/2/);
            });

            it('image with detail:high option — higher token usage than detail:low', async () => {
                const baseMsg: ChatMessage = {
                    role: 'user',
                    content: 'Describe this image.',
                };

                const [lowResp, highResp] = await Promise.all([
                    driver.chat.create({
                        messages: [{ ...baseMsg, attachments: [{ type: 'image', source: BLUE_PNG_URI, options: { detail: 'low' } }] }],
                        stream: false,
                        maxTokens: 24,
                    }),
                    driver.chat.create({
                        messages: [{ ...baseMsg, attachments: [{ type: 'image', source: BLUE_PNG_URI, options: { detail: 'high' } }] }],
                        stream: false,
                        maxTokens: 24,
                    }),
                ]);

                const lowTokens = 'usage' in lowResp ? lowResp.usage?.prompt_tokens ?? 0 : 0;
                const highTokens = 'usage' in highResp ? highResp.usage?.prompt_tokens ?? 0 : 0;
                console.log('[detail] low=%d high=%d', lowTokens, highTokens);

                // high detail should consume >= low detail tokens
                expect(highTokens).toBeGreaterThanOrEqual(lowTokens);
            });
        });

        // ── 3. Text attachments (type:'text') ────────────────────────────────
        // Tests the new text attachment path: attachments are auto-expanded by
        // LLMDriver into MessageContentText parts before sending to the provider.

        describe('text attachment', () => {
            it('plain text string source — model reads content from attachment', async () => {
                const messages: ChatMessage[] = [{
                    role: 'user',
                    content: 'Read the attached document and answer: what number is mentioned? Reply with the number only.',
                    attachments: [{
                        type: 'text',
                        source: TEXT_CONTENT,
                        name: 'doc.txt',
                        mimeType: 'text/plain',
                    }],
                }];

                const response = await driver.chat.create({ messages, stream: false, maxTokens: 8 });
                const text = toText(response);
                console.log('[text-att-plain]', text);

                expect(text).toContain('42');
            });

            it('JSON string source — model extracts field from text attachment', async () => {
                const messages: ChatMessage[] = [{
                    role: 'user',
                    content: 'Read the attached JSON and answer: what is the value of the "city" field? Reply with the city name only.',
                    attachments: [{
                        type: 'text',
                        source: JSON_CONTENT,
                        name: 'data.json',
                        mimeType: 'application/json',
                    }],
                }];

                const response = await driver.chat.create({ messages, stream: false, maxTokens: 8 });
                const text = toText(response);
                console.log('[text-att-json]', text);

                expect(text.toLowerCase()).toContain('tokyo');
            });

            it('markdown string source — model reads structure from text attachment', async () => {
                const messages: ChatMessage[] = [{
                    role: 'user',
                    content: 'Read the attached markdown and answer: what is the project name? One word answer.',
                    attachments: [{
                        type: 'text',
                        source: MD_CONTENT,
                        name: 'report.md',
                        mimeType: 'text/markdown',
                    }],
                }];

                const response = await driver.chat.create({ messages, stream: false, maxTokens: 8 });
                const text = toText(response);
                console.log('[text-att-md]', text);

                expect(text.toLowerCase()).toContain('phoenix');
            });

            it('file type with text MIME — auto-downgraded to text path', async () => {
                // type='file' + mimeType='application/json' should resolve to text, not base64 file
                const messages: ChatMessage[] = [{
                    role: 'user',
                    content: 'Read the attached file and answer: what is the value of the "city" field? Reply with the city name only.',
                    attachments: [{
                        type: 'file',
                        source: JSON_CONTENT,
                        name: 'data.json',
                        mimeType: 'application/json',
                    }],
                }];

                const response = await driver.chat.create({ messages, stream: false, maxTokens: 8 });
                const text = toText(response);
                console.log('[text-att-file-downgrade]', text);

                expect(text.toLowerCase()).toContain('tokyo');
            });

            it('multiple text attachments in one message', async () => {
                const messages: ChatMessage[] = [{
                    role: 'user',
                    content: 'I am sending two documents. The first contains a number, the second contains a city name. Reply with exactly: "<number> <city>"',
                    attachments: [
                        { type: 'text', source: TEXT_CONTENT, name: 'numbers.txt', mimeType: 'text/plain' },
                        { type: 'text', source: JSON_CONTENT, name: 'data.json', mimeType: 'application/json' },
                    ],
                }];

                const response = await driver.chat.create({ messages, stream: false, maxTokens: 16 });
                const text = toText(response);
                console.log('[text-att-multi]', text);

                expect(text).toContain('42');
                expect(text.toLowerCase()).toContain('tokyo');
            });

            it('text attachment mixed with image attachment', async () => {
                const messages: ChatMessage[] = [{
                    role: 'user',
                    content: 'I am sending a text document and an image. What number is in the text? Reply with the number only.',
                    attachments: [
                        { type: 'text', source: TEXT_CONTENT, name: 'doc.txt', mimeType: 'text/plain' },
                        { type: 'image', source: BLUE_PNG_URI, name: 'img.png' },
                    ],
                }];

                const response = await driver.chat.create({ messages, stream: false, maxTokens: 8 });
                const text = toText(response);
                console.log('[text-att-mixed]', text);

                expect(text).toContain('42');
            });
        });

        // ── 4. Text content (inline) ──────────────────────────────────────────
        // NOTE: OpenAI Chat Completions API does NOT support { type:'file' } content parts.
        // That is a Responses API feature. Text documents must be embedded inline as text.

        describe('inline text content', () => {
            it('plain text document — model reads inline content', async () => {
                const messages: ChatMessage[] = [{
                    role: 'user',
                    content: `Here is a text document:\n\n---\n${TEXT_CONTENT}\n---\n\nWhat number is mentioned? Reply with the number only.`,
                }];

                const response = await driver.chat.create({ messages, stream: false, maxTokens: 8 });
                const text = toText(response);
                console.log('[inline-text]', text);

                expect(text).toContain('42');
            });

            it('JSON data — model extracts a field from inline content', async () => {
                const messages: ChatMessage[] = [{
                    role: 'user',
                    content: `Here is JSON data:\n\n\`\`\`json\n${JSON_CONTENT}\n\`\`\`\n\nWhat is the value of the "city" field? Reply with the city name only.`,
                }];

                const response = await driver.chat.create({ messages, stream: false, maxTokens: 8 });
                const text = toText(response);
                console.log('[inline-json]', text);

                expect(text.toLowerCase()).toContain('tokyo');
            });

            it('markdown document — model reads structure from inline content', async () => {
                const messages: ChatMessage[] = [{
                    role: 'user',
                    content: `Here is a markdown document:\n\n${MD_CONTENT}\n\nWhat is the project name? One word answer.`,
                }];

                const response = await driver.chat.create({ messages, stream: false, maxTokens: 8 });
                const text = toText(response);
                console.log('[inline-md]', text);

                expect(text.toLowerCase()).toContain('phoenix');
            });
        });

        // ── 5. Multi-turn with attachments ────────────────────────────────────

        describe('multi-turn conversation', () => {
            it('image in first turn is referenced in follow-up', async () => {
                // Round 1: upload image
                const turn1Resp = await driver.chat.create({
                    messages: [{
                        role: 'user',
                        content: 'I am sharing an image. Just say "got it".',
                        attachments: [imageAttachment(BLUE_PNG_URI)],
                    }],
                    stream: false,
                    maxTokens: 16,
                });

                const assistantReply = toText(turn1Resp);

                // Round 2: follow-up without re-uploading
                const messages: ChatMessage[] = [
                    {
                        role: 'user',
                        content: 'I am sharing an image. Just say "got it".',
                        attachments: [imageAttachment(BLUE_PNG_URI)],
                    },
                    { role: 'assistant', content: assistantReply },
                    { role: 'user', content: 'What color was the pixel in the image I shared?' },
                ];

                const response = await driver.chat.create({ messages, stream: false, maxTokens: 24 });
                const text = toText(response);
                console.log('[multi-turn]', text);

                expect(text.length).toBeGreaterThan(0);
            });

            it('mixed text + image rounds maintain history', async () => {
                const messages: ChatMessage[] = [
                    { role: 'user', content: 'Remember the number 7.' },
                    { role: 'assistant', content: 'I will remember the number 7.' },
                    {
                        role: 'user',
                        content: 'Now I am also showing you an image. What number did I ask you to remember?',
                        attachments: [imageAttachment(BLUE_PNG_URI)],
                    },
                ];

                const response = await driver.chat.create({ messages, stream: false, maxTokens: 24 });
                const text = toText(response);
                console.log('[mixed-history]', text);

                expect(text).toContain('7');
            });
        });

        // ── 6. Token usage reporting ──────────────────────────────────────────

        describe('token usage', () => {
            it('non-streaming response includes usage stats', async () => {
                const response = await driver.chat.create({
                    messages: [{ role: 'user', content: 'Hi.' }],
                    stream: false,
                    maxTokens: 8,
                });

                expect('usage' in response).toBe(true);
                if ('usage' in response && response.usage) {
                    const { prompt_tokens, completion_tokens, total_tokens } = response.usage;
                    console.log('[usage]', { prompt_tokens, completion_tokens, total_tokens });

                    expect(prompt_tokens).toBeGreaterThan(0);
                    expect(completion_tokens).toBeGreaterThan(0);
                    expect(total_tokens).toBe(prompt_tokens + completion_tokens);
                }
            });

            it('image attachment increases prompt token count vs text-only', async () => {
                const textOnlyResp = await driver.chat.create({
                    messages: [{ role: 'user', content: 'Say hi.' }],
                    stream: false,
                    maxTokens: 8,
                });

                const withImageResp = await driver.chat.create({
                    messages: [{
                        role: 'user',
                        content: 'Say hi.',
                        attachments: [imageAttachment(BLUE_PNG_URI)],
                    }],
                    stream: false,
                    maxTokens: 8,
                });

                const textTokens = 'usage' in textOnlyResp ? textOnlyResp.usage?.prompt_tokens ?? 0 : 0;
                const imageTokens = 'usage' in withImageResp ? withImageResp.usage?.prompt_tokens ?? 0 : 0;
                console.log('[token-diff] text=%d image=%d', textTokens, imageTokens);

                expect(imageTokens).toBeGreaterThan(textTokens);
            });
        });
    },
);
