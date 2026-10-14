import * as TPL from './templates';

export type EditorTypeKey = 'standard' | 'agent' | 'flow';

export interface AppFileTypeConfig {
    id: string;
    label: string;
    extension: string;
    icon?: string;
    defaultFileName: string;
    defaultContent: string;
    editorType: EditorTypeKey;
    duplicateTransformer?: (content: string) => string | Promise<string>;
}

export const FILE_REGISTRY: Record<string, AppFileTypeConfig> = {
    markdown: {
        id: 'markdown',
        label: 'Note',
        extension: '.md',
        defaultFileName: 'Untitled.md',
        defaultContent: '',
        editorType: 'standard',
    },
    anki: {
        id: 'anki',
        label: 'Card',
        extension: '.anki',
        defaultFileName: 'New Card.anki',
        defaultContent: TPL.TPL_ANKI,
        editorType: 'standard',
    },
    agent: {
        id: 'agent',
        label: 'Agent',
        extension: '.agent',
        icon: '🤖',
        defaultFileName: 'New Assistant.agent',
        defaultContent: '',
        editorType: 'agent',
        duplicateTransformer: (content) => {
            try {
                const def = JSON.parse(content);
                def.id = '';
                def.name = `${def.name} (copy)`;
                return JSON.stringify(def, null, 2);
            } catch {
                return content;
            }
        },
    },
    flow: {
        id: 'flow',
        label: 'Workflow',
        extension: '.flow',
        icon: '🔀',
        defaultFileName: 'new-flow.flow',
        defaultContent: JSON.stringify({
            id: '',
            draftVersion: 1,
            name: 'New Workflow',
            nodes: [],
            edges: [],
            layout: {},
            parameters: [],
            updatedAt: 0,
        }),
        editorType: 'flow',
    },
    mind: {
        id: 'mind',
        label: 'Mind',
        extension: '.mind',
        defaultFileName: 'New Mind.md',
        defaultContent: TPL.TPL_MIND,
        editorType: 'standard',
    },
    project: {
        id: 'project',
        label: 'Project',
        extension: '.prj',
        defaultFileName: 'New Project.md',
        defaultContent: TPL.TPL_PROJECT,
        editorType: 'standard',
    },
    email: {
        id: 'email',
        label: 'Email',
        extension: '.email',
        defaultFileName: 'Draft.md',
        defaultContent: TPL.TPL_EMAIL,
        editorType: 'standard',
    },
    private: {
        id: 'private',
        label: 'Note',
        extension: '.private',
        defaultFileName: 'My Private Note.md',
        defaultContent: TPL.TPL_PRIVATE,
        editorType: 'standard',
    },
};
