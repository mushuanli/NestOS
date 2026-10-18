import { sha256HexSync } from '@itookit/common';
import type { ApplicationBackend } from '@itookit/app-contracts/services';

/** Per-agent host launch preferences, shared by browser and desktop clients. */
export class AgentProjectPreferences {
    constructor(private readonly backend: Pick<ApplicationBackend, 'readUiDocuments' | 'writeUiDocuments'>) {}
    private key(agentId: string): string { return 'mindos_agent_project_' + sha256HexSync(agentId); }
    async read(agentId: string): Promise<string | undefined> {
        const key = this.key(agentId), value = (await this.backend.readUiDocuments([key]))[key] as {projectId?: unknown} | undefined;
        return typeof value?.projectId === 'string' && value.projectId ? value.projectId : undefined;
    }
    async save(agentId: string, projectId?: string): Promise<void> {
        await this.backend.writeUiDocuments({[this.key(agentId)]: {projectId: projectId ?? null}});
    }
}
