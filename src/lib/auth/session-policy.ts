export function isAccountActive(
  record: { isActive?: boolean | null } | null | undefined,
) {
  return record?.isActive === true;
}

export function requiresPasswordChange(record: {
  mustChangePassword?: boolean | null;
}) {
  return record.mustChangePassword === true;
}
