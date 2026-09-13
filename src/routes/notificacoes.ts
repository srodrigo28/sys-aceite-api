import { and, count, desc, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../db/client.js'
import { notificacoes } from '../db/schema.js'
import { autenticar } from '../lib/auth.js'
import { doc } from '../lib/doc.js'
import { notificacaoSchema } from '../lib/esquemas.js'
import { naoEncontrado, validar } from '../lib/http.js'

/**
 * O sino.
 *
 * Toda rota aqui e escopada no usuario logado. NUNCA aceite `usuarioId` por
 * query: a notificacao de uma pessoa nao pode aparecer para outra, nem por id
 * direto — por isso marcar a notificacao de outro responde 404, e nao 403.
 */

const LIMITE = 30

const idParam = z.object({ id: z.string().uuid() })

const listaQuery = z.object({
  apenasNaoLidas: z.string().optional().describe('1 devolve so as pendentes'),
})

export async function rotasNotificacoes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', autenticar)

  app.get('/notificacoes', {
    schema: doc({
      tag: 'Notificacoes',
      resumo: 'O sino: suas notificacoes, das mais recentes para as antigas',
      descricao:
        'Sempre escopada em quem esta com o token — **nao existe parametro de usuario aqui**, e ' +
        'de proposito: aceitar um `usuarioId` por query entregaria a caixa de outra pessoa. ' +
        'No maximo 30 itens; `naoLidas` conta todas as pendentes, inclusive alem desse teto, ' +
        'porque e ele que vira o numerinho do sino.',
      query: listaQuery,
      ok: {
        schema: z.object({
          naoLidas: z.number().int().describe('Total de pendentes, sem o limite de 30'),
          itens: z.array(notificacaoSchema),
        }),
      },
    }),
  }, async (req) => {
    const { apenasNaoLidas } = validar(
      listaQuery,
      req.query,
    )

    const filtro = and(
      eq(notificacoes.usuarioId, req.user.sub),
      apenasNaoLidas === '1' ? isNull(notificacoes.lidaEm) : undefined,
    )

    const [itens, [contagem]] = await Promise.all([
      db.query.notificacoes.findMany({
        where: filtro,
        orderBy: desc(notificacoes.criadoEm),
        limit: LIMITE,
      }),
      db
        .select({ total: count() })
        .from(notificacoes)
        .where(and(eq(notificacoes.usuarioId, req.user.sub), isNull(notificacoes.lidaEm))),
    ])

    return { naoLidas: Number(contagem?.total ?? 0), itens }
  })

  app.post('/notificacoes/:id/lida', {
    schema: doc({
      tag: 'Notificacoes',
      resumo: 'Marca uma notificacao como lida',
      descricao:
        'Marcar a notificacao de outra pessoa responde **404**, nao 403: o filtro por usuario esta ' +
        'na propria consulta, entao a rota nem chega a saber que o id existe.',
      params: idParam,
      semCorpo: true,
      ok: { schema: z.object({ notificacao: notificacaoSchema }) },
    }),
  }, async (req) => {
    const { id } = validar(idParam, req.params)

    // o filtro por usuarioId e o que impede marcar a notificacao de outro
    const [atualizada] = await db
      .update(notificacoes)
      .set({ lidaEm: new Date() })
      .where(and(eq(notificacoes.id, id), eq(notificacoes.usuarioId, req.user.sub)))
      .returning()
    if (!atualizada) throw naoEncontrado('Notificacao')

    return { notificacao: atualizada }
  })

  app.post('/notificacoes/lidas', {
    schema: doc({
      tag: 'Notificacoes',
      resumo: 'Marca todas as suas como lidas',
      descricao: 'Zera o sino. Sem nada pendente, devolve `marcadas: 0` — nao e erro.',
      semCorpo: true,
      ok: { schema: z.object({ marcadas: z.number().int() }) },
    }),
  }, async (req) => {
    const marcadas = await db
      .update(notificacoes)
      .set({ lidaEm: new Date() })
      .where(and(eq(notificacoes.usuarioId, req.user.sub), isNull(notificacoes.lidaEm)))
      .returning({ id: notificacoes.id })

    return { marcadas: marcadas.length }
  })
}
