import {expect, it} from 'vitest';
import type {Round} from '../src/contracts/conversation';
import {roundCallTarget} from '../src/session/round-call-target';

it('consumes Flow parameter overrides once when regenerating an Agent backed by a published Flow', () => {
    const round = {target: {kind: 'agent', id: 'reviewer', version: 'ap1_revision', digest: 'agent-digest'},
        flow: {flowId: 'review', revision: 1, parameters: {request: 'Original', count: 0}}} as Round;
    const overrides = {flowParameters: {request: 'Edited', count: 2}, temperature: 0};
    const request = roundCallTarget(round, overrides);
    expect(request).toMatchObject({agentId: 'reviewer', target: {kind: 'agent', id: 'reviewer', version: 'ap1_revision'},
        expectedTarget: round.target, source: {kind: 'arguments', value: overrides.flowParameters}, overrides: {temperature: 0}});
    expect(request).not.toHaveProperty('overrides.flowParameters');
    expect(overrides.flowParameters.request).toBe('Edited');
    expect(round.flow?.parameters?.request).toBe('Original');
});
