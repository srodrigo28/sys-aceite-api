-- Area H: a paleta de categorias vira propriedade do TEMA.
--
-- A paleta semeada hoje reprova nos testes de contraste contra a superficie
-- escura: `#14b8a6` (Conteudo) e `#0ea5e9` (Suporte) ficam a dE 12.8 em visao
-- NORMAL, abaixo do piso de 15 — nao e daltonismo, e contraste insuficiente
-- entre os dois tons. Em barra fina de calendario fica pior que num badge.
--
-- Guardar hex no banco obrigaria uma migracao a cada correcao de tom, e nao
-- resolveria o modo escuro: cada cor precisa de um tom por superficie. O slot
-- aponta para `--cat-N` em globals.css, que ja define os dois.
--
-- `cor` fica para categoria que o cliente cria com cor livre.
ALTER TABLE "categorias" ADD COLUMN "slot" integer;--> statement-breakpoint

-- Backfill das seis semeadas, pela cor antiga.
UPDATE "categorias" SET "slot" = 1 WHERE "cor" = '#6366f1';--> statement-breakpoint
UPDATE "categorias" SET "slot" = 2 WHERE "cor" = '#ec4899';--> statement-breakpoint
UPDATE "categorias" SET "slot" = 3 WHERE "cor" = '#f97316';--> statement-breakpoint
UPDATE "categorias" SET "slot" = 4 WHERE "cor" = '#0ea5e9';--> statement-breakpoint
UPDATE "categorias" SET "slot" = 5 WHERE "cor" = '#14b8a6';--> statement-breakpoint
UPDATE "categorias" SET "slot" = 6 WHERE "cor" = '#a855f7';
