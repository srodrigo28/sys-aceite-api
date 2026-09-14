-- B-3b: a coluna orfa sai.
--
-- `responsavel_id` deixou de ser escrita e de ser selecionada no B-3a, que ja
-- esta no ar e verificado. Quem responde pela atividade vive em
-- `atividade_responsaveis`; a API ainda devolve `responsavelId` na resposta,
-- mas DERIVADO do primeiro da lista.
--
-- Sem perda de dado: os 34 vinculos foram copiados no backfill da 0009, e
-- conferidos linha a linha antes deste passo.
ALTER TABLE "atividades" DROP COLUMN IF EXISTS "responsavel_id";
