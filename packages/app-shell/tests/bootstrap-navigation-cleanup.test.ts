// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NAVIGATION_EVENTS } from '@itookit/common';
import { OcrService, type ApplicationRuntime } from '@itookit/app-core';
import { themeService } from '../src/ThemeService';
import type { WorkspaceConfig } from '../src/types';

const visibility = vi.hoisted(() => vi.fn());

vi.mock('../src/ThemeService', () => ({
    themeService: { init: vi.fn(async () => {}), destroy: vi.fn(), setMode: vi.fn(async () => {}) },
    ThemeMode: undefined,
}));

vi.mock('@itookit/mdx-adapter', () => ({
    defaultEditorFactory: vi.fn(async () => ({ destroy: vi.fn(async () => {}) })),
}));

vi.mock('@itookit/kernel-adapters', () => ({
    createSessionSkillControls: vi.fn(() => ({})),
}));

vi.mock('@itookit/app-settings', () => ({
    createSettingsModule: vi.fn(async () => ({
        engine: {},
        service: { dispose: vi.fn() },
    })),
    createSettingsFactory: vi.fn(() => vi.fn(async () => ({ destroy: vi.fn(async () => {}) }))),
    SkillsEngine: class { dispose() {} },
}));

vi.mock('../src/core/Workbench', () => ({
    Workbench: class {
        setVisible = visibility;
        start = vi.fn(async () => {});
        destroy = vi.fn(async () => {});
        openFile = vi.fn(async () => {});
        createAndOpenFile = vi.fn(async () => 'new-id');
        getActiveFilePath = vi.fn(() => null);
        setNodeWaitingInput = vi.fn();
    },
}));

vi.mock('../src/projects/SessionWorkbench', () => ({
    SessionWorkbench: class {
        start = vi.fn(async () => {});
        destroy = vi.fn(async () => {});
        openResource = vi.fn(async () => {});
        createResource = vi.fn(async () => 'new-id');
        getActiveResourceId = vi.fn(() => null);
        setWaitingInput = vi.fn();
    },
}));

import { initApp } from '../src/bootstrap';

const workspace: WorkspaceConfig = {
    elementId: 'settings-workspace',
    workspaceName: 'settings',
    slug: 'settings',
    type: 'settings',
    title: 'Settings',
    supportedFileTypes: [],
    syncEnabled: false,
};

function makeRuntime(): ApplicationRuntime {
    return {
        vfs: { openFileSystem: vi.fn(async () => ({ driver: { exists: async () => false, createFile: vi.fn() } })) },
        llmDriver: {},
        agentService: { getConnections: vi.fn(async () => []), getSystemPrompt: async () => null, saveSystemPrompt: vi.fn() },
        sessionRepository: {},
        flowEngine: { engine: {} },
        sessionFiles: {},
        directoryMounts: {},
        projects: {},
        kernel: { kernel: {}, sessions: {} },
        sessionManager: { onGlobalEvent: vi.fn(() => () => {}) },
        commandBus: {},
        runCatalog: {},
        dispose: vi.fn(async () => {}),
    } as unknown as ApplicationRuntime;
}

afterEach(() => {
    document.body.innerHTML = '';
    window.location.hash = '';
    vi.restoreAllMocks();
});

describe('app-shell navigation listener cleanup', () => {
    it('does not handle navigation events after destroy()', async () => {
        const container = document.createElement('div');
        container.id = workspace.elementId;
        document.body.appendChild(container);

        const pushState = vi.spyOn(window.history, 'pushState');
        const handle = await initApp({
            runtime: makeRuntime(),
            workspaces: [workspace],
            ui: {
                createChatEditor: vi.fn(() => vi.fn(async () => ({ destroy: vi.fn(async () => {}) }))),
                createAgentEditor: vi.fn(() => vi.fn(async () => ({ destroy: vi.fn(async () => {}) }))),
                createFlowEditor: vi.fn(() => vi.fn(async () => ({ destroy: vi.fn(async () => {}) }))),
                createSkillEditor: vi.fn(() => vi.fn(async () => ({ destroy: vi.fn(async () => {}) }))),
                createAIContextMenu: vi.fn(() => ({})),
                createFlowContextMenu: vi.fn(() => ({})),
                llmUiEditors: {},
            },
        });

        document.dispatchEvent(new CustomEvent(NAVIGATION_EVENTS.NAVIGATE, {
            detail: { target: workspace.slug, resourceId: 'first', action: 'open' },
        }));
        await vi.waitFor(() => expect(pushState).toHaveBeenCalledTimes(1));

        await handle.destroy();

        document.dispatchEvent(new CustomEvent(NAVIGATION_EVENTS.NAVIGATE, {
            detail: { target: workspace.slug, resourceId: 'second', action: 'open' },
        }));
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(pushState).toHaveBeenCalledTimes(1);
    });
});

