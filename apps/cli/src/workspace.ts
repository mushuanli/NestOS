import { realpath, readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ToolVFSContext } from '@itookit/tools/contracts';
import { buildTool } from '@itookit/tools';
import { z } from 'zod/v4';
import type { WorkspaceAccess, WorkspaceGrant } from './types';

export class WorkspaceGrantRegistry {
    private readonly values = new Map<string, WorkspaceGrant>();
    private onGrant?: (grant: WorkspaceGrant) => Promise<void>;

    constructor(
        readonly workspaceRoot: string,
        readonly stateDir: string,
        initial: WorkspaceGrant[] = [],
        private readonly onChange?: (grants: WorkspaceGrant[]) => Promise<void>,
        private readonly readOnly = false,
    ) {
        for (const grant of initial) this.values.set(grant.id, readOnly ? { ...grant, access: 'read' } : grant);
    }

    list(): WorkspaceGrant[] {
        return [...this.values.values()];
    }

    /** Bridge an approved Agent grant into the Session VFS mount namespace. */
    setOnGrant(handler: (grant: WorkspaceGrant) => Promise<void>): void {
        this.onGrant = handler;
    }

    async grant(requestedPath: string, access: WorkspaceAccess): Promise<WorkspaceGrant> {
        if (this.readOnly && access === 'write') throw new Error('Read-only workspace cannot acquire writable mounts');
        const resolved = await realpath(path.resolve(this.workspaceRoot, requestedPath));
        const info = await stat(resolved);
        const directory = info.isDirectory() ? resolved : path.dirname(resolved);
        if (inside(this.stateDir, directory)) throw new Error('NestOS state directory cannot be granted');
        const existing = this.list().find(item => item.path === directory && covers(item.access, access));
        if (existing) return existing;
        const id = `grant-${this.values.size + 1}`;
        const grant: WorkspaceGrant = { id, path: directory, access, createdAt: Date.now() };
        this.values.set(id, grant);
        try {
            await this.onGrant?.(grant);
            await this.onChange?.(this.list());
        } catch (error) {
            this.values.delete(id);
            throw error;
        }
        return grant;
    }

    permits(candidate: string, access: WorkspaceAccess): boolean {
        if (this.readOnly && access === 'write') return false;
        if (inside(this.stateDir, candidate)) return false;
        if (inside(this.workspaceRoot, candidate)) return true;
        return this.list().some(grant => inside(grant.path, candidate) && covers(grant.access, access));
    }
}

export function createWorkspacePort(registry: WorkspaceGrantRegistry): ToolVFSContext {
    return {
        async readFile(filePath) {
            const resolved = await resolveExisting(registry, filePath, 'read');
            return readFile(resolved, 'utf8');
        },
        async writeFile(filePath, content) {
            const resolved = await resolveWritable(registry, filePath);
            await mkdir(path.dirname(resolved), { recursive: true });
            await writeFile(resolved, content, 'utf8');
        },
        async listFiles(dir = '.') {
            const root = await resolveExisting(registry, dir, 'read');
            const files: string[] = [];
            await walk(root, files, registry.stateDir);
            return files;
        },
    };
}

export function createWorkspaceAccessTool(registry: WorkspaceGrantRegistry) {
    const inputSchema = z.strictObject({
        path: z.string().describe('Host path to request access to'),
        access: z.enum(['read', 'write']).default('read'),
        reason: z.string().describe('Why this path is required'),
    });
    return buildTool({
        name: 'RequestWorkspaceAccess',
        searchHint: 'request access to a path outside the workspace',
        maxResultSizeChars: 2_000,
        description: async () => 'Request run-scoped access to a directory outside the current workspace.',
        prompt: async () => 'Use RequestWorkspaceAccess before accessing any path outside the workspace.',
        userFacingName: input => `Request access ${String(input?.path ?? '')}`,
        inputSchema,
        isConcurrencySafe: () => false,
        isReadOnly: () => false,
        isEnabled: () => true,
        async call(input) {
            const grant = await registry.grant(input.path, input.access);
            return { data: {
                grantId: grant.id,
                hostPath: grant.path,
                sandboxPath: grant.mountAt ?? `/mnt/grants/${grant.id}`,
                access: grant.access,
            } };
        },
        mapToolResultToToolResultBlockParam(output, toolUseId) {
            return { tool_use_id: toolUseId, type: 'tool_result', content: JSON.stringify(output) };
        },
    });
}

async function resolveExisting(
    registry: WorkspaceGrantRegistry,
    requested: string,
    access: WorkspaceAccess,
): Promise<string> {
    const resolved = await realpath(path.resolve(registry.workspaceRoot, requested));
    assertPermitted(registry, resolved, access);
    return resolved;
}

async function resolveWritable(registry: WorkspaceGrantRegistry, requested: string): Promise<string> {
    const absolute = path.resolve(registry.workspaceRoot, requested);
    const parent = await nearestExistingParent(path.dirname(absolute));
    const canonicalParent = await realpath(parent);
    const suffix = path.relative(parent, absolute);
    const resolved = path.resolve(canonicalParent, suffix);
    assertPermitted(registry, resolved, 'write');
    return resolved;
}

async function nearestExistingParent(candidate: string): Promise<string> {
    let current = candidate;
    while (true) {
        try {
            const info = await stat(current);
            if (!info.isDirectory()) throw new Error(`Parent is not a directory: ${current}`);
            return current;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const parent = path.dirname(current);
            if (parent === current) throw new Error(`No existing parent for ${candidate}`);
            current = parent;
        }
    }
}

function assertPermitted(registry: WorkspaceGrantRegistry, candidate: string, access: WorkspaceAccess): void {
    if (!registry.permits(candidate, access)) {
        throw new Error(`Path is outside the authorized workspace: ${candidate}. Use RequestWorkspaceAccess first.`);
    }
}

async function walk(dir: string, output: string[], hiddenState: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        if (inside(hiddenState, child)) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(child, output, hiddenState);
        else if (entry.isFile()) output.push(child);
    }
}

function inside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function covers(current: WorkspaceAccess, requested: WorkspaceAccess): boolean {
    return current === 'write' || current === requested;
}
