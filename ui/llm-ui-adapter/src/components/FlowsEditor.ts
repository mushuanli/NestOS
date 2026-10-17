import { editorResourceId } from '@itookit/ui-common';
// @file: llm-ui/components/FlowsEditor.ts
// Standalone workflow workspace editor: a thin IEditor shell around DagWorkbench.
// Workflows are first-class resources (flows VFS module); running one creates a
// new chat session instance with the declared parameters filled in.

import { IEditor, type EditorFactory, type EditorOptions } from '@itookit/ui-common';
import { NAVIGATION_EVENTS } from '@itookit/common';
import { type FlowDraft } from '@itookit/llm-flow/contracts';
import { type ICommandBus } from '@itookit/llm-session/contracts';
import { FlowCommand } from '@itookit/llm-flow/contracts';
import { DagWorkbench } from './DagWorkbench';
import { FlowLauncher, flowIdFromNodeId } from '../flows/run-flow';
import { Toast } from '@itookit/ui-common';

export interface FlowsEditorDeps {
    commands: ICommandBus;
    /** Optional override for the run action (defaults to create-session + navigate). */
    onRunFlow?: (flowId: string, revision: number) => void;
    /** Global LLM connections available to bind flow-level connection slots to. */
    listConnections?: () => Promise<Array<{ id: string; name: string }>>;
    listAgents?: () => Promise<Array<{ id: string; name: string; description?: string }>>;
    listSystemPrompts?: () => Promise<Array<{ id: string; name: string; description?: string }>>;
    listTools?: () => Promise<Array<{ id: string; name: string; description?: string }>>;
    listSkills?: () => Promise<Array<{ id: string; name: string; description?: string }>>;
}

export class FlowsEditor extends IEditor {
    private workbench?: DagWorkbench;
    private container?: HTMLElement;
    private readonly launcher: FlowLauncher;

    constructor(
        private readonly deps: FlowsEditorDeps,
        private initialNodeId?: string,
    ) {
        super();
        this.launcher = new FlowLauncher({ commands: deps.commands, navigate: sessionId => {
            this.container?.dispatchEvent(new CustomEvent(NAVIGATION_EVENTS.NAVIGATE, {
                bubbles: true, composed: true, detail: { target: 'chat', resourceId: sessionId },
            }));
        } });
    }

    async init(container: HTMLElement, _initialContent?: string): Promise<void> {
        this.container = container;
        container.innerHTML = '';
        this.workbench = new DagWorkbench(container, {
            commands: this.deps.commands,
            onSelectFlow: (flowId, revision) => void this.handleRunFlow(flowId, revision),
            listConnections: this.deps.listConnections,
            listAgents: this.deps.listAgents,
            listSystemPrompts: this.deps.listSystemPrompts,
            listTools: this.deps.listTools,
            listSkills: this.deps.listSkills,
        });
        await this.workbench.initialize();
        // Open the sidebar-selected .flow file if any; otherwise stay on the empty
        // state. We deliberately do NOT auto-invoke pickFlow(): the VFS sidebar
        // re-mounts the editor on every selection/refresh, and auto-prompting
        // there re-opens the "Select Flow" dialog in a loop.
        const flowId = flowIdFromNodeId(this.initialNodeId);
        if (flowId) {
            try {
                const draft = await this.deps.commands.execute<FlowDraft | null>(FlowCommand.DraftLoad, { id: flowId, expandScopes: true });
                if (!draft) return;
                if (!draft.id) {
                    // Template file created via the VFS "+" button has an empty id;
                    // adopt it into a valid workflow (unique id + file rename).
                    const adopted = await this.deps.commands.execute<FlowDraft>(FlowCommand.DraftAdopt, {
                        nodeId: this.initialNodeId,
                        name: draft.name || flowId,
                    });
                    this.workbench.setDraft(adopted);
                } else {
                    this.workbench.setDraft(draft);
                }
            } catch { /* not a valid flow file — ignore */ }
        }
    }

    /** Publish → fill parameters → create a session instance → open it in chat. */
    private async handleRunFlow(flowId: string, revision: number): Promise<void> {
        if (this.deps.onRunFlow) {
            this.deps.onRunFlow(flowId, revision);
            return;
        }
        try { await this.launcher.run(flowId, revision); }
        catch (error) { Toast.error(String(error)); }
    }

    async destroy(): Promise<void> {
        this.workbench?.destroy();
        this.workbench = undefined;
    }

    // ── IEditor no-op surface (workflows are not text documents) ──────────
    getText(): string { return ''; }
    setText(_markdown: string): void {}
    updateNodeId = (newNodeId: string): void => { this.initialNodeId = newNodeId; };
    focus(): void {}
    getMode(): 'edit' | 'render' { return 'edit'; }
    async switchToMode(_mode: 'edit' | 'render'): Promise<void> {}
    setTitle(_title: string): void {}
    setReadOnly(_readOnly: boolean): void {}
    isDirty(): boolean { return false; }
    setDirty(_dirty: boolean): void {}
    readonly commands: Readonly<Record<string, Function>> = {};
    async navigateTo(): Promise<void> {}
    async search(): Promise<never[]> { return []; }
    gotoMatch(): void {}
    clearSearch(): void {}
    on(): () => void { return () => {}; }
}

export function createFlowsEditorFactory(deps: FlowsEditorDeps): EditorFactory {
    return async (container: HTMLElement, options?: EditorOptions) => {
        const editor = new FlowsEditor(deps, options ? editorResourceId(options) : undefined);
        await editor.init(container);
        return editor;
    };
}
