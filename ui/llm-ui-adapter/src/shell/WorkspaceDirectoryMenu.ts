import { t } from '@itookit/common';
import { Toast, type EditorHostContext } from '@itookit/ui-common';
import { EventCleanup } from '../components/common/EventCleanup';

/** Configuration crosses only the host port, with the current Session captured by the host. */
export class WorkspaceDirectoryMenu {
    private readonly events = new EventCleanup();
    private readonly popupEvents = new EventCleanup();
    private popup?: HTMLElement;
    private focusTarget?: HTMLElement;

    constructor(container: HTMLElement, private readonly commands: EditorHostContext['directoryCommands'],
        private readonly isRunning: () => boolean) {
        const button = container.querySelector<HTMLButtonElement>('#llm-btn-workspace');
        if (button) button.hidden = !commands?.configureWorkspace;
        if (!commands?.configureWorkspace) return;
        if (button) this.events.add(button, 'click', () => {
            const bounds = button.getBoundingClientRect(); this.show(bounds.left, bounds.bottom, button);
        });
        this.events.add(container, 'contextmenu', event => {
            const mouse = event as MouseEvent, target = mouse.target as HTMLElement;
            if (event.defaultPrevented || target.closest('input,textarea,select,[contenteditable="true"],a')) return;
            if (!target.closest('.llm-workspace-titlebar,.llm-input__toolbar') && target !== container) return;
            event.preventDefault(); this.show(mouse.clientX, mouse.clientY, button ?? target);
        });
    }

    private show(x: number, y: number, focusTarget: HTMLElement): void {
        this.close(false); this.focusTarget = focusTarget;
        const menu = document.createElement('div'); menu.className = 'llm-workspace-menu'; menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', t('workspace.menu')); this.popup = menu;
        for (const mode of ['workspace', 'mount'] as const) {
            const item = document.createElement('button'); item.type = 'button'; item.setAttribute('role', 'menuitem');
            item.textContent = t(mode === 'workspace' ? this.commands?.workspaceReadOnly ? 'workspace.view' : 'workspace.configure' : 'workspace.mounts');
            item.disabled = this.isRunning(); item.dataset.directoryMode = mode;
            item.onclick = () => { void this.configure(mode); }; menu.append(item);
        }
        if (this.isRunning()) { const hint = document.createElement('p'); hint.textContent = t('workspace.busy'); menu.append(hint); }
        document.body.append(menu);
        menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - menu.offsetWidth))}px`;
        menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - menu.offsetHeight))}px`;
        focusTarget.setAttribute('aria-expanded', 'true'); menu.tabIndex = -1;
        (menu.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu).focus();
        this.popupEvents.add(document, 'pointerdown', event => { if (!menu.contains(event.target as Node)) this.close(false); }, true);
        this.popupEvents.add(menu, 'keydown', event => this.keydown(event as KeyboardEvent));
    }

    private async configure(mode: 'workspace' | 'mount'): Promise<void> {
        if (this.isRunning()) { this.close(); Toast.error(t('workspace.busy')); return; }
        this.close();
        try { await this.commands?.configureWorkspace?.(mode); }
        catch (error) { Toast.error(error instanceof Error ? error.message : String(error)); }
    }

    private keydown(event: KeyboardEvent): void {
        if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); this.close(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(this.popup?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        if (!buttons.length) return;
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index].focus();
    }

    private close(restoreFocus = true): void {
        this.popupEvents.cleanup(); this.popup?.remove(); this.popup = undefined;
        this.focusTarget?.setAttribute('aria-expanded', 'false');
        if (restoreFocus) this.focusTarget?.focus();
        this.focusTarget = undefined;
    }

    destroy(): void { this.close(false); this.events.cleanup(); }
}
