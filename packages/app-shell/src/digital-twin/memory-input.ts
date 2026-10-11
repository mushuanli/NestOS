import type { TwinMemoryData } from '@itookit/app-core';
const field = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
export function memoryInput(data: FormData): Partial<TwinMemoryData> {
    const predicate = field(data, 'relationPredicate'), target = field(data, 'relationTarget');
    const relation = predicate || target ? { predicate, target, targetKind: field(data, 'relationTargetKind') as NonNullable<TwinMemoryData['relation']>['targetKind'] } : undefined;
    return { relation, content: field(data, 'content'), kind: field(data, 'kind') as TwinMemoryData['kind'], subject: field(data, 'subject'),
        project: field(data, 'project'), eventTime: field(data, 'eventTime'), goalStatus: field(data, 'goalStatus') as TwinMemoryData['goalStatus'],
        successCondition: field(data, 'successCondition'), deadline: field(data, 'deadline') };
}
