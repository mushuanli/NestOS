import {packageError} from './manifest';
import type {ExecutableBinding} from './files';

interface BindingLease {path: string; original?: string; users: Set<symbol>}
const leases = new Map<string, BindingLease>();

export function assertPackageEnvironment(bindings: ExecutableBinding[]): void {
    for (const binding of bindings) {
        const current = leases.get(binding.env);
        if (current && current.path !== binding.path)
            throw packageError('TOOL_PACKAGE_EXECUTABLE_CONFLICT', `Executable environment ${binding.env} is already bound to another registered package`);
    }
}

/** Only committed packages retain executable bindings; failed installs release their changes. */
export function activatePackageEnvironment(bindings: ExecutableBinding[]): () => void {
    assertPackageEnvironment(bindings); const user = Symbol('tool-package');
    for (const binding of bindings) {
        const lease = leases.get(binding.env) ?? {path: binding.path, original: process.env[binding.env], users: new Set<symbol>()};
        lease.users.add(user); leases.set(binding.env, lease); process.env[binding.env] = binding.path;
    }
    return () => {
        for (const binding of bindings) {
            const lease = leases.get(binding.env); if (!lease || !lease.users.delete(user) || lease.users.size) continue;
            if (process.env[binding.env] === lease.path) {
                if (lease.original === undefined) delete process.env[binding.env]; else process.env[binding.env] = lease.original;
            }
            leases.delete(binding.env);
        }
    };
}

let loading = Promise.resolve();
export function withPackageEnvironment<T>(bindings: ExecutableBinding[], action: () => Promise<T>): Promise<T> {
    const work = loading.then(async () => {
        assertPackageEnvironment(bindings);
        const release = activatePackageEnvironment(bindings);
        try {return await action();} finally {release();}
    });
    loading = work.then(() => {}, () => {}); return work;
}
