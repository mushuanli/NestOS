import type { ApplicationClient } from '@itookit/app-contracts/services';
import type { IFileSystem } from '@itookit/vfs-core';
import type { FlowDraft } from '@itookit/llm-flow/contracts';

export interface PreparedServices { fileSystems: Map<string, IFileSystem> }
export interface HostedApplicationClient extends ApplicationClient {
    prepared: PreparedServices;
    flowLibrary: FlowDraft[];
    fileTemplates: Readonly<Record<string, string>>;
}
