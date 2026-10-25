import {expect, it} from 'vitest';
import type {TaskRecord} from '@itookit/durable-kernel';
import {invocationTaskHistory} from '../src/flow/invocation-projection';

function task(id: string, createdAt: number, labels: Record<string, string> = {}, parentTaskId?: string, sessionId = 's'): TaskRecord {
    return {id, createdAt, sessionId, labels, parentTaskId, status: 'succeeded', program: {kind: 'value', version: '1'}} as TaskRecord;
}

it('retains replaced calls and their owned Task details without expanding control membership or crossing Sessions', () => {
    const root = task('root', 1, {invocationId: 'call'}), old = task('old', 2, {invocationId: 'child-call', parentInvocationId: 'call'});
    const details = task('details', 3, {}, old.id), nested = task('nested', 4, {}, details.id);
    const current = task('current', 5, {...old.labels});
    const unrelated = task('unrelated', 6, {invocationId: 'other', parentInvocationId: 'other-root'});
    const foreign = task('foreign', 7, {invocationId: 'foreign-call', parentInvocationId: 'call'}, old.id, 'another-session');
    const members = new Set([root.id, current.id]);
    const history = invocationTaskHistory(root, [foreign, unrelated, current, nested, details, old, root], members);
    expect(history.map(task => task.id)).toEqual(['root', 'old', 'details', 'nested', 'current']);
    expect([...members]).toEqual(['root', 'current']);
});
