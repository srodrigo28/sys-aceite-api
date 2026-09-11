import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { carregarEnv, mascarar } from '../carregar-env.js';
import * as schema from '../db/schema.js';
/**
 * Diagnostico de ambiente — `npm run env:check`.
 *
 * Feito para rodar na VPS quando algo nao sobe: diz de onde as variaveis vieram,
 * o que esta faltando e se o banco e o bucket respondem de verdade.
 * Nao importa ../env.js de proposito: aquele modulo encerra o processo quando a
 * validacao falha, e aqui queremos relatar em vez de morrer.
 */
const OBRIGATORIAS = [
    { nome: 'DATABASE_URL', dica: 'string de conexao do Postgres' },
    { nome: 'JWT_SECRET', dica: 'minimo 16 caracteres' },
];
const RECOMENDADAS = [
    { nome: 'NODE_ENV', dica: 'production na VPS' },
    { nome: 'PORT', dica: 'padrao 3333' },
    { nome: 'WEB_ORIGIN', dica: 'origem do front (aceita lista separada por virgula)' },
    { nome: 'APP_PUBLIC_URL', dica: 'base do link /a/<token> — precisa ser a URL publica' },
];
const BUCKET = ['BUCKET_URL', 'BUCKET_SLUG', 'BUCKET_TOKEN'];
/** Tabelas que o codigo espera, lidas do proprio schema — nunca desatualiza. */
const TABELAS_ESPERADAS = Object.values(schema)
    .filter((v) => is(v, PgTable))
    .map((t) => getTableName(t))
    .sort();
/** Quantas migrations existem na pasta, para comparar com o que o banco aplicou. */
function migrationsNoDisco() {
    try {
        const pasta = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
        return readdirSync(pasta).filter((f) => f.endsWith('.sql')).length;
    }
    catch {
        return 0;
    }
}
const ok = (m) => console.log(`  \x1b[32mOK\x1b[0m    ${m}`);
const aviso = (m) => console.log(`  \x1b[33mAVISO\x1b[0m ${m}`);
const erro = (m) => console.log(`  \x1b[31mERRO\x1b[0m  ${m}`);
let problemas = 0;
console.log('\n=== SysAceite — diagnostico de ambiente ===\n');
/* 1. de onde vieram as variaveis --------------------------------------- */
const relatorio = carregarEnv();
console.log(`raiz da api: ${relatorio.raizApi}`);
console.log(`cwd:         ${process.cwd()}`);
console.log(`node:        ${process.version}\n`);
console.log('Arquivos de ambiente');
if (relatorio.carregados.length) {
    for (const c of relatorio.carregados)
        ok(`carregado  ${c}`);
}
else {
    aviso('nenhum arquivo .env encontrado — valendo so as variaveis do processo');
}
for (const a of relatorio.ausentes)
    console.log(`        (nao existe) ${a}`);
