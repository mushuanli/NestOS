// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { t } from '@itookit/common';
import { type IAgentConfigService } from '@itookit/kernel-adapters/contracts';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { Kernel } from '@itookit/durable-kernel';
import { MemorySharingControls, SessionMemoryProvider, SharedMemoryStore } from '@itookit/llm-session';
import { showMemorySharingDialog } from '../src/files/memory-sharing-dialog';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it('creates, explicitly grants, revokes and deletes shared Memory through host controls', async () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: () => {} });
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    const kernel = new Kernel({ catalog: { fs } }); await kernel.initialize();
    const store = new SharedMemoryStore(fs); await store.init();
    const memory = new SessionMemoryProvider(kernel, store);
    let agent = { id: 'agent', memoryPolicy: { namespaceId: 'notes', readScopes: ['project'], writeScopes: ['project'] } };
    const agents = { getAgentConfig: async () => structuredClone(agent), saveAgent: async (next: typeof agent) => { agent = next; } };
    const controls = new MemorySharingControls(memory, agents as unknown as IAgentConfigService, () => 'one', async () => true);
    const closed = showMemorySharingDialog(controls, 'agent');
    const button = (key: Parameters<typeof t>[0]) => [...document.querySelectorAll('button')].find(item => item.textContent === t(key))!;
    const idle = () => vi.waitFor(() => expect(button('memory.manage.close').disabled).toBe(false));
    const click = async (key: Parameters<typeof t>[0]) => { button(key).click(); await idle(); expect(document.querySelector('[role=status]')?.textContent).toBe(''); };
    try {
        await idle(); document.querySelectorAll('input')[0].value = 'team';
        await click('memory.sharing.create');
        const policy = (await controls.state('agent')).policy;
        await memory.upsert('one', policy, { scope: 'project', entryId: 'note', content: 'shared' });
        await expect(memory.list('two', policy)).rejects.toThrow('denied');
        document.querySelectorAll('input')[1].value = 'two'; await click('memory.sharing.read');
        expect((await memory.list('two', policy))[0].content).toBe('shared');
        await expect(memory.remove('two', policy, 'project', 'note')).rejects.toThrow('denied');
        await click('memory.sharing.write');
        await memory.upsert('two', policy, { scope: 'project', entryId: 'other', content: 'another' });
        await click('memory.sharing.revoke'); await expect(memory.list('two', policy)).rejects.toThrow('denied');
        await click('memory.sharing.audit'); expect(document.querySelector('pre')?.textContent).toContain('revoke');
        await click('memory.sharing.delete'); await expect(memory.list('one', policy)).rejects.toThrow('unavailable');
        expect((await controls.state('agent')).policy.sharedMemory).toBeUndefined();
        button('memory.manage.close').click(); await closed;
    } finally { await kernel.dispose(); await manager.dispose(); }
});
