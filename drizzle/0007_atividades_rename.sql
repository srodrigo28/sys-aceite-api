-- A-1: a O.S. de hoje vira Atividade.
--
-- Renomeia APENAS a tabela. As colunas `os_id` das tabelas filhas ficam como
-- estao de proposito: elas vivem dentro de tabelas que nao sao renomeadas, e
-- nenhuma view de compatibilidade alcanca uma coluna nessa situacao. Renomea-las
-- aqui derrubaria o codigo antigo sem rede. Elas viram `atividade_id` no A-4,
-- quando nao houver mais codigo antigo rodando.
--
-- As foreign keys acompanham o rename sozinhas: elas apontam para o OID da
-- tabela, nao para o nome.
ALTER TABLE "ordens_servico" RENAME TO "atividades";
--> statement-breakpoint

-- Ponte temporaria.
--
-- API e web sao containers separados, e o painel nao roda migration: sao tres
-- passos que nao acontecem juntos. Entre esta migration e o redeploy da API, o
-- codigo antigo ainda consulta `ordens_servico` — sem esta view, seria 500 em
-- tudo, inclusive na pagina publica de aprovacao que 80 links de cliente
-- apontam.
--
-- View de tabela unica e automaticamente atualizavel no Postgres: SELECT,
-- INSERT, UPDATE e DELETE do codigo antigo continuam funcionando, e os defaults
-- da tabela base valem para quem insere pela view.
--
-- CAI NO A-4, junto com as rotas /os antigas.
CREATE VIEW "ordens_servico" AS SELECT * FROM "atividades";
