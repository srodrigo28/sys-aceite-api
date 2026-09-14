-- Areas C e D: datas previstas e horas. Mais `observacoes`, que o mockup
-- revelou e nao existia.
--
-- Tudo aditivo e opcional: nenhuma linha existente precisa de valor, e nenhum
-- cliente antigo quebra por nao conhecer os campos.
--
-- As datas previstas sao PLANEJAMENTO. Nao tocam em `inicio_atendimento_em`
-- nem em `concluida_em`, que sao execucao e alimentam o SLA — se o
-- replanejamento escrevesse la, mudar a data de uma atividade "consertaria" um
-- SLA estourado sozinho.
ALTER TABLE "atividades" ADD COLUMN "previsto_inicio_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "atividades" ADD COLUMN "previsto_fim_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "atividades" ADD COLUMN "minutos_estimados" integer;--> statement-breakpoint
ALTER TABLE "atividades" ADD COLUMN "minutos_apontados" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "atividades" ADD COLUMN "observacoes" text;
