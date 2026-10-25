import type {ContextBindingOperation, HarnessContextRequest} from '@itookit/kernel-adapters/contracts';

export const context: HarnessContextRequest = {invocationId: 'call-1', branchId: 'main', targetRef: 'agent@1', scopeRef: 'conversation',
    policyRef: 'policy', workspaceRef: 'workspace', memoryPolicyRef: 'native-inherited', conversation: {mode: 'new'},
    input: {mode: 'host-assembled', snapshotRef: 'snapshot-1', digest: 'digest-1'}};
export const operation: ContextBindingOperation = {operationId: 'op-1', invocationId: 'call-1', fingerprint: 'input-1',
    executionRef: {taskId: 'task-1', effectId: 'effect-1'}};
