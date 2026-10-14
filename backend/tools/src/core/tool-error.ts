/** A known tool failure that the model can correct without retrying an unknown effect. */
export class ToolInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}
