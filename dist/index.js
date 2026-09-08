import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import Fastify from 'fastify';
import { fecharConexao, verificarConexao } from './db/client.js';
import { env } from './env.js';
import { responderErro } from './lib/http.js';
import { rotasAprovacao } from './routes/aprovacao.js';
import { rotasAuth } from './routes/auth.js';
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
    bodyLimit: 12 * 1024 * 1024, // anexos chegam como dataURL no MVP
});
await app.register(cors, {
    origin: env.NODE_ENV === 'development' ? true : [env.WEB_ORIGIN],
    credentials: true,
});
await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_EXPIRES_IN },
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
        em: new Date().toISOString(),
    };
});
await app.register(rotasAuth);
await app.register(rotasPublicas);
await app.register(rotasProjetos);
await app.register(rotasOs);
await app.register(rotasSla);
await app.register(rotasAprovacao);
for (const sinal of ['SIGINT', 'SIGTERM']) {
    process.on(sinal, async () => {
        app.log.info('encerrando...');
        await app.close();
        await fecharConexao();
        process.exit(0);
    });
}
try {
    const banco = await verificarConexao();
    app.log.info(`banco conectado (${banco.versao}) em ${banco.latenciaMs}ms`);
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`API em http://localhost:${env.PORT}`);
}
catch (erro) {
    app.log.error(erro);
    process.exit(1);
}
//# sourceMappingURL=index.js.map