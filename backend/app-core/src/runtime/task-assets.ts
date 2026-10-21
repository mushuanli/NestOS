import type {IFileSystem} from '@itookit/vfs-core';
import {readInputAsset} from './input-assets';
import type { Kernel, TaskRecord } from '@itookit/durable-kernel';
import type { TaskAssetReader } from '@itookit/tools/contracts';
import { readMediaAsset } from '@itookit/kernel-adapters';
import { resolveFlowRunForTask } from '@itookit/llm-flow';

/** Task assets may cross node boundaries only inside the same authoritative Flow run. */
export function createTaskAssetReader(getKernel: () => Kernel, inputFS?: IFileSystem): TaskAssetReader {
    return async (reference, identity) => {
        if ('kind' in reference && reference.kind === 'input') {
            if (!inputFS) throw new Error('Input asset storage is unavailable');
            const session = await assetInspection(getKernel(), identity.sessionId);
            const task = (await session.listTasks()).find(task => task.id === identity.taskId);
            const root = await resolveFlowRunForTask(session, identity.taskId);
            const needle = reference.id;
            if (!containsInput(task?.input, needle) && !containsInput(root?.input, needle)) throw new Error('Input asset was not selected for this Task');
            return readInputAsset(inputFS, reference);
        }
        if ('kind' in reference) throw new Error('Invalid asset kind');
        if (reference.sessionId !== identity.sessionId) throw new Error('Asset belongs to another Session');
        const kernel = getKernel(), session = await assetInspection(kernel, identity.sessionId);
        if (reference.taskId !== identity.taskId && !isRetryAncestor(await session.listTasks(), reference.taskId, identity.taskId)) {
            const [source, consumer] = await Promise.all([
                resolveFlowRunForTask(session, reference.taskId), resolveFlowRunForTask(session, identity.taskId),
            ]);
            if (!source || !consumer || source.id !== consumer.id) throw new Error('Asset belongs to another Flow run');
        }
        const { storage } = session;
        const { fs, rootPath } = await kernel.storageResolvers.resolve(storage.kind).resolve(storage);
        return readMediaAsset(fs, rootPath, reference, { sessionId: identity.sessionId, taskId: reference.taskId });
    };
}

/** Reuse one cold Task snapshot within this read; never cache authorization across reads. */
async function assetInspection(kernel: Kernel, sessionId: string) {
    const session = await kernel.inspectSession(sessionId);
    let tasks: Promise<TaskRecord[]> | undefined;
    return {...session, listTasks: () => tasks ??= session.listTasks()};
}

function containsInput(value: unknown, id: string): boolean {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(item => containsInput(item, id));
    const record = value as Record<string, unknown>;
    return record.kind === 'input' && record.id === id || Object.values(record).some(item => containsInput(item, id));
}

function isRetryAncestor(tasks: TaskRecord[], sourceId: string, consumerId: string): boolean {
    const seen = new Set<string>();
    let current = tasks.find(task => task.id === consumerId)?.retryOfTaskId;
    while (current && !seen.has(current) && seen.size < 32) {
        if (current === sourceId) return true;
        seen.add(current); current = tasks.find(task => task.id === current)?.retryOfTaskId;
    }
    return false;
}
