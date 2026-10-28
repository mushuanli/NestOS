import {getLocale} from '@itookit/common';
import {t, FEEDBACK_ICONS} from '@itookit/common';
import type {ConversationModelCatalog, ConversationModelSelection} from '@itookit/ui-common';
import {PopupPanel, type PopupItem} from '@itookit/llm-ui';

/** A native selection belongs to the next submission, independent of local connections. */
export class NativeModelControl {
    private readonly trigger = document.createElement('button');
    private readonly popup: PopupPanel;
    private catalog?: ConversationModelCatalog;
    private selected?: ConversationModelSelection;
    private generation = 0;
    private enabled = false;
    private binding?: string;
    constructor(container: HTMLElement, private readonly load: () => Promise<ConversationModelCatalog>, private readonly failed: (error: unknown) => void, private readonly changed?: (selection?: ConversationModelSelection) => void) {
        this.trigger.type = 'button'; this.trigger.className = 'llm-input__native-model';
        this.trigger.hidden = true; this.trigger.textContent = t('chatInput.nativeModels');
        container.querySelector('.llm-input__execution-source')!.before(this.trigger);
        this.popup = new PopupPanel(this.trigger, {locale: getLocale(), positionAnchor: this.trigger.closest<HTMLElement>('.llm-input') ?? undefined, showSearch: true, searchPlaceholder: t('chatInput.model'), emptyText: t('chatInput.noModels')});
        this.trigger.onclick = () => {if (this.popup.isVisible) this.popup.hide(); else void this.open();};
        this.trigger.onkeydown = event => {if (this.popup.isVisible) this.popup.handleKeyDown(event);};
    }
    setBinding(binding: string, enabled: boolean, selection?: ConversationModelSelection): void {
        const newBinding = this.binding !== binding;
        const newSelection = this.selected?.modelId !== selection?.modelId || this.selected?.reasoningEffort !== selection?.reasoningEffort;
        if (newBinding || newSelection) {
            this.binding = binding; this.hide();
            if (newBinding) this.catalog = undefined;
            this.selected = selection ? {modelId: selection.modelId, ...(selection.reasoningEffort ? {reasoningEffort: selection.reasoningEffort} : {})} : undefined;
            this.updateLabel();
        }
        this.setAvailable(enabled);
    }
    setAvailable(enabled: boolean): void {
        this.enabled = enabled; this.trigger.hidden = !enabled;
        if (!enabled) {++this.generation; this.popup.hide(); this.trigger.disabled = false;}
    }
    selection(): ConversationModelSelection | undefined {return this.selected ? {...this.selected} : undefined;}
    private async open(): Promise<void> {
        const generation = ++this.generation; this.trigger.disabled = true;
        try {
            const catalog = await this.load();
            if (generation !== this.generation || !this.enabled) return;
            this.catalog = catalog; this.updateLabel();
            this.popup.show(this.items(catalog), {onSelect: item => this.choose(item.id)});
        } catch (error) {if (generation === this.generation) this.failed(error);}
        finally {if (generation === this.generation) this.trigger.disabled = false;}
    }
    private items(catalog: ConversationModelCatalog): PopupItem[] {
        const current = this.selected ?? catalog.current ?? catalog.default;
        const model = catalog.models.find(row => row.id === current?.modelId);
        return [{id: 'default', label: t('harness.followNativeSettings')},
            ...(model?.reasoningEfforts.length ? [{id: 'auto-effort', label: t('chatSettings.followDefault'), group: t('harness.reasoning')},
                ...model.reasoningEfforts.map(effort => ({id: 'effort:' + effort.id, label: effort.label, group: t('harness.reasoning'), icon: effort.id === current?.reasoningEffort ? FEEDBACK_ICONS.success : undefined}))] : []),
            ...catalog.models.map(row => ({id: 'model:' + row.id, label: row.label, group: t('chatInput.model'), icon: row.id === current?.modelId ? FEEDBACK_ICONS.success : undefined}))];
    }
    private choose(id: string): void {
        if (id === 'default') this.selected = undefined;
        else if (id.startsWith('model:')) this.selected = {modelId: id.slice(6)};
        else {
            const modelId = (this.selected ?? this.catalog?.current ?? this.catalog?.default)?.modelId;
            if (!modelId) return;
            this.selected = {modelId, ...(id === 'auto-effort' ? {} : {reasoningEffort: id.slice(7)})};
        }
        this.changed?.(this.selection()); this.updateLabel();
    }
    private updateLabel(): void {
        const current = this.selected ?? this.catalog?.current ?? this.catalog?.default;
        const model = this.catalog?.models.find(row => row.id === current?.modelId);
        this.trigger.textContent = model ? [model.label, current?.reasoningEffort].filter(Boolean).join(' · ') : this.selected?.modelId ?? t('chatInput.nativeModels');
        this.trigger.title = `${t('chatInput.model')}: ${this.trigger.textContent}`;
    }
    hide(): void {++this.generation; this.popup.hide(); this.trigger.disabled = false;}
    destroy(): void {++this.generation; this.enabled = false; this.popup.destroy(); this.trigger.remove();}
}
