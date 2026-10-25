export class OperationalError extends Error {
  constructor(public readonly rule: string, message: string) {
    super(message);
  }
}
