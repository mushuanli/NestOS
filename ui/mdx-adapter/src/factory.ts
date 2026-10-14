import { createMDxEditor as createEditor, defaultEditorFactory as createDefaultEditor, fileReference,
    type MDxEditor, type PluginConfig, type MDxEditorFactoryConfig } from '@itookit/mdxeditor';
import { t } from '@itookit/common';
import { editorFilePath, normalizeEditorOptions, type EditorOptions } from '@itookit/ui-common';
import { EngineMetadataStore } from './metadata-store';
import { createAssetProvider } from './assets';
import { createDocumentHost } from './document-host';
import { AssetManagerPlugin } from './asset-manager.plugin';

export interface MDxAdapterOptions extends EditorOptions { onSave?: (content: string) => Promise<void>; }
export type AdaptedMDxEditor = MDxEditor & { updateNodeId(path: string): void };

export function resolveDocumentFormat(options: EditorOptions): 'markdown' | 'text' {
    const path = editorFilePath(options);
    return options.contentFormat ?? (!path || /\.(md|markdown|mdx)$/i.test(path) ? 'markdown' : 'text');
}

function isPluginConfig(value: unknown): value is PluginConfig {
    if (typeof value === 'string') return true;
    if (Array.isArray(value)) return typeof value[0] === 'string';
    return typeof value === 'object' && value !== null && ('name' in value || 'install' in value);
}

function pluginDefaults(options: MDxAdapterOptions, path?: string): Record<string, Record<string, any> | undefined> {
    const defaults: Record<string, Record<string, any> | undefined> = {};
    for (const [key, value] of Object.entries(options.defaultPluginOptions ?? {})) {
        if (typeof value === 'object' && value !== null) defaults[key] = value as Record<string, any>;
    }
    const titlebar = (defaults['core:titlebar'] ?? {}) as Record<string, unknown>;
    defaults['core:titlebar'] = { ...titlebar,
        aiCallback: titlebar.aiCallback ?? (path && options.hostContext?.chatFromFile ? async (editor: MDxEditor) => {
            const reference = fileReference(editor); await editor.flushPendingSave();
            await options.hostContext!.chatFromFile!(reference);
        } : undefined),
        onSidebarToggle: titlebar.onSidebarToggle ?? (options.hostContext ? () => options.hostContext!.toggleSidebar() : undefined),
        saveCallback: async (editor: MDxEditor) => { await editor.save(); },
    };
    return defaults;
}

/** Validation happens before any editor DOM, asset access or save callback is constructed. */
export function adaptEditorOptions(options: MDxAdapterOptions): MDxEditorFactoryConfig {
    normalizeEditorOptions(options);
    let path = editorFilePath(options);
    const host = createDocumentHost(options);
    const rename = host.renameDocument;
    if (rename) host.renameDocument = async (current, title) => {
        const result = await rename(current, title); path = result.path; return result;
    };
    const defaults = pluginDefaults(options, path);
    const titlebar = defaults['core:titlebar']!;
    const assets = createAssetProvider(options.files?.fs, () => path, options.assets);
    const plugins = (options.plugins ?? []).filter(isPluginConfig);
    if (assets && titlebar.enableAssetManager !== false && !plugins.includes('-ui:asset-manager')) plugins.push(new AssetManagerPlugin(options.files?.fs, () => path, options.assets, defaults['ui:asset-manager']));
    return { signal: options.signal, documentPath: path, title: options.title, language: options.language,
        initialContent: options.initialContent, initialMode: options.initialMode, contentFormat: resolveDocumentFormat(options),
        onDocumentPathChange: next => { path = next; },
        readOnly: options.readOnly, plugins, defaultPluginOptions: defaults, host, assets, translate: key => t(key as Parameters<typeof t>[0]),
        onSave: options.onSave ?? (path && options.hostContext?.saveContent
            ? content => options.hostContext!.saveContent!(path!, content) : undefined),
        storeFactory: options.files && path ? plugin => new EngineMetadataStore(options.files!.fs, path!, plugin) : undefined,
    };
}

async function construct(container: HTMLElement, options: MDxAdapterOptions, standard: boolean): Promise<AdaptedMDxEditor> {
    const config = adaptEditorOptions(options);
    const editor = await (standard ? createDefaultEditor : createEditor)(container, config) as AdaptedMDxEditor;
    editor.updateNodeId = path => editor.updateDocumentPath(path);
    return editor;
}
export const createMDxEditor = (container: HTMLElement, options: MDxAdapterOptions = {}) => construct(container, options, false);
export const defaultEditorFactory = (container: HTMLElement, options: MDxAdapterOptions) => construct(container, options, true);
