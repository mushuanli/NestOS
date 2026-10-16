/** A known tool failure that the model can correct without retrying an unknown effect. */
export class ToolInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/** Output failures happen after execution and must not invite replaying side effects. */
export class ToolOutputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ToolOutputError';
  }
}
