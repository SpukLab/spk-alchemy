/** Typed errors. The portable contract reports these; adapters must map to them. */
export class SpkError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}
export class UniquenessError extends SpkError {
  constructor(collection: string, index: string, detail: string) {
    super('UNIQUENESS', `unique index ${collection}.${index} violated: ${detail}`);
  }
}
export class IntegrityError extends SpkError {
  constructor(detail: string) { super('INTEGRITY', detail); }
}
export class BatchTooLargeError extends SpkError {
  constructor(size: number, max: number) {
    super('BATCH_TOO_LARGE', `batch of ${size} mutations exceeds bounded maximum ${max}`);
  }
}
export class NotFoundError extends SpkError {
  constructor(collection: string, id: string) {
    super('NOT_FOUND', `${collection}/${id} not found`);
  }
}
export class DomainRuleError extends SpkError {
  constructor(detail: string) { super('DOMAIN_RULE', detail); }
}
export class KeyEncodingError extends SpkError {
  constructor(detail: string) { super('KEY_ENCODING', detail); }
}
