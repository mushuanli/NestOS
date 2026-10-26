import type {IAgentConfigService} from '@itookit/kernel-adapters/contracts';
import type {ICommandBus, RootCallTarget, SubmissionRequest} from '@itookit/llm-session/contracts';
import type {ChatSubmission} from '@itookit/llm-ui';
import {prepareAgentFlow, prepareCallTarget} from '../flows/agent-flow';
import {buildExecutorOptions} from '../shell/AgentProvider';
import {AssetService} from '../services/AssetService';
import type {IFileSystem} from '@itookit/vfs-core';

/** Reuse the existing published input form and immutable attachment preparation. */
export async function prepareSessionChatRequest(options: {
    commands: ICommandBus; agents: IAgentConfigService; choice: RootCallTarget; request: SubmissionRequest;
    files: File[]; assets?: IFileSystem; input?: ChatSubmission; signal: AbortSignal;
}): Promise<SubmissionRequest> {
    const {commands, agents, choice, signal, files} = options, request = structuredClone(options.request);
    signal.throwIfAborted();
    const draft = {text: options.input?.text ?? (request.source.kind === 'composer' ? request.source.text : request.presentation?.text ?? ''), files,
        ...(options.input?.input ? {input: {...options.input.input, revision: 0, json: JSON.stringify(options.input.input.values)}} : {})};
    if (choice.input || choice.target.kind === 'flow') {
        const agent = choice.target.kind === 'agent' ? (await buildExecutorOptions(agents)).find(agent => agent.id === choice.target.id) : undefined;
        const prepared = choice.target.kind === 'flow' ? await prepareCallTarget(commands, choice, signal, draft)
            : agent ? await prepareAgentFlow(commands, agent, signal, draft) : null;
        signal.throwIfAborted();
        if (!prepared) throw Object.assign(new Error('Flow input preparation was cancelled or its Agent is unavailable'), {code: 'FLOW_INPUT_CANCELLED'});
        return {...request, source: {kind: 'arguments', value: prepared.flowParameters}, presentation: {text: draft.text},
            attachments: [], overrides: {...request.overrides, ...prepared}};
    }
    const attachments = (await new AssetService(options.assets).prepareUpload(files, request.submission!.id)).files;
    signal.throwIfAborted();
    return {...request, attachments, source: {kind: 'composer', text: draft.text, attachments: [], values: {}}};
}
