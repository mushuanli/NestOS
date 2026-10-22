import { createModuleLogger, randomUUID, t } from '@itookit/common';
import type { ToolboxKind } from './routes';
import type { ToolboxDrawers } from '@itookit/app-contracts/services';
import { drawerKind } from '@itookit/app-contracts';
import { drawerField } from './drawer-field';
import { providerTemplateFields } from './provider-template-fields';
import { resourceIcon } from './resource-icons';
import { mountDialogOverlays } from './dialog-overlays';

const log = createModuleLogger('toolbox-create');
export interface ToolboxCreationDraft {
    kind: ToolboxKind; name: string; drawer: string; providerId?: string; providerTemplateId?: string;
}
interface Options {
    kinds: readonly ToolboxKind[]; initialKind?: ToolboxKind; initialName?: string;
    drawer?: { kind: ToolboxKind; name: string }; drawers: ToolboxDrawers;
    providers: ReadonlyArray<{ id: string; name: string }>; providerId?: string;
    templates: ReadonlyArray<{ id: string; name: string }>; signal: AbortSignal;
    save(draft: ToolboxCreationDraft): Promise<string>; open(path: string): Promise<void>;
    configure?(container: HTMLElement, path: string, done: (discardResult?: boolean) => Promise<void>): Promise<{ flush(): Promise<void>; dispose(): void | Promise<void> }>;
    completed?(): Promise<void>;
}

