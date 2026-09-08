import { and, asc, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db } from '../db/client.js'
import {
  anexos,
  categorias,
  comentarios,
  historico,
  linksAprovacao,
  ordensServico,
  politicasSla,
  projetos,
  tenants,
  type LinkAprovacao,
} from '../db/schema.js'
import { invalido, naoEncontrado, validar } from '../lib/http.js'
import { calcularSla } from '../lib/sla.js'

const tokenParam = z.object({ token: z.string().min(10).max(64) })

const decidirSchema = z
  .object({
    decisao: z.enum(['aprovado', 'ajustes']),
    observacao: z.string().max(4000).default(''),
    aprovadorNome: z.string().min(2, 'Informe seu nome'),
    aprovadorEmail: z.string().email('E-mail invalido').or(z.literal('')).nullish(),
    ciente: z.literal(true, { message: 'Confirme que revisou o conteudo' }),
  })
  .refine((d) => d.decisao === 'aprovado' || d.observacao.trim().length >= 10, {
    path: ['observacao'],
    message: 'Descreva o ajuste necessario (minimo 10 caracteres)',
  })

/** Expiracao e avaliada na leitura: link vencido vira 'expirado'. */
function estadoEfetivo(link: LinkAprovacao, agora = new Date()) {
  if (link.estado === 'pendente' && link.expiraEm && link.expiraEm <= agora) return 'expirado'
  return link.estado
}

function ipDe(req: FastifyRequest): string {
  const encaminhado = req.headers['x-forwarded-for']
  if (typeof encaminhado === 'string') return encaminhado.split(',')[0]?.trim() ?? req.ip
  return req.ip
}

export async function rotasPublicas(app: FastifyInstance): Promise<void> {
  /**
   * Pagina de aprovacao. Sem login: o segredo e o proprio token.
   * Devolve apenas o que o link autoriza — comentario interno nunca sai daqui.
   */
  app.get('/publico/aprovacao/:token', async (req) => {
    const { token } = validar(tokenParam, req.params)

    const link = await db.query.linksAprovacao.findFirst({
      where: eq(linksAprovacao.token, token),
    })
    if (!link) throw naoEncontrado('Link de aprovacao')

    const estado = estadoEfetivo(link)

    const os = await db.query.ordensServico.findFirst({ where: eq(ordensServico.id, link.osId) })
    if (!os) throw naoEncontrado('O.S.')

    const [projeto, tenant, categoria] = await Promise.all([
      db.query.projetos.findFirst({ where: eq(projetos.id, os.projetoId) }),
      db.query.tenants.findFirst({ where: eq(tenants.id, link.tenantId) }),
      os.categoriaId
        ? db.query.categorias.findFirst({ where: eq(categorias.id, os.categoriaId) })
        : Promise.resolve(undefined),
    ])

    const arquivos = link.mostrarAnexos
      ? await db.query.anexos.findMany({ where: eq(anexos.osId, os.id), orderBy: asc(anexos.criadoEm) })
      : []

    let sla = null
    if (link.mostrarSla) {
      const [politicas, cats] = await Promise.all([
        db.query.politicasSla.findMany({ where: eq(politicasSla.tenantId, link.tenantId) }),
        db.query.categorias.findMany({ where: eq(categorias.tenantId, link.tenantId) }),
      ])
      sla = calcularSla(os, politicas, cats, new Date())
    }

    return {
      estado,
      link: {
        mensagem: link.mensagem,
        expiraEm: link.expiraEm,
        mostrarAnexos: link.mostrarAnexos,
        mostrarDatas: link.mostrarDatas,
        mostrarSla: link.mostrarSla,
        aprovadorNomeSugerido: link.aprovadorNomeSugerido,
        aprovadorEmailSugerido: link.aprovadorEmailSugerido,
      },
      parecer:
        link.decisao && link.decididoEm
          ? {
              decisao: link.decisao,
              observacao: link.observacao,
              aprovadorNome: link.aprovadorNome,
              decididoEm: link.decididoEm,
            }
          : null,
      os: {
        codigo: os.codigo,
        titulo: os.titulo,
        descricao: os.descricao,
        prioridade: os.prioridade,
        tipo: os.tipo,
        categoria: categoria ? { nome: categoria.nome, cor: categoria.cor } : null,
        datas: link.mostrarDatas
          ? { abertaEm: os.abertaEm, inicioAtendimentoEm: os.inicioAtendimentoEm, concluidaEm: os.concluidaEm }
          : null,
        sla,
        anexos: arquivos.map((a) => ({ id: a.id, nome: a.nome, url: a.url, tipo: a.tipo })),
      },
      projeto: projeto ? { nome: projeto.nome, cliente: projeto.cliente, cor: projeto.cor } : null,
      organizacao: tenant ? { nome: tenant.nome } : null,
    }
  })

  /** Registra o parecer. O card e marcado, mas NAO muda de coluna sozinho. */
  app.post('/publico/aprovacao/:token', async (req, reply) => {
    const { token } = validar(tokenParam, req.params)
    const dados = validar(decidirSchema, req.body)

    const link = await db.query.linksAprovacao.findFirst({
      where: eq(linksAprovacao.token, token),
    })
    if (!link) throw naoEncontrado('Link de aprovacao')

    const estado = estadoEfetivo(link)
    if (estado === 'expirado') throw invalido('Este link expirou. Peca um novo ao responsavel.')
    if (estado === 'revogado') throw invalido('Este link foi cancelado pelo responsavel.')
    if (estado !== 'pendente') throw invalido('Este link ja recebeu um parecer.')

    const agora = new Date()
    const aprovado = dados.decisao === 'aprovado'
    const observacao = dados.observacao.trim()

    const atualizado = await db.transaction(async (tx) => {
      // trava otimista: so grava se ainda estiver pendente
      const [gravado] = await tx
        .update(linksAprovacao)
        .set({
          estado: aprovado ? 'aprovado' : 'ajustes',
          decisao: dados.decisao,
          observacao: observacao || null,
          aprovadorNome: dados.aprovadorNome.trim(),
          aprovadorEmail: dados.aprovadorEmail || null,
          decididoEm: agora,
          ipDecisao: ipDe(req),
        })
        .where(and(eq(linksAprovacao.id, link.id), eq(linksAprovacao.estado, 'pendente')))
        .returning()

      if (!gravado) throw invalido('Este link ja recebeu um parecer.')

      await tx
        .update(ordensServico)
        .set({
          aprovado,
          aprovadorNome: dados.aprovadorNome.trim(),
          aprovacaoObservacao: observacao || null,
          aprovadoEm: agora,
          atualizadoEm: agora,
        })
        .where(eq(ordensServico.id, link.osId))

      if (observacao) {
        await tx.insert(comentarios).values({
          osId: link.osId,
          autorNome: `${dados.aprovadorNome.trim()} (aprovador)`,
          texto: observacao,
          interno: false,
        })
      }

      await tx.insert(historico).values({
        osId: link.osId,
        tipo: 'aprovacao',
        descricao: aprovado
          ? `Aprovado por ${dados.aprovadorNome.trim()}`
          : `Ajustes solicitados por ${dados.aprovadorNome.trim()}`,
        autorNome: dados.aprovadorNome.trim(),
      })

      return gravado
    })

    return reply.code(201).send({
      ok: true,
      estado: atualizado.estado,
      mensagem: aprovado
        ? 'Aprovacao registrada. Obrigado!'
        : 'Solicitacao de ajustes registrada. Obrigado!',
    })
  })
}
