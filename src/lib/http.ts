import type { FastifyReply } from 'fastify'
import { ZodError, type ZodType } from 'zod'

export class ErroApp extends Error {
  constructor(
    readonly status: number,
    readonly codigo: string,
    mensagem: string,
  ) {
    super(mensagem)
    this.name = 'ErroApp'
  }
}

export const naoEncontrado = (o = 'Registro') => new ErroApp(404, 'nao_encontrado', `${o} nao encontrado.`)
export const invalido = (m: string) => new ErroApp(400, 'invalido', m)
export const conflito = (m: string) => new ErroApp(409, 'conflito', m)
/** 403: a rota inteira e proibida. Para recurso que existe mas nao e seu, use naoEncontrado. */
export const semPermissao = (m: string) => new ErroApp(403, 'sem_permissao', m)

/** Valida com zod e lanca ErroApp 400 com as mensagens de campo. */
export function validar<T>(schema: ZodType<T>, dados: unknown): T {
  try {
    return schema.parse(dados)
  } catch (e) {
    if (e instanceof ZodError) {
      const detalhe = e.issues.map((i) => `${i.path.join('.') || 'corpo'}: ${i.message}`).join('; ')
      throw new ErroApp(400, 'validacao', detalhe)
    }
    throw e
  }
}

/** Erros do proprio Fastify (corpo invalido, arquivo grande demais...) ja trazem status. */
function erroDoFastify(erro: unknown): { status: number; codigo: string; mensagem: string } | null {
  if (typeof erro !== 'object' || erro === null) return null
  const e = erro as { statusCode?: number; code?: string; message?: string }
  if (typeof e.statusCode !== 'number' || e.statusCode >= 500) return null

  const amigaveis: Record<string, string> = {
    FST_ERR_CTP_EMPTY_JSON_BODY: 'Corpo da requisicao vazio.',
    FST_ERR_CTP_INVALID_MEDIA_TYPE: 'Formato de conteudo nao suportado.',
    FST_REQ_FILE_TOO_LARGE: 'Arquivo maior que o limite permitido.',
    FST_PARTS_LIMIT: 'Envie um arquivo por vez.',
  }

  return {
    status: e.statusCode,
    codigo: e.code ?? 'requisicao_invalida',
    mensagem: (e.code && amigaveis[e.code]) || e.message || 'Requisicao invalida.',
  }
}

export async function responderErro(erro: unknown, reply: FastifyReply): Promise<void> {
  if (erro instanceof ErroApp) {
    await reply.code(erro.status).send({ erro: erro.codigo, mensagem: erro.message })
    return
  }

  const doFastify = erroDoFastify(erro)
  if (doFastify) {
    await reply
      .code(doFastify.status)
      .send({ erro: doFastify.codigo, mensagem: doFastify.mensagem })
    return
  }

  reply.log.error(erro)
  await reply
    .code(500)
    .send({ erro: 'erro_interno', mensagem: 'Algo deu errado. Tente novamente.' })
}
