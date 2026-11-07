export class SafeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SafeError';
    this.code = code;
  }
}

// Never return upstream errors, response bodies, request headers or filesystem
// exception messages: any of those can contain session or financial data.
export function publicError(error) {
  if (error instanceof SafeError) return { code: error.code, message: error.message };
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return { code: 'REQUEST_CANCELLED', message: 'The request was cancelled or timed out. Retry the same page.' };
  }
  return { code: 'INTERNAL_ERROR', message: 'The request failed. No response body or credentials were logged.' };
}
