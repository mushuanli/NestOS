// @file: llm-flow/src/flow/command-names.ts
// Centralized workflow command names — single source of truth for the command
// bus string contract between the flow layer and UI/session consumers.

export const FlowCommand = {
    DraftInstall: 'flow.draft.install',
    DraftRestore: 'flow.draft.restore',
    DraftList: 'flow.draft.list',
    DraftCreate: 'flow.draft.create',
    DraftAdopt: 'flow.draft.adopt',
    DraftLoad: 'flow.draft.load',
    DraftSave: 'flow.draft.save',
    DraftValidate: 'flow.draft.validate',
    RevisionCreate: 'flow.revision.create',
    RevisionGet: 'flow.revision.get',
    RevisionList: 'flow.revision.list',
    Presentations: 'plugin.dag.presentations',
    RunList: 'dag.run.list',
    RunResume: 'dag.run.resume',
    RunStart: 'dag.run.start',
    RunGet: 'dag.run.get',
    RunTranscript: 'dag.run.transcript',
    RunCancel: 'dag.run.cancel',
    RunRespond: 'dag.run.respond',
    RunSignal: 'dag.run.signal',
    RunTaskCancel: 'dag.run.task.cancel',
    RunTaskRetry: 'dag.run.task.retry',
    RunGoalUpdate: 'dag.run.goal.update',
} as const;
