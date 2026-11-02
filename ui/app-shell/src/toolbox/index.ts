import {MCPDiagnosticsControls} from './mcp-diagnostics';
import { RemoteAgentDetailsEditor } from './RemoteAgentDetailsEditor';
import { CellsMCPControls } from './cells-controls';
import { MCPConfigurationControlsRegistry } from './mcp-controls';
import { CELLS_EXTENSION, cellsConfiguration } from '@itookit/app-contracts';
import type { ApplicationServices } from '@itookit/app-contracts/services';
import type { ToolboxResources } from '@itookit/app-contracts/services';
import type { NavigationRequest } from '@itookit/common';
import type { EditorFactory } from '@itookit/ui-common-adapter';
import type { AppUI } from '../types';
import type { VFSNodeUI, UIPersistencePort } from '@itookit/vfs-ui';
import type { ToolboxInventory } from '@itookit/app-contracts/services';
import { ToolboxWorkbench, type ToolboxPreferencesPort } from './ToolboxWorkbench';
import { ToolDetailsEditor } from './ToolDetailsEditor';
import { createWorkspaceModule, type WorkspaceModule } from '../workspaces/module';
import mediaProbeExamples from '../config/media-probe-examples.json';
import type { MediaProbeExamples } from '@itookit/kernel-adapters/contracts';

interface Options {
    backend: import('@itookit/app-contracts/services').ApplicationBackend;
    ocr?: import('../configuration/ocr-controls').OcrConfigurationControls;
    services: Pick<ApplicationServices, 'vfs' | 'agentService' | 'commandBus' | 'kernel' | 'flowEngine' | 'configuration' | 'projects'>;
    ui: Pick<AppUI, 'llmUiEditors' | 'createFlowContextMenu'>;
    sidebar: HTMLElement; editor: HTMLElement;
    factories: Record<'agents' | 'skills' | 'flows', EditorFactory>;
    navigate(request: NavigationRequest): Promise<void>; selected(path: string | null): void; onBeforeNavigate?(): void;
    uiPersistence?: UIPersistencePort;
    uiPreferences?: ToolboxPreferencesPort;
    executorUsage?: import('@itookit/ui-common-adapter').EditorOptions['executorUsage'];
    agentsInWorkbench?: boolean;
    workbenchState?: import('../workbench/state').WorkbenchStatePort;
    windows?: import('../workbench/windows').WorkbenchWindowBinding;
}
/** The toolbox owns its projection lifetime and editor wiring as one module. */
export async function createToolboxModule(options: Options): Promise<WorkspaceModule> {
    const { commandBus } = options.services;
    const view = await options.backend.toolboxView(), { inventory, resources, files } = view;
    try {
        const factories = configurationFactories(options, inventory, resources);
        const workbench = new ToolboxWorkbench({ ...options, inventory, resources, files, initial: view.initial, factories, configuration: options.services.configuration, projects: options.services.projects,
            flowMenu: options.ui.createFlowContextMenu<VFSNodeUI>({ commands: commandBus,
                navigate: id => options.navigate({ target: 'chat', resourceId: id }) }) });
        return createWorkspaceModule(workbench, async () => { try { await workbench.destroy(); } finally { await view.dispose(); } });
    } catch (error) { await view.dispose(); throw error; }
}
function configurationFactories(options: Options, inventory: ToolboxInventory, resources: ToolboxResources) {
    const { agentService } = options.services, editors = options.ui.llmUiEditors;
    const create = (Editor: new (element: HTMLElement, service: typeof agentService, options: import('@itookit/ui-common-adapter').EditorOptions, examples?: MediaProbeExamples) => import('@itookit/ui-common-adapter').IEditor, examples?: MediaProbeExamples): EditorFactory => async (element, config) => {
        const editor = new Editor(element, agentService, config, examples); await editor.init(element); return editor;
    };
    return { ...options.factories, agents: async (element: HTMLElement, config: import('@itookit/ui-common-adapter').EditorOptions) => {
        if (config.target?.kind === 'file' && config.target.path.startsWith('/@remote/')) {
            const editor = new RemoteAgentDetailsEditor(element, inventory, config, options.services.projects); await editor.init(element); return editor;
        }
        return options.factories.agents(element, config);
    }, prompts: create(editors.SystemPromptSettingsEditor), providers: create(editors.ProviderSettingsEditor, mediaProbeExamples), connections: create(editors.ConnectionSettingsEditor),
        mcp: async (element: HTMLElement, config: import('@itookit/ui-common-adapter').EditorOptions) => {
            const remote = options.services.projects?.remoteMounts;
            const controls = new MCPConfigurationControlsRegistry().register('diagnostics', new MCPDiagnosticsControls(options.backend.diagnostics, remote), () => true);
            if (remote) controls.register(CELLS_EXTENSION, new CellsMCPControls(remote, options.services.projects, options.backend.diagnostics), server => !!cellsConfiguration(server));
            const editor = new editors.MCPSettingsEditor(element, agentService, config, controls); await editor.init(element); return editor;
        }, tools: async (element: HTMLElement, config: import('@itookit/ui-common-adapter').EditorOptions) => {
            const editor = new ToolDetailsEditor(element, inventory, config, resources); await editor.init(element); return editor;
        } };
}
