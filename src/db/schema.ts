import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

export const userRoleEnum = pgEnum("user_role", ["OWNER", "COLLABORATOR"]);
export const membershipRoleEnum = pgEnum("membership_role", ["ADMIN", "MEMBER"]);
export const siteStatusEnum = pgEnum("site_status", [
  "UNCONFIGURED",
  "VERIFIED",
  "ERROR",
]);
export const auditResultEnum = pgEnum("audit_result", [
  "SUCCESS",
  "FAILURE",
  "DENIED",
]);
export const buildStateEnum = pgEnum("build_state", [
  "pending",
  "running",
  "completed",
  "failed",
]);
export const hostingerOperationStatusEnum = pgEnum(
  "hostinger_operation_status",
  ["IN_PROGRESS", "SUCCEEDED", "FAILED"],
);

export const user = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    role: userRoleEnum("role").default("COLLABORATOR").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    mustChangePassword: boolean("must_change_password").default(true).notNull(),
    banned: boolean("banned").default(false).notNull(),
    banReason: text("ban_reason"),
    banExpires: timestamp("ban_expires", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("users_email_unique").on(sql`lower(${table.email})`),
    index("users_active_idx").on(table.isActive),
  ],
);

export const session = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: uuid("impersonated_by"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("sessions_token_unique").on(table.token),
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const account = pgTable(
  "accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("accounts_provider_account_unique").on(
      table.providerId,
      table.accountId,
    ),
    index("accounts_user_id_idx").on(table.userId),
  ],
);

export const verification = pgTable(
  "verifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);

export const sites = pgTable(
  "sites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    primaryDomain: text("primary_domain").notNull(),
    hostingerUsername: text("hostinger_username").notNull(),
    hostingerOrderId: text("hostinger_order_id"),
    nodeEnabled: boolean("node_enabled").default(false).notNull(),
    status: siteStatusEnum("status").default("UNCONFIGURED").notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("sites_primary_domain_unique").on(
      sql`lower(${table.primaryDomain})`,
    ),
    index("sites_status_idx").on(table.status),
  ],
);

export const siteMemberships = pgTable(
  "site_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: membershipRoleEnum("role").default("MEMBER").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("site_memberships_site_user_unique").on(
      table.siteId,
      table.userId,
    ),
    index("site_memberships_user_id_idx").on(table.userId),
  ],
);

export const hostingerResourceBindings = pgTable(
  "hostinger_resource_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(),
    externalId: text("external_id").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("resource_bindings_site_type_external_unique").on(
      table.siteId,
      table.resourceType,
      table.externalId,
    ),
    index("resource_bindings_lookup_idx").on(table.siteId, table.resourceType),
  ],
);

export const siteBuilds = pgTable(
  "site_builds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    buildUuid: uuid("build_uuid").notNull(),
    state: buildStateEnum("state").notNull(),
    origin: text("origin"),
    hostingerCreatedAt: timestamp("hostinger_created_at", {
      withTimezone: true,
    }),
    hostingerUpdatedAt: timestamp("hostinger_updated_at", {
      withTimezone: true,
    }),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("site_builds_build_uuid_unique").on(table.buildUuid),
    index("site_builds_site_state_idx").on(table.siteId, table.state),
    index("site_builds_site_updated_idx").on(
      table.siteId,
      table.hostingerUpdatedAt,
    ),
  ],
);

export const siteDatabases = pgTable(
  "site_databases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    nameKeyHash: text("name_key_hash").notNull(),
    databaseUser: text("database_user").notNull(),
    verifiedDomain: text("verified_domain").notNull(),
    diskUsageMb: integer("disk_usage_mb"),
    maxSizeMb: integer("max_size_mb"),
    hostingerCreatedAt: timestamp("hostinger_created_at", {
      withTimezone: true,
    }),
    hostingerUpdatedAt: timestamp("hostinger_updated_at", {
      withTimezone: true,
    }),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("site_databases_name_key_unique").on(table.nameKeyHash),
    index("site_databases_site_verified_idx").on(
      table.siteId,
      table.lastVerifiedAt,
    ),
    check(
      "site_databases_name_length_check",
      sql`char_length(${table.name}) BETWEEN 1 AND 128`,
    ),
    check(
      "site_databases_name_key_hash_check",
      sql`${table.nameKeyHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "site_databases_user_length_check",
      sql`char_length(${table.databaseUser}) BETWEEN 1 AND 128`,
    ),
    check(
      "site_databases_domain_length_check",
      sql`char_length(${table.verifiedDomain}) BETWEEN 1 AND 253`,
    ),
    check(
      "site_databases_disk_usage_nonnegative_check",
      sql`${table.diskUsageMb} IS NULL OR ${table.diskUsageMb} >= 0`,
    ),
    check(
      "site_databases_max_size_nonnegative_check",
      sql`${table.maxSizeMb} IS NULL OR ${table.maxSizeMb} >= 0`,
    ),
  ],
);

export const hostingerOperations = pgTable(
  "hostinger_operations",
  {
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    operationType: text("operation_type").notNull(),
    resourceKeyHash: text("resource_key_hash"),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    status: hostingerOperationStatusEnum("status")
      .default("IN_PROGRESS")
      .notNull(),
    referenceId: text("reference_id").notNull(),
    correlationId: text("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      name: "hostinger_operations_identity_pk",
      columns: [
        table.siteId,
        table.operationType,
        table.idempotencyKeyHash,
      ],
    }),
    uniqueIndex("hostinger_operations_reference_unique").on(
      table.referenceId,
    ),
    uniqueIndex("hostinger_operations_active_unscoped_unique")
      .on(table.siteId, table.operationType)
      .where(
        sql`${table.status} = 'IN_PROGRESS' AND ${table.resourceKeyHash} IS NULL`,
      ),
    uniqueIndex("hostinger_operations_active_resource_unique")
      .on(table.siteId, table.resourceKeyHash)
      .where(
        sql`${table.status} = 'IN_PROGRESS' AND ${table.resourceKeyHash} IS NOT NULL`,
      ),
    index("hostinger_operations_site_created_idx").on(
      table.siteId,
      table.operationType,
      table.createdAt,
    ),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorUserId: uuid("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    operation: text("operation").notNull(),
    targetType: text("target_type").notNull(),
    targetIdentifierHash: text("target_identifier_hash"),
    result: auditResultEnum("result").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_events_created_at_idx").on(table.createdAt),
    index("audit_events_actor_idx").on(table.actorUserId),
    index("audit_events_site_idx").on(table.siteId),
    index("audit_events_operation_idx").on(table.operation),
  ],
);

export const schema = {
  user,
  session,
  account,
  verification,
  sites,
  siteMemberships,
  hostingerResourceBindings,
  siteBuilds,
  siteDatabases,
  hostingerOperations,
  auditEvents,
};

export type AppUser = typeof user.$inferSelect;
export type Site = typeof sites.$inferSelect;
