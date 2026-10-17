// @file: llm-ui/domain/ports/IStatusPresenter.ts

import type { SessionSnapshot } from '@itookit/llm-session/contracts';

export interface IStatusPresenter {
    update(status: string): void;
    updateFromSnapshot(snapshot: SessionSnapshot): void;
    updateBackground(payload: { running: number; queued: number }): void;
    cacheElements(): void;
    destroy(): void;
}
