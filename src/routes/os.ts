import { and, asc, desc, eq, like, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../db/client.js'
import {
  anexos,
  categorias,
  checklistItens,
  comentarios,
  historico,
  linksAprovacao,
  ordensServico,
  politicasSla,
  projetos,
  type OrdemServico,
  type StatusOS,
} from '../db/schema.js'
import { autenticar, contexto } from '../lib/auth.js'
import { invalido, naoEncontrado, validar } from '../lib/http.js'
import { calcularSla } from '../lib/sla.js'

const idParam = z.object({ id: z.string().uuid() })

const criarSchema = z.object({
  projetoId: z.string().uuid(),
  tipo: z.enum(['evento', 'tarefa']).default('tarefa'),
  titulo: z.string().min(3, 'Informe um titulo com ao menos 3 caracteres'),
  descricao: z.string().max(20000).nullish(),
  categoriaId: z.string().uuid().nullish(),
  prioridade: z.enum(['critica', 'alta', 'media', 'baixa']).default('media'),
  nivel: z.enum(['n1', 'n2', 'n3']).default('n1'),
  status: z.enum(['a_fazer', 'atendendo', 'pausado', 'em_aprovacao', 'finalizado']).default('a_fazer'),
  responsavelId: z.string().uuid().nullish(),
  solicitante: z.string().max(120).nullish(),
})

const atualizarSchema = criarSchema.partial().omit({ projetoId: true, status: true })

/* ------------------------------------------------------------------ *
 * Transicoes de status: e aqui que os relogios de SLA param e voltam
 * ------------------------------------------------------------------ */

function aplicarTransicao(
  os: OrdemServico,
  novo: StatusOS,
  agora: Date,
): Partial<typeof ordensServico.$inferInsert> {
  const mudanca: Partial<typeof ordensServico.$inferInsert> = {
    status: novo,
    atualizadoEm: agora,
  }

  // saindo de "pausado": acumula o tempo parado e zera o marcador
  if (os.status === 'pausado' && novo !== 'pausado') {
    const parados = os.pausadaEm ? (agora.getTime() - os.pausadaEm.getTime()) / 60_000 : 0
    mudanca.minutosPausados = os.minutosPausados + Math.round(parados)
    mudanca.pausadaEm = null
  }

  if (novo === 'pausado' && os.status !== 'pausado') {
    mudanca.pausadaEm = agora
  }

  if (novo === 'atendendo' && !os.inicioAtendimentoEm) {
    mudanca.inicioAtendimentoEm = agora
  }

  if (novo === 'finalizado') {
    mudanca.concluidaEm = os.concluidaEm ?? agora
  } else if (os.status === 'finalizado') {
    // reabertura: o relogio de resolucao volta a correr
    mudanca.concluidaEm = null
  }

  return mudanca
}

/** Gera OS-<ano>-<sequencial> por tenant. */
async function gerarCodigo(tenantId: string): Promise<string> {
  const ano = new Date().getFullYear()
  const prefixo = `OS-${ano}-`
  const [linha] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(ordensServico)
    .where(and(eq(ordensServico.tenantId, tenantId), like(ordensServico.codigo, `${prefixo}%`)))
  return `${prefixo}${String((linha?.total ?? 0) + 1).padStart(4, '0')}`
}

async function registrar(osId: string, tipo: string, descricao: string, autorNome: string) {
  await db.insert(historico).values({ osId, tipo, descricao, autorNome })
}

/** Carrega a O.S. garantindo que ela pertence ao tenant do usuario. */
async function buscarDoTenant(id: string, tenantId: string): Promise<OrdemServico> {
  const os = await db.query.ordensServico.findFirst({
    where: and(eq(ordensServico.id, id), eq(ordensServico.tenantId, tenantId)),
  })
  if (!os) throw naoEncontrado('O.S.')
  return os
}

export async function rotasOs(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', autenticar)

  /** Quadro Kanban de um projeto: todas as O.S. com o SLA ja calculado. */
  app.get('/projetos/:id/os', async (req) => {
    const { id: projetoId } = validar(idParam, req.params)
    const { tenantId } = req.user

    const projeto = await db.query.projetos.findFirst({
      where: and(eq(projetos.id, projetoId), eq(projetos.tenantId, tenantId)),
    })
    if (!projeto) throw naoEncontrado('Projeto')

    const [lista, politicas, cats] = await Promise.all([
      db.query.ordensServico.findMany({
        where: and(eq(ordensServico.projetoId, projetoId), eq(ordensServico.tenantId, tenantId)),
        orderBy: [asc(ordensServico.ordem), desc(ordensServico.criadoEm)],
      }),
      db.query.politicasSla.findMany({ where: eq(politicasSla.tenantId, tenantId) }),
      db.query.categorias.findMany({ where: eq(categorias.tenantId, tenantId) }),
    ])

    const agora = new Date()
    return {
      projeto,
      categorias: cats,
      ordens: lista.map((os) => ({ ...os, sla: calcularSla(os, politicas, cats, agora) })),
    }
  })

  app.post('/os', async (req, reply) => {
    const dados = validar(criarSchema, req.body)
    const { tenantId, nome } = contexto(req)

    const projeto = await db.query.projetos.findFirst({
      where: and(eq(projetos.id, dados.projetoId), eq(projetos.tenantId, tenantId)),
    })
    if (!projeto) throw naoEncontrado('Projeto')

    const agora = new Date()
    const [criada] = await db
      .insert(ordensServico)
      .values({
        ...dados,
        tenantId,
        codigo: await gerarCodigo(tenantId),
        abertaEm: agora,
        inicioAtendimentoEm: dados.status === 'atendendo' ? agora : null,
        pausadaEm: dados.status === 'pausado' ? agora : null,
        concluidaEm: dados.status === 'finalizado' ? agora : null,
      })
      .returning()
    if (!criada) throw invalido('Nao foi possivel criar a O.S.')

    await registrar(criada.id, 'criacao', `O.S. aberta em ${projeto.nome}`, nome)
    return reply.code(201).send({ os: criada })
  })

  /** Detalhe completo: filhos + SLA + links de aprovacao. */
  app.get('/os/:id', async (req) => {
    const { id } = validar(idParam, req.params)
    const { tenantId } = req.user
    const os = await buscarDoTenant(id, tenantId)

    const [checklist, arquivos, comentariosOs, eventos, links, politicas, cats] = await Promise.all([
      db.query.checklistItens.findMany({
        where: eq(checklistItens.osId, id),
        orderBy: asc(checklistItens.ordem),
      }),
      db.query.anexos.findMany({ where: eq(anexos.osId, id), orderBy: asc(anexos.criadoEm) }),
      db.query.comentarios.findMany({
        where: eq(comentarios.osId, id),
        orderBy: asc(comentarios.criadoEm),
      }),
      db.query.historico.findMany({
        where: eq(historico.osId, id),
        orderBy: desc(historico.criadoEm),
      }),
      db.query.linksAprovacao.findMany({
        where: eq(linksAprovacao.osId, id),
        orderBy: desc(linksAprovacao.criadoEm),
      }),
      db.query.politicasSla.findMany({ where: eq(politicasSla.tenantId, tenantId) }),
      db.query.categorias.findMany({ where: eq(categorias.tenantId, tenantId) }),
    ])

    return {
      os: { ...os, sla: calcularSla(os, politicas, cats, new Date()) },
      checklist,
      anexos: arquivos,
      comentarios: comentariosOs,
      historico: eventos,
      links,
    }
  })

  app.patch('/os/:id', async (req) => {
    const { id } = validar(idParam, req.params)
    const dados = validar(atualizarSchema, req.body)
    const { tenantId, nome } = contexto(req)
    await buscarDoTenant(id, tenantId)

    const [atualizada] = await db
      .update(ordensServico)
      .set({ ...dados, atualizadoEm: new Date() })
      .where(and(eq(ordensServico.id, id), eq(ordensServico.tenantId, tenantId)))
      .returning()
    if (!atualizada) throw naoEncontrado('O.S.')

    await registrar(id, 'edicao', 'O.S. atualizada', nome)
    return { os: atualizada }
  })

  /** Movimento do Kanban. Sempre manual — a aprovacao nao move o card sozinha. */
  app.patch('/os/:id/status', async (req) => {
    const { id } = validar(idParam, req.params)
    const { status, ordem } = validar(
      z.object({
        status: z.enum(['a_fazer', 'atendendo', 'pausado', 'em_aprovacao', 'finalizado']),
        ordem: z.number().int().min(0).optional(),
      }),
      req.body,
    )
    const { tenantId, nome } = contexto(req)
    const os = await buscarDoTenant(id, tenantId)

    if (os.status === status && ordem === undefined) return { os }

    const agora = new Date()
    const mudanca = aplicarTransicao(os, status, agora)
    if (ordem !== undefined) mudanca.ordem = ordem

    const [atualizada] = await db
      .update(ordensServico)
      .set(mudanca)
      .where(and(eq(ordensServico.id, id), eq(ordensServico.tenantId, tenantId)))
      .returning()
    if (!atualizada) throw naoEncontrado('O.S.')

    if (os.status !== status) {
      await registrar(id, 'status', `Movido de ${rotulo(os.status)} para ${rotulo(status)}`, nome)
    }
    return { os: atualizada }
  })

  app.delete('/os/:id', async (req, reply) => {
    const { id } = validar(idParam, req.params)
    const [removida] = await db
      .delete(ordensServico)
      .where(and(eq(ordensServico.id, id), eq(ordensServico.tenantId, req.user.tenantId)))
      .returning({ id: ordensServico.id })
    if (!removida) throw naoEncontrado('O.S.')
    return reply.code(204).send()
  })

  /* ---------------------------- comentarios ---------------------------- */

  app.post('/os/:id/comentarios', async (req, reply) => {
    const { id } = validar(idParam, req.params)
    const { texto, interno } = validar(
      z.object({ texto: z.string().min(1, 'Escreva algo'), interno: z.boolean().default(false) }),
      req.body,
    )
    const { tenantId, usuarioId, nome } = contexto(req)
    const os = await buscarDoTenant(id, tenantId)

    const [criado] = await db
      .insert(comentarios)
      .values({ osId: id, autorId: usuarioId, autorNome: nome, texto, interno })
      .returning()

    // o primeiro comentario publico marca a primeira resposta do SLA
    if (!interno && !os.primeiraRespostaEm) {
      await db
        .update(ordensServico)
        .set({ primeiraRespostaEm: new Date() })
        .where(eq(ordensServico.id, id))
    }

    return reply.code(201).send({ comentario: criado })
  })

  /* ------------------------------ anexos ------------------------------- */

  app.post('/os/:id/anexos', async (req, reply) => {
    const { id } = validar(idParam, req.params)
    const dados = validar(
      z.object({
        nome: z.string().min(1),
        // MVP: dataURL vinda do navegador. TODO(storage): trocar por upload em S3/R2.
        url: z.string().min(1),
        tipo: z.string().nullish(),
        tamanho: z.number().int().nonnegative().nullish(),
      }),
      req.body,
    )
    const { tenantId, nome } = contexto(req)
    await buscarDoTenant(id, tenantId)

    const [criado] = await db.insert(anexos).values({ osId: id, ...dados }).returning()
    await registrar(id, 'anexo', `Anexou ${dados.nome}`, nome)
    return reply.code(201).send({ anexo: criado })
  })

  app.delete('/os/:id/anexos/:anexoId', async (req, reply) => {
    const { id, anexoId } = validar(
      z.object({ id: z.string().uuid(), anexoId: z.string().uuid() }),
      req.params,
    )
    await buscarDoTenant(id, req.user.tenantId)
    await db.delete(anexos).where(and(eq(anexos.id, anexoId), eq(anexos.osId, id)))
    return reply.code(204).send()
  })

  /* ----------------------------- checklist ----------------------------- */

  app.post('/os/:id/checklist', async (req, reply) => {
    const { id } = validar(idParam, req.params)
    const { texto, ordem } = validar(
      z.object({ texto: z.string().min(1), ordem: z.number().int().min(0).default(0) }),
      req.body,
    )
    await buscarDoTenant(id, req.user.tenantId)
    const [criado] = await db.insert(checklistItens).values({ osId: id, texto, ordem }).returning()
    return reply.code(201).send({ item: criado })
  })

  app.patch('/os/:id/checklist/:itemId', async (req) => {
    const { id, itemId } = validar(
      z.object({ id: z.string().uuid(), itemId: z.string().uuid() }),
      req.params,
    )
    const dados = validar(
      z.object({ texto: z.string().min(1).optional(), feito: z.boolean().optional() }),
      req.body,
    )
    await buscarDoTenant(id, req.user.tenantId)
    const [atualizado] = await db
      .update(checklistItens)
      .set(dados)
      .where(and(eq(checklistItens.id, itemId), eq(checklistItens.osId, id)))
      .returning()
    if (!atualizado) throw naoEncontrado('Item')
    return { item: atualizado }
  })

  app.delete('/os/:id/checklist/:itemId', async (req, reply) => {
    const { id, itemId } = validar(
      z.object({ id: z.string().uuid(), itemId: z.string().uuid() }),
      req.params,
    )
    await buscarDoTenant(id, req.user.tenantId)
    await db.delete(checklistItens).where(and(eq(checklistItens.id, itemId), eq(checklistItens.osId, id)))
    return reply.code(204).send()
  })
}

function rotulo(status: StatusOS): string {
  const mapa: Record<StatusOS, string> = {
    a_fazer: 'A Fazer',
    atendendo: 'Em Atendimento',
    pausado: 'Pausado',
    em_aprovacao: 'Em Aprovacao',
    finalizado: 'Finalizado',
  }
  return mapa[status]
}
