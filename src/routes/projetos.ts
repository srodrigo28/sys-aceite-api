import { and, count, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../db/client.js'
import {
  categorias,
  atividades,
  politicasSla,
  projetoMembros,
  projetos,
} from '../db/schema.js'
import { autenticar, garantirAcessoProjeto, projetosVisiveis } from '../lib/auth.js'
import { doc } from '../lib/doc.js'
import { projetoSchema, slaSchema, uuidParam } from '../lib/esquemas.js'
import { apagarArquivosDasOs } from './os.js'
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

const projetoComContagemSchema = projetoSchema.extend({
  contagem: z
    .record(z.string(), z.number().int())
    .describe('O.S. por status, ex.: { "a_fazer": 3, "atendendo": 1 }. Status sem O.S. fica de fora'),
})

const dashboardSchema = z.object({
  kpis: z.object({
    abertas: z.number().int(),
    emRisco: z.number().int(),
    estouradas: z.number().int(),
    aguardandoAprovacao: z.number().int(),
  }),
  precisaAtencao: z
    .array(
      z.object({
        id: z.string().uuid(),
        codigo: z.string(),
        titulo: z.string(),
        projetoId: z.string().uuid(),
        prioridade: z.enum(['critica', 'alta', 'media', 'baixa']),
        status: z.enum(['a_fazer', 'atendendo', 'pausado', 'em_aprovacao', 'finalizado']),
        sla: slaSchema,
      }),
    )
    .describe('As 5 O.S. abertas com maior consumo do prazo de resolucao'),
})

export async function rotasProjetos(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', autenticar)

  /**
   * Projetos que o usuario enxerga, com a contagem de O.S. por status.
   * Admin ve todos os do tenant; colaborador so os que participa.
   */
  app.get('/projetos', {
    schema: doc({
      tag: 'Projetos',
      resumo: 'Projetos visiveis, com a contagem de O.S. por status',
      descricao:
        'Admin ve todos os do tenant; membro so aqueles em que consta como participante. ' +
        'Nao e paginado: a lista e por workspace e cabe numa tela.',
      ok: { schema: z.object({ projetos: z.array(projetoComContagemSchema) }) },
    }),
  }, async (req) => {
    const { tenantId } = req.user
    const visiveis = await projetosVisiveis(req)

    // colaborador sem projeto nenhum: lista vazia, sem ir ao banco de novo
    if (visiveis !== 'todos' && visiveis.length === 0) return { projetos: [] }

    const filtroProjeto =
      visiveis === 'todos'
        ? eq(projetos.tenantId, tenantId)
        : and(eq(projetos.tenantId, tenantId), inArray(projetos.id, visiveis))

    const lista = await db.query.projetos.findMany({
      where: filtroProjeto,
      orderBy: (p, { desc }) => [desc(p.criadoEm)],
    })

    const filtroOs =
      visiveis === 'todos'
        ? eq(atividades.tenantId, tenantId)
        : and(eq(atividades.tenantId, tenantId), inArray(atividades.projetoId, visiveis))

    const contagens = await db
      .select({
        projetoId: atividades.projetoId,
        status: atividades.status,
        total: count(),
      })
      .from(atividades)
      .where(filtroOs)
      .groupBy(atividades.projetoId, atividades.status)

    return {
      projetos: lista.map((p) => ({
        ...p,
        contagem: contagens
          .filter((c) => c.projetoId === p.id)
          .reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.status]: c.total }), {}),
      })),
    }
  })

  app.post('/projetos', {
    schema: doc({
      tag: 'Projetos',
      resumo: 'Cria um projeto',
      descricao:
        'Quem cria entra como membro automaticamente — caso contrario um membro criaria ' +
        'um projeto invisivel para ele mesmo. O responsavel indicado tambem entra.',
      body: criarSchema,
      ok: { status: 201, schema: z.object({ projeto: projetoSchema }), descricao: 'Projeto criado' },
    }),
  }, async (req, reply) => {
    const dados = validar(criarSchema, req.body)

    const criado = await db.transaction(async (tx) => {
      const [projeto] = await tx
        .insert(projetos)
        .values({ ...dados, tenantId: req.user.tenantId })
        .returning()
      if (!projeto) throw invalido('Nao foi possivel criar o projeto.')

      // quem cria participa; senao um colaborador criaria um projeto invisivel
      // para ele mesmo. Para o admin a linha e inofensiva: ele ve tudo.
      const membros = new Set([req.user.sub])
      if (dados.responsavelId) membros.add(dados.responsavelId)
      await tx
        .insert(projetoMembros)
        .values([...membros].map((usuarioId) => ({ projetoId: projeto.id, usuarioId })))
        .onConflictDoNothing()

      return projeto
    })

    return reply.code(201).send({ projeto: criado })
  })

  app.get('/projetos/:id', {
    schema: doc({
      tag: 'Projetos',
      resumo: 'Detalhe do projeto',
      descricao:
        'Projeto de outro tenant, ou do seu tenant mas fora dos seus projetos, responde 404 — ' +
        'nao 403. Um 403 confirmaria que o id existe.',
      params: uuidParam,
      ok: { schema: z.object({ projeto: projetoSchema }) },
    }),
  }, async (req) => {
    const { id } = validar(uuidParam, req.params)
    await garantirAcessoProjeto(req, id)

    const projeto = await db.query.projetos.findFirst({
      where: and(eq(projetos.id, id), eq(projetos.tenantId, req.user.tenantId)),
    })
    if (!projeto) throw naoEncontrado('Projeto')
    return { projeto }
  })

  app.patch('/projetos/:id', {
    schema: doc({
      tag: 'Projetos',
      resumo: 'Edita o projeto',
      descricao: 'Todos os campos sao opcionais. `arquivado: true` tira o projeto do uso corrente.',
      params: uuidParam,
      body: atualizarSchema,
      ok: { schema: z.object({ projeto: projetoSchema }) },
    }),
  }, async (req) => {
    const { id } = validar(uuidParam, req.params)
    const dados = validar(atualizarSchema, req.body)
    await garantirAcessoProjeto(req, id)

    const [atualizado] = await db
      .update(projetos)
      .set({ ...dados, atualizadoEm: new Date() })
      .where(and(eq(projetos.id, id), eq(projetos.tenantId, req.user.tenantId)))
      .returning()
    if (!atualizado) throw naoEncontrado('Projeto')
    return { projeto: atualizado }
  })

  app.delete('/projetos/:id', {
    schema: doc({
      tag: 'Projetos',
      resumo: 'Apaga o projeto e tudo que pende dele',
      descricao:
        'O cascade do banco leva O.S., comentarios e anexos. Os **arquivos** no bucket sao ' +
        'apagados aqui, no codigo: o banco nao alcanca o storage, e sem esta passagem eles ' +
        'ficariam orfaos para sempre. Nao ha desfazer.',
      params: uuidParam,
      ok: { status: 204, schema: null, descricao: 'Projeto apagado. Sem corpo.' },
    }),
  }, async (req, reply) => {
    const { id } = validar(uuidParam, req.params)
    await garantirAcessoProjeto(req, id)

    // cascade: projeto -> O.S. -> anexos. As linhas o banco leva; os arquivos
    // no bucket ficariam orfaos para sempre se ninguem apagasse aqui.
    const doProjeto = await db
      .select({ id: atividades.id })
      .from(atividades)
      .where(eq(atividades.projetoId, id))
    await apagarArquivosDasOs(doProjeto.map((o) => o.id))

    const [removido] = await db
      .delete(projetos)
      .where(and(eq(projetos.id, id), eq(projetos.tenantId, req.user.tenantId)))
      .returning({ id: projetos.id })
    if (!removido) throw naoEncontrado('Projeto')
    return reply.code(204).send()
  })

  /** KPIs do dashboard, sobre as O.S. abertas dos projetos que o usuario ve. */
  app.get('/dashboard', {
    schema: doc({
      tag: 'Projetos',
      resumo: 'KPIs e as O.S. mais proximas de estourar',
      descricao:
        'Conta apenas O.S. abertas (status diferente de `finalizado`) dos projetos visiveis. ' +
        'O SLA e calculado na hora da leitura, nunca gravado: politica ou multiplicador de ' +
        'categoria editado hoje ja vale para card aberto ontem.',
      ok: { schema: dashboardSchema },
    }),
  }, async (req) => {
    const { tenantId } = req.user
    const visiveis = await projetosVisiveis(req)

    if (visiveis !== 'todos' && visiveis.length === 0) {
      return {
        kpis: { abertas: 0, emRisco: 0, estouradas: 0, aguardandoAprovacao: 0 },
        precisaAtencao: [],
      }
    }

    const filtroAbertas =
      visiveis === 'todos'
        ? and(eq(atividades.tenantId, tenantId), sql`${atividades.status} <> 'finalizado'`)
        : and(
            eq(atividades.tenantId, tenantId),
            inArray(atividades.projetoId, visiveis),
            sql`${atividades.status} <> 'finalizado'`,
          )

    const [abertas, politicas, cats] = await Promise.all([
      db.query.atividades.findMany({ where: filtroAbertas }),
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
