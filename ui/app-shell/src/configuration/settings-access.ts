import { createSettingsFactory, createSettingsNavigation } from '@itookit/app-settings';
import type { SettingsFactoryOptions } from '@itookit/app-settings';
import type { ApplicationBackend } from '@itookit/app-contracts/services';
import type { SettingsWorkspaceSource } from '@itookit/app-contracts/settings';
import type { EditorFactory } from '@itookit/ui-common';
import type { IFileSystem } from '@itookit/vfs-core';
import type { WorkspaceConfig } from '../types';
import { traceBoot } from '@itookit/common';
import { lazyResource } from '../lifecycle/lazy-resource';
import mediaProbeExamples from '../config/media-probe-examples.json';

type Options = Omit<SettingsFactoryOptions, 'settingsService' | 'initialFiles'> & { excludedPages?: readonly string[] };
interface SettingsAccess { factory: EditorFactory; files(): IFileSystem; close(): Promise<void> }
/** Navigation is local; settings data and recovery capabilities load on first use. */
export function createSettingsAccess(backend: ApplicationBackend, workspaces: () => readonly WorkspaceConfig[], options: Options): SettingsAccess {
    const service = lazyResource(() => traceBoot('settings.service', () => backend.settings(settingsSources(workspaces()))), value => value.dispose());
    const initial = lazyResource(() => backend.initialFiles(), () => {});
    let navigation: ReturnType<typeof createSettingsNavigation> | undefined, editor: EditorFactory | undefined;
    const factory: EditorFactory = async (element, config) => {
        const ready = await service.get();
        editor ??= createSettingsFactory({ ...options, mediaProbeExamples: options.mediaProbeExamples ?? mediaProbeExamples, settingsService: ready, initialFiles: {
            list: async () => (await initial.get()).list(), restore: async ids => (await initial.get()).restore(ids),
        } });
        return editor(element, config);
    };
    return { factory, files: () => navigation ??= createSettingsNavigation({ excludedPages: options.excludedPages }),
        close: async () => { await Promise.all([service.close(), initial.close()]); } };
}
function settingsSources(workspaces: readonly WorkspaceConfig[]): SettingsWorkspaceSource[] {
    return workspaces.filter(workspace => !['settings', 'skills', 'toolbox', 'twin'].includes(workspace.type ?? ''))
        .map(workspace => ({ name: workspace.workspaceName, description: workspace.title,
            ...(workspace.files ? { fs: workspace.files.fs } : { workspace: workspace.workspaceName }) }));
}
