import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../db/client.js'
import { categorias, politicasSla, tenants, usuarios } from '../db/schema.js'
import { autenticar } from '../lib/auth.js'
import { usuarioPublico } from './equipe.js'
import { conflito, invalido, naoEncontrado, validar } from '../lib/http.js'
import { SLA_PADRAO } from '../lib/sla.js'

const CATEGORIAS_PADRAO = [
  { nome: 'Desenvolvimento', cor: '#6366f1', multiplicadorSla: 1 },
  { nome: 'Design', cor: '#ec4899', multiplicadorSla: 1 },
  { nome: 'Infraestrutura', cor: '#f97316', multiplicadorSla: 1.5 },
  { nome: 'Suporte', cor: '#0ea5e9', multiplicadorSla: 0.5 },
  { nome: 'Conteudo', cor: '#14b8a6', multiplicadorSla: 1 },
  { nome: 'Comercial', cor: '#a855f7', multiplicadorSla: 2 },
]

function gerarSlug(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

const registrarSchema = z.object({
  nome: z.string().min(2, 'Informe seu nome'),
  email: z.string().email('E-mail invalido'),
  senha: z.string().min(8, 'A senha precisa ter ao menos 8 caracteres'),
  empresa: z.string().min(2, 'Informe o nome da empresa'),
})

const loginSchema = z.object({
  email: z.string().email('E-mail invalido'),
  senha: z.string().min(1, 'Informe a senha'),
})

export async function rotasAuth(app: FastifyInstance): Promise<void> {
  /** Cadastro: cria o tenant, o usuario admin e os dados base do workspace. */
  app.post('/auth/registrar', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const dados = validar(registrarSchema, req.body)
    const email = dados.email.toLowerCase().trim()

    const existente = await db.query.usuarios.findFirst({ where: eq(usuarios.email, email) })
    if (existente) throw conflito('Ja existe uma conta com este e-mail.')

    const resultado = await db.transaction(async (tx) => {
      let slug = gerarSlug(dados.empresa) || 'workspace'
      const slugOcupado = await tx.query.tenants.findFirst({ where: eq(tenants.slug, slug) })
      if (slugOcupado) slug = `${slug}-${Date.now().toString(36).slice(-4)}`

      const [tenant] = await tx
        .insert(tenants)
        .values({ nome: dados.empresa.trim(), slug })
        .returning()
      if (!tenant) throw invalido('Nao foi possivel criar o workspace.')

      const [usuario] = await tx
        .insert(usuarios)
        .values({
          tenantId: tenant.id,
          nome: dados.nome.trim(),
          email,
          senhaHash: await bcrypt.hash(dados.senha, 10),
          papel: 'admin',
        })
        .returning()
      if (!usuario) throw invalido('Nao foi possivel criar o usuario.')

      await tx
        .insert(categorias)
        .values(CATEGORIAS_PADRAO.map((c) => ({ ...c, tenantId: tenant.id })))

      await tx.insert(politicasSla).values(
        (Object.keys(SLA_PADRAO) as (keyof typeof SLA_PADRAO)[]).map((prioridade) => ({
          tenantId: tenant.id,
          prioridade,
          minutosPrimeiraResposta: SLA_PADRAO[prioridade].minutosPrimeiraResposta,
          minutosResolucao: SLA_PADRAO[prioridade].minutosResolucao,
        })),
      )

      return { tenant, usuario }
    })

    const token = app.jwt.sign({
      sub: resultado.usuario.id,
      tenantId: resultado.tenant.id,
      nome: resultado.usuario.nome,
      email: resultado.usuario.email,
      papel: resultado.usuario.papel,
    })

    return reply.code(201).send({
      token,
      usuario: comoPublico(resultado.usuario),
      tenant: { id: resultado.tenant.id, nome: resultado.tenant.nome, slug: resultado.tenant.slug },
    })
  })

  app.post('/auth/login', { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const dados = validar(loginSchema, req.body)
    const email = dados.email.toLowerCase().trim()

    const usuario = await db.query.usuarios.findFirst({ where: eq(usuarios.email, email) })
    const confere = usuario ? await bcrypt.compare(dados.senha, usuario.senhaHash) : false

    // mensagem unica para nao revelar se o e-mail existe — nem que ele existe
    // e foi desativado, que tambem e informacao sobre a conta
    if (!usuario || !confere || !usuario.ativo) {
      return reply.code(401).send({ erro: 'credenciais', mensagem: 'E-mail ou senha incorretos.' })
    }

    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, usuario.tenantId) })

    const token = app.jwt.sign({
      sub: usuario.id,
      tenantId: usuario.tenantId,
      nome: usuario.nome,
      email: usuario.email,
      papel: usuario.papel,
    })

    return reply.send({
      token,
      usuario: comoPublico(usuario),
      tenant: tenant ? { id: tenant.id, nome: tenant.nome, slug: tenant.slug } : null,
    })
  })

  app.get('/auth/eu', { preHandler: autenticar }, async (req) => {
    const usuario = await db.query.usuarios.findFirst({ where: eq(usuarios.id, req.user.sub) })
    if (!usuario) throw naoEncontrado('Usuario')
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, usuario.tenantId) })
    return {
      usuario: comoPublico(usuario),
      tenant: tenant ? { id: tenant.id, nome: tenant.nome, slug: tenant.slug } : null,
    }
  })

  /** Equipe do tenant — usada para o seletor de responsável e os avatares do card. */
  app.get('/usuarios', { preHandler: autenticar }, async (req) => {
    const equipe = await db.query.usuarios.findMany({
      where: eq(usuarios.tenantId, req.user.tenantId),
      orderBy: (u, { asc }) => [asc(u.nome)],
    })
    return { usuarios: equipe.map(comoPublico) }
  })

  app.patch('/auth/eu', { preHandler: autenticar }, async (req) => {
    const dados = validar(
      z.object({
        nome: z.string().min(2).optional(),
        cargo: z.string().max(80).nullable().optional(),
        avatarUrl: z.string().url().nullable().optional(),
      }),
      req.body,
    )
    const [atualizado] = await db
      .update(usuarios)
      .set(dados)
      .where(eq(usuarios.id, req.user.sub))
      .returning()
    if (!atualizado) throw naoEncontrado('Usuario')
    return { usuario: comoPublico(atualizado) }
  })

  /** Troca a propria senha. Exige a atual — token roubado nao vira sequestro. */
  app.patch('/auth/senha', { preHandler: autenticar }, async (req) => {
    const { senhaAtual, novaSenha } = validar(
      z.object({
        senhaAtual: z.string().min(1, 'Informe a senha atual'),
        novaSenha: z.string().min(8, 'A nova senha precisa ter ao menos 8 caracteres'),
      }),
      req.body,
    )

    const usuario = await db.query.usuarios.findFirst({ where: eq(usuarios.id, req.user.sub) })
    if (!usuario) throw naoEncontrado('Usuario')

    if (!(await bcrypt.compare(senhaAtual, usuario.senhaHash))) {
      throw invalido('A senha atual esta incorreta.')
    }
    if (await bcrypt.compare(novaSenha, usuario.senhaHash)) {
      throw invalido('A nova senha precisa ser diferente da atual.')
    }

    await db
      .update(usuarios)
      .set({ senhaHash: await bcrypt.hash(novaSenha, 10) })
      .where(eq(usuarios.id, usuario.id))

    return { ok: true }
  })
}

/** Um serializador so para usuario, compartilhado com as rotas de equipe. */
function comoPublico(u: typeof usuarios.$inferSelect) {
  return usuarioPublico(u)
}
