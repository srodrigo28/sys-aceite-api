import type { FastifyReply, FastifyRequest } from 'fastify'

export interface PayloadToken {
  sub: string
  tenantId: string
  nome: string
  email: string
  papel: 'admin' | 'membro'
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: PayloadToken
    user: PayloadToken
  }
}

/**
 * preHandler das rotas privadas. Valida o Bearer token e deixa o usuario
 * (com o tenant) disponivel em `req.user` — todo acesso a dados filtra por ele.
 */
export async function autenticar(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify()
  } catch {
    await reply.code(401).send({ erro: 'nao_autenticado', mensagem: 'Faca login para continuar.' })
  }
}

/** Atalho tipado para o contexto do usuario logado. */
export function contexto(req: FastifyRequest): { usuarioId: string; tenantId: string; nome: string } {
  return { usuarioId: req.user.sub, tenantId: req.user.tenantId, nome: req.user.nome }
}
