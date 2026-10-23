import { expect, it, vi } from 'vitest';
import { createTransferSummarizer } from '../src/runtime/transfer-summary';

function fixture(contextWindow = 8192) {
    const chat = vi.fn(async () => ({choices: [{message: {content: '  Prepared summary  '}}]}));
    const connection = {id: 'chosen', providerId: 'p', enabled: true, credentialsReady: true, tiers: {optimal: 'model'}};
    const agents = {getConnection: vi.fn(async () => connection), getDefaultConnection: vi.fn(async () => connection),
        getProvider: () => ({id: 'p', enabled: true, models: [{id: 'model', name: 'Model', contextWindow, maxOutput: 1024}]})};
    const summarize = createTransferSummarizer({getSessionSettings: async () => ({connectionId: 'chosen'})} as never, agents as never, {chat} as never);
    return {chat, agents, connection, summarize};
}

it('uses the configured chat model and returns only the frozen summary text', async () => {
    const {chat, agents, summarize} = fixture();
    expect(await summarize('session', 'Source conversation')).toBe('Prepared summary');
    expect(agents.getDefaultConnection).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledWith('chosen', expect.objectContaining({model: 'model', maxTokens: 1024}));
});

it('rejects unavailable credentials and input budget overflow before contacting the model', async () => {
    const unavailable = fixture(); unavailable.connection.credentialsReady = false;
    await expect(unavailable.summarize('session', 'source')).rejects.toThrow('CONTENT_SUMMARY_CONNECTION_UNAVAILABLE');
    expect(unavailable.chat).not.toHaveBeenCalled();
    const limited = fixture(1100);
    await expect(limited.summarize('session', 'too much content'.repeat(100))).rejects.toThrow('CONTENT_SUMMARY_INPUT_TOO_LARGE');
    expect(limited.chat).not.toHaveBeenCalled();
});
