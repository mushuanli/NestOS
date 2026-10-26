import {taskStat, type TaskRecord} from '@itookit/durable-kernel';
import type {DurableChatOutput} from '@itookit/llm-tasks';
import type {Round} from '../contracts/conversation';
import type {SubmissionRequest} from '../contracts/submission';
import type {PreparedIndependentTaskCall} from './independent-call-preparation';
import {submissionInstruction} from './submission-input';
import {instructionDigest, prepareInstruction} from './instruction-queue-rules';
import {conversationUserMessage} from './conversation-attachments';

/** Terminal history is a deterministic projection of the original request and real target. */
export async function independentCallResult(request: SubmissionRequest, ready: PreparedIndependentTaskCall,
    task: TaskRecord): Promise<Round | undefined> {
    if (!taskStat(task).settled || !task.exit) return;
    if (task.sessionId !== ready.executionSessionId || task.labels?.roundId !== request.submission!.id
        || task.labels?.invocationId !== ready.invocation.invocationId) throw invalid('CALL_EXECUTION_CONFLICT');
    const input = prepareInstruction(submissionInstruction(request), task.sessionId, request.expectedBranch!);
    const temporary = input.sendIntent?.retention.mode === 'temporary';
    return {id: request.submission!.id, sessionId: task.sessionId, submission: structuredClone(request.submission),
        submissionDigest: await instructionDigest(input), historyParentIds: [],
        input: [conversationUserMessage(input.text, input.files)], ...result(task),
        executions: [{taskId: task.id, role: 'primary', invocation: structuredClone(ready.invocation)}],
        createdAt: task.createdAt, completedAt: task.exit.completedAt, origin: 'user',
        agentId: request.expectedTarget!.id, target: structuredClone(request.expectedTarget),
        callInput: {source: structuredClone(request.source)}, exposure: temporary ? 'internal' : 'public',
        defaultContextMode: temporary ? 'exclude' : 'include', defaultContextScope: 'subtree'};
}

function result(task: TaskRecord): Pick<Round, 'output' | 'status' | 'error' | 'result'> {
    const exit = task.exit!;
    if (exit.status !== 'succeeded') return {output: [], status: exit.status === 'cancelled' ? 'cancelled' : 'failed',
        error: exit.error?.message ?? `Task ${exit.status}`};
    const output = exit.output as Partial<DurableChatOutput> | null;
    if (!output?.message || output.message.role !== 'assistant'
        || typeof output.message.content !== 'string' && !Array.isArray(output.message.content))
        throw invalid('CALL_RESULT_INVALID');
    return {output: [structuredClone(output.message)], status: 'completed', result: {
        assistantBlocks: [{type: 'text', content: structuredClone(output.message.content)}], toolResults: [],
        ...(output.usage ? {usage: structuredClone(output.usage)} : {}),
        ...(output.finishReason ? {finishReason: output.finishReason} : {})}};
}
function invalid(code: string): Error {return Object.assign(new Error(code), {code});}
