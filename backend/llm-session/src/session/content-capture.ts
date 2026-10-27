import type { ChatMessage } from '@itookit/llm-context';
import type { JsonValue, DurableFlowSnapshot } from '@itookit/llm-flow';
import { FlowCommand } from '@itookit/llm-flow';
import type { ContentCapture, TransferMessage, TransferOutput, TransferSelection } from '../contracts/content-transfer';
import type { ICommandBus } from '../contracts';
import type { ISessionRepository } from '../persistence/types';
import { RoundLog } from '../persistence/round-log';
import { collectHistoryChain } from '../persistence/history-chain';
import { FlowInvocationCommand, type FlowInvocationRecord } from '../contracts/flow-invocations';
import { ulid } from '../persistence/ulid';

export async function captureContent(repository: ISessionRepository, commands: ICommandBus, sessionId: string,
    kernel?: Pick<import('@itookit/durable-kernel').Kernel, 'listSessionTaskPage'>): Promise<ContentCapture> {
    const log = new RoundLog(repository, sessionId), manifest = await log.loadManifest();
    const history = repository.readHistoryChain ? await repository.readHistoryChain(sessionId)
        : await collectHistoryChain(manifest, id => log.readRound(id, manifest.currentBranch, manifest));
    const messages = history.rounds.filter(round => !round._deleted && (!round.exposure || round.exposure === 'public')).flatMap(round => [
        ...messageItems(round.id, 'input', round.input),
        ...(round.status === 'completed' ? messageItems(round.id, 'output', round.output) : []),
    ]);
    return { id: ulid(), sessionId, branch: history.branch, head: history.chain.at(-1) ?? null,
        createdAt: Date.now(), messages, outputs: [...await outputItems(commands, sessionId), ...await toolOutputs(kernel, sessionId)] };
}

/** Only explicit completed tool commands are selectable; live effects are never input evidence. */
async function toolOutputs(kernel: Pick<import('@itookit/durable-kernel').Kernel, 'listSessionTaskPage'> | undefined, sessionId: string): Promise<TransferOutput[]> {
    if (!kernel) return [];
    const outputs: TransferOutput[] = [];
    let afterIndex: number | undefined, throughIndex: number | undefined;
    do {
        const page = await kernel.listSessionTaskPage(sessionId, {afterIndex, throughIndex, limit: 100});
        throughIndex = page.throughIndex; afterIndex = page.nextAfterIndex;
        for (const task of page.items) {
            if (task.status !== 'succeeded' || task.program.kind !== 'kernel-adapters.tool' || task.labels?.command !== 'tool') continue;
            const result = (task.output as {outputs?: {result?: {content?: JsonValue}}} | undefined)?.outputs?.result;
            if (!result || !Object.hasOwn(result, 'content')) continue;
            const input = task.input as {toolId: string};
            outputs.push({id: `tool/${task.id}/result`, requestId: task.labels.toolRequestId ?? task.id,
                taskId: task.id, port: 'result', label: `${input.toolId} · ${task.id.slice(0, 8)}`, value: result.content!});
        }
    } while (afterIndex !== undefined);
    return outputs;
}

function messageItems(roundId: string, side: string, messages: ChatMessage[]): TransferMessage[] {
    return messages.flatMap((message, index) => {
        if (message.role !== 'user' && message.role !== 'assistant') return [];
        const text = typeof message.content === 'string' ? message.content
            : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
        return text ? [{ id: `${roundId}/${side}/${index}`, roundId, role: message.role, text }] : [];
    });
}

async function outputItems(commands: ICommandBus, sessionId: string): Promise<TransferOutput[]> {
    const calls = await commands.execute<FlowInvocationRecord[]>(FlowInvocationCommand.List, { sessionId });
    const result: TransferOutput[] = [];
    for (const call of calls) {
        if (!call.rootTaskId) continue;
        const snapshot = await commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, { sessionId: call.executionSessionId ?? sessionId, taskId: call.rootTaskId });
        if (snapshot.root.task.status !== 'succeeded') continue;
        const raw = snapshot.root.task.output as { nodes?: Record<string, JsonValue> } | undefined;
        const returned = raw?.nodes?.__flow_return;
        const ports = returned && typeof returned === 'object' && !Array.isArray(returned) ? Object.entries(returned) : [['result', raw ?? null] as const];
        for (const [port, value] of ports) result.push({ id: `${call.requestId}/${port}`, requestId: call.requestId,
            taskId: call.rootTaskId, port, label: `${call.flow.name} · ${call.requestId.slice(0, 8)} · ${port}`, value });
    }
    return result;
}

export function selectedMessages(capture: ContentCapture, selection: TransferSelection): TransferMessage[] {
    if (selection.kind === 'output' || selection.kind === 'text') return [];
    if (selection.kind === 'latest') return capture.messages.filter(item => item.role === 'assistant').slice(-1);
    if (selection.kind === 'replies') return capture.messages.filter(item => item.role === 'assistant');
    if (selection.kind !== 'selected') return capture.messages;
    const ids = new Set(selection.messageIds);
    if (!ids.size || ids.size !== selection.messageIds.length || [...ids].some(id => !capture.messages.some(item => item.id === id)))
        throw new Error('CONTENT_SELECTION_INVALID');
    return capture.messages.filter(item => ids.has(item.id));
}

export function transferText(messages: TransferMessage[]): string {
    return messages.length === 1 ? messages[0].text : messages.map(message => `[${message.role}]\n${message.text}`).join('\n\n---\n\n');
}
