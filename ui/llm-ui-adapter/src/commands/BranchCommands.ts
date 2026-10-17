// @file: llm-ui/commands/BranchCommands.ts

import { Command } from './Command';
import { Toast, showConfirmDialog } from '@itookit/ui-common';
import { BranchError } from '../services/BranchService';
import type { BranchItem } from '../domain/types';

// ── Create ────────────────────────────────────────────

export class CreateBranchCommand extends Command<{ sourceNodeId: string }> {
    protected readonly name = 'Create Branch';

    protected async execute({ sourceNodeId }: { sourceNodeId: string }): Promise<void> {
        const branchName = await this.promptBranchName();
        if (branchName === null) return;
        await this.ctx.branchService.create(sourceNodeId, branchName);
        Toast.success(`Branch "${branchName || 'Untitled'}" created`);
    }

    private promptBranchName(): Promise<string | null> {
        return new Promise((resolve) => {
            const dialog = document.createElement('div');
            dialog.className = 'llm-branch-name-dialog';
            dialog.innerHTML = `
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
            `;

            document.body.appendChild(dialog);
            const input = dialog.querySelector('input') as HTMLInputElement;
            input.focus();

            const cleanup = () => dialog.remove();
            const submit = () => { cleanup(); resolve(input.value.trim()); };
            const cancel = () => { cleanup(); resolve(null); };

            dialog.querySelector('[data-action="create"]')?.addEventListener('click', submit);
            dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', cancel);
            dialog.querySelector('.llm-branch-name-dialog__overlay')?.addEventListener('click', cancel);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') submit();
                else if (e.key === 'Escape') cancel();
            });
        });
    }
}

// ── Switch ────────────────────────────────────────────

export class SwitchBranchCommand extends Command<{ branchName: string }> {
    protected readonly name = 'Switch Branch';

    protected async execute({ branchName }: { branchName: string }): Promise<void> {
        try {
            await this.ctx.branchService.switch(branchName);
        } catch (e) {
            if (e instanceof BranchError && e.code === 'ALREADY_CURRENT') {
                Toast.info(e.message);
                return;
            }
            throw e;
        }
    }
}

export class SwitchBranchByIdCommand extends Command<{ headNodeId: string }> {
    protected readonly name = 'Switch Branch By ID';

    protected async execute({ headNodeId }: { headNodeId: string }): Promise<void> {
        await this.ctx.branchService.switchById(headNodeId);
    }
}

export class SwitchBranchByOffsetCommand extends Command<{ offset: number; cachedBranches: BranchItem[] }> {
    protected readonly name = 'Switch Branch By Offset';

    protected async execute({ offset, cachedBranches }: { offset: number; cachedBranches: BranchItem[] }): Promise<void> {
        try {
            await this.ctx.branchService.switchByOffset(offset, cachedBranches);
        } catch (e) {
            if (e instanceof BranchError && e.code === 'NO_OTHER') {
                Toast.info('No other branches to switch to');
                return;
            }
            throw e;
        }
    }
}

// ── Rename ────────────────────────────────────────────

export class RenameBranchCommand extends Command<{ oldName: string; newName: string }> {
    protected readonly name = 'Rename Branch';

    protected async execute({ oldName, newName }: { oldName: string; newName: string }): Promise<void> {
        await this.ctx.branchService.rename(oldName, newName);
        Toast.success('Branch renamed');
    }
}

// ── Delete ────────────────────────────────────────────

export class DeleteBranchCommand extends Command<{ branchName: string }> {
    protected readonly name = 'Delete Branch';

    protected async execute({ branchName }: { branchName: string }): Promise<void> {
        const confirmed = await showConfirmDialog(
            `Delete branch "${branchName}" and all its unique children?`
        );
        if (!confirmed) return;
        await this.ctx.branchService.delete(branchName);
        Toast.success('Branch deleted');
    }
}
