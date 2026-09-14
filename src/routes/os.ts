import { and, asc, desc, eq, inArray, like, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db } from '../db/client.js'
import {
  anexos,
  atividadeResponsaveis,
  categorias,
  checklistItens,
  comentarios,
  historico,
  linksAprovacao,
  atividades,
  politicasSla,
  projetos,
  projetoMembros,
  usuarios,
  type Atividade,
  type StatusOS,
} from '../db/schema.js'
import { anexoTamanhoMax } from '../env.js'
import {
  anexoPublico,
  arquivosDoAnexo,
  MAX_ANEXOS_POR_OS,
  responderArquivo,
  validarArquivo,
  versaoParaServir,
} from '../lib/anexo.js'
import { encolherParaLimite, gerarMiniatura, podeGerarMiniatura } from '../lib/imagem.js'
import { interessadosNaOs, notificar } from '../lib/notificacao.js'
import {
  autenticar,
  contexto,
  garantirAcessoProjeto,
  projetosVisiveis,
} from '../lib/auth.js'
import { apagar, baixar, enviar } from '../lib/bucket.js'
import { doc } from '../lib/doc.js'
import {
  anexoSchema,
  categoriaSchema,
  checklistItemSchema,
  comentarioSchema,
  historicoSchema,
  linkSchema,
  osComSlaSchema,
  osSchema,
  projetoSchema,
  uuidParam,
} from '../lib/esquemas.js'
import { invalido, naoEncontrado, validar } from '../lib/http.js'
import { calcularSla } from '../lib/sla.js'

const idParam = z.object({ id: z.string().uuid() })

