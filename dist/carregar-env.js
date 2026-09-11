import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as carregarArquivo } from 'dotenv';
/** Sobe a partir do modulo ate achar o package.json da API. */
function acharRaizApi() {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
        const pkg = join(dir, 'package.json');
        if (existsSync(pkg)) {
            try {
                const nome = JSON.parse(readFileSync(pkg, 'utf8')).name;
                if (nome === 'sysaceite-api')
                    return dir;
            }
            catch {
                /* package.json ilegivel: continua subindo */
            }
        }
        const acima = dirname(dir);
        if (acima === dir)
            break;
        dir = acima;
    }
    // fallback: dois niveis acima de src/ ou dist/
    return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}
let relatorio = null;
export function carregarEnv() {
    if (relatorio)
        return relatorio;
    const raizApi = acharRaizApi();
    const raizRepo = dirname(raizApi);
    const ambiente = process.env.NODE_ENV ?? 'development';
    const candidatos = [
        process.env.ENV_FILE
            ? isAbsolute(process.env.ENV_FILE)
                ? process.env.ENV_FILE
                : resolve(raizApi, process.env.ENV_FILE)
            : null,
        join(raizApi, `.env.${ambiente}.local`),
        join(raizApi, '.env.local'),
        join(raizApi, `.env.${ambiente}`),
        join(raizApi, '.env.vps'),
        join(raizApi, '.env'),
        join(raizRepo, '.env'),
    ].filter((c) => Boolean(c));
    const carregados = [];
    const ausentes = [];
    for (const caminho of candidatos) {
        if (!existsSync(caminho)) {
            ausentes.push(caminho);
            continue;
        }
        // override: false — quem ja esta no processo, e os arquivos de maior
        // precedencia lidos antes, continuam valendo
        const r = carregarArquivo({ path: caminho, override: false, quiet: true });
        if (r.error) {
            console.error(`[env] nao consegui ler ${caminho}: ${r.error.message}`);
            continue;
        }
        carregados.push(caminho);
    }
    relatorio = {
        carregados,
        ausentes,
        raizApi,
        somenteProcesso: carregados.length === 0,
    };
    return relatorio;
}
/** Descricao curta para o log de boot. */
export function resumoEnv(r) {
    if (r.somenteProcesso)
        return 'variaveis do processo (nenhum arquivo .env encontrado)';
    return r.carregados.map((c) => c.replace(r.raizApi, '.')).join(' + ');
}
/** Esconde o valor, mostrando o suficiente para conferir qual segredo e. */
export function mascarar(valor) {
    if (!valor)
        return '(vazio)';
    if (valor.length <= 8)
        return '***';
    if (valor.startsWith('postgres')) {
        try {
            const u = new URL(valor);
            return `${u.protocol}//${u.username}:***@${u.host}${u.pathname}`;
        }
        catch {
            return '***';
        }
    }
    return `${valor.slice(0, 6)}…${valor.slice(-4)} (${valor.length} chars)`;
}
//# sourceMappingURL=carregar-env.js.map