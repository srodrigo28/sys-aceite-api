CREATE TYPE "public"."decisao" AS ENUM('aprovado', 'ajustes');--> statement-breakpoint
CREATE TYPE "public"."estado_link" AS ENUM('pendente', 'aprovado', 'ajustes', 'expirado', 'revogado');--> statement-breakpoint
CREATE TYPE "public"."nivel" AS ENUM('n1', 'n2', 'n3');--> statement-breakpoint
CREATE TYPE "public"."papel" AS ENUM('admin', 'membro');--> statement-breakpoint
CREATE TYPE "public"."prioridade" AS ENUM('critica', 'alta', 'media', 'baixa');--> statement-breakpoint
CREATE TYPE "public"."status_os" AS ENUM('a_fazer', 'atendendo', 'pausado', 'em_aprovacao', 'finalizado');--> statement-breakpoint
CREATE TYPE "public"."tipo_os" AS ENUM('evento', 'tarefa');--> statement-breakpoint
CREATE TABLE "anexos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"os_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"url" text NOT NULL,
	"tipo" text,
	"tamanho" integer,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categorias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"cor" text DEFAULT '#6366f1' NOT NULL,
	"multiplicador_sla" real DEFAULT 1 NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_itens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"os_id" uuid NOT NULL,
	"texto" text NOT NULL,
	"feito" boolean DEFAULT false NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comentarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"os_id" uuid NOT NULL,
	"autor_id" uuid,
	"autor_nome" text NOT NULL,
	"texto" text NOT NULL,
	"interno" boolean DEFAULT false NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "historico" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"os_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"descricao" text NOT NULL,
	"autor_nome" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "links_aprovacao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"os_id" uuid NOT NULL,
	"token" text NOT NULL,
	"estado" "estado_link" DEFAULT 'pendente' NOT NULL,
	"mostrar_anexos" boolean DEFAULT true NOT NULL,
	"mostrar_datas" boolean DEFAULT true NOT NULL,
	"mostrar_sla" boolean DEFAULT false NOT NULL,
	"mensagem" text,
	"aprovador_nome_sugerido" text,
	"aprovador_email_sugerido" text,
	"expira_em" timestamp with time zone,
	"criado_por_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"decisao" "decisao",
	"observacao" text,
	"aprovador_nome" text,
	"aprovador_email" text,
	"decidido_em" timestamp with time zone,
	"ip_decisao" text
);
--> statement-breakpoint
CREATE TABLE "ordens_servico" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"projeto_id" uuid NOT NULL,
	"codigo" text NOT NULL,
	"tipo" "tipo_os" DEFAULT 'tarefa' NOT NULL,
	"titulo" text NOT NULL,
	"descricao" text,
	"categoria_id" uuid,
	"prioridade" "prioridade" DEFAULT 'media' NOT NULL,
	"nivel" "nivel" DEFAULT 'n1' NOT NULL,
	"status" "status_os" DEFAULT 'a_fazer' NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	"responsavel_id" uuid,
	"solicitante" text,
	"aberta_em" timestamp with time zone DEFAULT now() NOT NULL,
	"inicio_atendimento_em" timestamp with time zone,
	"primeira_resposta_em" timestamp with time zone,
	"concluida_em" timestamp with time zone,
	"pausada_em" timestamp with time zone,
	"minutos_pausados" integer DEFAULT 0 NOT NULL,
	"aprovado" boolean,
	"aprovador_nome" text,
	"aprovacao_observacao" text,
	"aprovado_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "politicas_sla" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"prioridade" "prioridade" NOT NULL,
	"categoria_id" uuid,
	"nivel" "nivel",
	"minutos_primeira_resposta" integer NOT NULL,
	"minutos_resolucao" integer NOT NULL,
	"ativa" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projetos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"cliente" text NOT NULL,
	"descricao" text,
	"cor" text DEFAULT '#6366f1' NOT NULL,
	"responsavel_id" uuid,
	"arquivado" boolean DEFAULT false NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"slug" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usuarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"email" text NOT NULL,
	"senha_hash" text NOT NULL,
	"cargo" text,
	"avatar_url" text,
	"papel" "papel" DEFAULT 'membro' NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "anexos" ADD CONSTRAINT "anexos_os_id_ordens_servico_id_fk" FOREIGN KEY ("os_id") REFERENCES "public"."ordens_servico"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorias" ADD CONSTRAINT "categorias_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_itens" ADD CONSTRAINT "checklist_itens_os_id_ordens_servico_id_fk" FOREIGN KEY ("os_id") REFERENCES "public"."ordens_servico"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comentarios" ADD CONSTRAINT "comentarios_os_id_ordens_servico_id_fk" FOREIGN KEY ("os_id") REFERENCES "public"."ordens_servico"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comentarios" ADD CONSTRAINT "comentarios_autor_id_usuarios_id_fk" FOREIGN KEY ("autor_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historico" ADD CONSTRAINT "historico_os_id_ordens_servico_id_fk" FOREIGN KEY ("os_id") REFERENCES "public"."ordens_servico"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links_aprovacao" ADD CONSTRAINT "links_aprovacao_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links_aprovacao" ADD CONSTRAINT "links_aprovacao_os_id_ordens_servico_id_fk" FOREIGN KEY ("os_id") REFERENCES "public"."ordens_servico"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links_aprovacao" ADD CONSTRAINT "links_aprovacao_criado_por_id_usuarios_id_fk" FOREIGN KEY ("criado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordens_servico" ADD CONSTRAINT "ordens_servico_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordens_servico" ADD CONSTRAINT "ordens_servico_projeto_id_projetos_id_fk" FOREIGN KEY ("projeto_id") REFERENCES "public"."projetos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordens_servico" ADD CONSTRAINT "ordens_servico_categoria_id_categorias_id_fk" FOREIGN KEY ("categoria_id") REFERENCES "public"."categorias"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordens_servico" ADD CONSTRAINT "ordens_servico_responsavel_id_usuarios_id_fk" FOREIGN KEY ("responsavel_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "politicas_sla" ADD CONSTRAINT "politicas_sla_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "politicas_sla" ADD CONSTRAINT "politicas_sla_categoria_id_categorias_id_fk" FOREIGN KEY ("categoria_id") REFERENCES "public"."categorias"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projetos" ADD CONSTRAINT "projetos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projetos" ADD CONSTRAINT "projetos_responsavel_id_usuarios_id_fk" FOREIGN KEY ("responsavel_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "anexos_os_idx" ON "anexos" USING btree ("os_id");--> statement-breakpoint
CREATE UNIQUE INDEX "categorias_tenant_nome_idx" ON "categorias" USING btree ("tenant_id","nome");--> statement-breakpoint
CREATE INDEX "checklist_os_idx" ON "checklist_itens" USING btree ("os_id");--> statement-breakpoint
CREATE INDEX "comentarios_os_idx" ON "comentarios" USING btree ("os_id");--> statement-breakpoint
CREATE INDEX "historico_os_idx" ON "historico" USING btree ("os_id");--> statement-breakpoint
CREATE UNIQUE INDEX "links_token_idx" ON "links_aprovacao" USING btree ("token");--> statement-breakpoint
CREATE INDEX "links_os_idx" ON "links_aprovacao" USING btree ("os_id");--> statement-breakpoint
CREATE INDEX "links_tenant_idx" ON "links_aprovacao" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "os_tenant_codigo_idx" ON "ordens_servico" USING btree ("tenant_id","codigo");--> statement-breakpoint
CREATE INDEX "os_projeto_status_idx" ON "ordens_servico" USING btree ("projeto_id","status");--> statement-breakpoint
CREATE INDEX "os_tenant_idx" ON "ordens_servico" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "politicas_tenant_idx" ON "politicas_sla" USING btree ("tenant_id","prioridade");--> statement-breakpoint
CREATE INDEX "projetos_tenant_idx" ON "projetos" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_idx" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "usuarios_email_idx" ON "usuarios" USING btree ("email");--> statement-breakpoint
CREATE INDEX "usuarios_tenant_idx" ON "usuarios" USING btree ("tenant_id");