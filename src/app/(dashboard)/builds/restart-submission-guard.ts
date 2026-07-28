export type RestartSubmissionLock = { current: boolean };

export const NODE_RESTARTED_EVENT = "hostinger:node-restarted";

export function claimRestartSubmission(lock: RestartSubmissionLock) {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function releaseRestartSubmission(lock: RestartSubmissionLock) {
  lock.current = false;
}
