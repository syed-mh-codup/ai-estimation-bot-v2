export type AgentStep =
  | 'LIBRARIAN'
  | 'COMPLEXITY'
  | 'DETECTIVE'
  | 'ARCHIVIST'
  | 'SPECIALIST_DEV'
  | 'SPECIALIST_QA'
  | 'SPECIALIST_PM'
  | 'SPECIALIST_BA'
  | 'TAXATION'
  | 'HIDDEN_WORK'
  | 'VALIDATION'
  | 'ARCHITECT';

export class StepError extends Error {
  constructor(
    public readonly step: AgentStep,
    public readonly cause: unknown,
    public readonly retriable: boolean = true,
  ) {
    super(
      `Agent step ${step} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'StepError';
  }
}

export async function withRetry<T>(
  step: AgentStep,
  fn: () => Promise<T>,
  maxRetries = 1,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) break;
    }
  }
  throw new StepError(step, lastError, false);
}
