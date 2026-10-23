import {expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {SessionCommand} from '@itookit/llm-session/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';

it('preflights the saved model and selected protocol before creating a session or requesting model output', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('A model request must not be made during preflight'));
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    try {
        await runtime.agentService.saveProvider({id: 'format-fixture', name: 'Format fixture', implementation: 'anthropic',
            baseURL: 'https://example.invalid', apiKey: 'fixture', defaultProtocol: 'anthropic-messages',
            models: [{id: 'declared-model', name: 'Declared model', supportsVision: true, supportsStructuredOutput: true}]});
        await runtime.agentService.saveConnection({id: 'selected', name: 'Selected fixture', providerId: 'format-fixture',
            protocol: 'anthropic-messages', tiers: {optimal: 'declared-model'}});
        const flow = {id: 'output-admission', name: 'Output admission', draftVersion: 1, edges: [],
            connections: [{name: 'vision', connectionId: 'selected', requirements: {operation: 'chat', inputModalities: ['image']}}],
            nodes: [{id: 'recognize', name: 'Read images', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {}, config: {
                connectionSlot: 'vision', instruction: 'Return only the requested JSON object.', responseFormat: {type: 'json_object'},
                outputValidation: {onInvalid: 'repair', retries: 2, schema: {type: 'object', required: ['cards'], properties: {cards: {type: 'array'}}}},
            }}]};
        const before = await runtime.sessionRepository.list();
        await expect(runtime.commandBus.execute(SessionCommand.CheckFlowConnections, {flow})).rejects.toThrow(/slot vision.*anthropic-messages.*json_object/);
        flow.nodes[0].config.responseFormat.type = 'text';
        await expect(runtime.commandBus.execute(SessionCommand.CheckFlowConnections, {flow})).resolves.toEqual({valid: true});
        expect(await runtime.sessionRepository.list()).toEqual(before); expect(request).not.toHaveBeenCalled();
    } finally {await runtime.dispose(); request.mockRestore();}
});
