import { OcrAccess } from './ocr-access';
import type { OcrService } from '@itookit/app-contracts/services';
import { escapeHTML, randomUUID, t, type NavigationRequest } from '@itookit/common';
import { type IAgentManagementService } from '@itookit/kernel-adapters/contracts';
import { Modal, Toast, renderOcrSettings, readOcrSettings, type OcrSettingsState, type EditorTarget, type OcrControls } from '@itookit/ui-common';

export interface OcrConfigurationControls extends OcrControls {
    dispose(): Promise<void>;
    deletionImpact(targets: readonly EditorTarget[]): Promise<string>;
}
export function createOcrControls(load: () => Promise<OcrService>, agents: IAgentManagementService,
    navigate: (request: NavigationRequest) => Promise<void>): OcrConfigurationControls {
    const resource = new OcrAccess(load, agents);
    let pending: Promise<boolean> | undefined;
    const configure = (): Promise<boolean> => pending ??= resource.get().then(service => showConfiguration(service, navigate)).finally(() => { pending = undefined; });
    return {
        configure, label: async () => (await resource.get()).label(),
        readSettings: async () => configurationState(await resource.get()),
        saveSettings: async value => { const service = await resource.get(); await service.save({ ...await service.readSettings(), ...value }); },
        openSettings: async target => openConfiguration(await resource.get(), navigate, target),
        subscribe: listener => resource.subscribe(listener),
        recognize: async (image, signal) => {
            signal?.throwIfAborted(); const service = await resource.get();
            const ready = await service.ready(); signal?.throwIfAborted();
            if (!ready && !await configure()) throw new Error(t('ocr.cancelled'));
            signal?.throwIfAborted(); return service.recognize(image, signal);
        },
        deletionImpact: async targets => deletionImpact(await resource.get(), agents, targets),
        dispose: () => resource.close(),
    };
}
async function deletionImpact(service: OcrService, agents: IAgentManagementService, targets: readonly EditorTarget[]): Promise<string> {
    const [settings, connections] = await Promise.all([service.readSettings(), agents.getConnections()]);
    const affected = targets.some(target => target.kind === 'entity' && (
        (target.entityType === 'system-prompt' && target.id === settings.systemPromptId)
        || (target.entityType === 'connection' && target.id === settings.connectionId)
        || (target.entityType === 'provider' && connections.some(c => c.id === settings.connectionId && c.providerId === target.id))));
    return affected ? t('ocr.deleteImpact') : '';
}
async function showConfiguration(service: OcrService,
    navigate: (request: NavigationRequest) => Promise<void>): Promise<boolean> {
    const id = 'ocr-' + randomUUID(), body = `<div id="${id}">${renderOcrSettings(await configurationState(service), id)}</div>`;
    return new Promise(resolve => {
        const modal = new Modal(t('ocr.configure'), body, {
            width: '560px', onCancel: () => resolve(false),
            onConfirm: async element => {
                await service.save({ ...await service.readSettings(), ...readOcrSettings(element) }); resolve(true);
            },
        });
        modal.show();
        const form = document.getElementById(id)!;
        form.addEventListener('click', event => {
            const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-ocr-open]');
            if (!button) return;
            modal.hide(); resolve(false);
            void openConfiguration(service, navigate, button.dataset.ocrOpen === 'prompt' ? 'prompt' : 'models')
                .catch(error => Toast.error(escapeHTML(String(error))));
        });
    });
}
async function configurationState(service: OcrService): Promise<OcrSettingsState> {
    await service.prepareConfiguration();
    const [settings, entries] = await Promise.all([service.readSettings(), service.connections()]);
    const value = { connectionId: settings.connectionId };
    const connections: OcrSettingsState['connections'] = [{ id: '', label: t('ocr.unconfigured') }, ...entries.map(item => ({
        id: item.connection.id, disabled: !item.available,
        label: [item.connection.name, item.modelId, item.tier && t(`ocr.tier.${item.tier}`), item.reason].filter(Boolean).join(' · '),
    }))];
    if (value.connectionId && !entries.some(item => item.connection.id === value.connectionId))
        connections.push({ id: value.connectionId, label: t('ocr.connectionMissing', { id: value.connectionId }), disabled: true });
    return { value, connections };
}
async function openConfiguration(service: OcrService, navigate: (request: NavigationRequest) => Promise<void>, target: 'models' | 'prompt'): Promise<void> {
    const resourceId = target === 'prompt' ? '/prompts/' + encodeURIComponent(await service.preparePromptEditor()) : '/connections';
    await navigate({ target: 'toolbox', resourceId });
}
