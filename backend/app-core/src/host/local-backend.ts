import { withConfigurationImport } from '../configuration/configuration-import';
import { harnessObservation, conversationBranches } from '@itookit/piagent-driver';
import { SettingsService } from '../settings/SettingsService';
import { OcrService } from '../configuration/ocr-service';
import { MindosInitialFiles } from '../presets/initial-files';
import { PrivilegedCommandService } from '../kernel/privileged-command-service';
import { createSessionSkillControls } from '@itookit/kernel-adapters';
import { ProjectSessions } from '../projects/project-sessions';
import { createSessionBrowser, taskSummary, taskKeyEvent } from '../session/session-browser';
import { SessionLifecycleService } from '../session/session-lifecycle';
import { ProjectSearch } from '../projects/project-search';
import { WorkbenchArchiveExporter } from '../projects/workbench-archive';
import { WorkbenchArchiveImporter } from '../projects/workbench-import';
import { exportSessionBundle } from '../session/session-bundle';
import { exportRemoteSession } from '../session/remote-session-export';
import { resolveProjectFavorite } from '../projects/favorites/routes';
import { manageRemoteSession } from '../session/remote-session-management';
import { remoteSessionSources } from '../session/remote-session-sources';
import { taskStat } from '@itookit/durable-kernel';
import { ToolboxInventory } from '../configuration/toolbox-catalog';
import { ToolboxResources } from '../configuration/toolbox-resources';
import { listRemoteHarnessAgents } from '../projects/remote-agent-catalog';
import type { LocalBackendPort, LocalBackendOptions } from '@itookit/app-contracts/services';
import type { LocalApplicationServices } from '../contracts/application-services';
import type { ApplicationRuntime } from '../runtime/create-application-runtime';

/** Only the host owns dispose(), recovery and client execution contexts. */
export function bindLocalApplicationServices(runtime: ApplicationRuntime): LocalApplicationServices {
    const { vfs, llmDriver, agentService, configuration, sessionRepository, flowEngine, sessionFiles,
        directoryMounts, projects, projectSync, digitalTwin, kernel, sessionManager, commandBus } = runtime;
    return { vfs, llmDriver, agentService, configuration, sessionRepository, flowEngine, sessionFiles,
        directoryMounts, projects, projectSync, digitalTwin, kernel, sessionManager, commandBus,
        prepareSession: runtime.prepareSession?.bind(runtime), startBackground: runtime.startBackground?.bind(runtime) };
}

/** Backend assembly belongs to the host; closing a view never owns the runtime. */
export function createLocalBackendPort(options: LocalBackendOptions = {}): LocalBackendPort {
    return {
        configurationService: withConfigurationImport, harnessObservation, conversationBranches,
        settings: (vfs, sources) => new SettingsService(vfs, undefined, sources, options.snapshots?.(vfs)),
        ocr: (...args) => new OcrService(...args), initialFiles: (...args) => new MindosInitialFiles(...args),
        privilegedCommands: (...args) => new PrivilegedCommandService(...args), sessionSkills: createSessionSkillControls,
        projectSessions: (...args) => new ProjectSessions(...args), sessionBrowser: createSessionBrowser,
        sessionLifecycle: (...args) => new SessionLifecycleService(...args), projectSearch: (...args) => new ProjectSearch(...args),
        archiveExporter: (...args) => new WorkbenchArchiveExporter(...args), archiveImporter: (...args) => new WorkbenchArchiveImporter(...args),
        exportSession: exportSessionBundle, exportRemoteSession, resolveFavorite: resolveProjectFavorite,
        manageRemoteSession, remoteSessionSources, taskStat, taskSummary, taskKeyEvent,
        toolboxInventory: (...args) => new ToolboxInventory(...args), toolboxResources: (...args) => new ToolboxResources(...args),
        remoteHarnessAgents: listRemoteHarnessAgents,
    };
}
