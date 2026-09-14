import { and, desc, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { db } from '../db/client.js'
import { historico, linksAprovacao, atividades } from '../db/schema.js'
import { autenticar, contexto, projetosVisiveis } from '../lib/auth.js'
import { doc } from '../lib/doc.js'
import { linkSchema, uuidParam } from '../lib/esquemas.js'
import { invalido, naoEncontrado, validar } from '../lib/http.js'
import { env } from '../env.js'

const VALIDADES = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30, sem_expiracao: null } as const

const criarLinkSchema = z.object({
  aprovadorNome: z.string().max(120).nullish(),
  aprovadorEmail: z.string().email('E-mail invalido').nullish(),
  mensagem: z.string().max(1000).nullish(),
  mostrarAnexos: z.boolean().default(true),
  mostrarDatas: z.boolean().default(true),
  mostrarSla: z.boolean().default(false),
  validade: z.enum(['24h', '7d', '30d', 'sem_expiracao']).default('7d'),
  /** O card so muda de coluna se voce pedir — o Kanban e movido a mao. */
  moverParaAprovacao: z.boolean().default(false),
})

const linkIdParam = z.object({ linkId: z.string().uuid() })

export function montarUrlPublica(token: string): string {
  return `${env.APP_PUBLIC_URL.replace(/\/$/, '')}/a/${token}`
}

/** O.S. do tenant e, para colaborador, de projeto que ele participa. */
async function osVisivel(id: string, req: FastifyRequest) {
  const os = await db.query.atividades.findFirst({
    where: and(eq(atividades.id, id), eq(atividades.tenantId, req.user.tenantId)),
  })
  if (!os) throw naoEncontrado('O.S.')

  const visiveis = await projetosVisiveis(req)
  if (visiveis !== 'todos' && !visiveis.includes(os.projetoId)) throw naoEncontrado('O.S.')

  return os
}

export async function rotasAprovacao(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', autenticar)

  /** Gera um link secreto de aprovacao para a O.S. */
  app.post('/os/:id/links', {
    schema: doc({
      tag: 'Aprovacoes',
      resumo: 'Gera um link de aprovacao para a O.S.',
      descricao:
        'O token **e** o segredo: quem tem a URL aprova, sem login e sem conta. Por isso a ' +
        'validade importa, e `sem_expiracao` deve ser excecao. Voce escolhe o que o aprovador ' +
        've — anexos, datas, SLA — e nada alem disso chega la; comentario interno nunca aparece. ' +
        '`moverParaAprovacao` e opcional porque o Kanban e movido a mao: gerar o link nao arrasta ' +
        'o card sozinho.',
      params: uuidParam,
      body: criarLinkSchema,
      ok: {
        status: 201,
        schema: z.object({ link: linkSchema }),
        descricao: 'Link criado, com a `url` pronta para enviar ao cliente',
      },
    }),
  }, async (req, reply) => {
    const { id } = validar(uuidParam, req.params)
    const dados = validar(criarLinkSchema, req.body)
    const { tenantId, usuarioId, nome } = contexto(req)

    const os = await osVisivel(id, req)

    const horas = VALIDADES[dados.validade]
    const expiraEm = horas === null ? null : new Date(Date.now() + horas * 3_600_000)

    const [link] = await db
      .insert(linksAprovacao)
      .values({
        tenantId,
        osId: id,
        token: nanoid(32),
        expiraEm,
        mensagem: dados.mensagem ?? null,
        mostrarAnexos: dados.mostrarAnexos,
        mostrarDatas: dados.mostrarDatas,
        mostrarSla: dados.mostrarSla,
        aprovadorNomeSugerido: dados.aprovadorNome ?? null,
        aprovadorEmailSugerido: dados.aprovadorEmail ?? null,
        criadoPorId: usuarioId,
      })
      .returning()
    if (!link) throw invalido('Nao foi possivel gerar o link.')

    if (dados.moverParaAprovacao && os.status !== 'em_aprovacao') {
      await db
        .update(atividades)
        .set({ status: 'em_aprovacao', atualizadoEm: new Date() })
        .where(eq(atividades.id, id))
    }

    await db.insert(historico).values({
      osId: id,
      tipo: 'aprovacao',
      descricao: dados.aprovadorNome
        ? `Link de aprovacao enviado para ${dados.aprovadorNome}`
        : 'Link de aprovacao gerado',
      autorNome: nome,
    })

    return reply.code(201).send({ link: { ...link, url: montarUrlPublica(link.token) } })
  })

  app.get('/os/:id/links', {
    schema: doc({
      tag: 'Aprovacoes',
      resumo: 'Links ja gerados para a O.S., do mais novo ao mais antigo',
      descricao: 'Inclui os ja respondidos, revogados e expirados — e o historico de envio.',
      params: uuidParam,
      ok: { schema: z.object({ links: z.array(linkSchema) }) },
    }),
  }, async (req) => {
    const { id } = validar(uuidParam, req.params)
    await osVisivel(id, req)

    const lista = await db.query.linksAprovacao.findMany({
      where: and(eq(linksAprovacao.osId, id), eq(linksAprovacao.tenantId, req.user.tenantId)),
      orderBy: desc(linksAprovacao.criadoEm),
    })
    return { links: lista.map((l) => ({ ...l, url: montarUrlPublica(l.token) })) }
  })

  app.post('/links/:linkId/revogar', {
    schema: doc({
      tag: 'Aprovacoes',
      resumo: 'Revoga um link pendente',
      descricao:
        'Mata o token na hora: quem abrir depois ve a tela de link revogado. So funciona em link ' +
        '`pendente` — um parecer ja dado nao se apaga, e tentar revoga-lo da 400.',
      params: linkIdParam,
      semCorpo: true,
      ok: { schema: z.object({ link: linkSchema }) },
    }),
  }, async (req) => {
    const { linkId } = validar(linkIdParam, req.params)
    const { tenantId, nome } = contexto(req)

    const link = await db.query.linksAprovacao.findFirst({
      where: and(eq(linksAprovacao.id, linkId), eq(linksAprovacao.tenantId, tenantId)),
    })
    if (!link) throw naoEncontrado('Link')
    await osVisivel(link.osId, req)
    if (link.estado !== 'pendente') {
      throw invalido('Este link nao esta mais pendente e nao pode ser revogado.')
    }

    const [atualizado] = await db
      .update(linksAprovacao)
      .set({ estado: 'revogado' })
      .where(eq(linksAprovacao.id, linkId))
      .returning()

    await db.insert(historico).values({
      osId: link.osId,
      tipo: 'aprovacao',
      descricao: 'Link de aprovacao revogado',
      autorNome: nome,
    })

    return { link: atualizado }
  })
}
