export const nodeReadPermissions = [
  "node.deployments.read",
  "node.logs.read",
] as const;

export type NodeReadPermission = (typeof nodeReadPermissions)[number];

export function hasNodeReadPermission(
  membershipRole: "ADMIN" | "MEMBER",
  permission: NodeReadPermission,
) {
  return (
    (membershipRole === "ADMIN" || membershipRole === "MEMBER") &&
    nodeReadPermissions.includes(permission)
  );
}
