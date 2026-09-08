import { and, count, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../db/client.js'
import { categorias, ordensServico, politicasSla, projetos } from '../db/schema.js'
import { autenticar } from '../lib/auth.js'
import { calcularSla } from '../lib/sla.js'
import { invalido, naoEncontrado, validar } from '../lib/http.js'

const criarSchema = z.object({
  nome: z.string().min(2, 'Informe o nome do projeto'),
  cliente: z.string().min(2, 'Informe o cliente'),
  descricao: z.string().max(2000).nullish(),
  cor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Cor deve estar no formato #RRGGBB')
    .default('#6366f1'),
  responsavelId: z.string().uuid().nullish(),
})

const atualizarSchema = criarSchema.partial().extend({
  arquivado: z.boolean().optional(),
})

export async function rotasProjetos(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', autenticar)

  /** Lista os projetos do tenant com a contagem de O.S. por status. */
  app.get('/projetos', async (req) => {
    const { tenantId } = req.user

    const lista = await db.query.projetos.findMany({
      where: eq(projetos.tenantId, tenantId),
      orderBy: (p, { desc }) => [desc(p.criadoEm)],
    })

    const contagens = await db
      .select({
        projetoId: ordensServico.projetoId,
        status: ordensServico.status,
        total: count(),
      })
      .from(ordensServico)
      .where(eq(ordensServico.tenantId, tenantId))
      .groupBy(ordensServico.projetoId, ordensServico.status)

    return {
      projetos: lista.map((p) => ({
        ...p,
        contagem: contagens
          .filter((c) => c.projetoId === p.id)
          .reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.status]: c.total }), {}),
      })),
    }
  })

  app.post('/projetos', async (req, reply) => {
    const dados = validar(criarSchema, req.body)
    const [criado] = await db
      .insert(projetos)
      .values({ ...dados, tenantId: req.user.tenantId })
      .returning()
    if (!criado) throw invalido('Nao foi possivel criar o projeto.')
    return reply.code(201).send({ projeto: criado })
  })

  app.get('/projetos/:id', async (req) => {
    const { id } = validar(z.object({ id: z.string().uuid() }), req.params)
    const projeto = await db.query.projetos.findFirst({
      where: and(eq(projetos.id, id), eq(projetos.tenantId, req.user.tenantId)),
    })
    if (!projeto) throw naoEncontrado('Projeto')
    return { projeto }
  })

  app.patch('/projetos/:id', async (req) => {
    const { id } = validar(z.object({ id: z.string().uuid() }), req.params)
    const dados = validar(atualizarSchema, req.body)
    const [atualizado] = await db
      .update(projetos)
      .set({ ...dados, atualizadoEm: new Date() })
      .where(and(eq(projetos.id, id), eq(projetos.tenantId, req.user.tenantId)))
      .returning()
    if (!atualizado) throw naoEncontrado('Projeto')
    return { projeto: atualizado }
  })

  app.delete('/projetos/:id', async (req, reply) => {
    const { id } = validar(z.object({ id: z.string().uuid() }), req.params)
    const [removido] = await db
      .delete(projetos)
      .where(and(eq(projetos.id, id), eq(projetos.tenantId, req.user.tenantId)))
      .returning({ id: projetos.id })
    if (!removido) throw naoEncontrado('Projeto')
    return reply.code(204).send()
  })

  /** KPIs do dashboard, calculados sobre as O.S. abertas do tenant. */
  app.get('/dashboard', async (req) => {
    const { tenantId } = req.user

    const [abertas, politicas, cats] = await Promise.all([
      db.query.ordensServico.findMany({
        where: and(
          eq(ordensServico.tenantId, tenantId),
          sql`${ordensServico.status} <> 'finalizado'`,
        ),
      }),
      db.query.politicasSla.findMany({ where: eq(politicasSla.tenantId, tenantId) }),
      db.query.categorias.findMany({ where: eq(categorias.tenantId, tenantId) }),
    ])

    const agora = new Date()
    let emRisco = 0
    let estouradas = 0

    const criticas = abertas
      .map((os) => {
        const sla = calcularSla(os, politicas, cats, agora)
        if (sla.resolucao.estado === 'em_risco') emRisco++
        if (sla.resolucao.estado === 'estourado') estouradas++
        return { os, sla }
      })
      .sort((a, b) => b.sla.resolucao.consumo - a.sla.resolucao.consumo)
      .slice(0, 5)
      .map(({ os, sla }) => ({
        id: os.id,
        codigo: os.codigo,
        titulo: os.titulo,
        projetoId: os.projetoId,
        prioridade: os.prioridade,
        status: os.status,
        sla,
      }))

    return {
      kpis: {
        abertas: abertas.length,
        emRisco,
        estouradas,
        aguardandoAprovacao: abertas.filter((o) => o.status === 'em_aprovacao').length,
      },
      precisaAtencao: criticas,
    }
  })
}
