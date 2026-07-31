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

export function claimDatabaseRequest(
  activeDatabaseIds: Set<string>,
  databaseId: string,
) {
  if (activeDatabaseIds.has(databaseId)) return false;
  activeDatabaseIds.add(databaseId);
  return true;
}

export function releaseDatabaseRequest(
  activeDatabaseIds: Set<string>,
  databaseId: string,
) {
  activeDatabaseIds.delete(databaseId);
}
