import type { ProjectDraftComposer } from '@itookit/app-contracts/services';
import type { IEditor, SessionDraftControls, SessionDraftMaterialization } from '@itookit/ui-common';

/** Navigation adapts a headless draft use case into editor controls. */
export function createProjectDraftControls(composer: ProjectDraftComposer,
    navigation: { check(): Promise<void>; open(id: string, request?: SessionDraftMaterialization): Promise<IEditor>;
        remote?(request: SessionDraftMaterialization): Promise<IEditor>; identity?(id: string): void },
    presentation: Pick<SessionDraftControls, 'scope' | 'executorScope'> = {}): SessionDraftControls<import('@itookit/llm-flow/contracts').SessionSubmission> {
    let identity = composer.id;
    return {
        ...presentation,
        get id() {return identity;},
        inPlace: !!navigation.remote,
        initialData: composer.initialData,
        attachments: composer.attachments,
        refresh: async () => {
            const next = await composer.refresh?.();
            if (next?.id) navigation.identity?.(next.id);
            return next ? createProjectDraftControls(next, navigation, presentation) : undefined;
        },
        save: data => composer.save(data),
        clear: async () => {
            const next = await composer.clear(); identity = typeof next === 'string' ? next : composer.id;
            if (identity) navigation.identity?.(identity);
        },
        materialize: async request => {
            await navigation.check();
            if (request?.agentId?.startsWith('remote:') && navigation.remote)
                return {editor: await navigation.remote(request), resumeOnly: false};
            const prepared = await composer.prepare();
            const editor = await navigation.open(prepared.sessionId, request);
            return { editor, resumeOnly: prepared.resumeOnly, submission: prepared.submission };
        },
    };
}
