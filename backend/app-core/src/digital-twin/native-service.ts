import type { ProjectService } from '@itookit/app-contracts/services';
import type { IFileSystem } from '@itookit/vfs-core';
import type { Kernel } from '@itookit/durable-kernel';
import type { SessionRepository } from '@itookit/llm-session';
import type { ConnectionMeta, LLMProvider } from '@itookit/driver-llm/contracts';
import { sha256HexSync } from '@itookit/llm-context';
import { SessionLifecycleService } from '../session/session-lifecycle';
import { DigitalTwinService } from './service';
import { NestosTwinSourceReader } from './source-reader';
import { KernelTwinExtractor } from './extraction';

interface Models { getConnection(id: string): Promise<ConnectionMeta | undefined>; getProvider(id: string): LLMProvider | undefined; getDefaultConnection?(): Promise<ConnectionMeta | null>; }
/** The model destination binding excludes mutable accounting and all credentials. */
export function createNativeDigitalTwin(fs: IFileSystem, repository: SessionRepository, kernel: Kernel, models: Models, hostKind = 'local', projects?: ProjectService): DigitalTwinService {
    return new DigitalTwinService({ fs, scanHost: { kind: hostKind }, defaultConnection: async () => (await models.getDefaultConnection?.())?.id ?? '', reader: new NestosTwinSourceReader(fs, repository, projects), extractor: new KernelTwinExtractor(kernel),
        executionExists: async (sessionId, taskId) => {
            const task = await kernel.task(sessionId, taskId);
            return task.id === taskId && task.sessionId === sessionId;
        },
        deleteSession: id => new SessionLifecycleService({ repository, kernel }).deleteSession(id),
        connectionFingerprint: async id => {
            const connection = await models.getConnection(id);
            if (!connection?.enabled) throw new Error('TWIN_CONNECTION_UNAVAILABLE');
            const provider = models.getProvider(connection.providerId);
            if (!provider) throw new Error('TWIN_CONNECTION_UNAVAILABLE');
            return sha256HexSync(JSON.stringify({ connection: { id: connection.id, providerId: connection.providerId,
                model: connection.model, tiers: connection.tiers, protocol: connection.protocol },
                provider: { id: provider.id, implementation: provider.implementation, baseURL: provider.baseURL,
                    defaultProtocol: provider.defaultProtocol, defaultPath: provider.defaultPath, chatPath: provider.chatPath,
                    anthropicPath: provider.anthropicPath, responsesPath: provider.responsesPath, geminiPath: provider.geminiPath } }));
        } });
}
