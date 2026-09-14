-- A11: os codigos das atividades passam de OS- para AT-.
--
-- `OS` ficou para a ordem de servico de faturamento, criada na 0012, que tem o
-- proprio contador. Sem prefixos distintos, uma atividade e uma O.S. poderiam
-- carregar o mesmo codigo e ninguem saberia de qual se fala.
--
-- Decisao 6, com a ressalva registrada na epoca: o codigo aparece na pagina
-- publica de aprovacao, entao um link ja enviado passa a mostrar AT- em vez de
-- OS-. Os dados sao quase todos de teste — o risco foi aceito conscientemente.
UPDATE "atividades" SET "codigo" = 'AT-' || substring("codigo" from 4)
WHERE "codigo" LIKE 'OS-%';