/* 2. variaveis ---------------------------------------------------------- */
console.log('\nVariaveis obrigatorias');
for (const { nome, dica } of OBRIGATORIAS) {
    const valor = process.env[nome];
    if (!valor) {
        erro(`${nome} nao definida — ${dica}`);
        problemas++;
    }
    else if (nome === 'JWT_SECRET' && valor.length < 16) {
        erro(`${nome} tem ${valor.length} caracteres — precisa de 16+`);
        problemas++;
    }
    else {
        ok(`${nome} = ${mascarar(valor)}`);
    }
}
console.log('\nVariaveis recomendadas');
for (const { nome, dica } of RECOMENDADAS) {
    const valor = process.env[nome];
    if (!valor)
        aviso(`${nome} nao definida — ${dica}`);
    else
        ok(`${nome} = ${valor}`);
}
if (process.env.NODE_ENV === 'production') {
    const publica = process.env.APP_PUBLIC_URL ?? '';
    if (publica.includes('localhost')) {
        erro('APP_PUBLIC_URL aponta para localhost em producao — os links de aprovacao vao quebrar');
        problemas++;
    }
    if ((process.env.WEB_ORIGIN ?? '').includes('localhost')) {
        aviso('WEB_ORIGIN aponta para localhost em producao — o CORS vai barrar o front');
    }
}
/* 3. storage ------------------------------------------------------------ */
console.log('\nStorage de anexos');
const temBucket = Boolean(process.env.BUCKET_URL && process.env.BUCKET_TOKEN);
if (!temBucket) {
    aviso(`bucket nao configurado — anexos vao para o disco (${process.env.UPLOAD_DIR ?? './uploads'})`);
    for (const v of BUCKET)
        if (!process.env[v])
            console.log(`        falta ${v}`);
}
else {
    // so o token e segredo; URL e slug ajudam mais visiveis
    for (const v of BUCKET) {
        ok(`${v} = ${v === 'BUCKET_TOKEN' ? mascarar(process.env[v]) : process.env[v]}`);
    }
    if (process.env.BUCKET_URL?.includes('/bucket/bucket/')) {
        erro('BUCKET_URL tem /bucket duplicado — o certo e https://99dev.pro/bucket/api');
        problemas++;
    }
}
/* 3b. e-mail ------------------------------------------------------------ */
console.log('\nE-mail');
const temResend = Boolean(process.env.RESEND_API_KEY);
const temSmtp = Boolean(process.env.SMTP_URL);
if (temResend && temSmtp) {
    aviso('RESEND_API_KEY e SMTP_URL definidos — o Resend tem precedencia');
}
if (!temResend && !temSmtp) {
    aviso('nenhum provedor — o convite vira link para o admin copiar (nao e erro)');
    console.log('        defina RESEND_API_KEY ou SMTP_URL para enviar de verdade');
}
else if (temResend) {
    ok(`driver = resend · RESEND_API_KEY = ${mascarar(process.env.RESEND_API_KEY)}`);
}
else {
    ok(`driver = smtp · SMTP_URL = ${mascarar(process.env.SMTP_URL)}`);
    console.log('        lembre do `npm i nodemailer` — o driver SMTP depende dele');
}
ok(`remetente = ${process.env.EMAIL_REMETENTE ?? '(padrao) SysAceite <nao-responda@sysaceite.dev>'}`);
/* 4. conexoes de verdade ------------------------------------------------ */
console.log('\nConexoes');
if (process.env.DATABASE_URL) {
    try {
        const { default: postgres } = await import('postgres');
        const u = new URL(process.env.DATABASE_URL);
        u.searchParams.delete('channel_binding');
        const sql = postgres(u.toString(), {
            ssl: 'require',
            prepare: false,
            connect_timeout: 15,
            max: 1,
        });
        const inicio = Date.now();
        const [linha] = await sql `select version() as v`;
        ok(`banco respondeu em ${Date.now() - inicio}ms — ${linha?.v.split(',')[0]}`);
        // conta nao basta: base meio migrada tem tabela, so nao tem as certas
        const existentes = await sql `
      select table_name as nome from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`;
        const nomes = new Set(existentes.map((l) => l.nome));
        const faltando = TABELAS_ESPERADAS.filter((t) => !nomes.has(t));
        if (nomes.size === 0) {
            erro('banco conectou mas esta vazio — rode: npm run db:migrate');
            problemas++;
        }
        else if (faltando.length > 0) {
            erro(`faltam ${faltando.length} de ${TABELAS_ESPERADAS.length} tabelas: ${faltando.join(', ')}`);
            console.log('        a base nao esta na versao do codigo — rode: npm run db:migrate');
            problemas++;
        }
        else {
            ok(`${TABELAS_ESPERADAS.length} tabelas do schema conferem`);
            const sobrando = [...nomes].filter((n) => !TABELAS_ESPERADAS.includes(n) && n !== '__drizzle_migrations');
            if (sobrando.length > 0) {
                aviso(`tabelas fora do schema (restos de versao antiga?): ${sobrando.join(', ')}`);
            }
        }
        // migrations aplicadas x arquivos na pasta drizzle/
        const noDisco = migrationsNoDisco();
        if (noDisco > 0) {
            const [m] = await sql `
        select count(*)::int as n from drizzle.__drizzle_migrations`.catch(() => [{ n: -1 }]);
            const aplicadas = m?.n ?? -1;
            if (aplicadas < 0) {
                aviso(`${noDisco} migration(s) na pasta, mas o banco nao tem registro delas`);
            }
            else if (aplicadas < noDisco) {
                erro(`${aplicadas} de ${noDisco} migrations aplicadas — rode: npm run db:migrate`);
                problemas++;
            }
            else {
                ok(`${aplicadas} migrations aplicadas`);
            }
        }
        await sql.end({ timeout: 5 });
    }
    catch (e) {
        erro(`banco: ${e.message}`);
        problemas++;
    }
}
else {
    erro('banco: sem DATABASE_URL para testar');
    problemas++;
}
if (temBucket) {
    try {
        const inicio = Date.now();
        const r = await fetch(`${process.env.BUCKET_URL}/files?bucket=${process.env.BUCKET_SLUG ?? 'sysaceite'}&per_page=1`, {
            headers: { 'X-API-Token': process.env.BUCKET_TOKEN },
            signal: AbortSignal.timeout(20_000),
        });
        if (r.ok) {
            const j = (await r.json());
            ok(`bucket respondeu em ${Date.now() - inicio}ms — ${j.pagination?.total_items ?? 0} arquivo(s)`);
        }
        else if (r.status === 401 || r.status === 403) {
            erro(`bucket: token recusado (${r.status}) — gere um novo no super admin`);
            problemas++;
        }
        else if (r.status === 404) {
            erro('bucket: 404 — confira BUCKET_URL (o certo e https://99dev.pro/bucket/api)');
            problemas++;
        }
        else {
            erro(`bucket: HTTP ${r.status}`);
            problemas++;
        }
    }
    catch (e) {
        erro(`bucket: ${e.message}`);
        problemas++;
    }
}
/* 5. veredito ----------------------------------------------------------- */
if (problemas === 0) {
    console.log('\n\x1b[32mAmbiente pronto.\x1b[0m\n');
    process.exit(0);
}
console.log(`\n\x1b[31m${problemas} problema(s) encontrado(s).\x1b[0m Veja api/.env.example.\n`);
process.exit(1);
//# sourceMappingURL=verificar-env.js.map