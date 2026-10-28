/**
 * @file ui/app-shell/src/workspaces/index.ts
 *
 * Pre-defined workspace configs shared across all apps.
 * Import whichever you need and spread-override any field that differs.
 *
 * @example
 *   import { WS_CHAT, WS_AGENTS } from '@itookit/app-shell';
 *   const WORKSPACES = [
 *     WS_CHAT,
 *     { ...WS_AGENTS, mentionScope: ['agents', 'notes'] },
 *   ];
 */

import type { WorkspaceConfig } from '../types';

export const WS_SETTINGS: WorkspaceConfig = {
    elementId: 'settings-workspace',
    workspaceName: 'settings_root',
    slug: 'settings',
    type: 'settings',
    title: 'Settings',
    supportedFileTypes: [],
    syncEnabled: false,
    readOnly: true,
    aiEnabled: false,
    mentionAble: false,
};

export const WS_CHAT: WorkspaceConfig = {
    elementId: 'llm-workspace',
    workspaceName: 'chats',
    slug: 'chat',
    type: 'chat',
    title: 'AI Sessions',
    supportedFileTypes: [],
    syncEnabled: true,
    mentionScope: ['*'],
    mentionAble: true,
    plugins: [],
    aiEnabled: false,
};

export const WS_AGENTS: WorkspaceConfig = {
    elementId: 'agent-workspace',
    workspaceName: 'agents',
    slug: 'agents',
    type: 'agent',
    title: 'Agents',
    supportedFileTypes: ['agent'],
    syncEnabled: true,
    isSystem: true,
    plugins: ['core:titlebar'],
    // Conservative default — apps extend with their reachable modules
    mentionScope: ['agents'],
    mentionAble: false,
    aiEnabled: false,
};

export const WS_NOTES: WorkspaceConfig = {
    elementId: 'notes-workspace',
    workspaceName: 'notes',
    slug: 'notes',
    type: 'standard',
    title: 'Notes',
    supportedFileTypes: ['mind'],
    syncEnabled: true,
    mentionAble: true,
    aiEnabled: true,
};

export const WS_PROJECTS: WorkspaceConfig = {
    elementId: 'project-workspace',
    workspaceName: 'projects',
    slug: 'projects',
    type: 'standard',
    title: 'Projects',
    supportedFileTypes: ['project'],
    syncEnabled: true,
    mentionAble: true,
    aiEnabled: true,
};

export const WS_EMAILS: WorkspaceConfig = {
    elementId: 'email-workspace',
    workspaceName: 'emails',
    slug: 'emails',
    type: 'standard',
    title: 'Email Drafts',
    supportedFileTypes: ['email'],
    syncEnabled: true,
    mentionAble: true,
    aiEnabled: true,
};

/** Skills workspace — VFSUIShell list backed by SkillsEngine + SkillSettingsEditor (form-only). */
export const WS_SKILLS: WorkspaceConfig = {
    elementId:        'skills-workspace',
    workspaceName:       'skills',
    slug:             'skills',
    type:             'skills',   // handled by SkillsWorkspaceStrategy in bootstrap.ts
    title:            'Skills',
    supportedFileTypes: [],
    syncEnabled:      false,
    readOnly:         false,
    mentionAble:      false,
    aiEnabled:        false,
};

/** Workflows workspace — standalone FlowsEditor (design surface) backed by the flows VFS module. */
export const WS_FLOWS: WorkspaceConfig = {
    elementId:        'flows-workspace',
    workspaceName:       'flows',
    slug:             'flows',
    type:             'flows',   // handled by FactoryWorkspaceStrategy (flowsFactory + FlowEngine)
    title:            'Workflows',
    supportedFileTypes: ['flow'],
    syncEnabled:      false,
    // Editable sidebar: list / rename / delete .flow files. The FlowsEditor
    // "New Flow" button creates a workflow with a valid id (vs. the VFS "+"
    // button which creates a template file with an empty id).
    readOnly:         false,
    mentionAble:      false,
    aiEnabled:        false,
};

export const WS_PRIVATE: WorkspaceConfig = {
    elementId: 'private-workspace',
    workspaceName: 'private',
    slug: 'private',
    type: 'standard',
    title: 'Private Notes',
    supportedFileTypes: ['private'],
    syncEnabled: false,
    isProtected: true,
    mentionScope: [],
    mentionAble: true,
    aiEnabled: true,
};

/**
 * Local filesystem workspace — primary entry point for desktop apps.
 * Backend wiring (LocalFSBackend, driver) is the app's responsibility.
 */
export const WS_HOME: WorkspaceConfig = {
    elementId: 'home-workspace',
    workspaceName: 'home',
    slug: 'files',
    type: 'standard',
    title: 'Files',
    supportedFileTypes: ['markdown', 'mind', 'project', 'email', 'private'],
    syncEnabled: false,
    mentionAble: true,
    aiEnabled: true,
    showFileExtensions: true,   // external FS: show full filenames with extensions
};

/**
 * Factory for dynamically-mounted local directory workspaces.
 * Each mount gets a unique id (e.g. 'mnt_1234567890') and its own VFS module.
 * Backend wiring is the caller's responsibility.
 */
export function createWsMount(id: string, label: string, files: import('@itookit/vfs-core').FileSystemContext): WorkspaceConfig {
    return {
        files,
        elementId: `${id}-workspace`,
        workspaceName: id,
        slug: id,
        type: 'standard',
        title: label,
        supportedFileTypes: ['markdown'],
        syncEnabled: false,
        mentionAble: false,
        aiEnabled: true,
        showFileExtensions: true,   // external FS mount: show full filenames with extensions
    };
}

/** Shared management surface for reusable AI resources and their capability sources. */
export const WS_TOOLBOX: WorkspaceConfig = {
    elementId: 'toolbox-workspace', workspaceName: 'toolbox', slug: 'toolbox', type: 'toolbox',
    title: 'Toolbox', supportedFileTypes: [], syncEnabled: false, readOnly: false, mentionAble: false, aiEnabled: false,
};

/** User-owned personal context management. */
export const WS_TWIN: WorkspaceConfig = {
    elementId: 'twin-workspace', workspaceName: 'digital-twin', slug: 'twin', type: 'twin',
    title: 'Digital twin', supportedFileTypes: [], syncEnabled: false, readOnly: false, mentionAble: false, aiEnabled: false,
};
