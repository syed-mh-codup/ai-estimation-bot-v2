export class AuthError extends Error {
  constructor(
    /**
     * 404 is an authorisation outcome here, not a routing one: a thread that
     * exists but belongs to someone else is reported as missing rather than
     * forbidden, because confirming it exists already leaks what a colleague is
     * looking into. See lib/oracle-access.ts.
     */
    public readonly status: 401 | 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
