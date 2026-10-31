import {afterEach, expect, it, vi} from 'vitest';
import {NodeServerTerminals} from '../../node-host/src/terminal/server-terminals';
const state = vi.hoisted(() => ({spawn: vi.fn(), info: vi.fn(), error: vi.fn()}));
vi.mock('../../node-host/node_modules/node-pty/lib/index.js', () => ({spawn: state.spawn}));
vi.mock('@itookit/common', async original => ({...await original<object>(), createModuleLogger: () => ({info: state.info, error: state.error})}));
afterEach(() => vi.resetAllMocks());
it('reports the spawn stage and keeps native details out of errors and diagnostics', async () => {
    state.spawn.mockImplementation(() => {throw new Error('PRIVATE_TERMINAL_NATIVE_DETAILS');});
    const host = new NodeServerTerminals();
    await expect(host.openTerminal()).rejects.toMatchObject({code: 'ECAPABILITY', message: expect.stringContaining('/bin/bash')});
    expect(state.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({stage: 'spawn', code: 'TERMINAL_SPAWN_FAILED', result: 'failure', operationId: expect.any(String), durationMs: expect.any(Number)}));
    expect(JSON.stringify(state.error.mock.calls)).not.toContain('PRIVATE_TERMINAL_NATIVE_DETAILS');
    await host.dispose();
});
it('classifies write and resize failures without logging input or environment values', async () => {
    let exited!: (event: {exitCode: number}) => void;
    state.spawn.mockReturnValue({onData: () => ({dispose() {}}), onExit: (callback: typeof exited) => {exited = callback; return {dispose() {}};},
        write: () => {throw new Error('PRIVATE_TERMINAL_INPUT');}, resize: () => {throw new Error('PRIVATE_TERMINAL_ENV');}, kill: () => exited({exitCode: 0})});
    const host = new NodeServerTerminals(), terminal = await host.openTerminal();
    try {
        await expect(terminal.sendInput('PRIVATE_TERMINAL_INPUT')).rejects.toMatchObject({code: 'EIO', message: expect.stringContaining('write')});
        await expect(terminal.resizeTerminal(90, 30)).rejects.toMatchObject({code: 'EIO', message: expect.stringContaining('resize')});
        expect(state.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({operation: 'write', code: 'TERMINAL_IO_FAILED'}));
        expect(state.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({operation: 'resize', code: 'TERMINAL_IO_FAILED'}));
        expect(JSON.stringify(state.error.mock.calls)).not.toContain('PRIVATE_TERMINAL');
    } finally {await host.dispose();}
});
