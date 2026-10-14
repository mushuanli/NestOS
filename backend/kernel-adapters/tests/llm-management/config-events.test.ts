import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { LLMDeviceDriver } from '../../src/llm-management/core';

it('ignores UI persistence writes but reloads committed LLM changes including renames', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const driver = new LLMDeviceDriver(manager); await driver.init();
    const engine = await manager.openFileSystem('/etc');
    const connections = vi.spyOn((driver as any).connectionManager, 'reload');
    const mcp = vi.spyOn((driver as any).mcpManager, 'reload');
    const skills = vi.spyOn((driver as any).skillManager, 'reload');
    vi.useFakeTimers();
    try {
        await engine.driver.createFile({ parentPath: '/ui', name: 'tabs.json', content: '{}', recursive: true });
        await engine.driver.writeContent('/ui/tabs.json', '{"selected":1}');
        await vi.advanceTimersByTimeAsync(400);
        expect(connections).not.toHaveBeenCalled(); expect(mcp).not.toHaveBeenCalled(); expect(skills).not.toHaveBeenCalled();
        await engine.driver.createFile({ parentPath: '/llm', name: 'test.json', content: '{}' });
        await vi.advanceTimersByTimeAsync(400); expect(connections).toHaveBeenCalledTimes(1);
        await engine.driver.rename('/llm/test.json', 'renamed.json');
        await vi.advanceTimersByTimeAsync(400); expect(connections).toHaveBeenCalledTimes(2);
        await engine.driver.move(['/llm/renamed.json'], '/ui');
        await vi.advanceTimersByTimeAsync(400); expect(connections).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); await driver.dispose(); await manager.dispose(); }
});
