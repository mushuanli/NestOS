import type {RunDefinition} from '@itookit/app-core';
import type {CliRuntime} from './runtime';
import {recordRuntimeDiagnostic} from './diagnostics';

/** YAML carries connection ids; only the trusted host can freeze native execution grants. */
export async function bindWorkflowHarness(definition: RunDefinition, sessionId: string,
    capabilities: Pick<CliRuntime['flowCapabilities'], 'bindNode'>): Promise<void> {
    for (const node of definition.graph.nodes) {
        const config = node.config as {execution?: {kind?: string}};
        if (node.plugin !== 'builtin.agent' || config?.execution?.kind !== 'harness') continue;
        const started = Date.now();
        try {
            const bound = await capabilities.bindNode(sessionId, node as never);
            Object.assign(node, bound);
            recordRuntimeDiagnostic('harness.binding', {operation: 'flow.harness.bind', stage: 'admission',
                result: 'success', sessionId, nodeId: node.id, elapsedMs: Date.now() - started});
        } catch (error) {
            recordRuntimeDiagnostic('harness.binding', {operation: 'flow.harness.bind', stage: 'admission',
                result: 'failure', sessionId, nodeId: node.id, elapsedMs: Date.now() - started,
                errorCategory: 'HARNESS_CONNECTION_ADMISSION_FAILED'});
            throw error;
        }
    }
}
