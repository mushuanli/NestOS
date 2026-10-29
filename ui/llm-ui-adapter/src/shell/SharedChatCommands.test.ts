// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {createOperationLedger} from '@itookit/llm-ui';
import {SharedChatCommands} from './SharedChatCommands';

function fixture() {
    const configure = vi.fn(async () => {}), signal = new AbortController(), input = {revision: 1, selection: {connectionId: 'connection'}};
    const service = {getConnections: async () => [{id: 'connection', providerId: 'provider', tiers: {optimal: 'model-large', fast: 'model-small'}}],
        getDefaultConnection: async () => ({id: 'connection'}), getProvider: () => ({id: 'provider', models: [{id: 'model-large'}, {id: 'model-small'}]}), findAgent: () => undefined};
    const context = {getDraft: () => input, inputContext: () => ({})};
    const commands = new SharedChatCommands({config: {agentService: service}, signal: signal.signal, operations: createOperationLedger(),
        view: () => context, current: () => !signal.signal.aborted, configure} as never);
    const execute = (name: string, args: string) => {const command = commands.getSnapshot().find(item => item.name === name)!;
        return commands.execute({target: {id: command.id, expectedRevision: command.revision}, kind: command.kind, text: `/${name} ${args}`, arguments: args}, {operationId: 'operation', viewId: 'view'});};
    return {commands, configure, execute, signal};
}
it('delegates run to one send operation and rejects malformed history preferences definitively', async () => {
    const f = fixture(); expect(f.commands.getSnapshot().find(item => item.name === 'run')?.dispatch).toBe('send');
    expect(await f.execute('history', '-2')).toMatchObject({status: 'rejected', code: 'INVALID_HISTORY_LENGTH'});
    expect(f.configure).not.toHaveBeenCalled(); expect(await f.execute('history', '-1')).toMatchObject({status: 'accepted'});
    expect(f.configure).toHaveBeenCalledWith({historyLength: '-1'}); await f.commands.destroy();
});
it('resolves a model id through the current connection and refuses a model absent from its tiers', async () => {
    const f = fixture(); expect(await f.execute('model', 'model-small')).toMatchObject({status: 'accepted'});
    expect(f.configure).toHaveBeenCalledWith({connectionId: 'connection', modelTier: 'fast'});
    expect(await f.execute('model', 'missing')).toMatchObject({status: 'rejected', code: 'MODEL_SELECTION_UNAVAILABLE'});
    expect(f.configure).toHaveBeenCalledOnce(); f.signal.abort(); await expect(f.execute('model', 'fast')).rejects.toThrow(); await f.commands.destroy();
});
