import type {ChatView, ComposerDraft, JsonValue, MountedToolbar, ToolbarContext} from '@itookit/llm-ui';
import {isTargetRef} from '@itookit/llm-flow/contracts';
import {t} from '@itookit/common';
import {WorkspaceContextPicker, type ContextScope, type ContextOptionsPort} from '../components/input/WorkspaceContextPicker';
import {readInputContextDraft} from '../domain/context-draft';

/** Reuses the workspace picker; the independent composer owns frozen draft revisions. */
export class SessionContextPicker implements MountedToolbar {
    private readonly picker: WorkspaceContextPicker;
    private readonly error = document.createElement('p');
    private readonly clear = document.createElement('button');
    private view: ChatView;
    private active = true;
    constructor(host: HTMLElement, context: ToolbarContext, private scope: () => ContextScope | undefined, read: ContextOptionsPort) {
        this.view = context.view; this.error.setAttribute('role', 'alert'); this.clear.type = 'button';
        this.clear.textContent = t('callable.context.clear'); this.clear.onclick = () => {if (this.active) this.view.setContext(null);};
        host.append(this.error, this.clear);
        this.picker = new WorkspaceContextPicker(host, () => this.active ? read : undefined, value => {if (this.active) this.view.setContext(value ? JSON.parse(JSON.stringify(value)) as JsonValue : null);},
            () => this.view.getDraft().context?.revision ?? 0, false);
        this.update(context);
    }
    setActive(active: boolean): void {this.active = active; this.picker.invalidate(); this.updateDraft(this.view.getDraft());}
    update(context: ToolbarContext): void {this.view = context.view; this.updateDraft(context.view.getDraft());}
    updateDraft(draft: ComposerDraft): void {
        if (!this.active) {this.picker.element.hidden = true; this.error.hidden = true; this.clear.hidden = true; return;}
        this.error.hidden = false;
        try {
            const selected = readInputContextDraft(draft.context?.value ?? undefined);
            this.picker.update({scope: this.scope(), target: isTargetRef(draft.target) ? draft.target : undefined, draft: selected});
            this.error.textContent = ''; this.clear.hidden = true;
        } catch {
            this.picker.invalidate(); this.picker.element.hidden = true;
            this.error.textContent = t('callable.context.invalidDraft'); this.clear.hidden = false;
        }
    }
    destroy(): void {this.picker.destroy(); this.clear.onclick = null; this.clear.remove(); this.error.remove();}
}
