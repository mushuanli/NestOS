import {t} from '@itookit/common';
import type {ExtensionRenderer, MessagePart} from '@itookit/llm-ui';
import type {SessionGroup} from '@itookit/llm-session/contracts';

export const messageOutputsPart = 'mindos.execution-outputs';
/** Only host-projected Flow executions receive the optional details action. */
export function messageOutputs(group: SessionGroup): MessagePart[] {
    const taskId = group.execution?.taskId;
    if (group.role !== 'assistant' || !taskId || !(group.target?.kind === 'flow' || group.executionRoot?.executorType === 'flow'
        || group.callInput?.admitted || group.executionRoot?.children?.some(child => child.data.metaInfo?.flowInteraction === true))) return [];
    return [{id: 'execution-outputs', kind: 'extension', type: messageOutputsPart, data: {taskId}}];
}
export function outputRenderer(open: (taskId: string) => void | Promise<void>): ExtensionRenderer {
    return (root, part) => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = t('flow.output.title');
        button.dataset.executionOutputs = ''; root.append(button);
        let current = part;
        button.onclick = () => {const taskId = (current.data as {taskId?: unknown})?.taskId;
            if (typeof taskId === 'string' && taskId) void open(taskId);};
        return {update: part => {current = part;}, destroy: () => {button.onclick = null; button.remove();}};
    };
}
