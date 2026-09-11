import { eq, inArray, like, or } from 'drizzle-orm';
import { carregarEnv } from '../carregar-env.js';
import { db, fecharConexao } from '../db/client.js';
import { anexos, tenants, usuarios } from '../db/schema.js';
import { apagar } from '../lib/bucket.js';
import { arquivosDoAnexo } from '../lib/anexo.js';
carregarEnv();
/**
 * Remove os tenants que as suites de `npm run teste` criam.
 *
 * Cada execucao registra um tenant novo (e assim tem que ser: os testes nao
 * podem depender do estado deixado pela rodada anterior). O que nao pode e
 * acumular para sempre no banco.
 *
 * A selecao e pelo E-MAIL do usuario, nao pelo nome da empresa: nome e texto
 * livre e um cliente de verdade poderia se chamar "Agencia alguma coisa". Os
 * prefixos abaixo so existem dentro de `testes/*.mjs`.
 *
 * `demo@sysaceite.dev` NUNCA entra: e a conta de demonstracao.
 */
const PREFIXOS_DE_TESTE = [
    'teste.%@sysaceite.dev', // testes/aprovacao.mjs
    'admin.%@sysaceite.dev', // testes/equipe.mjs e testes/grupos.mjs
    'outro.%@sysaceite.dev', // testes/grupos.mjs (o segundo tenant, do isolamento)
    'intruso.%@x.dev', // testes/anexos.mjs (tenant "Outra")
];
const EMAIL_DEMO = 'demo@sysaceite.dev';
const seco = process.argv.includes('--seco') || process.argv.includes('--dry-run');
const donos = await db
    .select({ tenantId: usuarios.tenantId, email: usuarios.email })
    .from(usuarios)
    .where(or(...PREFIXOS_DE_TESTE.map((p) => like(usuarios.email, p))));
const ids = [...new Set(donos.map((d) => d.tenantId))];
if (ids.length === 0) {
    console.log('\nNenhum tenant de teste encontrado.\n');
    await fecharConexao();
    process.exit(0);
}
// trava de seguranca: se a conta demo cair na lista, algo esta errado
const demo = await db.query.usuarios.findFirst({ where: eq(usuarios.email, EMAIL_DEMO) });
if (demo && ids.includes(demo.tenantId)) {
    console.error('\nABORTADO: o tenant de demonstracao entrou na selecao.\n');
    await fecharConexao();
    process.exit(1);
}
const alvos = await db.query.tenants.findMany({ where: inArray(tenants.id, ids) });
console.log(`\n${alvos.length} tenant(s) de teste:`);
for (const t of alvos)
    console.log(`  - ${t.nome}`);
// os arquivos do storage nao saem por cascade: some com eles antes das linhas
const arquivos = await db.query.anexos.findMany({ where: inArray(anexos.tenantId, ids) });
console.log(`\n${arquivos.length} anexo(s) no storage.`);
if (seco) {
    console.log('\nModo seco: nada foi apagado. Rode sem --seco para apagar.\n');
    await fecharConexao();
    process.exit(0);
}
let apagados = 0;
for (const anexo of arquivos) {
    for (const arquivo of arquivosDoAnexo(anexo)) {
        await apagar(arquivo);
        apagados++;
    }
}
const removidos = await db.delete(tenants).where(inArray(tenants.id, ids)).returning({ id: tenants.id });
console.log(`\n${removidos.length} tenant(s) e ${apagados} arquivo(s) removidos.`);
console.log('A conta de demonstracao nao foi tocada.\n');
await fecharConexao();
//# sourceMappingURL=limpar-testes.js.map