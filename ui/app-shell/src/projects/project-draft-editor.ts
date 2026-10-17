import type { ProjectDraftComposer } from '@itookit/app-contracts/services';
import type { IEditor, SessionDraftControls } from '@itookit/ui-common';

/** Navigation adapts a headless draft use case into editor controls. */
export function createProjectDraftControls(composer: ProjectDraftComposer,
    navigation: { check(): Promise<void>; open(id: string): Promise<IEditor> }): SessionDraftControls<import('@itookit/llm-flow/contracts').SessionSubmission> {
    return {
        initialData: composer.initialData,
        attachments: composer.attachments,
        refresh: async () => {
            const next = await composer.refresh?.();
            return next ? createProjectDraftControls(next, navigation) : undefined;
        },
        save: data => composer.save(data),
        clear: () => composer.clear(),
        materialize: async () => {
            await navigation.check();
            const prepared = await composer.prepare();
            const editor = await navigation.open(prepared.sessionId);
            return { editor, resumeOnly: prepared.resumeOnly, submission: prepared.submission };
        },
    };
}
