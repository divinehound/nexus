import { ApiError } from '@/lib/api';

/** A readable message for a failed sign-in step, including the browser's passkey errors. */
export function authErrorMessage(err: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (err instanceof ApiError) return err.data?.message || err.message || fallback;
  if (err instanceof Error) {
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') return 'The passkey prompt was closed.';
    if (err.name === 'InvalidStateError') return 'This device already has a passkey for this account.';
    return err.message || fallback;
  }
  return fallback;
}
