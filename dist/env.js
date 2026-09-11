import { z } from 'zod';
import { carregarEnv, resumoEnv } from './carregar-env.js';
export const relatorioEnv = carregarEnv();
/** Variavel de texto opcional: "" no .env conta como nao definida. */
const textoOpcional = z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined));
const schema = z.object({
    DATABASE_URL: z.string().min(1, 'DATABASE_URL e obrigatoria'),
    PORT: z.coerce.number().int().positive().default(3333),
    HOST: z.string().default('0.0.0.0'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    JWT_SECRET: z.string().min(16, 'JWT_SECRET precisa ter ao menos 16 caracteres'),
    JWT_EXPIRES_IN: z.string().default('7d'),
    /** Uma ou mais origens separadas por virgula (apex + www, por exemplo). */
    WEB_ORIGIN: z.string().default('http://localhost:3000'),
    APP_PUBLIC_URL: z.string().default('http://localhost:3000'),
    // Bucket (99dev.pro). Sem URL+TOKEN, os anexos vao para UPLOAD_DIR.
    BUCKET_URL: textoOpcional,
    BUCKET_SLUG: z.string().trim().default('sysaceite'),
    BUCKET_TOKEN: textoOpcional,
    BUCKET_TIMEOUT: z.coerce.number().int().positive().default(30_000),
    /**
     * Teto do bucket, medido em 09/09/2026: o nginx dele responde 413 a partir de
     * 1 MB de corpo, independente da cota da conta. Nao adianta subir
     * ANEXO_TAMANHO_MAX sem subir o `client_max_body_size` de la.
     */
    BUCKET_TAMANHO_MAX: z.coerce.number().int().positive().default(1_000_000),
    UPLOAD_DIR: z.string().trim().default('./uploads'),
    ANEXO_TAMANHO_MAX: z.coerce.number().int().positive().default(15 * 1024 * 1024),
    // E-mail. Sem provedor, o convite vira link para o admin copiar.
    EMAIL_REMETENTE: z.string().trim().default('SysAceite <nao-responda@sysaceite.dev>'),
    RESEND_API_KEY: textoOpcional,
    SMTP_URL: textoOpcional,
    EMAIL_TIMEOUT: z.coerce.number().int().positive().default(30_000),
});
const parsed = schema.safeParse(process.env);
if (!parsed.success) {
    console.error('\n[env] Variaveis de ambiente invalidas ou faltando:\n');
    for (const issue of parsed.error.issues) {
        // o zod diz "expected string, received undefined"; em portugues fica mais claro
        const mensagem = issue.message.includes('received undefined')
            ? 'nao definida'
            : issue.message;
        console.error(`  - ${issue.path.join('.')}: ${mensagem}`);
    }
    console.error(`\n  origem: ${resumoEnv(relatorioEnv)}`);
    if (relatorioEnv.somenteProcesso) {
        console.error('\n  Nenhum arquivo .env foi encontrado. Procurei em:');
        for (const p of relatorioEnv.ausentes)
            console.error(`    - ${p}`);
        console.error('\n  Na VPS, escolha um caminho:');
        console.error(`    a) crie ${relatorioEnv.raizApi}\\.env (ou .env.vps)`);
        console.error('    b) aponte ENV_FILE=/caminho/para/o/arquivo');
        console.error('    c) defina as variaveis no systemd/pm2/Docker');
        console.error('\n  Modelo: api/.env.example    Diagnostico: npm run env:check\n');
    }
    else {
        console.error('  Confira o arquivo acima. Modelo em api/.env.example.\n');
    }
    process.exit(1);
}
export const env = parsed.data;
/** Com URL e token, os anexos vao para o bucket; sem, gravam em disco. */
export const bucketAtivo = Boolean(env.BUCKET_URL && env.BUCKET_TOKEN);
export const descricaoStorage = bucketAtivo
    ? `bucket (${env.BUCKET_SLUG})`
    : `disco (${env.UPLOAD_DIR})`;
/** Tamanho maximo que o storage ativo aceita de verdade. */
export const anexoTamanhoMax = bucketAtivo
    ? Math.min(env.ANEXO_TAMANHO_MAX, env.BUCKET_TAMANHO_MAX)
    : env.ANEXO_TAMANHO_MAX;
/** Driver de e-mail em uso. Sem nenhum, o convite so existe como link. */
export const driverEmail = env.RESEND_API_KEY
    ? 'resend'
    : env.SMTP_URL
        ? 'smtp'
        : null;
export const emailAtivo = driverEmail !== null;
export const descricaoEmail = driverEmail
    ? `${driverEmail} (${env.EMAIL_REMETENTE})`
    : 'desligado (convite so por link)';
/** WEB_ORIGIN aceita lista separada por virgula. */
export const origensPermitidas = env.WEB_ORIGIN.split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
//# sourceMappingURL=env.js.map