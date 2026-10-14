import { InitialFilesSection, type InitialFilesPort } from './initial-files';
import { BaseSettingsEditor, type EditorOptions } from '@itookit/ui-common';
import { escapeHTML, t } from '@itookit/common';
import type { SettingsPort as SettingsService } from '@itookit/app-contracts/settings';
import { StorageOverviewSection } from './storage/StorageOverviewSection';
import { SnapshotSection } from './storage/SnapshotSection';
import { MigrationSection } from './storage/MigrationSection';
import { DangerZoneSection } from './storage/DangerZoneSection';

interface StorageSection { init(): void | Promise<void>; destroy?(): void | Promise<void>; }

/** Storage maintenance is separate from toolbox connection configuration. */
export class StorageSettingsEditor extends BaseSettingsEditor<SettingsService> {
    private sections: StorageSection[] = [];
    private initialization?: Promise<void>;
    private closed = false;
    constructor(container: HTMLElement, service: SettingsService, options: EditorOptions, private readonly initialFiles?: InitialFilesPort) {
        super(container, service, options);
    }
    async render(): Promise<void> {
        if (this.closed) return;
        return this.initialization ??= this.initializeSections();
    }
    private async initializeSections(): Promise<void> {
        this.container.innerHTML = `<div class="settings-page">
            <div class="settings-page__header"><div>
                <h2 class="settings-page__title">${escapeHTML(t('storage.title'))}</h2>
                <p class="settings-page__description">${escapeHTML(t('storage.description'))}</p>
            </div></div>
            <div data-storage-section="initial"></div>
            <div data-storage-section="overview"></div>
            <div data-storage-section="snapshot"></div>
            <div data-storage-section="migration"></div>
            <div data-storage-section="danger"></div>
        </div>`;
        const section = (name: string) => this.container.querySelector<HTMLElement>(`[data-storage-section="${name}"]`)!;
        this.sections = [new StorageOverviewSection(section('overview'), this.service), new SnapshotSection(section('snapshot'), this.service),
            new MigrationSection(section('migration'), this.service), new DangerZoneSection(section('danger'), this.service)];
        if (this.initialFiles) {
            const initial = new InitialFilesSection(this.initialFiles);
            this.sections.unshift({ init: () => initial.mount(section('initial')), destroy: () => initial.destroy() });
        }
        await Promise.all(this.sections.map(item => item.init()));

    }
    async destroy(): Promise<void> {
        this.closed = true;
        await this.initialization?.catch(() => {});
        await Promise.all(this.sections.map(section => section.destroy?.())); this.sections = [];
        await super.destroy();
    }
}
export default StorageSettingsEditor;
