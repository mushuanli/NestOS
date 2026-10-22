import {expect, it, vi} from 'vitest';
import {HarnessConversation} from '@itookit/mindos-node-driver';
import {observeConversation} from '../src/projects/conversation-view';

it.each([false, true])('observes and answers early approval without blocking on history repair (gap: %s)', async gap => {
    const profile = {id: 'codex', kind: 'codex', projectRuntime: true, workspaces: [{id: 'p'}], capabilities: {history: true, create: true, resume: true, interrupt: true, interactions: true}};
    const listeners = new Set<() => void>();
    let requests: any[] = [], finish!: (value: {turnId: string}) => void;
    const client = {subscribe: (_profile: string, listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },profiles: async () => ({epoch: 'e', profiles: [profile]}),
        read: vi.fn(async () => ({session: {id: 's', title: 'S', cwd: '/p', status: 'idle', owned: true, resumable: true}, turns: []})), close: async () => {},
        eventSnapshot: vi.fn(async () => ({epoch: 'events', cursor: 1, gap: requests.length > 0 && gap, events: [], requests})),
        turn: vi.fn(() => {requests = [{id: 'approve', method: 'item/commandExecution/requestApproval', params: {threadId: 's'}}]; for (const listener of listeners) listener(); return new Promise<{turnId: string}>(resolve => {finish = resolve;});}),
        respond: vi.fn(async () => {requests = []; finish({turnId: 'turn'});})};
    const source = new HarnessConversation(client as never, profile, 'p', 's'), port = observeConversation(source);
    await port.read(); const stop = port.subscribe(() => {}), sending = port.send('approval-before-start-reply');
    try {
        await vi.waitFor(() => expect(port.snapshot().requests).toHaveLength(1));
        expect(port.snapshot()).toMatchObject({canRespond: true, pending: true});
        expect(client.read).toHaveBeenCalledOnce();
        await port.respond('approve', {decision: 'accept'}); await sending;
        expect(client.respond).toHaveBeenCalledOnce(); expect(port.snapshot()).toMatchObject({pending: false, requests: []});
    } finally {finish?.({turnId: 'turn'}); stop(); await sending; await port.close();}
});
