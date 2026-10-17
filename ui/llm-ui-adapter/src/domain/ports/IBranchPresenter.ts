// @file: llm-ui/domain/ports/IBranchPresenter.ts

export interface IBranchPresenter {
    refresh(): Promise<void>;
    flash(): void;
    destroy(): void;
}
