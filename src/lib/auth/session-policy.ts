export function isAccountActive(
  record: { isActive: boolean } | null | undefined,
) {
  return record?.isActive === true;
}

export function requiresPasswordChange(record: {
  mustChangePassword: boolean;
}) {
  return record.mustChangePassword;
}
