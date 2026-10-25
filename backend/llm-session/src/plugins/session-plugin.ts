// session-plugin — registers core session operation commands.
//
// Maps SessionManager methods to ICommandBus commands so UI can call
// commands.execute(SessionCommand.Send, { text }) instead of sessionManager.sendMessage().

import type { ILLMPlugin, ExtensionContext } from '../contracts';
import type { SessionManager } from '../session/session-manager';
import { FlowInvocationCommand } from '../session/flow-invocations';

import { SessionCommand } from '../contracts/commands';
export { SessionCommand } from '../contracts/commands';

export function createSessionPlugin(sessionManager: SessionManager): ILLMPlugin {
    return {
        name: 'session',
        activate(ctx: ExtensionContext): void {
            const sm = sessionManager;

            ctx.commands.register(SessionCommand.Bind, async (args) => {
                const { sessionId, createMissing } = args as { sessionId: string; createMissing?: boolean };
                return createMissing === undefined ? sm.bindSession(sessionId) : sm.bindSession(sessionId, { createMissing });
            });
            ctx.commands.register(SessionCommand.Unbind, async () => sm.unbindSession());
            ctx.commands.register(SessionCommand.CreateFromFlow, async (args) => {
                const { flowId, revision, parameters, title, invocation, connectionId, connectionBindings, expectedSignature } = args as {
                    flowId: string;
                    revision: number;
                    parameters?: Record<string, unknown>;
                    title?: string;
                    invocation?: boolean;
                    connectionId?: string;
                    connectionBindings?: Record<string, string>;
                    expectedSignature?: import('../contracts/flow-invocations').FlowInvocationInput['expectedSignature'];
                };
                await ctx.commands.execute(SessionCommand.CheckFlowConnections, {flowId, revision, parameters, connectionId, connectionBindings,
                    ...(expectedSignature ? {expectedSignature} : {})});
                const created = await sm.createSessionFromFlow(
                    flowId,
                    revision,
                    parameters as Record<string, import('@itookit/llm-flow/contracts').JsonValue> | undefined,
                    title ?? 'Workflow',
                    invocation,
                    connectionId, connectionBindings,
                );
                if (invocation) await ctx.commands.execute(FlowInvocationCommand.Invoke, {
                    sessionId: created.sessionId, requestId: 'initial-flow', flowId, revision, parameters: parameters ?? {}, connectionId, connectionBindings,
                    ...(expectedSignature ? {expectedSignature} : {}),
                });
                return created;
            });

            ctx.commands.register(SessionCommand.FlowBranchExecutions, args => sm.getFlowBranchExecutions((args as { sessionId: string }).sessionId));
            ctx.commands.register(SessionCommand.FlowRerunContext, args => sm.getFlowRerunContext((args as {sourceRoundId?: string} | undefined)?.sourceRoundId));
            ctx.commands.register(SessionCommand.FlowRerun, args => {
                const { parameters, sourceRoundId, sessionId, definitionKey, connectionId, connectionBindings, sourceSelection } = args as {sourceSelection?: 'selected'; connectionBindings?: Record<string, string>; connectionId?: string; parameters: Record<string, import('@itookit/llm-flow/contracts').JsonValue>; sourceRoundId: string | null; sessionId?: string; definitionKey?: string };
                return sm.rerunFlow(parameters, sourceRoundId, sessionId, definitionKey, connectionId, connectionBindings, sourceSelection);
            });

            ctx.commands.register(SessionCommand.GetSnapshot, async () => sm.getSnapshot());
            ctx.commands.register(SessionCommand.GetInstructionQueue, () => sm.getInstructionQueue());
            ctx.commands.register(SessionCommand.EditInstructionQueue, args => sm.editInstructionQueue(args as import('../contracts/instruction-queue').InstructionQueueEdit));
            ctx.commands.register(SessionCommand.GetSessions, async () => sm.getSessions());
            ctx.commands.register(SessionCommand.GetCurrentId, async () => sm.getCurrentSessionId());
            ctx.commands.register(SessionCommand.GetStatus, async () => sm.getStatus());
            ctx.commands.register(SessionCommand.IsGenerating, async () => sm.isGenerating());
            ctx.commands.register(SessionCommand.HasUnsaved, async () => sm.hasUnsavedChanges());
            ctx.commands.register(SessionCommand.GetAll, async () => sm.getAllSessions());
            ctx.commands.register(SessionCommand.GetRuntime, async (args) => {
                const { sessionId } = args as { sessionId: string };
                return sm.getSessionRuntime(sessionId);
            });

            ctx.commands.register(SessionCommand.CanRegenerate, async (args) => {
                const { messageId } = args as { messageId: string };
                return sm.canRegenerate(messageId);
            });
            ctx.commands.register(SessionCommand.CanDelete, async (args) => {
                const { messageId } = args as { messageId: string };
                return sm.canDeleteMessage(messageId);
            });
            ctx.commands.register(SessionCommand.CanEdit, async (args) => {
                const { messageId } = args as { messageId: string };
                return sm.canEdit(messageId);
            });

            ctx.commands.register(SessionCommand.Send, async (args) => {
                const { text, files, agentId, overrides, origin, historyPolicy, sendIntent } = args as {
                    text: string;
                    files?: unknown[];
                    agentId?: string;
                    overrides?: unknown;
                    origin?: unknown;
                    historyPolicy?: unknown;
                    sendIntent?: unknown;
                };
                if (!agentId) {
                    console.warn('[SessionPlugin] SessionCommand.Send arrived without agentId — the empty id cannot resolve and will fall back to the default agent');
                }
                return sm.sendMessage(text, files as any, agentId ?? '', overrides as any, origin as any, historyPolicy as any, sendIntent as any);
            });
            ctx.commands.register(SessionCommand.Submit, args => sm.submit(args as import('../contracts/submission').SubmissionRequest));
            ctx.commands.register(SessionCommand.ListTargets, () => sm.listCallTargets());
            ctx.commands.register(SessionCommand.GetSubmissionReceipt, args => sm.getSubmissionReceipt(args as import('../contracts/submission').SubmissionRequest));
            ctx.commands.register(SessionCommand.InspectSubmissionReceipt, args => sm.inspectSubmissionReceipt(args as import('../contracts/submission').SubmissionRequest));
            ctx.commands.register(SessionCommand.HasCommittedSubmission, args => sm.hasCommittedSubmission(args as {
                sessionId: string; submission: import('@itookit/llm-flow/contracts').SessionSubmission}));
            ctx.commands.register(SessionCommand.Abort, async () => sm.abort());
            ctx.commands.register(SessionCommand.ContextSet, async (args) => {
                const { roundIds, mode, scope } = args as {
                    roundIds: string[];
                    mode: 'include' | 'exclude';
                    scope?: 'node' | 'subtree';
                };
                return sm.setContextMode(roundIds, mode, scope);
            });
            ctx.commands.register(SessionCommand.ContextGet, async (args) => {
                const { roundIds } = args as { roundIds: string[] };
                return sm.getContextModes(roundIds);
            });
            ctx.commands.register(SessionCommand.ContextSnapshotGet, async (args) => {
                const { snapshotId } = args as { snapshotId: string };
                return sm.getContextSnapshot(snapshotId);
            });
            ctx.commands.register(SessionCommand.ContextBindings, args => sm.getContextBindings(args as import('../contracts/context-bindings').ContextBindingQuery));
            ctx.commands.register(SessionCommand.ContextOptions, args => sm.getContextOptions(args as import('../contracts/context-options').ContextOptionsQuery));
            ctx.commands.register(SessionCommand.ArtifactGet, args => sm.getArtifact((args as {artifactId: string}).artifactId));
            ctx.commands.register(SessionCommand.ContextPreview, async (args) => {
                const { agentId, pendingText } = args as { agentId: string; pendingText?: string };
                return sm.previewContext(agentId, pendingText);
            });
            ctx.commands.register(SessionCommand.Regenerate, async (args) => {
                const { assistantId, options } = args as { assistantId: string; options?: unknown };
                return sm.regenerate(assistantId, options as any);
            });
            ctx.commands.register(SessionCommand.RegenerateFromUser, async (args) => {
                const { userMessageId, options } = args as { userMessageId: string; options?: unknown };
                return sm.regenerateFromUser(userMessageId, options as any);
            });

            ctx.commands.register(SessionCommand.DeleteMessage, async (args) => {
                const { messageId, options } = args as { messageId: string; options?: unknown };
                return sm.deleteMessage(messageId, options as any);
            });
            ctx.commands.register(SessionCommand.DeleteMessages, async (args) => {
                const { messageIds, options } = args as { messageIds: string[]; options?: unknown };
                return sm.deleteMessages(messageIds, options as any);
            });
            ctx.commands.register(SessionCommand.UpdateDraft, async (args) => {
                const { messageId, newContent } = args as { messageId: string; newContent: string };
                return sm.updateDraft(messageId, newContent);
            });
            ctx.commands.register(SessionCommand.CommitEdit, async (args) => {
                const { messageId, newContent, autoRerun } = args as { messageId: string; newContent: string; autoRerun?: boolean };
                return sm.commitEdit(messageId, newContent, autoRerun);
            });
            ctx.commands.register(SessionCommand.SwitchSibling, async (args) => {
                const { messageId, siblingIndex } = args as { messageId: string; siblingIndex: number };
                return sm.switchToSibling(messageId, siblingIndex);
            });
            ctx.commands.register(SessionCommand.GetSiblings, async (args) => {
                const { messageId } = args as { messageId: string };
                return sm.getSiblings(messageId);
            });

            ctx.commands.register(SessionCommand.GetSettings, async () => sm.getSessionSettings());
            ctx.commands.register(SessionCommand.SaveSettings, async (args) => {
                return sm.saveSessionSettings(args as any);
            });

            ctx.commands.register(SessionCommand.GetAgents, async () => sm.getAvailableAgents());
            ctx.commands.register(SessionCommand.GetModels, async (args) => {
                const { agentId } = args as { agentId: string };
                return sm.getModelsForAgent(agentId);
            });

            ctx.commands.register(SessionCommand.Export, async () => sm.exportToMarkdown());
        },
    };
}
