import {expect, it, vi} from 'vitest';
import type {AgentDefinition} from '@itookit/kernel-adapters/contracts';
import {AgentPublications} from '../src/services/agent-publications';
import {createSessionHost} from '../src/utils/host-ports';
import {agentRevisionDigest, agentSourceDigest} from '../src/services/agent-definition-digest';

function setup() {
    const definition: AgentDefinition = {id: 'agent', name: 'Agent', type: 'agent', config: {systemPrompt: 'PRIVATE_POLICY'}};
    const content = {definition, sourceDigest: agentSourceDigest(definition)};
    const request = {agentId: 'agent', operationId: 'publication', expectedSourceDigest: content.sourceDigest,
        expectedRevisionDigest: agentRevisionDigest(content), expectedPublishedVersion: null};
    const host = createSessionHost();
    const logger = {...host.logger, info: vi.fn(() => {throw new Error('Diagnostic failed');}), warn: vi.fn(() => {throw new Error('Diagnostic failed');})};
    const publications = new AgentPublications({} as never, async () => definition, async () => null, logger);
    vi.spyOn(publications.store, 'receipt').mockResolvedValue(null);
    return {publications, request, content, logger};
}

it('preserves a committed publication and its replay when injected diagnostics throw', async () => {
    const f = setup(), revision = {...f.content, schemaVersion: 1 as const,
        target: {kind: 'agent' as const, id: 'agent', version: `ap1_${f.request.expectedRevisionDigest}`, digest: f.request.expectedRevisionDigest}, createdAt: 1};
    const commit = vi.spyOn(f.publications.store, 'publish').mockResolvedValue(revision);
    await expect(f.publications.publish(f.request)).resolves.toEqual(revision);
    vi.mocked(f.publications.store.receipt).mockResolvedValue(revision);
    await expect(f.publications.publish(f.request)).resolves.toEqual(revision);
    expect(commit).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.logger.info.mock.calls)).not.toContain('PRIVATE_POLICY');
});

it('preserves the original rejection and known outcome when failure diagnostics throw', async () => {
    const f = setup(), error = Object.assign(new Error('Source changed'), {code: 'AGENT_SOURCE_CHANGED'});
    vi.spyOn(f.publications.store, 'publish').mockRejectedValue(error);
    await expect(f.publications.publish(f.request)).rejects.toBe(error);
    expect(error).toMatchObject({outcome: 'not-committed'});
    await expect(f.publications.publish({...f.request, operationId: ''})).rejects.toMatchObject({code: 'AGENT_PUBLICATION_REQUEST_INVALID', outcome: 'not-committed'});
});
