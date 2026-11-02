import {BaseSettingsEditor} from '@itookit/ui-common-adapter';
import {escapeHTML, t} from '@itookit/common';
import type {EditorOptions} from '@itookit/ui-common-adapter';
import type {ServerTerminal, ServerTerminals} from '@itookit/app-contracts/services';
import type {Terminal} from '@xterm/xterm';
import type {FitAddon} from '@xterm/addon-fit';

/** The editor owns only its terminal lease; it never replays input after failure. */
export class TerminalSettingsEditor extends BaseSettingsEditor<ServerTerminals | undefined> {
    private terminal?: Terminal;
    private fit?: FitAddon;
    private session?: ServerTerminal;
    private observer?: ResizeObserver;
    private timer?: ReturnType<typeof setTimeout>;
    private inputTimer?: ReturnType<typeof setTimeout>;
    private pendingInput = '';
    private inputTail = Promise.resolve();
    private cursor = 0;
    private closed = false;
    private active = false;
    private opening = false;
    constructor(container: HTMLElement, service: ServerTerminals | undefined, options: EditorOptions) {
        super(container, service, options);
    }
    async render(): Promise<void> {
        this.container.innerHTML = `<div class="settings-page settings-terminal">
            <h1 class="settings-page__title">${escapeHTML(t('terminal.title'))}</h1>
            <p class="settings-page__description">${escapeHTML(t('terminal.description'))}</p>
            <div class="settings-terminal__toolbar">
                <button class="settings-btn settings-btn--secondary settings-btn--sm" type="button" data-terminal="open">${escapeHTML(t('terminal.open'))}</button>
                <button class="settings-btn settings-btn--secondary settings-btn--sm" type="button" data-terminal="interrupt" disabled>${escapeHTML(t('terminal.interrupt'))}</button>
                <button class="settings-btn settings-btn--secondary settings-btn--sm" type="button" data-terminal="clear">${escapeHTML(t('terminal.clear'))}</button>
                <button class="settings-btn settings-btn--secondary settings-btn--sm" type="button" data-terminal="close" disabled>${escapeHTML(t('terminal.close'))}</button>
            </div><p class="settings-terminal__status" role="status" aria-live="polite"></p>
            <div class="settings-terminal__screen"></div></div>`;
        this.container.onclick = event => {
            const action = (event.target as HTMLElement).closest<HTMLElement>('[data-terminal]')?.dataset.terminal;
            if (action === 'open') void this.open();
            if (action === 'clear') this.terminal?.clear();
            if (action === 'interrupt') this.enqueueInput('\x03');
            if (action === 'close') void this.closeSession().catch(error => this.fail(error));
        };
        if (this.service) await this.open();
        else { this.status(t('terminal.unavailable')); this.buttons(false); }
    }
    private async open(): Promise<void> {
        if (!this.service || this.closed || this.opening || this.active) return;
        this.opening = true; this.buttons(false); this.status(t('terminal.connecting'));
        try {
            await this.closeSession();
            const [{Terminal}, {FitAddon}] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
            if (this.closed) return;
            const session = await this.service.openTerminal();
            if (this.closed) { await session.dispose(); return; }
            this.session = session; this.cursor = 0;
            this.terminal?.dispose();
            this.terminal = new Terminal({cursorBlink: true, scrollback: 3000, fontSize: 14, allowProposedApi: false});
            this.fit = new FitAddon(); this.terminal.loadAddon(this.fit);
            this.terminal.open(this.container.querySelector<HTMLElement>('.settings-terminal__screen')!);
            this.active = true;
            this.terminal.onData(data => this.enqueueInput(data));
            this.observer = new ResizeObserver(() => this.resize());
            this.observer.observe(this.container.querySelector('.settings-terminal__screen')!);
            this.resize(); this.terminal.focus(); this.status(t('terminal.connected'));
            this.buttons(true); void this.poll();
        } catch (error) { this.fail(error); }
        finally { this.opening = false; this.buttons(this.active); }
    }
    private resize(): void {
        if (!this.active || !this.session || !this.terminal) return;
        const size = this.fit?.proposeDimensions();
        if (!size || size.cols < 2 || size.rows < 2) return;
        const cols = Math.min(500, size.cols), rows = Math.min(500, size.rows);
        if (cols === this.terminal.cols && rows === this.terminal.rows) return;
        this.terminal.resize(cols, rows);
        const session = this.session;
        void session.resizeTerminal(cols, rows).catch(error => { if (this.session === session && this.active) this.fail(error); });
    }
    private enqueueInput(data: string): void {
        if (!this.active) return;
        this.pendingInput += data;
        if (this.pendingInput.length > 65536) { this.pendingInput = ''; this.fail(new Error(t('terminal.inputLimit'))); return; }
        if (!this.inputTimer) this.inputTimer = setTimeout(() => this.flushInput(), 20);
    }
    private flushInput(): void {
        this.inputTimer = undefined;
        const data = this.pendingInput, session = this.session; this.pendingInput = '';
        if (!data || !session || !this.active) return;
        this.inputTail = this.inputTail.then(async () => {
            let start = 0;
            while (start < data.length && this.active && this.session === session) {
                let end = Math.min(start + 2048, data.length);
                if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--;
                await session.sendInput(data.slice(start, end)); start = end;
            }
        }).catch(error => this.fail(error));
    }
    private async poll(): Promise<void> {
        const session = this.session;
        if (!this.active || !session || this.closed) return;
        try {
            const page = await session.readOutput(this.cursor);
            if (this.session !== session || !this.active || this.closed) return;
            this.cursor = page.cursor;
            if (page.truncated) { this.terminal?.reset(); this.status(t('terminal.truncated')); }
            if (page.output && this.terminal) await new Promise<void>(resolve => this.terminal!.write(page.output, resolve));
            if (this.session !== session || !this.active || this.closed) return;
            if (page.exited) { this.active = false; this.buttons(false); this.status(`${t('terminal.exited')}: ${page.exitCode ?? '—'}`); return; }
            this.timer = setTimeout(() => void this.poll(), page.output.length >= 32768 ? 0 : 150);
        } catch (error) { if (this.session === session && !this.closed) this.fail(error); }
    }
    private fail(error: unknown): void {
        if (this.closed) return;
        this.active = false; this.buttons(false);
        this.status(`${t('terminal.failed')}: ${error instanceof Error ? error.message : String(error)}`);
    }
    private status(message: string): void {
        const status = this.container.querySelector('.settings-terminal__status');
        if (status) status.textContent = message;
    }
    private buttons(active: boolean): void {
        for (const button of this.container.querySelectorAll<HTMLButtonElement>('[data-terminal]')) {
            const action = button.dataset.terminal;
            button.disabled = action === 'open' ? !this.service || active || this.opening :
                action === 'clear' ? false : action === 'close' ? !this.session : !active;
        }
    }
    private async closeSession(): Promise<void> {
        this.active = false; clearTimeout(this.timer); clearTimeout(this.inputTimer);
        this.pendingInput = ''; this.inputTimer = undefined; this.observer?.disconnect();
        const session = this.session; this.session = undefined;
        await this.inputTail;
        await session?.dispose();
        if (!this.closed) { this.status(t('terminal.closed')); this.buttons(false); }
    }
    async destroy(): Promise<void> {
        this.closed = true; this.container.onclick = null;
        try { await this.closeSession(); }
        finally { this.terminal?.dispose(); await super.destroy(); }
    }
}