/** Creation order follows the user's choices; saved resources survive a failed navigation retry. */
class ToolboxCreationDialog {
    private readonly dialog = document.createElement('dialog');
    private readonly heading = document.createElement('h2');
    private readonly form = document.createElement('form');
    private readonly fields = document.createElement('fieldset');
    private readonly choices = document.createElement('div');
    private kind?: ToolboxKind;
    private readonly name = document.createElement('input');
    private readonly nameField = document.createElement('label');
    private readonly nameLabel = document.createElement('span');
    private readonly provider = document.createElement('select');
    private readonly providerField = document.createElement('label');
    private readonly template;
    private readonly drawer;
    private readonly status = document.createElement('p');
    private readonly setupRoot = document.createElement('section');
    private readonly setupStatus = document.createElement('p');
    private setup?: { flush(): Promise<void>; dispose(): void | Promise<void> };
    private stopOverlays?: () => void;
    private readonly cancel = document.createElement('button');
    private readonly back = document.createElement('button');
    private readonly submit = document.createElement('button');
    private readonly operationId = randomUUID();
    private readonly drafts = new Map<ToolboxKind, { name: string; drawer: string }>();
    private path = '';
    private busy = false;
    private done: (path: string) => void = () => {};
    constructor(private readonly options: Options) {
        this.kind = options.initialKind ?? (options.kinds.length === 1 ? options.kinds[0] : undefined);
        this.template = providerTemplateFields(options.templates, options.initialName, options.providers);
        this.drawer = drawerField(options.drawers);
        this.build(); this.update();
    }
    show(): Promise<string> {
        if (this.options.signal.aborted) return Promise.resolve('');
        return new Promise(resolve => {
            this.done = resolve; this.options.signal.addEventListener('abort', this.close, { once: true });
            document.body.append(this.dialog); this.dialog.showModal();
            this.focus();
        });
    }
    private build(): void {
        this.dialog.className = 'project-dialog toolbox-create';
        this.fields.className = 'toolbox-create__fields';
        this.name.name = 'resourceName'; this.name.required = true; this.name.value = this.options.initialName ?? '';
        this.nameField.append(this.nameLabel, this.name);
        this.provider.name = 'providerId'; this.provider.required = true;
        this.provider.append(new Option(t('toolbox.chooseProvider'), ''), ...this.options.providers.map(item => new Option(item.name, item.id)));
        this.provider.value = this.options.providerId ?? (this.options.providers.length === 1 ? this.options.providers[0].id : '');
        this.providerField.textContent = t('toolbox.providerType'); this.providerField.append(this.provider);
        const providerHelp = document.createElement('small'); providerHelp.textContent = t(this.options.providers.length ? 'toolbox.connectionHelp' : 'toolbox.connectionNeedsProvider');
        this.providerField.append(providerHelp);
        this.fields.append(this.template.field, this.providerField, this.nameField, this.drawer.field);
        this.buildChoices();
        this.buildActions(); this.setupRoot.hidden = this.setupStatus.hidden = true; this.setupStatus.setAttribute('role', 'alert');
        this.dialog.append(this.heading, this.form, this.setupRoot, this.setupStatus);
        this.bind();
    }
    private bind(): void {
        this.form.onsubmit = event => { event.preventDefault(); void this.save(); };
        this.form.addEventListener('invalid', event => {
            const control = event.target as HTMLInputElement | HTMLSelectElement;
            log.warn('toolbox.resource.create.invalid', { operation: 'toolbox.resource.create', operationId: this.operationId,
                stage: 'validation', outcome: 'failure', code: 'RESOURCE_FIELD_INVALID', field: control.name, durationMs: 0 });
        }, true);
        this.dialog.oncancel = event => {
            event.preventDefault();
            const nested = this.dialog.querySelector<HTMLButtonElement>('.settings-modal-overlay .settings-modal-cancel');
            if (nested) { nested.click(); return; }
            if (!this.busy) { if (this.setup) void this.finish(); else this.close(); }
        };
    }
    private buildActions(): void {
        this.status.setAttribute('role', 'alert');
        const actions = document.createElement('div'); actions.className = 'project-dialog__actions';
        this.back.type = 'button'; this.back.className = 'toolbox-create__back'; this.back.textContent = t('toolbox.backToTypes');
        this.back.onclick = () => {
            this.drafts.set(this.kind!, { name: this.name.value, drawer: this.drawer.input.value });
            this.kind = undefined; this.update(); this.focus();
        };
        this.cancel.type = 'button'; this.cancel.textContent = t('project.cancel'); this.cancel.onclick = this.close;
        this.submit.type = 'submit'; actions.append(this.back, this.cancel, this.submit);
        this.form.append(this.choices, this.fields, this.status, actions);
    }
    private buildChoices(): void {
        this.choices.className = 'toolbox-create__choices';
        const hint = document.createElement('p'); hint.textContent = t('toolbox.chooseType'); this.choices.append(hint);
        for (const kind of this.options.kinds) {
            const button = document.createElement('button'); button.type = 'button'; button.dataset.createKind = kind;
            button.className = 'toolbox-create__choice';
            const icon = document.createElement('span'); icon.innerHTML = resourceIcon(kind); icon.setAttribute('aria-hidden', 'true');
            button.append(icon, document.createTextNode(t(kind === 'providers' ? 'toolbox.providerType' : kind === 'connections' ? 'toolbox.connectionType' : `toolbox.${kind}`)));
            button.onclick = () => {
                this.kind = kind; this.name.value = this.drafts.get(kind)?.name ?? this.options.initialName ?? '';
                this.update();
                this.focus();
            };
            this.choices.append(button);
        }
    }
    private focus(): void {
        if (!this.kind) this.choices.querySelector<HTMLButtonElement>('button')?.focus();
        else if (this.kind === 'providers') this.template.focus();
        else if (this.kind === 'connections' && !this.provider.value) this.provider.focus();
        else this.name.focus();
    }
    private update(): void {
        const kind = this.kind;
        this.heading.textContent = kind ? t(kind === 'providers' ? 'toolbox.providerType' : kind === 'connections' ? 'toolbox.connectionType' : `toolbox.${kind}`) : t('toolbox.create');
        this.dialog.setAttribute('aria-label', this.heading.textContent);
        this.choices.hidden = !!kind; this.fields.hidden = !kind; this.fields.disabled = !kind;
        this.back.hidden = !kind || this.options.kinds.length === 1; this.submit.hidden = !kind;
        this.template.setVisible(kind === 'providers');
        this.providerField.hidden = kind !== 'connections'; this.provider.disabled = kind !== 'connections';
        this.nameField.hidden = !kind || kind === 'providers'; this.name.disabled = !kind || kind === 'providers';
        this.nameLabel.textContent = t('toolbox.name');
        this.drawer.field.hidden = !kind || !drawerKind(kind); this.drawer.input.disabled = !kind || !drawerKind(kind);
        if (kind && drawerKind(kind)) this.drawer.update(kind, this.drafts.get(kind)?.drawer ?? (this.options.drawer?.kind === kind ? this.options.drawer.name : ''));
        this.submit.textContent = t(kind === 'providers' ? 'toolbox.addAndConfigure' : 'project.createConfirm');
        this.submit.disabled = !kind || kind === 'connections' && !this.options.providers.length;
        this.status.textContent = '';
    }
    private draft(): ToolboxCreationDraft {
        return { kind: this.kind!, name: this.kind === 'providers' ? this.template.providerName() : this.name.value.trim(), drawer: this.drawer.input.value,
            providerId: this.kind === 'connections' ? this.provider.value : undefined,
            providerTemplateId: this.kind === 'providers' ? this.template.templateId() : undefined };
    }
    private async save(): Promise<void> {
        if (this.busy || this.submit.disabled || !this.form.reportValidity()) return;
        if (this.kind === 'providers' && !this.template.validate()) return;
        const started = performance.now(); let stage = this.path ? 'navigation' : 'persistence';
        this.busy = true; this.fields.disabled = true; this.submit.disabled = this.cancel.disabled = this.back.disabled = true;
        const context = { operation: 'toolbox.resource.create', operationId: this.operationId, kind: this.kind };
        log.info('toolbox.resource.create.started', { ...context, stage });
        try {
            if (!this.path) this.path = await this.options.save(this.draft());
            stage = this.options.configure && ['providers', 'connections'].includes(this.kind!) ? 'configuration' : 'navigation';
            if (!this.options.signal.aborted) {
                if (stage === 'configuration') await this.configure();
                else { await this.options.open(this.path); this.close(); }
            }
            log.info('toolbox.resource.create.completed', { ...context, stage, outcome: 'success', durationMs: Math.round(performance.now() - started) });
        } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_:-]{1,80}$/.test(error.code) ? error.code : undefined;
            log.error('toolbox.resource.create.failed', { ...context, stage, outcome: 'failure', code: code ?? (stage === 'persistence' ? 'RESOURCE_SAVE_FAILED' : 'RESOURCE_OPEN_FAILED'), errorType: error instanceof Error ? error.name : typeof error, durationMs: Math.round(performance.now() - started) });
            this.status.textContent = (this.path ? t('toolbox.createdOpenFailed') + ' ' : '') + (error instanceof Error ? error.message : String(error));
            if (this.path) this.submit.textContent = t('toolbox.retryOpen');
        } finally {
            this.busy = false; this.fields.disabled = this.back.disabled = !!this.path; this.submit.disabled = this.cancel.disabled = false;
        }
    }
    private async configure(): Promise<void> {
        this.stopOverlays ??= mountDialogOverlays(this.dialog);
        const setup = await this.options.configure!(this.setupRoot, this.path, async discardResult => {
            if (discardResult) this.path = '';
            await this.finish();
        });
        if (this.options.signal.aborted) { await setup.dispose(); return; }
        this.setup = setup; this.setupRoot.hidden = false; this.heading.hidden = this.form.hidden = true;
        this.dialog.classList.remove('project-dialog'); this.dialog.classList.add('toolbox-create--setup', 'settings-root');
        this.dialog.setAttribute('aria-label', t('toolbox.setupTitle'));
    }
    private finish = async (): Promise<void> => {
        if (this.busy) return;
        const started = performance.now(); this.busy = true;
        try {
            await this.setup?.flush(); await this.options.completed?.();
            await this.setup?.dispose(); this.setup = undefined; this.close();
            log.info('toolbox.resource.configure.completed', { operation: 'toolbox.resource.configure', operationId: this.operationId,
                stage: 'completion', outcome: 'success', durationMs: Math.round(performance.now() - started) });
        } catch (error) {
            this.setupStatus.hidden = false;
            this.setupStatus.textContent = t('toolbox.setupFailed', { message: error instanceof Error ? error.message : String(error) });
            log.error('toolbox.resource.configure.failed', { operation: 'toolbox.resource.configure', operationId: this.operationId,
                stage: 'completion', outcome: 'failure', code: 'RESOURCE_CONFIGURE_INCOMPLETE', errorType: error instanceof Error ? error.name : typeof error, durationMs: Math.round(performance.now() - started) });
        } finally { this.busy = false; }
    };
    private close = (): void => {
        this.options.signal.removeEventListener('abort', this.close);
        this.stopOverlays?.(); this.stopOverlays = undefined;
        const setup = this.setup; this.setup = undefined;
        if (setup) void Promise.resolve(setup.dispose()).catch(error => log.error('toolbox.resource.configure.dispose', { operationId: this.operationId, code: 'RESOURCE_EDITOR_DISPOSE_FAILED', errorType: error instanceof Error ? error.name : typeof error }));
        this.dialog.close(); this.dialog.remove(); this.done(this.path);
    };
}

export function showToolboxCreationDialog(options: Options): Promise<string> { return new ToolboxCreationDialog(options).show(); }
