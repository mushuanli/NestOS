import {randomUUID, createModuleLogger} from '@itookit/common';
import type {OperationLedger, OperationRecord} from '@itookit/llm-ui';
import type {IPrivilegedCommandService, ToolCommandRequest} from '@itookit/llm-session/contracts';
import {canonicalJson} from '../utils/canonical-json';

interface Frozen {protocol: 'tool-command-v1'; request: ToolCommandRequest}
const log = createModuleLogger('tool-command-submission');

/** Persist the exact request before dispatch; retries reuse the same Kernel submission identity. */
export class ToolCommandOperations {
    constructor(private readonly ledger: OperationLedger, private readonly service: IPrivilegedCommandService) {}
    async submit(value: Omit<ToolCommandRequest, 'requestId'>): Promise<string> {
        if (!this.service.tool) throw new Error('TOOL_COMMAND_UNAVAILABLE');
        const previous = this.ledger.getSnapshot().find(record => matches(record, value));
        const request = previous ? (previous.input as unknown as Frozen).request : {...value, requestId: randomUUID()};
        const operationId = request.requestId, started = Date.now();
        if (!previous) await this.ledger.register({context: {operationId, viewId: 'tool-command'},
            conversationId: value.sessionId, kind: 'command', status: 'submitting',
            input: {protocol: 'tool-command-v1', request} as unknown as OperationRecord['input']});
        try {
            const taskId = await this.service.tool(request);
            await this.ledger.settle({operationId, status: 'accepted', submissionRef: taskId});
            report(operationId, started, 'accepted');
            return taskId;
        } catch (error) {
            await this.ledger.settle({operationId, status: 'unknown', message: 'TOOL_COMMAND_OUTCOME_UNKNOWN'});
            report(operationId, started, 'unknown'); throw error;
        }
    }
}
function matches(record: OperationRecord, value: Omit<ToolCommandRequest, 'requestId'>): boolean {
    const frozen = record.input as unknown as Frozen;
    if (frozen?.protocol !== 'tool-command-v1' || record.conversationId !== value.sessionId
        || record.status !== 'submitting' && record.status !== 'unknown') return false;
    const {requestId: _requestId, ...original} = frozen.request;
    return canonicalJson(original) === canonicalJson(value);
}
function report(operationId: string, started: number, result: string): void {
    try {log.info('Tool command submission', {operation: 'tool.command', operationId, stage: 'receipt', result, elapsedMs: Date.now() - started});}
    catch { /* Diagnostics cannot change a durable submission receipt. */ }
}
