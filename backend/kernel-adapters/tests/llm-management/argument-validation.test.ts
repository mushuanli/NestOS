import { expect, it, vi } from 'vitest';
import { validateLLMIoctlArgument, isStoredProvider } from '../../src/llm-management/device/argument-validation';
import { LLMDeviceDriver } from '../../src/llm-management/device/llm-device-driver';
import { LLM_IOCTL } from '../../src/llm-management/contracts/device';
import { ConnectionManager } from '../../src/llm-management/device/connection-manager';

it.each([
    [LLM_IOCTL.SAVE_CONNECTION, { id: '../bad', name: 'Bad', providerId: 'p' }],
    [LLM_IOCTL.SAVE_PROVIDER, { id: 'p', name: 'P', baseURL: '', models: [], implementation: { toString: () => 'custom' } }],
    [LLM_IOCTL.SAVE_MCP_SERVER, { id: 'm', name: 'M', transport: 'http', headers: { Authorization: 42 } }],
    [LLM_IOCTL.CHAT, { messages: [{ role: 'user', content: null }] }],
    [LLM_IOCTL.MCP_CALL_TOOL, { tool: 'tool', args: [], timeout: 1 }],
    [LLM_IOCTL.DELETE_CONNECTION, '../escape'],
])('rejects invalid arguments before consulting device context: %s', async (command, value) => {
    const vfs = { openFileSystem: vi.fn() };
    const driver = new LLMDeviceDriver(vfs as never);
    await expect(driver.ioctl(undefined as never, command, value)).rejects.toThrow('Invalid LLM ioctl argument');
    expect(vfs.openFileSystem).not.toHaveBeenCalled();
});
it('rejects malformed direct saves without writing or changing the connection catalog', async () => {
    const helper = { engineUpsert: vi.fn() };
    const manager = new ConnectionManager(helper as never, {} as never, {} as never, vi.fn());
    await expect(manager.saveConnection({ id: 'bad', name: 'Bad' } as never)).rejects.toThrow('Invalid LLM connection');
    expect(helper.engineUpsert).not.toHaveBeenCalled(); expect(manager.getRawConnections()).toEqual([]);
});
it('retains deletion records and forwards unknown commands to device dispatch', () => {
    expect(isStoredProvider({ id: 'deleted', __deleted: true })).toBe(true);
    expect(isStoredProvider({ id: '../deleted', __deleted: true })).toBe(false);
    expect(() => validateLLMIoctlArgument('toString', null)).not.toThrow();
});
