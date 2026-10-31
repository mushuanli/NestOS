// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {TerminalSettingsEditor} from '../../app-settings/src/editors/TerminalSettingsEditor';
import {t} from '@itookit/common';

const state = vi.hoisted(() => ({data: undefined as undefined | ((data: string) => void), write: vi.fn(), dispose: vi.fn()}));
vi.mock('../../app-settings/node_modules/@xterm/xterm/lib/xterm.js', () => ({Terminal: class {
    cols = 80; rows = 24;
    loadAddon() {} open() {} focus() {} clear() {} reset() {}
    onData(callback: (data: string) => void) {state.data = callback;}
    resize() {} write(data: string, done?: () => void) {state.write(data); done?.();} dispose = state.dispose;
}}));
vi.mock('../../app-settings/node_modules/@xterm/addon-fit/lib/addon-fit.js', () => ({FitAddon: class {proposeDimensions() {return {cols: 80, rows: 24};}}}));
const editors: TerminalSettingsEditor[] = [];
afterEach(async () => {await Promise.all(editors.splice(0).map(editor => editor.destroy())); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.clearAllMocks();});
function fixture(service?: ConstructorParameters<typeof TerminalSettingsEditor>[1]) {
    vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {}});
    const container = document.createElement('div'); document.body.append(container);
    const editor = new TerminalSettingsEditor(container, service, {} as never); editors.push(editor);
    return {editor, container};
}
it('explains unavailable server capability without offering an executable terminal', async () => {
    const {editor, container} = fixture(); await editor.render();
    expect(container.textContent).toContain(t('terminal.unavailable'));
    expect(container.querySelector<HTMLButtonElement>('[data-terminal=open]')!.disabled).toBe(true);
});
it('streams output, sends Ctrl+C, and releases the server process when the editor closes', async () => {
    const session = {id: 'terminal-id', readOutput: vi.fn(async () => ({output: 'server output', cursor: 13, truncated: false, exited: false, exitCode: null})),
        sendInput: vi.fn(async (_data: string) => {}), resizeTerminal: vi.fn(async () => {}), dispose: vi.fn(async () => {})};
    const {editor, container} = fixture({openTerminal: vi.fn(async () => session)}); await editor.render();
    await vi.waitFor(() => expect(state.write).toHaveBeenCalledWith('server output'));
    container.querySelector<HTMLButtonElement>('[data-terminal=interrupt]')!.click();
    await vi.waitFor(() => expect(session.sendInput).toHaveBeenCalledWith('\x03'));
    await editor.destroy(); editors.splice(editors.indexOf(editor), 1);
    expect(session.dispose).toHaveBeenCalledOnce(); expect(state.dispose).toHaveBeenCalledOnce();
});
it('disposes a terminal that finishes opening after the editor was destroyed', async () => {
    let resolve!: (session: never) => void;
    const service = {openTerminal: vi.fn(() => new Promise<never>(done => {resolve = done;}))};
    const {editor} = fixture(service), rendering = editor.render();
    await vi.waitFor(() => expect(service.openTerminal).toHaveBeenCalledOnce());
    await editor.destroy(); editors.splice(editors.indexOf(editor), 1);
    const dispose = vi.fn(async () => {}); resolve({dispose} as never); await rendering;
    expect(dispose).toHaveBeenCalledOnce();
});
it('stops sending after an input failure and shows the actionable server error', async () => {
    const session = {id: 'failed-terminal', readOutput: vi.fn(async () => ({output: '', cursor: 0, truncated: false, exited: false, exitCode: null})),
        sendInput: vi.fn(async (_data: string) => {throw new Error('Server terminal write failed; close and reopen the terminal');}),
        resizeTerminal: vi.fn(async () => {}), dispose: vi.fn(async () => {})};
    const {editor, container} = fixture({openTerminal: vi.fn(async () => session)}); await editor.render();
    state.data!('echo once\r');
    await vi.waitFor(() => expect(container.textContent).toContain('close and reopen the terminal'));
    state.data!('echo never\r');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(session.sendInput).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLButtonElement>('[data-terminal=open]')!.disabled).toBe(false);
});
