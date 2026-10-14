// @file: durable-kernel/src/application/actions.ts
// KernelAction → commit 副作用的转换。

import type { KernelAction } from '../domain/types';
import { createId, type PreparedSpawn, type TaskCommitSideEffects } from '../infrastructure/seqfile/store';

export function decisionSideEffects(
    actions: KernelAction[],
    spawns: PreparedSpawn[],
): TaskCommitSideEffects {
    const shared: NonNullable<TaskCommitSideEffects['shared']> = [];
    const events: NonNullable<TaskCommitSideEffects['events']> = [];
    for (const action of actions) {
        if (action.type === 'set-shared') shared.push({
            type: 'set', key: action.key, value: action.value, expectedVersion: action.expectedVersion,
        });
        if (action.type === 'delete-shared') shared.push({
            type: 'delete', key: action.key, expectedVersion: action.expectedVersion,
        });
        if (action.type === 'emit') events.push({ type: action.eventType, payload: action.payload });
        if (action.type === 'request-interaction') events.push({
            type: 'task.interaction.requested', payload: action.interaction,
        });
    }
    return { shared, events, spawns, messages: actions.filter(action => action.type === 'send-message').map(action => action.message), cache: actions.filter(action => action.type === 'cache-read' || action.type === 'cache-publish' || action.type === 'cache-create' || action.type === 'cache-invalidate' || action.type === 'cache-renew') };
}

export function prepareSpawns(actions: KernelAction[]): PreparedSpawn[] {
    return actions.filter(action => action.type === 'spawn').map(action => ({
        id: createId('task'), spawnKey: action.spawnKey, spec: action.spec,
    }));
}
