import type {
    DurableTaskProgram,
    EffectAdapter,
    SessionStorageResolver,
    WorkspaceAdapter,
} from '../domain/types';

export interface KernelRegistration {
    registerProgram(program: DurableTaskProgram): void;
    registerResourceAdapter(adapter: import('../domain/resource-api').ManagedResourceAdapter): void;
    registerEffect(adapter: EffectAdapter): void;
    registerStorageResolver(resolver: SessionStorageResolver): void;
    registerWorkspace(adapter: WorkspaceAdapter): void;
}

export interface KernelPlugin {
    readonly id: string;
    readonly version: string;
    install(registration: KernelRegistration): void | Promise<void>;
    onSessionClosed?(sessionId: string): void | Promise<void>;
}
