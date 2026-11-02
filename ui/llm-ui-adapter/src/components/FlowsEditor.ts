import {type EditorOptions} from '../contracts';
import {createOperationLedger} from '@itookit/llm-ui';
import {persistOperations} from '../services/OperationPersistence';
import type {ISessionRepository} from '@itookit/llm-session/contracts';
import {editorResourceId} from '@itookit/ui-common-adapter';
// @file: llm-ui/components/FlowsEditor.ts
// Standalone workflow workspace editor: a thin IEditor shell around DagWorkbench.
// Workflows are first-class resources (flows VFS module); running one creates a
// new chat session instance with the declared parameters filled in.

import {IEditor, type EditorFactory} from '@itookit/ui-common-adapter';
import { NAVIGATION_EVENTS, randomUUID, t } from '@itookit/common';
import { type FlowDraft } from '@itookit/llm-flow/contracts';
import { type ICommandBus } from '@itookit/llm-session/contracts';
import { FlowCommand } from '@itookit/llm-flow/contracts';
import { DagWorkbench } from './DagWorkbench';
import { FlowLauncher, flowIdFromNodeId, type FlowRunInput } from '../flows/run-flow';

export interface FlowsEditorDeps {
    inspectDependencies?(flowId: string, signal: AbortSignal): Promise<void>;
    sessionRepository?: Pick<ISessionRepository, 'getManifest' | 'compareAndSetUIState'>;
    commands: ICommandBus;
    /** Optional override for the run action (defaults to create-session + navigate). */
    onRunFlow?: (flowId: string, revision: number, input?: FlowRunInput) => void | Promise<void>;
    /** Global LLM connections available to bind flow-level connection slots to. */
    listConnections?: () => Promise<Array<{ id: string; name: string }>>;
    listAgents?: () => Promise<Array<{ id: string; name: string; description?: string }>>;
    listSystemPrompts?: () => Promise<Array<{ id: string; name: string; description?: string }>>;
    listTools?: () => Promise<import('./dag/FlowSettingsDialog').EntityOption[]>;
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
            inspectDependencies: this.deps.inspectDependencies,
            operations: this.deps.sessionRepository ? async sessionId => {
                const repository = this.deps.sessionRepository!;
                const initial = await persistOperations(repository, sessionId, []);
                return createOperationLedger({initial, save: records => persistOperations(repository, sessionId, records)});
            } : undefined,
            onSelectFlow: (flowId, revision, input) => this.handleRunFlow(flowId, revision, input),
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
        if (flowId) await this.openInitialFlow(flowId);
    }

    private async openInitialFlow(flowId: string): Promise<void> {
        const operationId = randomUUID(), started = performance.now();
        let stage = 'draft.load';
        try {
            const draft = await this.deps.commands.execute<FlowDraft | null>(FlowCommand.DraftLoad, {id: flowId, expandScopes: true});
            if (!draft) throw Object.assign(new Error('Flow draft is unavailable'), {code: 'FLOW_DRAFT_NOT_FOUND'});
            stage = draft.id ? 'draft.render' : 'draft.adopt';
            const selected = draft.id ? draft : await this.deps.commands.execute<FlowDraft>(FlowCommand.DraftAdopt, {
                nodeId: this.initialNodeId, name: draft.name || flowId,
            });
            stage = 'draft.render'; this.workbench?.setDraft(selected);
            console.info('[FlowEditor]', {operation: 'open', operationId, stage, result: 'success', durationMs: performance.now() - started});
        } catch (error) {
            const supplied = (error as {code?: unknown})?.code;
            const code = typeof supplied === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(supplied) ? supplied
                : stage === 'draft.render' ? 'FLOW_EDITOR_RENDER_FAILED' : 'FLOW_EDITOR_LOAD_FAILED';
            console.error('[FlowEditor]', {operation: 'open', operationId, stage, result: 'failure', code,
                errorType: error instanceof Error ? error.name : 'Unknown', durationMs: performance.now() - started});
            const message = document.createElement('p'); message.className = 'dag-run-error'; message.setAttribute('role', 'alert');
            message.textContent = `${t('flow.editor.loadFailed')} · ${code} · ${operationId}`; this.container?.prepend(message);
        }
    }

    /** Use validated sidebar parameters to create a session and open it in chat. */
    private async handleRunFlow(flowId: string, revision: number, input?: FlowRunInput): Promise<void> {
        if (this.deps.onRunFlow) {
            await this.deps.onRunFlow(flowId, revision, input);
            return;
        }
        await this.launcher.run(flowId, revision, input);
    }

    cancelPendingRender(): void {this.workbench?.setVisible(false);}
    async activate(): Promise<void> {this.workbench?.setVisible(true);}

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
