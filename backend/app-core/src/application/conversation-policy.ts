import { SessionCommand } from '@itookit/llm-session/contracts';

export const APPLICATION_READ_COMMANDS = [SessionCommand.GetSnapshot, SessionCommand.GetSessions, SessionCommand.GetCurrentId,
    SessionCommand.GetStatus, SessionCommand.IsGenerating, SessionCommand.HasUnsaved, SessionCommand.GetSettings,
    SessionCommand.GetConnections, SessionCommand.GetAgents, SessionCommand.GetModels, SessionCommand.CanRegenerate,
    SessionCommand.CanDelete, SessionCommand.CanEdit, SessionCommand.GetSiblings, SessionCommand.ContextGet,
    SessionCommand.ContextSnapshotGet, SessionCommand.ContextPreview, SessionCommand.FlowBranchExecutions,
    SessionCommand.FlowRerunContext, SessionCommand.Export] as const;

/** Explicit exposure policy: adding a Session command does not publish it automatically. */
export const APPLICATION_CONVERSATION_COMMANDS = [...APPLICATION_READ_COMMANDS,
    SessionCommand.Send, SessionCommand.Abort, SessionCommand.ContextSet, SessionCommand.Regenerate,
    SessionCommand.RegenerateFromUser, SessionCommand.DeleteMessage, SessionCommand.DeleteMessages,
    SessionCommand.UpdateDraft, SessionCommand.CommitEdit, SessionCommand.SwitchSibling,
    SessionCommand.SaveSettings, SessionCommand.FlowRerun] as const;
