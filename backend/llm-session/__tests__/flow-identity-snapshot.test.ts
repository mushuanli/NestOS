import { expect, it, vi } from 'vitest';
import { captureFlowIdentities, frozenFlowIdentities } from '../src/session/flow-identity-snapshot';

it('preserves Session scope, absent optional resources and frozen versions through source edits', async () => {
    const prompt = { id: 'prompt', name: 'Prompt', content: ['ORIGINAL'] };
    const getSkills = vi.fn(async () => []), getMCPToolIds = vi.fn(async () => ['tool']);
    const live = { resolveExact: vi.fn(async () => ({ id: 'agent', name: 'Agent', type: 'agent' as const })),
        getSkills, getMCPToolIds, getSystemPrompt: vi.fn(async () => prompt) };
    const capture = captureFlowIdentities(live, 'session-a');
    await Promise.all([capture.resolver.getSkills(['missing'], 'session-a'), capture.resolver.getSystemPrompt('prompt'),
        capture.resolver.getMCPToolIds!(['profile'], 'session-a')]);
    expect(getSkills).toHaveBeenCalledWith(['missing'], 'session-a');
    expect(getMCPToolIds).toHaveBeenCalledWith(['profile'], 'session-a');
    const frozen = frozenFlowIdentities(capture.snapshot());
    prompt.content[0] = 'CHANGED';
    expect(await frozen.getSystemPrompt('prompt')).toMatchObject({ content: ['ORIGINAL'] });
    expect(await frozen.getSkills(['missing'], 'session-a')).toEqual([]);
    await expect(frozen.resolveExact('new-agent')).rejects.toThrow('not admitted');
    const dynamic = frozenFlowIdentities(capture.snapshot(), live);
    expect(await dynamic.resolveExact('new-agent')).toMatchObject({ id: 'agent' });
    expect(await dynamic.getSystemPrompt('prompt')).toMatchObject({ content: ['ORIGINAL'] });
    expect(live.getSystemPrompt).toHaveBeenCalledOnce();
});
