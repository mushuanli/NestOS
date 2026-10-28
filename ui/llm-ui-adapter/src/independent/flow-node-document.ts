import {createModuleLogger, t} from '@itookit/common';
import type {ExtensionRenderer, MessagePart} from '@itookit/llm-ui';
import type {ExecutionNode} from '@itookit/llm-session/contracts';
import {FlowDocuments, flowRequestMarkdown} from '../components/dag/FlowDocuments';
import {runStatus} from '../flows/run-presentation';

export const flowNodeDocumentPart = 'mindos.flow-node-document';
type FlowNodeDocument = {title: string; text: string}

/** Preserve node identity instead of flattening a direct Flow run into Markdown parts. */
export function flowNodeDocument(node: ExecutionNode): MessagePart {
    const sections: string[] = [];
    if (node.data.input !== undefined) sections.push(`## ${t('flow.invoke.inputs')}\n\n${flowRequestMarkdown(node.data.input)}`);
    if (node.data.thought) sections.push(node.data.thought);
    if (node.data.output) sections.push(node.data.output);
    if (node.data.error) sections.push(node.data.error);
    return {id: node.id, kind: 'extension', type: flowNodeDocumentPart,
        data: {title: `${node.name} · ${runStatus(node.status === 'success' ? 'succeeded' : node.status === 'aborted' ? 'cancelled' : node.status)}`, text: sections.join('\n\n')} satisfies FlowNodeDocument};
}

export const flowNodeDocumentRenderer: ExtensionRenderer = (root, part) => {
    const documents = new FlowDocuments();
    const update = (next: typeof part) => {
        const data = next.data as FlowNodeDocument;
        documents.mount(root, next.id, data.title, data.text);
        documents.retain(new Set([next.id]));
    };
    createModuleLogger('flow-node-document').debug('flow.node.mount', {operationId: part.id, stage: 'mount', result: 'success'});
    update(part);
    return {update, destroy: () => documents.destroy()};
};
