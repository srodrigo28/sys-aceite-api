-- B-1: uma atividade passa a poder ter varios responsaveis.
--
-- `atividades.responsavel_id` NAO cai aqui. Ela sai so depois que a API no ar
-- ja estiver lendo desta tabela — derrubar a coluna junto com o codigo que
-- ainda a le e o jeito mais rapido de quebrar producao.
CREATE TABLE "atividade_responsaveis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"atividade_id" uuid NOT NULL,
	"usuario_id" uuid NOT NULL,
	"principal" boolean DEFAULT false NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "atividade_responsaveis" ADD CONSTRAINT "atividade_responsaveis_atividade_id_fk"
	FOREIGN KEY ("atividade_id") REFERENCES "public"."atividades"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "atividade_responsaveis" ADD CONSTRAINT "atividade_responsaveis_usuario_id_fk"
	FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX "atividade_responsaveis_idx" ON "atividade_responsaveis" ("atividade_id","usuario_id");
--> statement-breakpoint
CREATE INDEX "atividade_responsaveis_usuario_idx" ON "atividade_responsaveis" ("usuario_id");
--> statement-breakpoint

-- Exatamente um principal por atividade.
--
-- Indice parcial, nao constraint: o banco recusa um segundo principal, mas nao
-- exige que exista um. Atividade sem responsavel nenhum continua valida — e o
-- estado de uma atividade recem-criada e sem dono.
CREATE UNIQUE INDEX "atividade_um_principal_idx"
	ON "atividade_responsaveis" ("atividade_id") WHERE "principal";
--> statement-breakpoint

-- Backfill: cada responsavel_id nao nulo vira o principal da sua atividade.
INSERT INTO "atividade_responsaveis" ("atividade_id", "usuario_id", "principal")
SELECT "id", "responsavel_id", true FROM "atividades" WHERE "responsavel_id" IS NOT NULL;
