import { SharedMemoryStore } from '@itookit/llm-session';
import type { CommandOptions } from './commands';
import { resolveProfileRoot } from './nestos';
import { openProfileInspectionFs } from './runtime';

/** Explicit single-user host administration; model tools cannot invoke these operations. */
export async function sharedMemoryCommand(args: string[], options: CommandOptions): Promise<number> {
    const host = await openProfileInspectionFs(resolveProfileRoot(options.profile));
    try {
        const store = new SharedMemoryStore(host.fs); await store.init();
        const result = await execute(store, args, options);
        process.stdout.write(`${JSON.stringify(result ?? { success: true }, null, 2)}\n`);
        return 0;
    } finally { await host.dispose(); }
}

async function execute(store: SharedMemoryStore, args: string[], options: CommandOptions): Promise<unknown> {
    const [action, id, incarnation, target] = args;
    if (action === 'list') return store.list();
    if (action === 'create') return store.create(required(id, 'resource id'), required(incarnation, 'namespace'), required(target, 'creator Session id'));
    const ref = { id: required(id, 'resource id'), incarnation: required(incarnation, 'incarnation') };
    if (action === 'audit') return store.history(ref);
    if (action === 'inspect') return store.inspect(ref);
    const current = await store.inspect(ref);
    if (action === 'delete') return store.remove(ref, current.revision);
    if (action === 'revoke') return store.grant(ref, required(target, 'target Session id'), null, current.revision);
    if (action === 'grant') {
        const grant = JSON.parse(required(options.value, '--value grant JSON'));
        if (!grant || typeof grant !== 'object' || Array.isArray(grant)) throw new Error('Expected a Memory grant object');
        return store.grant(ref, required(target, 'target Session id'), grant, current.revision);
    }
    throw new Error('memory requires list/create/inspect/grant/revoke/delete/audit');
}

function required(value: string | undefined, label: string): string {
    if (!value?.trim()) throw new Error(`Missing ${label}`);
    return value;
}
