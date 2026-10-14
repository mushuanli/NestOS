// @file: llm-ui/commands/Command.ts

import type { CommandContext } from './CommandContext';
import type { ErrorSeverity } from '../utils/errorHandler';

export type { CommandContext };

export abstract class Command<TParams = void, TResult = void> {
    protected abstract readonly name: string;
    protected severity: ErrorSeverity = 'toast';

    constructor(protected ctx: CommandContext) { }

    async run(params: TParams): Promise<TResult | undefined> {
        return this.ctx.errorHandler.wrap(
            () => this.execute(params),
            this.name,
            this.severity
        );
    }

    protected abstract execute(params: TParams): Promise<TResult>;
}
