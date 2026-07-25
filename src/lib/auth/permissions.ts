import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
} from "better-auth/plugins/admin/access";

export const authAccessControl = createAccessControl(defaultStatements);

export const ownerAuthRole = authAccessControl.newRole({
  ...adminAc.statements,
});

export const collaboratorAuthRole = authAccessControl.newRole({
  user: [],
  session: [],
});
