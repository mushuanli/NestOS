import {FSError} from '@itookit/vfs-core';
import {FlowInvocationCommand, SessionCommand} from '@itookit/llm-session/contracts';
import type {SessionPresentationState, ApplicationBackend, LocalApplicationServices, OpenedApplicationView, OpenViewRequest, WorkbenchView} from '@itookit/app-contracts/services';
import {ViewObservation} from './view-observation';
import {taskAttachment} from './task-attachment';

/** A cold view can activate immediately because it cannot replace an existing editor binding. */
export async function openView(services: LocalApplicationServices, backend: ApplicationBackend, request: OpenViewRequest): Promise<OpenedApplicationView> {
    if (request.workbench.initialSessionId && services.sessionManager.getSnapshot().sessionId)
        throw new FSError('EBUSY', 'Cold view opening requires an unbound client');
    const observation = new ViewObservation(services);
    let workbench: WorkbenchView | undefined;
    try {
        const results = await Promise.allSettled([backend.workbenchView(request.workbench), backend.readUiDocuments(request.documents)]);
        if (results[0].status === 'fulfilled') workbench = results[0].value;
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        await observation.addChat(workbench!, workbench?.initialSession?.manifest.id);
        const initial = workbench?.initialSession ? await prepareInitial(services, workbench, request, observation) : undefined;
        const projectId = workbench?.initialSession?.project?.project.id;
        const connectionInterests = projectId && services.projects.remoteMounts?.list(projectId).length ? [projectId] : [];
        await workbench?.connections?.update(connectionInterests, 0);
        const cursor = observation.getViewCursor();
        // This synchronous projection and cursor form the baseline for subsequent Session events.
        if (initial) alignSnapshot(services, initial);
        return {documents: (results[1] as PromiseFulfilledResult<Record<string, unknown>>).value, workbench: workbench!, initial, observation, cursor,
            taskAttachmentKey: request.taskAttachmentKey,
            connectionInterests,
            dispose: () => closeOpenedView(observation, workbench)};
    } catch (error) {
        const cleanup = await Promise.allSettled([closeOpenedView(observation, workbench), rollbackBinding(services, workbench)]);
        const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length) throw new AggregateError([error, ...failures], 'View opening and cleanup failed');
        throw error;
    }
}

function alignSnapshot(services: LocalApplicationServices, initial: NonNullable<OpenedApplicationView['initial']>): void {
    const snapshot = structuredClone(services.sessionManager.getSnapshot());
    if (snapshot.sessionId !== initial.sessionId) throw new FSError('EBUSY', 'Initial view binding changed');
    initial.snapshot = snapshot;
    if (snapshot.view) {
        initial.manifest = snapshot.view.manifest;
        initial.settings = snapshot.view.settings;
        initial.title = snapshot.view.manifest.title;
    }
}

async function rollbackBinding(services: LocalApplicationServices, view?: WorkbenchView): Promise<void> {
    const id = view?.initialSession?.manifest.id;
    if (id && services.sessionManager.getSnapshot().sessionId === id) await services.commandBus.execute(SessionCommand.Unbind);
}

async function prepareInitial(services: LocalApplicationServices, view: WorkbenchView, request: OpenViewRequest, observation: ViewObservation) {
    const initial = await view.initialSession!.activate(request.branch), sessionId = initial.sessionId;
    const before = observation.getViewCursor();
    const [recovery, flowInvocations, skills] = await Promise.allSettled([
        request.taskAttachmentKey ? taskAttachment(services, sessionId, request.taskAttachmentKey) : undefined,
        services.commandBus.execute<NonNullable<SessionPresentationState['flowInvocations']>>(FlowInvocationCommand.List, {sessionId}),
        view.chat?.sessionSkills.list(sessionId),
    ]);
    if (recovery.status === 'rejected') throw recovery.reason;
    if (flowInvocations.status === 'rejected') throw flowInvocations.reason;
    if (skills.status === 'rejected') throw skills.reason;
    const presentation: SessionPresentationState = {};
    if (!observation.changedSince(before, ['kernel', 'session'], sessionId)) presentation.taskAttachment = recovery.value;
    if (!observation.changedSince(before, ['kernel', 'repository'], sessionId)) presentation.flowInvocations = flowInvocations.value;
    if (!observation.changedSince(before, ['skills', 'agents'])) presentation.skills = skills.value;
    return {...initial, ...presentation};
}

async function closeOpenedView(observation: ViewObservation, view?: WorkbenchView): Promise<void> {
    const results = await Promise.allSettled([observation.dispose(), view?.connections?.dispose(), view?.initialSession?.dispose(),
        view?.chat?.configuration?.dispose(), view?.browser.dispose()]);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Opened view cleanup failed');
}
