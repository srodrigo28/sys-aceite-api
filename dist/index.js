import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { fecharConexao, verificarConexao } from './db/client.js';
import { resumoEnv } from './carregar-env.js';
import { anexoTamanhoMax, descricaoStorage, env, origensPermitidas, relatorioEnv, } from './env.js';
import { ErroApp, responderErro } from './lib/http.js';
import { rotasAprovacao } from './routes/aprovacao.js';
import { rotasAuth } from './routes/auth.js';
import { rotasEquipe } from './routes/equipe.js';
import { rotasGrupos } from './routes/grupos.js';
import { rotasNotificacoes } from './routes/notificacoes.js';
import { rotasOs } from './routes/os.js';
import { rotasProjetos } from './routes/projetos.js';
import { rotasPublicas } from './routes/publico.js';
import { rotasSla } from './routes/sla.js';
const app = Fastify({
    logger: {
        level: env.NODE_ENV === 'production' ? 'info' : 'debug',
        transport: env.NODE_ENV === 'development'
            ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
            : undefined,
    },
});
// anexos chegam por multipart; o limite real e o do @fastify/multipart abaixo
await app.register(multipart, {
    limits: { fileSize: env.ANEXO_TAMANHO_MAX, files: 1, fields: 4 },
});
await app.register(cors, {
    // em dev reflete a origem (a porta pode variar); em producao, a lista do WEB_ORIGIN
    origin: env.NODE_ENV === 'development' ? true : origensPermitidas,
    credentials: true,
    // o padrao do @fastify/cors v11 e so GET,HEAD,POST. Sem esta lista o navegador
    // barra no preflight tudo que usa PATCH/DELETE: mover card, editar O.S.,
    // checklist e remover anexo. Os testes em node nao pegam isso (nao fazem CORS).
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
});
await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_EXPIRES_IN },
});
/**
 * Limite de tentativas. `global: false`: vale so onde a rota pede, em
 * `config.rateLimit` — nao queremos travar o uso normal do app, e sim as rotas
 * que recebem segredo (senha, token de convite, token de aprovacao).
 *
 * Fora de producao o localhost fica de fora, senao as suites de `npm run teste`
 * batem no teto so por rodarem varias vezes seguidas.
 */
await app.register(rateLimit, {
    global: false,
    allowList: (req) => env.NODE_ENV !== 'production' && ['127.0.0.1', '::1'].includes(req.ip),
    errorResponseBuilder: (_req, contexto) => ({
        erro: 'muitas_tentativas',
        mensagem: `Muitas tentativas. Tente de novo em ${Math.ceil(contexto.ttl / 1000)}s.`,
    }),
});
// POST sem corpo (ex.: /links/:id/revogar) nao pode quebrar so porque o
// cliente mandou content-type: application/json
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, corpo, feito) => {
    if (!corpo || !corpo.trim())
        return feito(null, {});
    try {
        feito(null, JSON.parse(corpo));
    }
    catch {
        feito(new ErroApp(400, 'json_invalido', 'Corpo da requisicao nao e um JSON valido.'), undefined);
    }
});
app.setErrorHandler(async (erro, _req, reply) => {
    await responderErro(erro, reply);
});
app.get('/health', async () => {
    const banco = await verificarConexao();
    return {
        ok: true,
        servico: 'sysaceite-api',
        ambiente: env.NODE_ENV,
        banco: { conectado: banco.ok, versao: banco.versao, latenciaMs: banco.latenciaMs },
        storage: descricaoStorage,
        // o front usa para validar antes de gastar a subida
        limites: { anexoBytes: anexoTamanhoMax },
        em: new Date().toISOString(),
    };
});
await app.register(rotasAuth);
await app.register(rotasPublicas);
await app.register(rotasProjetos);
await app.register(rotasOs);
await app.register(rotasSla);
await app.register(rotasAprovacao);
await app.register(rotasEquipe);
await app.register(rotasGrupos);
await app.register(rotasNotificacoes);
for (const sinal of ['SIGINT', 'SIGTERM']) {
    process.on(sinal, async () => {
        app.log.info('encerrando...');
        await app.close();
        await fecharConexao();
        process.exit(0);
    });
}
try {
    app.log.info(`env: ${resumoEnv(relatorioEnv)}`);
    const banco = await verificarConexao();
    app.log.info(`banco conectado (${banco.versao}) em ${banco.latenciaMs}ms`);
    app.log.info(`storage de anexos: ${descricaoStorage}`);
    if (env.NODE_ENV === 'production') {
        app.log.info(`cors liberado para: ${origensPermitidas.join(', ')}`);
    }
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`API em http://localhost:${env.PORT}`);
}
catch (erro) {
    app.log.error(erro);
    process.exit(1);
}
//# sourceMappingURL=index.js.map