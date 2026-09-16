export class MemoryHouseError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MemoryHouseError';
    this.code = code;
    Object.assign(this, details);
  }
}
