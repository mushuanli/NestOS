import {expect, it} from 'vitest';
import type {ExecutorConfig} from '../src/core/types';
import {applyHarnessOverrides, applyOverrides, assertContextSelection} from '../src/session/execution-overrides';
import {assertContextOptionsQuery, directHarnessContextIdentity} from '../src/contracts/context-options';

const harness: ExecutorConfig = {id: 'agent', name: 'Agent', type: 'agent', agentVersion: 'published', systemPrompt: ['base'],
    execution: {kind: 'harness', connectionId: 'remote'}};
it('rejects a native context on model and Flow calls instead of silently discarding it', () => {
    const input = {overrides: {harnessConversation: {mode: 'new' as const}}};
    expect(() => assertContextSelection(input, {...harness, execution: {kind: 'agent'}})).toThrowError(expect.objectContaining({code: 'CONTEXT_TARGET_NOT_HARNESS'}));
    expect(() => applyOverrides(harness, input.overrides)).toThrowError(expect.objectContaining({code: 'CONTEXT_TARGET_NOT_HARNESS'}));
    expect(() => assertContextSelection({...input, sendIntent: {execution: {kind: 'flow'}} as never}, harness))
        .toThrowError(expect.objectContaining({code: 'CONTEXT_TARGET_NOT_HARNESS'}));
});
it('rejects strict native continuation and invalid prompt append while preserving the source definition', () => {
    expect(() => assertContextSelection({overrides: {harnessConversation: {mode: 'continue', bindingId: 'b', expectedBindingRevision: 1, expectedGeneration: 1}}}, harness))
        .toThrowError(expect.objectContaining({code: 'CONTEXT_NATIVE_WRITE_UNSUPPORTED'}));
    expect(() => applyHarnessOverrides(harness, {overrides: {systemPromptAppend: {} as never}}))
        .toThrowError(expect.objectContaining({code: 'CONTEXT_POLICY_OVERRIDE_INVALID'}));
    expect(() => assertContextSelection({overrides: {systemPromptAppend: {} as never}}, harness))
        .toThrowError(expect.objectContaining({code: 'CONTEXT_POLICY_OVERRIDE_INVALID'}));
    expect(applyHarnessOverrides(harness, {overrides: {systemPromptAppend: 'once'}}).systemPrompt).toEqual(['base', 'once']);
    expect(harness.systemPrompt).toEqual(['base']);
});
it('uses one direct context identity encoding and validates options cursors without side effects', () => {
    const query = {sessionId: 'session', branchId: 'other', target: {kind: 'agent' as const, id: 'agent', version: 'v1', digest: 'a'.repeat(64)}};
    expect(() => assertContextOptionsQuery(query)).not.toThrow();
    for (const cursor of [null, [], {}, {basis: 'a'.repeat(64)}])
        expect(() => assertContextOptionsQuery({...query, cursor} as never)).toThrowError(expect.objectContaining({code: 'CONTEXT_OPTIONS_INVALID'}));
    const identity = directHarnessContextIdentity({id: 'agent', version: 'v1'}, {workspace: 'project'});
    expect(identity.targetRef).toBe('agent:agent@v1'); expect(identity.workspaceRef).toMatch(/^[a-f0-9]{64}$/);
});
