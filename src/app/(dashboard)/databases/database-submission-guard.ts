export type DatabaseSubmissionLock = {
  current: boolean;
};

export function claimDatabaseSubmission(
  lock: DatabaseSubmissionLock,
) {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function releaseDatabaseSubmission(
  lock: DatabaseSubmissionLock,
) {
  lock.current = false;
}
