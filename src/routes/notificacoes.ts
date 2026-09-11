import { and, count, desc, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../db/client.js'
import { notificacoes } from '../db/schema.js'
import { autenticar } from '../lib/auth.js'
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

export async function rotasNotificacoes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', autenticar)

  app.get('/notificacoes', async (req) => {
    const { apenasNaoLidas } = validar(
      z.object({ apenasNaoLidas: z.string().optional() }),
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

  app.post('/notificacoes/:id/lida', async (req) => {
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

  app.post('/notificacoes/lidas', async (req) => {
    const marcadas = await db
      .update(notificacoes)
      .set({ lidaEm: new Date() })
      .where(and(eq(notificacoes.usuarioId, req.user.sub), isNull(notificacoes.lidaEm)))
      .returning({ id: notificacoes.id })

    return { marcadas: marcadas.length }
  })
}
