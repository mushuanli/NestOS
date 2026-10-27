import { afterEach, expect, it } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionRepository, RoundLog, type Round } from '@itookit/llm-session';
import { NestosTwinSourceReader } from '../src/digital-twin/source-reader';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }); cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), repository = new SessionRepository(fs);
    await repository.init(); cleanup.push(() => repository.dispose());
    return { fs, repository, reader: new NestosTwinSourceReader(fs, repository) };
}
it('reads only authorized ordinary VFS documents and rejects private paths, protected ancestors and oversized sources', async () => {
    const { fs, reader } = await setup();
    await fs.driver.createFile({ parentPath: '/home/admin/minds', name: 'source.md', content: 'public source', recursive: true });
    expect((await reader.read({ kind: 'file', target: '/home/admin/minds/source.md', label: '' })).text).toBe('public source');
    for (const target of ['/var/lib/kernel/input.md', '/home/admin/private/note.md', '/home/admin/minds/../private/note.md', '/home/admin/.config/secrets.md']) {
        await expect(reader.read({ kind: 'file', target, label: '' })).rejects.toThrow('SOURCE_SCOPE');
    }
    await fs.driver.createFile({ parentPath: '/home/admin/minds', name: 'protected.md', content: 'secret', metadata: { isProtected: true }, recursive: true });
    await expect(reader.read({ kind: 'file', target: '/home/admin/minds/protected.md', label: '' })).rejects.toThrow('PRIVATE_SOURCE');
    await fs.driver.createFile({ parentPath: '/home/admin/minds', name: 'large.md', content: 'x'.repeat(1024 * 1024 + 1), recursive: true });
    await expect(reader.read({ kind: 'file', target: '/home/admin/minds/large.md', label: '' })).rejects.toThrow('SOURCE_LIMIT');
});
it('preserves user and assistant attribution while excluding system prompts, thinking and tool outputs from native history', async () => {
    const { reader, repository } = await setup();
    const id = await repository.createSession('Native history');
    const log = new RoundLog(repository, id);
    const round: Round = { id: 'round', kind: 'chat', historyParentIds: [], origin: 'user', status: 'completed', createdAt: 1,
        input: [{ role: 'user', content: '我决定使用 Alpha。' }, { role: 'system', content: 'SECRET_SYSTEM_PROMPT' }],
        output: [{ role: 'assistant', content: '建议考虑 Beta。', thinking: 'SECRET_REASONING' }, { role: 'tool', content: 'SECRET_TOOL_OUTPUT' }] };
    await log.append('main', round);
    const content = await reader.read({ kind: 'session', target: id, label: '' });
    expect(content.text).toContain('我决定使用 Alpha'); expect(content.text).toContain('建议考虑 Beta');
    expect(content.text).toContain('"role":"user"'); expect(content.text).toContain('"role":"assistant"');
    expect(content.text).not.toContain('SECRET');
});
