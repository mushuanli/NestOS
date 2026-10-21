import {taskStoragePath, type Kernel} from '@itookit/durable-kernel';
import {sha256Hex} from '@itookit/llm-context';
import type {TaskAssetStore, TaskAssetReference, ToolExecutionIdentity} from '@itookit/tools/contracts';
import {readMediaAsset} from '@itookit/kernel-adapters';

/** Content-addressed binaries and small immutable receipts owned by the executing Task. */
export function createTaskAssetStore(getKernel: () => Kernel): TaskAssetStore {return new DurableTaskAssets(getKernel);}

class DurableTaskAssets implements TaskAssetStore {
    constructor(private readonly getKernel: () => Kernel) {}
    private async storage(identity: ToolExecutionIdentity) {
        const kernel = this.getKernel(), task = await kernel.task(identity.sessionId, identity.taskId);
        const {storage} = await kernel.inspectSession(identity.sessionId);
        const resolved = await kernel.storageResolvers.resolve(storage.kind).resolve(storage);
        return {...resolved, task, owner: taskStoragePath('/', identity.taskId).slice(1)};
    }
    async write(data: Uint8Array, mimeType: string, identity: ToolExecutionIdentity, signal?: AbortSignal): Promise<TaskAssetReference> {
        signal?.throwIfAborted();
        if (!(data instanceof Uint8Array) || !data.length || data.length > 32 * 1024 * 1024 || !/^[a-z]+\/[a-z0-9.+-]+$/i.test(mimeType)) throw new Error('Invalid binary asset');
        const {fs, rootPath, owner} = await this.storage(identity), sha256 = await sha256Hex(data), name = `${sha256}.bin`;
        const ref = {sessionId: identity.sessionId, taskId: identity.taskId, owner, name, mimeType, bytes: data.length, sha256};
        signal?.throwIfAborted();
        await fs.meta.assets.putAsset(`${rootPath}/${owner}`, name, new Uint8Array(data).buffer);
        await readMediaAsset(fs, rootPath, ref, identity); return ref;
    }
    async getRecord(key: string, identity: ToolExecutionIdentity): Promise<unknown | undefined> {
        const seen = new Set<string>();
        let taskId: string | undefined = identity.taskId;
        while (taskId && !seen.has(taskId) && seen.size < 32) {
            seen.add(taskId);
            const {fs, rootPath, owner, task} = await this.storage({...identity, taskId});
            const raw = await fs.meta.seq!.getEntry(`${rootPath}/${owner}`, recordKey(key));
            if (raw !== null && raw !== undefined) return JSON.parse(raw);
            taskId = task.retryOfTaskId;
        }
        return undefined;
    }
    async putRecord(key: string, value: unknown, identity: ToolExecutionIdentity, signal?: AbortSignal): Promise<void> {
        const {fs, rootPath, owner} = await this.storage(identity), encoded = JSON.stringify(value);
        if (!encoded || encoded.length > 100000) throw new Error('Asset record exceeds JSON budget');
        const entry = recordKey(key);
        if (!fs.meta.seq?.transaction) throw new Error('Asset records require atomic transactions');
        await fs.meta.seq.transaction(async tx => {
            signal?.throwIfAborted();
            const prior = await tx.getEntry(`${rootPath}/${owner}`, entry);
            if (prior !== null && prior !== encoded) throw new Error('Asset record identity conflict');
            await tx.setEntry(`${rootPath}/${owner}`, entry, encoded);
        });
    }
}
function recordKey(key: string): string {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9._:/-]{1,256}$/.test(key)) throw new Error('Invalid asset record key');
    return `tool-asset/${key}`;
}
