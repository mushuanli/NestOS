// @file: llm-ui/components/templates/DialogTemplates.ts

export const DialogTemplates = {
    /**
     * 渲染分支命名对话框
     */
    renderBranchNameDialog: () => `
        <div class="llm-branch-name-dialog__overlay"></div>
        <div class="llm-branch-name-dialog__content">
            <h4>Create New Branch</h4>
            <p>Enter a name for this branch (optional):</p>
            <input type="text" class="llm-input" placeholder="Branch name">
            <div class="llm-branch-name-dialog__actions">
                <button class="llm-btn" data-action="cancel">Cancel</button>
                <button class="llm-btn llm-btn--primary" data-action="create">Create</button>
            </div>
        </div>
    `,

    /**
     * 渲染确认对话框
     */
    renderConfirmDialog: (message: string) => `
        <div class="llm-confirm-dialog__overlay"></div>
        <div class="llm-confirm-dialog__content">
            <h4>Confirm</h4>
            <p>${message}</p>
            <div class="llm-confirm-dialog__actions">
                <button class="llm-btn" data-action="cancel">Cancel</button>
                <button class="llm-btn llm-btn--danger" data-action="confirm">Confirm</button>
            </div>
        </div>
    `
};
