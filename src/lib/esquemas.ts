/**
 * Formato das entidades como elas saem da API — a fonte do contrato OpenAPI.
 *
 * Nao valida resposta (ver o cabecalho de `doc.ts`): descreve. Datas saem como
 * ISO 8601 porque o `JSON.stringify` do Fastify converte os `Date` do Drizzle.
 * Campo que o serializador esconde de proposito — `senhaHash`, `caminho`,
 * `fileId` do anexo — nao aparece aqui, e essa ausencia e a documentacao.
 */
import { z } from 'zod'

const uuid = () => z.string().uuid()
const dataHora = () => z.string().datetime({ offset: true })

export const uuidParam = z.object({ id: uuid() })
export const tokenParam = z.object({ token: z.string() })

export const okSchema = z.object({ ok: z.boolean() })

/* ------------------------------------------------------------------ *
 * Sistema
 * ------------------------------------------------------------------ */

export const saudeSchema = z.object({
  ok: z.boolean(),
  servico: z.string(),
  ambiente: z.string(),
  banco: z.object({
    conectado: z.boolean(),
    versao: z.string().describe('Versao do Postgres, ou o erro quando nao conectou'),
    latenciaMs: z.number(),
  }),
  storage: z.string().describe('Ex.: bucket (sysaceite) ou disco (./uploads)'),
  limites: z
    .object({ anexoBytes: z.number().int() })
    .describe('O front consulta antes de gastar a subida de um arquivo grande demais'),
  em: dataHora(),
})

export const vivoSchema = z.object({ ok: z.boolean(), servico: z.string(), em: dataHora() })

/* ------------------------------------------------------------------ *
 * Pessoas
 * ------------------------------------------------------------------ */

export const usuarioSchema = z
  .object({
    id: uuid(),
    tenantId: uuid(),
    nome: z.string(),
    email: z.string().email(),
    cargo: z.string().nullable(),
    papel: z.enum(['admin', 'membro']),
    ativo: z.boolean(),
    temFoto: z.boolean(),
    /** Caminho do proxy autenticado; a URL real do storage nunca sai daqui. */
    fotoUrl: z.string().nullable(),
    avatarAtualizadoEm: dataHora().nullable(),
    criadoEm: dataHora(),
  })
  .describe('Usuario sem o hash da senha e sem o caminho da foto no storage')

export const tenantSchema = z.object({ id: uuid(), nome: z.string(), slug: z.string() })

export const sessaoSchema = z.object({
  token: z.string().describe('JWT para o cabecalho Authorization: Bearer'),
  usuario: usuarioSchema,
  tenant: tenantSchema.nullable(),
})

/* ------------------------------------------------------------------ *
 * SLA
 * ------------------------------------------------------------------ */

export const relogioSchema = z.object({
  prazoMinutos: z.number(),
  prazoEm: dataHora(),
  minutosDecorridos: z.number(),
  minutosRestantes: z.number(),
  consumo: z.number().describe('Fracao do prazo consumida: 0.7 = 70%'),
  estado: z.enum(['no_prazo', 'em_risco', 'estourado', 'cumprido', 'descumprido']),
  restanteLegivel: z.string().describe('Ex.: 2h 15min'),
  parado: z.boolean().describe('O.S. pausada: o relogio nao anda'),
})

export const slaSchema = z.object({ resposta: relogioSchema, resolucao: relogioSchema })

export const categoriaSchema = z.object({
  id: uuid(),
  tenantId: uuid(),
  nome: z.string(),
  cor: z.string(),
  multiplicadorSla: z.number().describe('Multiplica o prazo da politica. Infra 1.5, suporte 0.5'),
  criadoEm: dataHora(),
})

export const politicaSchema = z.object({
  id: uuid(),
  tenantId: uuid(),
  prioridade: z.enum(['critica', 'alta', 'media', 'baixa']),
  categoriaId: uuid().nullable(),
  nivel: z.enum(['n1', 'n2', 'n3']).nullable(),
  minutosPrimeiraResposta: z.number().int(),
  minutosResolucao: z.number().int(),
  ativa: z.boolean(),
  criadoEm: dataHora(),
})

/* ------------------------------------------------------------------ *
 * Projetos e O.S.
 * ------------------------------------------------------------------ */

export const projetoSchema = z.object({
  id: uuid(),
  tenantId: uuid(),
  nome: z.string(),
  cliente: z.string(),
  descricao: z.string().nullable(),
  cor: z.string(),
  responsavelId: uuid().nullable(),
  arquivado: z.boolean(),
  criadoEm: dataHora(),
  atualizadoEm: dataHora(),
})

