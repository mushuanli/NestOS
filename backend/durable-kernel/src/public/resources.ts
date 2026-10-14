import type { ResourceApi, ResourceCommand, ResourceResult, DurableResourceRequest, ResourceRequestSnapshot } from '../domain/resource-api';
import type { ManagedResourceStore, ResourceActor } from '../infrastructure/seqfile/managed-resources';

export function resourceApi(store: ManagedResourceStore, actor: ResourceActor): ResourceApi {
    const request = <T = ResourceResult>(scope: string, id: string): DurableResourceRequest<T> => ({
        id,
        poll: () => store.poll(actor, scope, id) as Promise<ResourceRequestSnapshot<T>>,
        cancel: () => store.poll(actor, scope, id, true) as Promise<ResourceRequestSnapshot<T>>,
        async wait(options = {}) {
            if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) throw new Error('Invalid resource wait timeout');
            const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
            for (;;) {
                if (options.signal?.aborted) throw options.signal.reason ?? new Error('Resource wait aborted');
                const state = await store.poll(actor, scope, id);
                if (state.status === 'succeeded') return structuredClone(state.result) as T;
                if (state.status !== 'pending') throw new Error(state.error ?? `Resource request ${state.status}`);
                if (Date.now() >= deadline) throw new Error('Resource wait timed out; request remains pending');
                await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(0, deadline - Date.now()))));
            }
        },
    });
    const execute = async <T>(command: ResourceCommand): Promise<DurableResourceRequest<T>> => {
        const state = await store.execute(actor, command); return request<T>(state.scope, state.id);
    };
    return {
        create: spec => execute({ ...spec, type: 'create' }),
        share: (ref, options) => execute({ ...options, ref, type: 'share' }),
        revoke: (ref, options) => execute({ ...options, ref, type: 'revoke' }),
        destroy: (ref, options) => execute({ ...options, ref, type: 'destroy' }),
        query: options => store.query(actor, options),
        open: (ref, options) => execute({ ...options, ref, type: 'open' }),
        acquire: (handle, options) => execute({ ...options, handle, type: 'acquire' }),
        release: (claim, options) => execute({ ...options, claim, type: 'release' }),
        close: (handle, options) => execute({ ...options, handle, type: 'close' }),
        read: (handle, options) => execute({ ...options, handle, type: 'read' }),
        write: (handle, options) => execute({ ...options, handle, type: 'write' }),
        request,
        claimAuthority: (authorityId, options) => store.claimAuthority(actor, authorityId, options),
        authority: (authorityId, scope) => store.authority(actor, authorityId, scope),
        stat: ref => store.stat(actor, ref),
        validate: claim => store.validate(actor, claim),
        list: () => store.list(actor),
    };
}

/** Host convenience only; the request, not this Promise, survives reconnection. */
export async function resourceResult<T>(command: Promise<DurableResourceRequest<T>>): Promise<T> {
    return (await command).wait();
}
