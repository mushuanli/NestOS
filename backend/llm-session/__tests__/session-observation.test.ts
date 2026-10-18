import {expect, it, vi} from 'vitest';
import {SessionRegistry} from '../src/session/session-registry';

function fixture() {
    return new SessionRegistry({getManifest: async () => ({branches: {main: null}, currentBranch: 'main',
        currentHead: null, rootRoundId: null, children: {}})} as never);
}
const event = {type: 'message:updated', payload: {messageId: 'reply', content: 'response', field: 'output'}} as const;

it('keeps pre-bind observers attached across bindings and removes only the subscribing observer', async () => {
    const registry = fixture(), observation = vi.fn(), editor = vi.fn();
    const stop = registry.onEvent(observation);
    await registry.bindSession('first');
    const stopEditor = registry.onEvent(editor);
    registry.eventBus.emitSession('first', event);
    expect(observation).toHaveBeenCalledOnce(); expect(observation).toHaveBeenCalledWith(event);
    expect(editor).toHaveBeenCalledOnce(); expect(editor).toHaveBeenCalledWith(event);
    stopEditor();
    registry.eventBus.emitSession('first', event);
    expect(observation).toHaveBeenCalledTimes(2); expect(editor).toHaveBeenCalledOnce();
    await registry.bindSession('second');
    registry.eventBus.emitSession('first', event);
    expect(observation).toHaveBeenCalledTimes(2);
    registry.eventBus.emitSession('second', event);
    expect(observation).toHaveBeenCalledTimes(3);
    stop(); registry.eventBus.emitSession('second', event);
    expect(observation).toHaveBeenCalledTimes(3);
});

it('isolates subscriber failures and leaves independently owned channel listeners intact on unbind', async () => {
    const registry = fixture(), received = vi.fn(), background = vi.fn();
    registry.onEvent(() => {throw new Error('Observer failed');}); registry.onEvent(received);
    await registry.bindSession('first');
    registry.eventBus.onSession('first', background);
    registry.eventBus.emitSession('first', event);
    expect(received).toHaveBeenCalledOnce();
    registry.updateStatus('first', 'running'); registry.unbindSession();
    registry.eventBus.emitSession('first', event);
    expect(received).toHaveBeenCalledOnce(); expect(background).toHaveBeenCalledTimes(2);
});
