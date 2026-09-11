CREATE TYPE "public"."estado_convite" AS ENUM('pendente', 'aceito', 'expirado', 'revogado');--> statement-breakpoint
CREATE TABLE "convite_projetos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"convite_id" uuid NOT NULL,
	"projeto_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "convites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"nome" text NOT NULL,
	"papel" "papel" DEFAULT 'membro' NOT NULL,
	"cargo" text,
	"mensagem" text,
	"token" text NOT NULL,
	"estado" "estado_convite" DEFAULT 'pendente' NOT NULL,
	"expira_em" timestamp with time zone,
	"convidado_por_id" uuid,
	"usuario_id" uuid,
	"aceito_em" timestamp with time zone,
	"email_enviado_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projeto_membros" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"projeto_id" uuid NOT NULL,
	"usuario_id" uuid NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usuarios" ADD COLUMN "ativo" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "convite_projetos" ADD CONSTRAINT "convite_projetos_convite_id_convites_id_fk" FOREIGN KEY ("convite_id") REFERENCES "public"."convites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "convite_projetos" ADD CONSTRAINT "convite_projetos_projeto_id_projetos_id_fk" FOREIGN KEY ("projeto_id") REFERENCES "public"."projetos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "convites" ADD CONSTRAINT "convites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "convites" ADD CONSTRAINT "convites_convidado_por_id_usuarios_id_fk" FOREIGN KEY ("convidado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "convites" ADD CONSTRAINT "convites_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projeto_membros" ADD CONSTRAINT "projeto_membros_projeto_id_projetos_id_fk" FOREIGN KEY ("projeto_id") REFERENCES "public"."projetos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projeto_membros" ADD CONSTRAINT "projeto_membros_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "convite_projetos_idx" ON "convite_projetos" USING btree ("convite_id","projeto_id");--> statement-breakpoint
CREATE UNIQUE INDEX "convites_token_idx" ON "convites" USING btree ("token");--> statement-breakpoint
CREATE INDEX "convites_tenant_estado_idx" ON "convites" USING btree ("tenant_id","estado");--> statement-breakpoint
CREATE INDEX "convites_email_idx" ON "convites" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "projeto_membros_idx" ON "projeto_membros" USING btree ("projeto_id","usuario_id");--> statement-breakpoint
CREATE INDEX "projeto_membros_usuario_idx" ON "projeto_membros" USING btree ("usuario_id");