export const osSchema = z.object({
  id: uuid(),
  tenantId: uuid(),
  projetoId: uuid(),
  codigo: z.string().describe('Sequencial por tenant, ex.: OS-0042'),
  tipo: z.enum(['evento', 'tarefa']),
  titulo: z.string(),
  descricao: z.string().nullable(),
  categoriaId: uuid().nullable(),
  prioridade: z.enum(['critica', 'alta', 'media', 'baixa']),
  nivel: z.enum(['n1', 'n2', 'n3']),
  status: z.enum(['a_fazer', 'atendendo', 'pausado', 'em_aprovacao', 'finalizado']),
  ordem: z.number().int().describe('Posicao dentro da coluna do Kanban'),
  responsavelId: uuid()
    .nullable()
    .describe('DERIVADO do primeiro de `responsaveis`. Nao e mais coluna — prefira a lista.'),
  responsaveis: z
    .array(uuid())
    .optional()
    .describe('Todos os responsaveis. O primeiro e o principal.'),
  solicitante: z.string().nullable(),
  abertaEm: dataHora(),
  inicioAtendimentoEm: dataHora().nullable(),
  primeiraRespostaEm: dataHora().nullable(),
  concluidaEm: dataHora().nullable(),
  pausadaEm: dataHora().nullable(),
  minutosPausados: z.number().int(),
  aprovado: z.boolean().nullable().describe('Parecer do link de aprovacao, se houve'),
  aprovadorNome: z.string().nullable(),
  aprovacaoObservacao: z.string().nullable(),
  aprovadoEm: dataHora().nullable(),
  criadoEm: dataHora(),
  atualizadoEm: dataHora(),
})

export const osComSlaSchema = osSchema.extend({ sla: slaSchema })

/* ------------------------------------------------------------------ *
 * Filhos da O.S.
 * ------------------------------------------------------------------ */

export const checklistItemSchema = z.object({
  id: uuid(),
  osId: uuid(),
  texto: z.string(),
  feito: z.boolean(),
  ordem: z.number().int(),
})

export const anexoSchema = z
  .object({
    id: uuid(),
    nome: z.string(),
    mimeType: z.string(),
    tamanho: z.number().int().describe('Bytes do arquivo ja gravado, apos eventual reducao'),
    ehImagem: z.boolean(),
    temMiniatura: z.boolean(),
    criadoEm: dataHora(),
  })
  .describe('Sem caminho, fileId e storage: o bucket e publico e a URL nunca sai da API')

export const comentarioSchema = z.object({
  id: uuid(),
  osId: uuid(),
  autorId: uuid().nullable(),
  autorNome: z.string(),
  texto: z.string(),
  interno: z.boolean().describe('true = invisivel na pagina publica de aprovacao'),
  criadoEm: dataHora(),
})

export const historicoSchema = z.object({
  id: uuid(),
  osId: uuid(),
  tipo: z.string(),
  descricao: z.string(),
  autorNome: z.string(),
  criadoEm: dataHora(),
})

/* ------------------------------------------------------------------ *
 * Aprovacao
 * ------------------------------------------------------------------ */

export const linkSchema = z.object({
  id: uuid(),
  tenantId: uuid(),
  osId: uuid(),
  token: z.string().describe('O segredo do link: quem tem o token aprova'),
  url: z.string().describe('Endereco pronto para enviar ao cliente').optional(),
  estado: z.enum(['pendente', 'aprovado', 'ajustes', 'expirado', 'revogado']),
  mostrarAnexos: z.boolean(),
  mostrarDatas: z.boolean(),
  mostrarSla: z.boolean(),
  mensagem: z.string().nullable(),
  aprovadorNomeSugerido: z.string().nullable(),
  aprovadorEmailSugerido: z.string().nullable(),
  expiraEm: dataHora().nullable(),
  criadoPorId: uuid().nullable(),
  criadoEm: dataHora(),
  decisao: z.enum(['aprovado', 'ajustes']).nullable(),
  observacao: z.string().nullable(),
  aprovadorNome: z.string().nullable(),
  aprovadorEmail: z.string().nullable(),
  decididoEm: dataHora().nullable(),
})

/* ------------------------------------------------------------------ *
 * Equipe, grupos e notificacoes
 * ------------------------------------------------------------------ */

export const conviteSchema = z.object({
  id: uuid(),
  tenantId: uuid(),
  email: z.string().email(),
  nome: z.string(),
  papel: z.enum(['admin', 'membro']),
  cargo: z.string().nullable(),
  mensagem: z.string().nullable(),
  estado: z.enum(['pendente', 'aceito', 'expirado', 'revogado']),
  expiraEm: dataHora().nullable(),
  convidadoPorId: uuid().nullable(),
  usuarioId: uuid().nullable(),
  aceitoEm: dataHora().nullable(),
  emailEnviadoEm: dataHora().nullable(),
  criadoEm: dataHora(),
})

export const grupoSchema = z.object({
  id: uuid(),
  tenantId: uuid(),
  nome: z.string(),
  cor: z.string(),
  descricao: z.string().nullable(),
  ordem: z.number().int(),
  criadoEm: dataHora(),
})

export const notificacaoSchema = z.object({
  id: uuid(),
  tenantId: uuid(),
  usuarioId: uuid(),
  tipo: z.enum(['os_atribuida', 'os_status', 'os_comentario', 'os_parecer', 'convite_aceito']),
  titulo: z.string(),
  descricao: z.string().nullable(),
  osId: uuid().nullable(),
  projetoId: uuid().nullable(),
  autorId: uuid().nullable(),
  autorNome: z.string().nullable(),
  lidaEm: dataHora().nullable(),
  criadoEm: dataHora(),
})
