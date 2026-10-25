import {vi} from 'vitest';
import type {IFileSystem} from '@itookit/vfs-core';

/** Inject failures before or after the real transaction commits. */
export function interceptConversationTransactions(source: IFileSystem) {
    const seq = source.meta.seq!, commit = seq.transaction!.bind(seq);
    const transaction = vi.fn(commit), read = vi.fn(seq.getEntry.bind(seq));
    const meta = {...source.meta, seq: new Proxy(seq, {get: (target, key) => {
        const value = Reflect.get(target, key);
        if (key === 'transaction') return transaction;
        if (key === 'getEntry') return read;
        return typeof value === 'function' ? value.bind(target) : value;
    }})};
    const fs = new Proxy(source, {get: (target, key) => {
        const value = Reflect.get(target, key);
        return key === 'meta' ? meta : typeof value === 'function' ? value.bind(target) : value;
    }});
    return {fs, transaction, commit, read};
}
