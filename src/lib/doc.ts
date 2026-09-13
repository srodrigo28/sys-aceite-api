/**
 * Contrato OpenAPI das rotas.
 *
 * As rotas validam com zod, chamando `validar()` no corpo do handler — nunca
 * pelo ajv do Fastify. Este modulo reaproveita esses mesmos schemas para
 * DOCUMENTAR, convertendo-os com `z.toJSONSchema`. Duas consequencias
 * deliberadas, garantidas pelos compiladores neutros registrados em
 * `index.ts`:
 *
 * - o JSON Schema aqui **nao valida** nada em tempo de execucao. A mensagem de
 *   erro continua vindo do zod, em portugues, com o nome do campo;
 * - o JSON Schema de resposta **nao serializa** nada. Declarar um campo a menos
 *   aqui nao apaga o campo da resposta real.
 *
 * O ganho: um unico lugar define o formato, e o contrato nunca contradiz o
 * codigo porque e gerado dele.
 */
import { z, type ZodType } from 'zod'

/** JSON Schema no dialeto do OpenAPI 3.0 (`nullable: true`, sem `const`). */
export function zj(schema: ZodType, io: 'input' | 'output' = 'input'): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io,
    // `z.instanceof`, transforms e afins nao tem representacao em JSON Schema.
    // Sem isto a conversao lanca e derruba o boot — preferimos `{}` a nada.
    unrepresentable: 'any',
  }) as Record<string, unknown>
}

/* ------------------------------------------------------------------ *
 * Erros — o formato e sempre o mesmo, definido em `responderErro`
 * ------------------------------------------------------------------ */

const erroSchema = z.object({
  erro: z.string().describe('Codigo estavel, para o cliente decidir o que fazer'),
  mensagem: z.string().describe('Texto pronto para mostrar a pessoa'),
})

type Resposta = { description: string } & Record<string, unknown>

function erro(description: string): Resposta {
  return { description, content: { 'application/json': { schema: zj(erroSchema) } } }
}

/** Catalogo dos erros que a API realmente produz, por status. */
export const ERROS = {
  400: erro('Corpo ou parametro invalido (`validacao`, `invalido`, `json_invalido`)'),
  401: erro('Token ausente, invalido ou expirado (`nao_autenticado`, `credenciais`)'),
  403: erro('Autenticado, mas sem permissao para a operacao (`sem_permissao`)'),
  404: erro('Registro inexistente — ou existente e fora do seu tenant/projeto (`nao_encontrado`)'),
  409: erro('Conflito com o estado atual (`conflito`)'),
  413: erro('Arquivo acima do limite aceito pela API'),
  429: erro('Limite de tentativas atingido (`muitas_tentativas`)'),
  500: erro('Falha inesperada (`erro_interno`)'),
} as const

/* ------------------------------------------------------------------ *
 * Builder
 * ------------------------------------------------------------------ */

export type Tag =
  | 'Sistema'
  | 'Autenticacao'
  | 'Projetos'
  | 'Ordens de servico'
  | 'SLA'
  | 'Aprovacoes'
  | 'Equipe'
  | 'Grupos'
  | 'Notificacoes'
  | 'Publico'

interface Opcoes {
  tag: Tag
  resumo: string
  descricao?: string
  /** Sem JWT: tira o cadeado e o 401 da operacao. */
  publico?: boolean
  params?: ZodType
  query?: ZodType
  body?: ZodType
  /** Corpo `multipart/form-data` — um arquivo no campo `arquivo`. */
  arquivo?: { campo?: string; descricao?: string }
  /** Corpo vazio de proposito (POST de acao, ex.: revogar). */
  semCorpo?: boolean
  /** Status de sucesso e o schema do corpo. `null` para 204. */
  ok?: { status?: number; schema: ZodType | null; descricao?: string }
  /** Resposta binaria (proxy de arquivo). */
  binario?: { status?: number; descricao: string }
  /** Erros alem dos automaticos. */
  erros?: (keyof typeof ERROS)[]
}

/**
 * Monta o `schema` da rota. Os erros vem de graca: 400 e 500 sempre; 401
 * quando a rota exige token; 404 quando ha `params`.
 */
export function doc(o: Opcoes): Record<string, unknown> {
  const respostas: Record<number, Resposta> = {}

  if (o.binario) {
    respostas[o.binario.status ?? 200] = {
      description: o.binario.descricao,
      content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
    }
  } else if (o.ok) {
    const status = o.ok.status ?? 200
    respostas[status] =
      o.ok.schema === null
        ? { description: o.ok.descricao ?? 'Removido. Sem corpo.' }
        : {
            description: o.ok.descricao ?? 'Sucesso',
            content: { 'application/json': { schema: zj(o.ok.schema, 'output') } },
          }
  }

  const automaticos: (keyof typeof ERROS)[] = [400]
  if (!o.publico) automaticos.push(401)
  if (o.params) automaticos.push(404)
  automaticos.push(500)

  for (const status of [...new Set([...automaticos, ...(o.erros ?? [])])].sort((a, b) => a - b)) {
    respostas[status] = ERROS[status]
  }

  const schema: Record<string, unknown> = {
    tags: [o.tag],
    summary: o.resumo,
    // `security: []` zera a exigencia global declarada no openapi de index.ts
    security: o.publico ? [] : [{ bearerAuth: [] }],
    response: respostas,
  }

  if (o.descricao) schema.description = o.descricao
  if (o.params) schema.params = zj(o.params)
  if (o.query) schema.querystring = zj(o.query)

  if (o.arquivo) {
    const campo = o.arquivo.campo ?? 'arquivo'
    schema.consumes = ['multipart/form-data']
    schema.body = {
      type: 'object',
      required: [campo],
      properties: {
        [campo]: {
          type: 'string',
          format: 'binary',
          description: o.arquivo.descricao ?? 'Arquivo a enviar',
        },
      },
    }
  } else if (o.body) {
    schema.body = zj(o.body)
  } else if (o.semCorpo) {
    schema.body = { type: 'object', description: 'Sem corpo.', properties: {} }
  }

  return schema
}
