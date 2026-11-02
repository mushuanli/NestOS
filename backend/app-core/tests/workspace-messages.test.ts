import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {KanbanAutomationJournal} from '../src/kanban/automation-journal';
import {consumeWorkspaceMessages, initializeWorkspaceMessages, parseWorkspaceMessage} from '../src/run/workspace-messages';

const scope = {runId: 'run', itemId: 'item', attemptId: 'attempt'}, directory = '/workspace/_nestos/kanban';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), journal = new KanbanAutomationJournal(fs); await journal.open();
    await initializeWorkspaceMessages(fs, directory, scope);
    const message = {schema: 'work-message/1', ...scope, id: 'message', type: 'clarification', content: 'Need acceptance details'};
    const publish = (value = message, name = 'message.json') => fs.driver.createFile({parentPath: directory + '/inbox', name, content: JSON.stringify(value)});
    return {fs, journal, message, publish};
}
it('consumes atomic publications once across reopening and detects rewritten IDs', async () => {
    const f = await fixture(), deliver = vi.fn(async () => {}); await f.publish(); await f.publish(f.message, 'unfinished.tmp');
    expect(await consumeWorkspaceMessages(f.fs, directory, scope, f.journal, deliver)).toHaveLength(1);
    await consumeWorkspaceMessages(f.fs, directory, scope, new KanbanAutomationJournal(f.fs), deliver);
    expect(deliver).toHaveBeenCalledTimes(1);
    await f.fs.driver.writeContent(directory + '/inbox/message.json', JSON.stringify({...f.message, content: 'Changed'}));
    await expect(consumeWorkspaceMessages(f.fs, directory, scope, f.journal, deliver)).rejects.toMatchObject({code: 'ECONFLICT'});
});
it('rejects scope changes, malformed and oversized messages without marking them delivered', async () => {
    const f = await fixture(), deliver = vi.fn(async () => {});
    expect(() => parseWorkspaceMessage(JSON.stringify({...f.message, attemptId: 'other'}), scope)).toThrow('scope');
    await f.publish({...f.message, content: 'x'.repeat(65537)});
    await expect(consumeWorkspaceMessages(f.fs, directory, scope, f.journal, deliver)).rejects.toThrow('64 KiB');
    expect(deliver).not.toHaveBeenCalled();
    await expect(initializeWorkspaceMessages(f.fs, directory, {...scope, attemptId: 'other'})).rejects.toMatchObject({code: 'ECONFLICT'});
});
it('retries delivery with the same stable message after an interrupted handler', async () => {
    const f = await fixture(); await f.publish();
    const deliver = vi.fn().mockRejectedValueOnce(new Error('Response lost')).mockResolvedValue(undefined);
    await expect(consumeWorkspaceMessages(f.fs, directory, scope, f.journal, deliver)).rejects.toThrow('Response lost');
    await consumeWorkspaceMessages(f.fs, directory, scope, f.journal, deliver);
    expect(deliver.mock.calls[0][0]).toEqual(deliver.mock.calls[1][0]);
});

it('documents the message fields and accepts the original body spelling without ambiguity', async () => {
    const f = await fixture();
    const protocol = JSON.parse(await f.fs.driver.readContent(directory + '/protocol.json', {encoding: 'utf-8'}));
    expect(protocol.message).toMatchObject({schema: 'work-message/1', ...scope, type: 'progress'});
    const {content, ...message} = f.message;
    expect(parseWorkspaceMessage(JSON.stringify({...message, body: content}), scope).content).toBe(content);
    expect(() => parseWorkspaceMessage(JSON.stringify({...f.message, body: content}), scope)).toThrow('both');
});

it('fits remote range reads to the file size instead of treating a maximum as an exact range', async () => {
    const f = await fixture(); await f.publish();
    const original = f.fs.driver.readContent.bind(f.fs.driver);
    vi.spyOn(f.fs.driver, 'readContent').mockImplementation((async (path: string, options?: {length?: number}) => {
        const node = await f.fs.driver.getNode(path);
        if (options?.length && node?.type === 'file' && options.length > node.size) throw new Error('Short remote range');
        return original(path, options);
    }) as typeof f.fs.driver.readContent);
    const deliver = vi.fn(async () => {});
    await consumeWorkspaceMessages(f.fs, directory, scope, f.journal, deliver);
    await initializeWorkspaceMessages(f.fs, directory, scope);
    expect(deliver).toHaveBeenCalledTimes(1);
});
