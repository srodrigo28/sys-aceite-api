ALTER TABLE "anexos" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "anexos" ALTER COLUMN "tamanho" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "anexos" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "anexos" ADD COLUMN "file_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "anexos" ADD COLUMN "storage" text NOT NULL;--> statement-breakpoint
ALTER TABLE "anexos" ADD COLUMN "caminho" text NOT NULL;--> statement-breakpoint
ALTER TABLE "anexos" ADD COLUMN "mime_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "anexos" ADD COLUMN "checksum" text;--> statement-breakpoint
ALTER TABLE "anexos" ADD COLUMN "enviado_por_id" uuid;--> statement-breakpoint
ALTER TABLE "anexos" ADD CONSTRAINT "anexos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anexos" ADD CONSTRAINT "anexos_enviado_por_id_usuarios_id_fk" FOREIGN KEY ("enviado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "anexos_tenant_idx" ON "anexos" USING btree ("tenant_id");