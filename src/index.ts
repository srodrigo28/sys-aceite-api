import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import Fastify from 'fastify'
import { fecharConexao, pingBanco } from './db/client.js'
import { resumoEnv } from './carregar-env.js'
import {
  anexoTamanhoMax,
  descricaoStorage,
  env,
  origensPermitidas,
  relatorioEnv,
} from './env.js'
import { doc } from './lib/doc.js'
import { saudeSchema, vivoSchema } from './lib/esquemas.js'
import { ErroApp, responderErro } from './lib/http.js'
import { rotasAprovacao } from './routes/aprovacao.js'
import { rotasAuth } from './routes/auth.js'
import { rotasEquipe } from './routes/equipe.js'
import { rotasGrupos } from './routes/grupos.js'
import { rotasNotificacoes } from './routes/notificacoes.js'
import { rotasOrdens } from './routes/ordens.js'
import { rotasOs } from './routes/os.js'
import { rotasProjetos } from './routes/projetos.js'
import { rotasPublicas } from './routes/publico.js'
import { rotasSla } from './routes/sla.js'

const app = Fastify({
  logger: {
    level: env.NODE_ENV === 'production' ? 'info' : 'debug',
    transport:
      env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
        : undefined,
  },
})

// Deve ser registrado antes de todas as rotas: o plugin descobre os schemas
// durante o registro delas e monta o contrato OpenAPI dinamicamente.
await app.register(swagger, {
  openapi: {
    openapi: '3.0.3',
    info: {
      title: 'SysAceite API',
      description:
        'API para controle de ordens de servico, SLA, Kanban e aprovacao por link.',
      version: '0.1.0',
    },
    servers: [
      { url: 'https://99dev.pro/sys-aceite-api', description: 'VPS de desenvolvimento' },
      { url: 'http://localhost:3333', description: 'Desenvolvimento local' },
    ],
    tags: [
      { name: 'Sistema', description: 'Disponibilidade e diagnostico da API' },
      { name: 'Autenticacao', description: 'Cadastro, login e perfil' },
      { name: 'Projetos', description: 'Projetos e painel' },
      { name: 'Ordens de servico', description: 'O.S., comentarios, checklist e anexos' },
      { name: 'SLA', description: 'Politicas e categorias de SLA' },
      { name: 'Aprovacoes', description: 'Links de aprovacao' },
      { name: 'Equipe', description: 'Usuarios e convites' },
      { name: 'Grupos', description: 'Grupos de trabalho' },
      { name: 'Notificacoes', description: 'Notificacoes do usuario' },
      { name: 'Publico', description: 'Rotas sem JWT para aprovacao e convite' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
    // padrao: rota exige JWT. As publicas zeram com `security: []` no proprio
    // schema, o que e mais seguro do que listar uma a uma quem precisa de token
    security: [{ bearerAuth: [] }],
  },
})

/**
 * Os schemas das rotas sao contrato, nao guarda.
 *
 * A validacao de entrada e do zod, dentro do handler, via `validar()`: e de la
 * que sai a mensagem em portugues com o nome do campo. Deixar o ajv validar
 * tambem criaria duas verdades sobre o mesmo corpo — e a que responderia
 * primeiro seria a de mensagem pior.
 */
app.setValidatorCompiler(() => (dados) => ({ value: dados }))

/**
 * Idem na saida: o `response` do schema documenta, nao filtra. O serializador
 * padrao do Fastify apaga silenciosamente todo campo ausente do schema — um
 * esquecimento na documentacao viraria um campo sumido em producao, sem erro
 * nenhum para avisar. `JSON.stringify` mantem a resposta identica a de hoje.
 */
app.setSerializerCompiler(() => (payload) => JSON.stringify(payload))

await app.register(swaggerUi, {
  routePrefix: '/doc',
  // O proxy publica a API sob este prefixo; sem ele os assets da UI buscariam
  // /doc/* na raiz de 99dev.pro e responderiam 404.
  indexPrefix: '/sys-aceite-api',
  uiConfig: { docExpansion: 'list', deepLinking: true },
})

// anexos chegam por multipart; o limite real e o do @fastify/multipart abaixo
await app.register(multipart, {
  limits: { fileSize: env.ANEXO_TAMANHO_MAX, files: 1, fields: 4 },
})

await app.register(cors, {
  // em dev reflete a origem (a porta pode variar); em producao, a lista do WEB_ORIGIN
  origin: env.NODE_ENV === 'development' ? true : origensPermitidas,
  credentials: true,
  // o padrao do @fastify/cors v11 e so GET,HEAD,POST. Sem esta lista o navegador
  // barra no preflight tudo que usa PATCH/DELETE: mover card, editar O.S.,
  // checklist e remover anexo. Os testes em node nao pegam isso (nao fazem CORS).
  methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
})

await app.register(jwt, {
  secret: env.JWT_SECRET,
  sign: { expiresIn: env.JWT_EXPIRES_IN },
})

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
  /**
   * O plugin faz `throw errorResponseBuilder(...)`, e o que sai daqui atravessa
   * o `setErrorHandler`. Devolver um objeto simples fazia o `erroDoFastify` nao
   * reconhecer status nenhum e cair no 500 generico: quem estourava o limite
   * via "Algo deu errado" em vez de saber que era limite, e em quanto tempo
   * podia tentar de novo.
   *
   * Precisa ser um Error COM `statusCode` — e o que o proprio padrao do plugin
   * devolve. As demais propriedades sobrevivem ate o handler.
   */
  errorResponseBuilder: (_req, contexto) => {
    const segundos = Math.ceil(contexto.ttl / 1000)
    return Object.assign(new Error(`Muitas tentativas. Tente de novo em ${segundos}s.`), {
      statusCode: contexto.statusCode ?? 429,
      code: 'muitas_tentativas',
    })
  },
})

