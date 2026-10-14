import type {
    DurableTaskProgram,
    EffectAdapter,
    SessionStorageResolver,
    WorkspaceAdapter,
} from '../domain/types';

export class ProgramRegistry {
    private readonly values = new Map<string, DurableTaskProgram>();

    register(program: DurableTaskProgram): void {
        const key = versioned(program.manifest.kind, program.manifest.version);
        if (this.values.has(key)) throw new Error(`Task program already registered: ${key}`);
        this.values.set(key, program);
    }

    has(kind: string, version: string): boolean {
        return this.values.has(versioned(kind, version));
    }

    resolve(kind: string, version: string): DurableTaskProgram {
        const key = versioned(kind, version);
        const program = this.values.get(key);
        if (!program) throw new Error(`Task program is not registered: ${key}`);
        return program;
    }
}

export class EffectRegistry {
    private readonly values = new Map<string, EffectAdapter>();

    register(adapter: EffectAdapter): void {
        const key = versioned(adapter.kind, adapter.version);
        if (this.values.has(key)) throw new Error(`Effect adapter already registered: ${key}`);
        this.values.set(key, adapter);
    }

    has(kind: string, version: string): boolean { return this.values.has(versioned(kind, version)); }

    resolve(kind: string, version: string): EffectAdapter {
        const key = versioned(kind, version);
        const adapter = this.values.get(key);
        if (!adapter) throw new Error(`Effect adapter is not registered: ${key}`);
        return adapter;
    }
}

export class StorageResolverRegistry {
    private readonly values = new Map<string, SessionStorageResolver>();

    register(resolver: SessionStorageResolver): void {
        if (this.values.has(resolver.kind)) throw new Error(`Storage resolver already registered: ${resolver.kind}`);
        this.values.set(resolver.kind, resolver);
    }

    resolve(kind: string): SessionStorageResolver {
        const resolver = this.values.get(kind);
        if (!resolver) throw new Error(`Storage resolver is not registered: ${kind}`);
        return resolver;
    }
}

export class WorkspaceRegistry {
    private readonly values = new Map<string, WorkspaceAdapter>();

    register(adapter: WorkspaceAdapter): void {
        const key = versioned(adapter.kind, adapter.version);
        if (this.values.has(key)) throw new Error(`Workspace adapter already registered: ${key}`);
        this.values.set(key, adapter);
    }

    resolve(kind: string, version: string): WorkspaceAdapter {
        const key = versioned(kind, version);
        const adapter = this.values.get(key);
        if (!adapter) throw new Error(`Workspace adapter is not registered: ${key}`);
        return adapter;
    }
}

function versioned(kind: string, version: string): string { return `${kind}@${version}`; }