/** O limite que vale de verdade depende do storage ativo (bucket ou disco). */
function limiteAnexo(): string {
  const mb = anexoTamanhoMax / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(mb % 1 === 0 ? 0 : 1)} MB` : `${Math.round(anexoTamanhoMax / 1024)} KB`
}

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
  /**
   * Quem responde pela atividade. O primeiro da lista e o principal.
   *
   * `responsavelId` continua aceito para nao quebrar cliente antigo: quando
   * vem sozinho, vira uma lista de um. Sai quando o web parar de mandar.
   */
  responsaveisIds: z.array(z.string().uuid()).optional(),

  /** Planejamento. Nao alimenta o SLA — isso e dos campos de execucao. */
  previstoInicioEm: z.coerce.date().nullish(),
  previstoFimEm: z.coerce.date().nullish(),
  /** Inteiros. A tela oferece de 1h a 10h; a API aceita qualquer valor >= 0. */
  minutosEstimados: z.number().int().min(0).nullish(),
  minutosApontados: z.number().int().min(0).optional(),
  observacoes: z.string().max(2000).nullish(),
  solicitante: z.string().max(120).nullish(),
})

const atualizarSchema = criarSchema.partial().omit({ projetoId: true, status: true })

const statusSchema = z.object({
  status: z.enum(['a_fazer', 'atendendo', 'pausado', 'em_aprovacao', 'finalizado']),
  ordem: z.number().int().min(0).optional().describe('Posicao na coluna de destino'),
})

const comentarioBodySchema = z.object({
  texto: z.string().min(1, 'Escreva algo'),
  interno: z.boolean().default(false).describe('true = nunca aparece na pagina publica'),
})

const itemBodySchema = z.object({
  texto: z.string().min(1),
  ordem: z.number().int().min(0).default(0),
})

const itemPatchSchema = z.object({
  texto: z.string().min(1).optional(),
  feito: z.boolean().optional(),
})

/** A lista completa evita estados intermediarios quando o usuario arrasta varias vezes. */
const ordenarChecklistSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1),
}).refine((dados) => new Set(dados.itemIds).size === dados.itemIds.length, {
  message: 'Cada item deve aparecer uma unica vez',
})

const anexoParam = z.object({ id: z.string().uuid(), anexoId: z.string().uuid() })
const itemParam = z.object({ id: z.string().uuid(), itemId: z.string().uuid() })

const arquivoQuery = z.object({
  download: z.string().optional().describe('1 forca o navegador a baixar em vez de exibir'),
  miniatura: z.string().optional().describe('1 serve a miniatura webp; sem ela, o original'),
})

/* ------------------------------------------------------------------ *
 * Transicoes de status: e aqui que os relogios de SLA param e voltam
 * ------------------------------------------------------------------ */

function aplicarTransicao(
  os: Atividade,
  novo: StatusOS,
  agora: Date,
): Partial<typeof atividades.$inferInsert> {
  const mudanca: Partial<typeof atividades.$inferInsert> = {
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
    .from(atividades)
    .where(and(eq(atividades.tenantId, tenantId), like(atividades.codigo, `${prefixo}%`)))
  return `${prefixo}${String((linha?.total ?? 0) + 1).padStart(4, '0')}`
}

async function registrar(osId: string, tipo: string, descricao: string, autorNome: string) {
  await db.insert(historico).values({ osId, tipo, descricao, autorNome })
}

/** Carrega a O.S. garantindo que ela pertence ao tenant do usuario. */
/**
 * Ponto unico de acesso a uma O.S.: filtra pelo tenant e, para colaborador,
 * tambem pelo projeto. O.S. de projeto que ele nao participa responde 404,
 * igual a O.S. que nao existe — nao revela que existe.
 */
/**
 * Tira do storage todos os anexos das O.S. informadas. Falha em um arquivo nao
 * interrompe os outros: sobrar arquivo e ruim, mas travar a exclusao e pior.
 */
export async function apagarArquivosDasOs(osIds: string[]): Promise<number> {
  if (osIds.length === 0) return 0

  const lista = await db.query.anexos.findMany({ where: inArray(anexos.osId, osIds) })
  let apagados = 0
  for (const anexo of lista) {
    for (const arquivo of arquivosDoAnexo(anexo)) {
      await apagar(arquivo)
      apagados++
    }
  }
  return apagados
}

async function buscarOsVisivel(id: string, req: FastifyRequest): Promise<Atividade> {
  const os = await db.query.atividades.findFirst({
    where: and(eq(atividades.id, id), eq(atividades.tenantId, req.user.tenantId)),
  })
  if (!os) throw naoEncontrado('O.S.')

  const visiveis = await projetosVisiveis(req)
  if (visiveis !== 'todos' && !visiveis.includes(os.projetoId)) throw naoEncontrado('O.S.')

  return os
}

async function validarResponsavel(projetoId: string, responsavelId: string | null | undefined, req: FastifyRequest) {
  if (!responsavelId) return
  const usuario = await db.query.usuarios.findFirst({
    where: and(eq(usuarios.id, responsavelId), eq(usuarios.tenantId, req.user.tenantId), eq(usuarios.ativo, true)),
    columns: { id: true, papel: true },
  })
  if (!usuario) throw naoEncontrado('Responsavel')
  if (usuario.papel === 'admin') return
  const membro = await db.query.projetoMembros.findFirst({
    where: and(eq(projetoMembros.projetoId, projetoId), eq(projetoMembros.usuarioId, responsavelId)),
  })
  if (!membro) throw invalido('O responsavel precisa participar deste projeto.')
}

/**
 * Fim nao pode vir antes do inicio.
 *
 * Confere contra o que a atividade JA tem, e nao so contra o que veio no corpo:
 * um PATCH que mande apenas `previstoFimEm` precisa ser comparado com o inicio
 * ja gravado, senao da para inverter o intervalo em duas requisicoes.
 */
function validarPeriodo(
  novo: { previstoInicioEm?: Date | null; previstoFimEm?: Date | null },
  atual?: { previstoInicioEm: Date | null; previstoFimEm: Date | null },
) {
  const inicio = novo.previstoInicioEm !== undefined ? novo.previstoInicioEm : atual?.previstoInicioEm
  const fim = novo.previstoFimEm !== undefined ? novo.previstoFimEm : atual?.previstoFimEm
  if (inicio && fim && fim < inicio) {
    throw invalido('A data de fim nao pode ser anterior a de inicio.')
  }
}

/** A mesma regra, pessoa por pessoa. Lista vazia e valida: atividade sem dono. */
async function validarResponsaveis(projetoId: string, ids: string[], req: FastifyRequest) {
  for (const id of new Set(ids)) await validarResponsavel(projetoId, id, req)
}

/**
 * Grava a lista de responsaveis de uma atividade, substituindo a anterior.
 *
 * O primeiro da lista e o principal — e ele que aparece onde so cabe um nome.
 * Devolve quem ENTROU, nao a lista inteira: e isso que vai para a notificacao.
 * Avisar todo mundo a cada edicao faria quem ja estava receber "voce foi
 * atribuido" de novo toda vez que outra pessoa entrasse.
 */
async function definirResponsaveis(
  atividadeId: string,
  ids: string[],
  tx: typeof db = db,
): Promise<string[]> {
  const antes = await tx
    .select({ usuarioId: atividadeResponsaveis.usuarioId })
    .from(atividadeResponsaveis)
    .where(eq(atividadeResponsaveis.atividadeId, atividadeId))
  const jaEstavam = new Set(antes.map((r) => r.usuarioId))

  const unicos = [...new Set(ids)]
  await tx.delete(atividadeResponsaveis).where(eq(atividadeResponsaveis.atividadeId, atividadeId))
  if (unicos.length > 0) {
    await tx.insert(atividadeResponsaveis).values(
      unicos.map((usuarioId, i) => ({ atividadeId, usuarioId, principal: i === 0 })),
    )
  }
  return unicos.filter((id) => !jaEstavam.has(id))
}

/**
 * Monta a atividade para a resposta.
 *
 * `responsavelId` nao e mais coluna: sai daqui, derivado do primeiro da lista.
 * Mantido porque cliente com bundle antigo em cache ainda o le — e como ele
 * agora e DERIVADO, nao ha duas fontes de verdade para divergir.
 */
function comResponsaveis<T extends object>(os: T, ids: string[]) {
  return { ...os, responsavelId: ids[0] ?? null, responsaveis: ids }
}

/** Os responsaveis de varias atividades de uma vez, para as listas. */
async function responsaveisDe(ids: string[]): Promise<Map<string, string[]>> {
  const mapa = new Map<string, string[]>()
  if (ids.length === 0) return mapa
  const linhas = await db
    .select({
      atividadeId: atividadeResponsaveis.atividadeId,
      usuarioId: atividadeResponsaveis.usuarioId,
      principal: atividadeResponsaveis.principal,
    })
    .from(atividadeResponsaveis)
    .where(inArray(atividadeResponsaveis.atividadeId, ids))
  // principal primeiro: o front usa o [0] onde so cabe um nome
  for (const l of linhas.sort((a, b) => Number(b.principal) - Number(a.principal))) {
    mapa.set(l.atividadeId, [...(mapa.get(l.atividadeId) ?? []), l.usuarioId])
  }
  return mapa
}

export async function rotasOs(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', autenticar)

  /** Quadro Kanban de um projeto: todas as O.S. com o SLA ja calculado. */
  app.get('/projetos/:id/atividades', {
    schema: doc({
      tag: 'Ordens de servico',
      resumo: 'Quadro Kanban do projeto, com o SLA ja calculado',
      descricao:
        'Uma chamada monta o quadro inteiro: projeto, categorias e as O.S. com os dois relogios ' +
        'resolvidos. O SLA nao e persistido — mudar uma politica hoje ja muda o semaforo de um ' +
        'card aberto ontem. Ordenado por `ordem` e, em empate, pelas mais recentes.',
      params: uuidParam,
      ok: {
        schema: z.object({
          projeto: projetoSchema,
          categorias: z.array(categoriaSchema),
          ordens: z.array(osComSlaSchema),
        }),
      },
    }),
  }, async (req) => {
    const { id: projetoId } = validar(idParam, req.params)
    const { tenantId } = req.user
    await garantirAcessoProjeto(req, projetoId)

    const projeto = await db.query.projetos.findFirst({
      where: and(eq(projetos.id, projetoId), eq(projetos.tenantId, tenantId)),
    })
    if (!projeto) throw naoEncontrado('Projeto')

    const [lista, politicas, cats] = await Promise.all([
      db.query.atividades.findMany({
        where: and(eq(atividades.projetoId, projetoId), eq(atividades.tenantId, tenantId)),
        orderBy: [asc(atividades.ordem), desc(atividades.criadoEm)],
      }),
      db.query.politicasSla.findMany({ where: eq(politicasSla.tenantId, tenantId) }),
      db.query.categorias.findMany({ where: eq(categorias.tenantId, tenantId) }),
    ])

    const agora = new Date()
    const porAtividade = await responsaveisDe(lista.map((o) => o.id))
    return {
      projeto,
      categorias: cats,
      ordens: lista.map((os) => ({
        ...comResponsaveis(os, porAtividade.get(os.id) ?? []),
        sla: calcularSla(os, politicas, cats, agora),
      })),
    }
  })

  app.post('/atividades', {
    schema: doc({
      tag: 'Ordens de servico',
      resumo: 'Abre uma O.S. (evento ou tarefa)',
      descricao:
        'O `codigo` (OS-ano-sequencial) e gerado pela API. Um responsavel indicado precisa ' +
        'participar do projeto — a nao ser que seja admin, que enxerga tudo — e recebe ' +
        'notificacao na hora. O `status` inicial ja acerta os relogios: nascer em `atendendo` ' +
        'marca o inicio do atendimento.',
      body: criarSchema,
      ok: { status: 201, schema: z.object({ os: osSchema }), descricao: 'O.S. aberta' },
      erros: [404],
    }),
  }, async (req, reply) => {
    const dados = validar(criarSchema, req.body)
    const { tenantId, usuarioId, nome } = contexto(req)
    await garantirAcessoProjeto(req, dados.projetoId)

    const projeto = await db.query.projetos.findFirst({
      where: and(eq(projetos.id, dados.projetoId), eq(projetos.tenantId, tenantId)),
    })
    if (!projeto) throw naoEncontrado('Projeto')
    const escolhidos = dados.responsaveisIds ?? (dados.responsavelId ? [dados.responsavelId] : [])
    await validarResponsaveis(dados.projetoId, escolhidos, req)
    validarPeriodo(dados)

    const agora = new Date()
    // nenhuma das duas e coluna: `responsaveisIds` nunca foi, e `responsavelId`
    // deixou de ser. O Drizzle ignorava a primeira em silencio — explicito e melhor.
    const { responsavelId: _p, responsaveisIds: _l, ...camposNovos } = dados
    const [criada] = await db
      .insert(atividades)
      .values({
        ...camposNovos,
        tenantId,
        codigo: await gerarCodigo(tenantId),
        abertaEm: agora,
        inicioAtendimentoEm: dados.status === 'atendendo' ? agora : null,
        pausadaEm: dados.status === 'pausado' ? agora : null,
        concluidaEm: dados.status === 'finalizado' ? agora : null,
      })
      .returning()
    if (!criada) throw invalido('Nao foi possivel criar a O.S.')

    const entraram = await definirResponsaveis(criada.id, escolhidos)

    await registrar(criada.id, 'criacao', `O.S. aberta em ${projeto.nome}`, nome)

    // atividade ja nasce atribuida: avisa quem vai tocar
    if (entraram.length > 0) {
      await notificar({
        tenantId,
        destinatarios: entraram,
        tipo: 'os_atribuida',
        titulo: `Nova atividade: ${criada.titulo}`,
        descricao: `${criada.codigo} em ${projeto.nome}`,
        osId: criada.id,
        projetoId: criada.projetoId,
        autorId: usuarioId,
        autorNome: nome,
      })
    }

    return reply.code(201).send({ os: comResponsaveis(criada, escolhidos) })
  })

  /** Atividades atribuídas ao usuário logado, agrupáveis por status no front. */
  app.get('/atividades/minhas', {
    schema: doc({
      tag: 'Ordens de servico',
      resumo: 'As O.S. em que voce e o responsavel',
      descricao:
        'Atravessa projetos: e a pergunta "o que esta comigo", nao "o que ha neste quadro". ' +
        'Inclui finalizadas; o front agrupa por status.',
      ok: { schema: z.object({ ordens: z.array(osComSlaSchema) }) },
    }),
  }, async (req) => {
    const { tenantId, usuarioId } = contexto(req)
    const [lista, politicas, cats] = await Promise.all([
      db.query.atividades.findMany({
        // "minhas" passa a significar QUALQUER vinculo, nao so o principal:
        // quem e o segundo responsavel tambem precisa ver a atividade na lista
        where: and(
          eq(atividades.tenantId, tenantId),
          inArray(
            atividades.id,
            db
              .select({ id: atividadeResponsaveis.atividadeId })
              .from(atividadeResponsaveis)
              .where(eq(atividadeResponsaveis.usuarioId, usuarioId)),
          ),
        ),
        orderBy: [asc(atividades.status), asc(atividades.ordem), desc(atividades.criadoEm)],
      }),
      db.query.politicasSla.findMany({ where: eq(politicasSla.tenantId, tenantId) }),
      db.query.categorias.findMany({ where: eq(categorias.tenantId, tenantId) }),
    ])
    const porAtividade = await responsaveisDe(lista.map((o) => o.id))
    return {
      ordens: lista.map((os) => ({
        ...comResponsaveis(os, porAtividade.get(os.id) ?? []),
        sla: calcularSla(os, politicas, cats, new Date()),
      })),
    }
  })

  /** Detalhe completo: filhos + SLA + links de aprovacao. */
  app.get('/atividades/:id', {
    schema: doc({
      tag: 'Ordens de servico',
      resumo: 'Detalhe completo: filhos, SLA e links de aprovacao',
      descricao:
        'Tudo o que a tela de detalhe precisa, em uma ida so. Os anexos vem sem `caminho` nem ' +
        '`fileId`: o arquivo so sai por `GET /anexos/{id}/arquivo`. Comentarios internos ' +
        'aparecem aqui — e so na pagina publica que eles somem.',
      params: uuidParam,
      ok: {
        schema: z.object({
          os: osComSlaSchema,
          checklist: z.array(checklistItemSchema),
          anexos: z.array(anexoSchema),
          comentarios: z.array(comentarioSchema),
          historico: z.array(historicoSchema),
          links: z.array(linkSchema),
        }),
      },
    }),
  }, async (req) => {
    const { id } = validar(idParam, req.params)
    const { tenantId } = req.user
    const os = await buscarOsVisivel(id, req)

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
      os: {
        ...comResponsaveis(os, (await responsaveisDe([os.id])).get(os.id) ?? []),
        sla: calcularSla(os, politicas, cats, new Date()),
      },
      checklist,
      anexos: arquivos.map(anexoPublico),
      comentarios: comentariosOs,
      historico: eventos,
      links,
    }
  })

  app.patch('/atividades/:id', {
    schema: doc({
      tag: 'Ordens de servico',
      resumo: 'Edita a O.S.',
      descricao:
        'Nao move o card: para isso existe `PATCH /os/{id}/status`, que mexe nos relogios. ' +
        '`projetoId` tambem nao entra — mudar de projeto mudaria quem enxerga a O.S.',
      params: uuidParam,
      body: atualizarSchema,
      ok: { schema: z.object({ os: osSchema }) },
    }),
  }, async (req) => {
    const { id } = validar(idParam, req.params)
    const dados = validar(atualizarSchema, req.body)
    const { tenantId, usuarioId, nome } = contexto(req)
    const antes = await buscarOsVisivel(id, req)
    // `responsaveisIds` manda quando vem; `responsavelId` sozinho vira lista de um
    const novaLista =
      dados.responsaveisIds ??
      (dados.responsavelId !== undefined
        ? dados.responsavelId
          ? [dados.responsavelId]
          : []
        : undefined)
    if (novaLista) await validarResponsaveis(antes.projetoId, novaLista, req)
    validarPeriodo(dados, antes)

    const { responsavelId: _principal, responsaveisIds: _lista, ...campos } = dados
    const [atualizada] = await db
      .update(atividades)
      .set({ ...campos, atualizadoEm: new Date() })
      .where(and(eq(atividades.id, id), eq(atividades.tenantId, tenantId)))
      .returning()
    if (!atualizada) throw naoEncontrado('O.S.')

    const entraram = novaLista ? await definirResponsaveis(id, novaLista) : []

    await registrar(id, 'edicao', 'O.S. atualizada', nome)

    // so quem ENTROU e avisado. Notificar a lista inteira a cada edicao faria
    // quem ja estava receber "voce foi atribuido" sempre que outra pessoa entra
    if (entraram.length > 0) {
      await notificar({
        tenantId,
        destinatarios: entraram,
        tipo: 'os_atribuida',
        titulo: `Atividade atribuida a voce: ${atualizada.titulo}`,
        descricao: atualizada.codigo,
        osId: atualizada.id,
        projetoId: atualizada.projetoId,
        autorId: usuarioId,
        autorNome: nome,
      })
    }
    const responsaveis = novaLista ?? (await responsaveisDe([id])).get(id) ?? []
    return { os: comResponsaveis(atualizada, responsaveis) }
  })

  /** Movimento do Kanban. Sempre manual — a aprovacao nao move o card sozinha. */
  app.patch('/atividades/:id/status', {
    schema: doc({
      tag: 'Ordens de servico',
      resumo: 'Move o card no Kanban',
      descricao:
        'E aqui que os relogios param e voltam: `atendendo` marca o inicio do atendimento na ' +
        'primeira vez; `pausado` congela o SLA e o tempo parado e descontado na saida; ' +
        '`finalizado` fecha, e reabrir volta a contar. Nenhuma outra rota move o card — nem a ' +
        'aprovacao do cliente, que so registra o parecer. Mandar o status atual sem `ordem` e ' +
        'no-op e devolve a O.S. como esta.',
      params: uuidParam,
      body: statusSchema,
      ok: { schema: z.object({ os: osSchema }) },
    }),
  }, async (req) => {
    const { id } = validar(idParam, req.params)
    const { status, ordem } = validar(
      statusSchema,
      req.body,
    )
    const { tenantId, usuarioId, nome } = contexto(req)
    const os = await buscarOsVisivel(id, req)

    const responsaveisAtuais = (await responsaveisDe([os.id])).get(os.id) ?? []
    if (os.status === status && ordem === undefined) {
      return { os: comResponsaveis(os, responsaveisAtuais) }
    }

    const agora = new Date()
    const mudanca = aplicarTransicao(os, status, agora)
    if (ordem !== undefined) mudanca.ordem = ordem

    const [atualizada] = await db
      .update(atividades)
      .set(mudanca)
      .where(and(eq(atividades.id, id), eq(atividades.tenantId, tenantId)))
      .returning()
    if (!atualizada) throw naoEncontrado('O.S.')

    if (os.status !== status) {
      await registrar(id, 'status', `Movido de ${rotulo(os.status)} para ${rotulo(status)}`, nome)

      // e daqui que sai o aviso do quadro para quem acompanha
      await notificar({
        tenantId,
        destinatarios: await interessadosNaOs(tenantId, atualizada.id),
        tipo: 'os_status',
        titulo: `${atualizada.codigo} foi para ${rotulo(status)}`,
        descricao: atualizada.titulo,
        osId: atualizada.id,
        projetoId: atualizada.projetoId,
        autorId: usuarioId,
        autorNome: nome,
      })
    }
    return { os: comResponsaveis(atualizada, responsaveisAtuais) }
  })

  app.delete('/atividades/:id', {
    schema: doc({
      tag: 'Ordens de servico',
      resumo: 'Apaga a O.S.',
      descricao:
        'Leva checklist, comentarios, historico, links e anexos. Os arquivos saem do storage ' +
        'aqui, no codigo: o cascade do banco nao alcanca o bucket. Nao ha desfazer.',
      params: uuidParam,
      ok: { status: 204, schema: null, descricao: 'O.S. apagada. Sem corpo.' },
    }),
  }, async (req, reply) => {
    const { id } = validar(idParam, req.params)
    await buscarOsVisivel(id, req)

    // o cascade do banco leva as linhas, nao os arquivos: sem isto o bucket
    // acumula anexo de O.S. que nao existe mais, para sempre
    await apagarArquivosDasOs([id])

    const [removida] = await db
      .delete(atividades)
      .where(and(eq(atividades.id, id), eq(atividades.tenantId, req.user.tenantId)))
      .returning({ id: atividades.id })
    if (!removida) throw naoEncontrado('O.S.')
    return reply.code(204).send()
  })

  /* ---------------------------- comentarios ---------------------------- */

  app.post('/atividades/:id/comentarios', {
    schema: doc({
      tag: 'Ordens de servico',
      resumo: 'Comenta na O.S.',
      descricao:
        'O primeiro comentario **publico** marca a primeira resposta do SLA — comentario interno ' +
        'nao serve, porque o cliente nao o ve e o relogio mede a resposta a ele. ' +
        'Interno tambem nao gera notificacao fora do time.',
      params: uuidParam,
      body: comentarioBodySchema,
      ok: { status: 201, schema: z.object({ comentario: comentarioSchema }) },
    }),
  }, async (req, reply) => {
    const { id } = validar(idParam, req.params)
    const { texto, interno } = validar(
      comentarioBodySchema,
      req.body,
    )
    const { tenantId, usuarioId, nome } = contexto(req)
    const os = await buscarOsVisivel(id, req)

    const [criado] = await db
      .insert(comentarios)
      .values({ osId: id, autorId: usuarioId, autorNome: nome, texto, interno })
      .returning()

    // o primeiro comentario publico marca a primeira resposta do SLA
    if (!interno && !os.primeiraRespostaEm) {
      await db
        .update(atividades)
        .set({ primeiraRespostaEm: new Date() })
        .where(eq(atividades.id, id))
    }

    // comentario interno nao sai do time: nao vira notificacao
    if (!interno) {
      await notificar({
        tenantId,
        destinatarios: await interessadosNaOs(tenantId, os.id),
        tipo: 'os_comentario',
        titulo: `Novo comentario em ${os.codigo}`,
        descricao: texto.slice(0, 160),
        osId: os.id,
        projetoId: os.projetoId,
        autorId: usuarioId,
        autorNome: nome,
      })
    }

    return reply.code(201).send({ comentario: criado })
  })

  /* ------------------------------ anexos ------------------------------- */

  /** Upload multipart. O arquivo vai para o bucket (ou disco) e so a linha fica no banco. */
  app.post('/atividades/:id/anexos', {
    schema: doc({
      tag: 'Ordens de servico',
      resumo: 'Envia um anexo (multipart)',
      descricao:
        'Um arquivo por chamada, no campo `arquivo`, no maximo 20 por O.S. O tipo e conferido ' +
        'pelos primeiros bytes, nao pelo que o navegador declara: `.exe` renomeado para `.jpg` ' +
        'e recusado, e `.svg` fica de fora de proposito (e documento e carrega script). ' +
        '**Imagem acima do teto do storage e encolhida em vez de recusada** e volta com ' +
        '`reduzida: true` — foto de celular tem 4-8 MB e o bucket corta em ~1 MB. Arquivo que ' +
        'nao e imagem, acima do teto, da 400. Acima do limite do proxy, 413.',
      params: uuidParam,
      arquivo: { campo: 'arquivo', descricao: 'Imagem, PDF, texto, ZIP ou documento do Office' },
      ok: {
        status: 201,
        schema: z.object({
          anexo: anexoSchema,
          reduzida: z.boolean().describe('true = a imagem foi convertida para webp menor'),
        }),
      },
      erros: [413],
    }),
  }, async (req, reply) => {
    const { id } = validar(idParam, req.params)
    const { tenantId, usuarioId, nome: autor } = contexto(req)

    // valida a posse ANTES de tocar no storage
    await buscarOsVisivel(id, req)

    const [{ total } = { total: 0 }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(anexos)
      .where(eq(anexos.osId, id))
    if (total >= MAX_ANEXOS_POR_OS) {
      throw invalido(`Esta O.S. ja tem ${MAX_ANEXOS_POR_OS} anexos.`)
    }

    const parte = await req.file()
    if (!parte) throw invalido('Envie um arquivo no campo "arquivo".')

    let buffer: Buffer
    try {
      buffer = await parte.toBuffer()
    } catch {
      // estourou o limite do @fastify/multipart
      throw invalido(`Arquivo maior que o limite de ${limiteAnexo()}.`)
    }
    if (parte.file.truncated) {
      throw invalido(`Arquivo maior que o limite de ${limiteAnexo()}.`)
    }

    const validado = validarArquivo(buffer, parte.filename, parte.mimetype)
    let { nome, mimeType } = validado
    let reduzida = false

    // Imagem acima do teto do storage: encolhe em vez de recusar. Foto de
    // celular tem 4-8 MB e o bucket corta em ~1 MB — sem isto o caso de uso
    // central (anexar a foto da O.S.) simplesmente nao funciona. Imagem que
    // ja cabe passa intacta; o que nao e imagem continua sendo recusado.
    if (buffer.byteLength > anexoTamanhoMax) {
      if (!podeGerarMiniatura(mimeType)) {
        throw invalido(
          `O arquivo tem ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB e o limite e ${limiteAnexo()}.`,
        )
      }
      const menor = await encolherParaLimite(buffer, mimeType, anexoTamanhoMax)
      if (!menor) {
        throw invalido(
          `Nao consegui reduzir esta imagem para caber em ${limiteAnexo()}. Tente uma menor.`,
        )
      }
      buffer = menor.buffer
      mimeType = menor.mimeType
      nome = `${nome.replace(/\.[^.]+$/, '')}.webp`
      reduzida = true
    }

    const pastaVirtual = `tenants/${tenantId}/os/${id}`
    const salvo = await enviar({ buffer, nome, mimeType, pastaVirtual })

    // Miniatura e conveniencia: se falhar, o anexo entra sem ela e o proxy
    // serve o original. Nunca derruba o upload.
    let mini: {
      miniaturaFileId: string
      miniaturaCaminho: string
      miniaturaMime: string
      miniaturaTamanho: number
    } | null = null

    const geradaMini = await gerarMiniatura(buffer, mimeType)
    if (geradaMini) {
      try {
        const salvoMini = await enviar({
          buffer: geradaMini.buffer,
          nome: `mini-${nome.replace(/\.[^.]+$/, '')}.webp`,
          mimeType: geradaMini.mimeType,
          pastaVirtual,
        })
        mini = {
          miniaturaFileId: salvoMini.fileId,
          miniaturaCaminho: salvoMini.caminho,
          miniaturaMime: salvoMini.mimeType,
          miniaturaTamanho: salvoMini.tamanho,
        }
      } catch (e) {
        console.error(`[miniatura] upload falhou: ${(e as Error).message}`)
      }
    }

    try {
      const [criado] = await db
        .insert(anexos)
        .values({ osId: id, tenantId, nome, enviadoPorId: usuarioId, ...salvo, ...mini })
        .returning()
      if (!criado) throw invalido('Nao foi possivel registrar o anexo.')

      await registrar(id, 'anexo', `Anexou ${nome}`, autor)
      return reply.code(201).send({ anexo: anexoPublico(criado), reduzida })
    } catch (erro) {
      // nao deixa orfao no bucket se o banco falhar depois do upload
      await apagar(salvo)
      throw erro
    }
  })

  /**
   * Proxy de download. O cliente nunca recebe a URL do bucket — ela abre sem
   * token, entao entrega-la tornaria o anexo publico para sempre.
   */
  app.get('/anexos/:id/arquivo', {
    schema: doc({
      tag: 'Ordens de servico',
      resumo: 'Baixa o arquivo do anexo (proxy autenticado)',
      descricao:
        'O bucket e publico: sua URL abre sem token. Por isso ela nunca chega ao cliente e todo ' +
        'download passa por aqui, filtrado pelo tenant **e** pelo projeto. Responde 304 quando o ' +
        '`If-None-Match` bate com o checksum.',
      params: uuidParam,
      query: arquivoQuery,
      binario: { descricao: 'O arquivo, com o content-type real e cache privado de 1 hora' },
    }),
  }, async (req, reply) => {
    const { id } = validar(idParam, req.params)
    const { download, miniatura } = validar(
      arquivoQuery,
      req.query,
    )

    // filtra pelo tenant do JWT: anexo de outro tenant e 404, nao 403
    const anexo = await db.query.anexos.findFirst({
      where: and(eq(anexos.id, id), eq(anexos.tenantId, req.user.tenantId)),
    })
    if (!anexo) throw naoEncontrado('Anexo')

    // e pelo projeto: sem isto, o id do anexo abriria arquivo de projeto alheio
    await buscarOsVisivel(anexo.osId, req)

    const versao = versaoParaServir(anexo, miniatura === '1')

    if (versao.checksum && req.headers['if-none-match'] === `"${versao.checksum}"`) {
      return reply.code(304).send()
    }

    const conteudo = await baixar(versao)
    return responderArquivo(reply, { ...anexo, ...versao }, conteudo, {
      cache: 'private, max-age=3600',
      anexar: download === '1',
    })
  })

  app.delete('/atividades/:id/anexos/:anexoId', {
    schema: doc({
      tag: 'Ordens de servico',
      resumo: 'Remove um anexo',
      descricao:
        'Tira o arquivo e a miniatura do storage antes da linha do banco. Falha no storage nao ' +
        'trava a remocao: arquivo sobrando incomoda menos que anexo fantasma na tela.',
      params: anexoParam,
      ok: { status: 204, schema: null, descricao: 'Anexo removido. Sem corpo.' },
    }),
  }, async (req, reply) => {
    const { id, anexoId } = validar(
      anexoParam,
      req.params,
    )
    const { tenantId, nome: autor } = contexto(req)
    await buscarOsVisivel(id, req)

    const anexo = await db.query.anexos.findFirst({
      where: and(eq(anexos.id, anexoId), eq(anexos.osId, id), eq(anexos.tenantId, tenantId)),
    })
    if (!anexo) throw naoEncontrado('Anexo')

    // some do storage primeiro; falha la nao trava a remocao da linha
    for (const arquivo of arquivosDoAnexo(anexo)) await apagar(arquivo)
    await db.delete(anexos).where(eq(anexos.id, anexoId))
    await registrar(id, 'anexo', `Removeu ${anexo.nome}`, autor)

    return reply.code(204).send()
  })

  /* ----------------------------- checklist ----------------------------- */

  app.post('/atividades/:id/checklist', {
    schema: doc({
      tag: 'Ordens de servico',
      resumo: 'Acrescenta um item ao checklist',
      params: uuidParam,
      body: itemBodySchema,
      ok: { status: 201, schema: z.object({ item: checklistItemSchema }) },
    }),
  }, async (req, reply) => {
    const { id } = validar(idParam, req.params)
    const { texto, ordem } = validar(
      itemBodySchema,
      req.body,
    )
    await buscarOsVisivel(id, req)
    const [criado] = await db.insert(checklistItens).values({ osId: id, texto, ordem }).returning()
    return reply.code(201).send({ item: criado })
  })

  app.patch('/atividades/:id/checklist/:itemId', {
    schema: doc({
      tag: 'Ordens de servico',
      resumo: 'Edita o texto ou marca o item como feito',
      descricao: 'A `ordem` do item ainda nao e editavel por esta rota.',
      params: itemParam,
      body: itemPatchSchema,
      ok: { schema: z.object({ item: checklistItemSchema }) },
    }),
  }, async (req) => {
    const { id, itemId } = validar(
      itemParam,
      req.params,
    )
    const dados = validar(
      itemPatchSchema,
      req.body,
    )
    await buscarOsVisivel(id, req)
    const [atualizado] = await db
      .update(checklistItens)
      .set(dados)
      .where(and(eq(checklistItens.id, itemId), eq(checklistItens.osId, id)))
      .returning()
    if (!atualizado) throw naoEncontrado('Item')
    return { item: atualizado }
  })

  app.put('/atividades/:id/checklist/ordem', {
    schema: doc({
      tag: 'Ordens de servico',
      resumo: 'Reordena todo o checklist',
      descricao: 'Recebe a lista completa de IDs na ordem final. O servidor confere que ela contem exatamente os itens da O.S. antes de gravar, dentro de uma transacao.',
      params: idParam,
      body: ordenarChecklistSchema,
      ok: { schema: z.object({ itens: z.array(checklistItemSchema) }) },
    }),
  }, async (req) => {
    const { id } = validar(idParam, req.params)
    const { itemIds } = validar(ordenarChecklistSchema, req.body)
    await buscarOsVisivel(id, req)

    const atuais = await db.query.checklistItens.findMany({
      where: eq(checklistItens.osId, id),
      columns: { id: true },
    })
    const idsAtuais = new Set(atuais.map((item) => item.id))
    if (idsAtuais.size !== itemIds.length || itemIds.some((itemId) => !idsAtuais.has(itemId))) {
      throw invalido('A ordem deve conter exatamente os itens atuais do checklist.')
    }

    await db.transaction(async (tx) => {
      const ordemPorId = new Map(itemIds.map((itemId, ordem) => [itemId, ordem]))
      // Toda requisicao trava as mesmas linhas na mesma ordem. Sem isso, duas
      // listas com ordens diferentes poderiam travar A→B e B→A e o Postgres
      // precisaria abortar uma delas por deadlock.
      for (const itemId of [...itemIds].sort()) {
        await tx
          .update(checklistItens)
          .set({ ordem: ordemPorId.get(itemId)! })
          .where(and(eq(checklistItens.id, itemId), eq(checklistItens.osId, id)))
      }
    })

    const itens = await db.query.checklistItens.findMany({
      where: eq(checklistItens.osId, id),
      orderBy: asc(checklistItens.ordem),
    })
    return { itens }
  })

  app.delete('/atividades/:id/checklist/:itemId', {
    schema: doc({
      tag: 'Ordens de servico',
      resumo: 'Remove um item do checklist',
      params: itemParam,
      ok: { status: 204, schema: null, descricao: 'Item removido. Sem corpo.' },
    }),
  }, async (req, reply) => {
    const { id, itemId } = validar(
      itemParam,
      req.params,
    )
    await buscarOsVisivel(id, req)
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