// POST sem corpo (ex.: /links/:id/revogar) nao pode quebrar so porque o
// cliente mandou content-type: application/json
app.addContentTypeParser(
  'application/json',
  { parseAs: 'string' },
  (_req, corpo: string, feito) => {
    if (!corpo || !corpo.trim()) return feito(null, {})
    try {
      feito(null, JSON.parse(corpo))
    } catch {
      feito(new ErroApp(400, 'json_invalido', 'Corpo da requisicao nao e um JSON valido.'), undefined)
    }
  },
)

app.setErrorHandler(async (erro, _req, reply) => {
  await responderErro(erro, reply)
})

app.get('/health', {
  schema: doc({
    tag: 'Sistema',
    resumo: 'Readiness — estado da API, do banco e do storage',
    descricao:
      'Banco fora do ar responde 200 com `banco.conectado: false`. Um 500 aqui seria ' +
      'indistinguivel de API morta, e e exatamente a diferenca que esta rota existe para mostrar. ' +
      'Para a sonda do deploy use `/healthz`.',
    publico: true,
    ok: { schema: saudeSchema },
  }),
}, async () => {
  // pingBanco no lugar de verificarConexao: banco fora vira `conectado: false`,
  // nao 500 nem requisicao pendurada. Quem consulta /health quer saber o estado,
  // e um erro aqui e indistinguivel de API morta.
  const banco = await pingBanco()
  return {
    ok: true,
    servico: 'sysaceite-api',
    ambiente: env.NODE_ENV,
    banco: {
      conectado: banco.ok,
      versao: banco.ok ? banco.versao : banco.erro,
      latenciaMs: banco.latenciaMs,
    },
    storage: descricaoStorage,
    // o front usa para validar antes de gastar a subida
    limites: { anexoBytes: anexoTamanhoMax },
    em: new Date().toISOString(),
  }
})

/**
 * Liveness puro: responde sem tocar em banco, storage ou e-mail.
 *
 * E o caminho que a sonda do painel da VPS consulta. Com ela apontada para
 * `/health`, uma indisponibilidade do Neon derruba o deploy inteiro — e um 404
 * aceito como "saudavel" nao prova nada. Aqui 200 significa exatamente uma
 * coisa: o processo esta escutando e roteando.
 */
app.get('/healthz', {
  schema: doc({
    tag: 'Sistema',
    resumo: 'Liveness — responde sem consultar dependencia nenhuma',
    descricao:
      'E o caminho que a sonda do deploy consulta. 200 aqui significa exatamente uma coisa: ' +
      'o processo esta escutando e roteando.',
    publico: true,
    ok: { schema: vivoSchema },
  }),
}, async () => ({ ok: true, servico: 'sysaceite-api', em: new Date().toISOString() }))

await app.register(rotasAuth)
await app.register(rotasPublicas)
await app.register(rotasProjetos)
await app.register(rotasOs)
await app.register(rotasOrdens)
await app.register(rotasSla)
await app.register(rotasAprovacao)
await app.register(rotasEquipe)
await app.register(rotasGrupos)
await app.register(rotasNotificacoes)

for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sinal, async () => {
    app.log.info('encerrando...')
    await app.close()
    await fecharConexao()
    process.exit(0)
  })
}

/**
 * Ordem do boot: ESCUTAR PRIMEIRO, checar o banco depois.
 *
 * Antes o ping do Neon vinha antes do `listen`. Banco lento ou fora do ar
 * prendia o processo antes de abrir a porta — e, se estourasse, o `exit(1)`
 * punha o container em loop de reinicio. De fora isso e indistinguivel de "a
 * API nao existe": o proxy aceita a conexao e nunca responde, nem 404. Estado
 * medido na VPS em 11/09/2026.
 *
 * Banco fora e um problema do banco. A API precisa subir mesmo assim para
 * poder dizer isso em `/health` — sem servidor escutando, nao ha como
 * diagnosticar nada.
 */
try {
  app.log.info(`env: ${resumoEnv(relatorioEnv)}`)
  app.log.info(`storage de anexos: ${descricaoStorage}`)
  if (env.NODE_ENV === 'production') {
    app.log.info(`cors liberado para: ${origensPermitidas.join(', ')}`)
  }

  await app.listen({ port: env.PORT, host: env.HOST })
  app.log.info(`API escutando em ${env.HOST}:${env.PORT}`)
} catch (erro) {
  app.log.error(erro, 'falha ao abrir a porta')
  process.exit(1)
}

const banco = await pingBanco(15_000)
if (banco.ok) {
  app.log.info(`banco conectado (${banco.versao}) em ${banco.latenciaMs}ms`)
} else {
  // nao derruba o processo: /health passa a reportar `conectado: false`
  app.log.error(`banco INDISPONIVEL apos ${banco.latenciaMs}ms: ${banco.erro}`)
}
