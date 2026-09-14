-- Area E: a O.S. de faturamento.
--
-- Nao e trabalho — trabalho e `atividades`. Aqui nao ha SLA, prioridade nem
-- coluna de kanban: ela agrupa as atividades de um projeto num mes e soma as
-- horas. Os totais sao calculados na leitura, nunca gravados.
CREATE TYPE "public"."status_ordem" AS ENUM('aberta', 'em_execucao', 'em_revisao', 'aprovada', 'finalizada');--> statement-breakpoint

CREATE TABLE "ordens_servico" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"projeto_id" uuid NOT NULL,
	"codigo" text NOT NULL,
	"ano" integer NOT NULL,
	"mes" integer NOT NULL,
	"status" "status_ordem" DEFAULT 'aberta' NOT NULL,
	"responsavel_id" uuid,
	"observacao" text,
	"aberta_em" timestamp with time zone DEFAULT now() NOT NULL,
	"execucao_em" timestamp with time zone,
	"revisao_em" timestamp with time zone,
	"aprovada_em" timestamp with time zone,
	"finalizada_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ordens_servico" ADD CONSTRAINT "ordens_tenant_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "ordens_servico" ADD CONSTRAINT "ordens_projeto_fk"
	FOREIGN KEY ("projeto_id") REFERENCES "public"."projetos"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "ordens_servico" ADD CONSTRAINT "ordens_responsavel_fk"
	FOREIGN KEY ("responsavel_id") REFERENCES "public"."usuarios"("id") ON DELETE set null;--> statement-breakpoint

-- A regra do modelo, escrita no banco: uma O.S. por projeto por mes.
CREATE UNIQUE INDEX "ordens_projeto_periodo_idx" ON "ordens_servico" ("projeto_id","ano","mes");--> statement-breakpoint
CREATE UNIQUE INDEX "ordens_tenant_codigo_idx" ON "ordens_servico" ("tenant_id","codigo");--> statement-breakpoint
CREATE INDEX "ordens_tenant_idx" ON "ordens_servico" ("tenant_id");--> statement-breakpoint

-- NULLABLE de proposito. Vira NOT NULL so depois que a API no ar estiver
-- atribuindo em toda criacao — apertar agora quebraria todo INSERT vindo do
-- codigo que ainda nao conhece a coluna.
ALTER TABLE "atividades" ADD COLUMN "os_id" uuid;--> statement-breakpoint
ALTER TABLE "atividades" ADD CONSTRAINT "atividades_os_fk"
	FOREIGN KEY ("os_id") REFERENCES "public"."ordens_servico"("id") ON DELETE set null;--> statement-breakpoint

-- Backfill: uma O.S. por (projeto, ano, mes) que ja tenha atividade.
--
-- O mes vem de `previsto_inicio_em` e cai para `aberta_em` quando nao ha
-- previsao — mesma regra que a API vai aplicar daqui para frente. Sem o
-- fallback, atividade sem planejamento ficaria sem O.S.
INSERT INTO "ordens_servico" ("tenant_id", "projeto_id", "ano", "mes", "codigo", "aberta_em")
SELECT
	p.tenant_id,
	p.projeto_id,
	p.ano,
	p.mes,
	'OS-' || p.ano || '-' || lpad(
		(row_number() OVER (PARTITION BY p.tenant_id, p.ano ORDER BY p.mes, p.projeto_id))::text, 4, '0'),
	p.primeira
FROM (
	SELECT
		a.tenant_id,
		a.projeto_id,
		EXTRACT(YEAR  FROM COALESCE(a.previsto_inicio_em, a.aberta_em))::int AS ano,
		EXTRACT(MONTH FROM COALESCE(a.previsto_inicio_em, a.aberta_em))::int AS mes,
		MIN(a.aberta_em) AS primeira
	FROM "atividades" a
	GROUP BY 1, 2, 3, 4
) p;
--> statement-breakpoint

UPDATE "atividades" a
SET "os_id" = o.id
FROM "ordens_servico" o
WHERE o.projeto_id = a.projeto_id
  AND o.ano = EXTRACT(YEAR  FROM COALESCE(a.previsto_inicio_em, a.aberta_em))::int
  AND o.mes = EXTRACT(MONTH FROM COALESCE(a.previsto_inicio_em, a.aberta_em))::int;