it('notifies cached workspaces when nav visibility changes', async () => {
    visibility.mockClear();
    const other = { ...workspace, elementId: 'other-workspace', slug: 'other' };
    document.body.innerHTML = '<div id="settings-workspace"></div><div id="other-workspace"></div>';
    const factory = () => vi.fn(async () => ({ destroy: vi.fn(async () => {}) }));
    const handle = await initApp({ runtime: makeRuntime(), workspaces: [workspace, other], defaultSlug: 'settings',
        ui: { createChatEditor: factory, createAgentEditor: factory, createFlowEditor: factory,
            createSkillEditor: factory, createAIContextMenu: () => ({}), createFlowContextMenu: () => ({}), llmUiEditors: {} } as any });
    try {
        await handle.navigate('other');
        expect(visibility).toHaveBeenCalledWith(false);
        visibility.mockClear();
        await handle.navigate('settings');
        expect(visibility.mock.calls).toEqual([[true], [false]]);
    } finally { await handle.destroy(); }
});

it('starts background services after a non-chat workspace is available', async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length; });
    const runtime = makeRuntime();
    runtime.startBackground = vi.fn();
    document.body.innerHTML = '<div id="settings-workspace"></div>';
    const factory = () => vi.fn(async () => ({ destroy: vi.fn(async () => {}) }));
    const handle = await initApp({ runtime, workspaces: [workspace], defaultSlug: 'settings',
        ui: { createChatEditor: factory, createAgentEditor: factory, createFlowEditor: factory,
            createSkillEditor: factory, createAIContextMenu: () => ({}), createFlowContextMenu: () => ({}), llmUiEditors: {} } as any });
    try {
        expect(runtime.startBackground).not.toHaveBeenCalled();
        callbacks.forEach(callback => callback(0));
        expect(runtime.startBackground).toHaveBeenCalledOnce();
    } finally { await handle.destroy(); vi.unstubAllGlobals(); }
});

it('prepares the theme while OCR loads and leaves an inactive workspace filesystem unopened', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ocr = vi.spyOn(OcrService.prototype, 'init').mockImplementation(async () => { await gate; });
    const runtime = makeRuntime();
    const inactive = { ...workspace, elementId: 'inactive-workspace', slug: 'inactive', type: 'twin' as const };
    document.body.innerHTML = '<div id="settings-workspace"></div><div id="inactive-workspace"></div>';
    const factory = () => vi.fn(async () => ({ destroy: vi.fn(async () => {}) }));
    vi.mocked(themeService.init).mockClear();
    const pending = initApp({ runtime, workspaces: [workspace, inactive], defaultSlug: 'settings',
        ui: { createChatEditor: factory, createAgentEditor: factory, createFlowEditor: factory,
            createSkillEditor: factory, createAIContextMenu: () => ({}), createFlowContextMenu: () => ({}), llmUiEditors: {} } as any });
    try {
        await vi.waitFor(() => expect(ocr).toHaveBeenCalled());
        expect(themeService.init).toHaveBeenCalled();
        expect(runtime.vfs.openFileSystem).not.toHaveBeenCalledWith('/home/admin');
        release();
        const handle = await pending;
        expect(runtime.vfs.openFileSystem).not.toHaveBeenCalledWith('/home/admin');
    } finally { release(); await pending.then(handle => handle.destroy()).catch(() => {}); }
});
