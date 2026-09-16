export class MemoryHouseError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MemoryHouseError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function safeError(error) {
  return error instanceof MemoryHouseError
    ? { code: error.code, message: error.message }
    : { code: 'OPERATION_FAILED', message: 'Memory House could not complete this operation. Check sign-in status and retry.' };
}
