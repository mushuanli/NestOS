// @file: llm-ui/domain/ports/IStreamingController.ts

/** Focused interface for streaming mode lifecycle — extracted from IHistoryPresenter (ISP). */
export interface IStreamingController {
    enterStreamingMode(): void;
    exitStreamingMode(): void;
}
