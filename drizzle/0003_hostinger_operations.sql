CREATE TYPE "public"."hostinger_operation_status" AS ENUM('IN_PROGRESS', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TABLE "hostinger_operations" (
	"site_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"operation_type" text NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"status" "hostinger_operation_status" DEFAULT 'IN_PROGRESS' NOT NULL,
	"reference_id" text NOT NULL,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "hostinger_operations_identity_pk" PRIMARY KEY("site_id","operation_type","idempotency_key_hash")
);
--> statement-breakpoint
ALTER TABLE "hostinger_operations" ADD CONSTRAINT "hostinger_operations_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostinger_operations" ADD CONSTRAINT "hostinger_operations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hostinger_operations_reference_unique" ON "hostinger_operations" USING btree ("reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hostinger_operations_active_site_type_unique" ON "hostinger_operations" USING btree ("site_id","operation_type") WHERE "hostinger_operations"."status" = 'IN_PROGRESS';--> statement-breakpoint
CREATE INDEX "hostinger_operations_site_created_idx" ON "hostinger_operations" USING btree ("site_id","operation_type","created_at");