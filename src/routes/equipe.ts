import bcrypt from 'bcryptjs'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { db } from '../db/client.js'
import {
  convites,
  conviteProjetos,
  projetoMembros,
  projetos,
  tenants,
  usuarios,
  type Convite,
} from '../db/schema.js'
import { bucketAtivo, env } from '../env.js'
import {
  autenticar,
  ehUltimoAdmin,
  projetosVisiveis,
  somenteAdmin,
  usuarioAtual,
} from '../lib/auth.js'
import { validarArquivo } from '../lib/anexo.js'
import { apagar, baixar, enviar } from '../lib/bucket.js'
import { emailDeConvite, enviarEmail } from '../lib/email.js'
import { podeGerarMiniatura, prepararAvatar } from '../lib/imagem.js'
import { conflito, invalido, naoEncontrado, validar } from '../lib/http.js'

const VALIDADES = { '7d': 7, '14d': 14, '30d': 30 } as const

const idParam = z.object({ id: z.string().uuid() })

const convidarSchema = z.object({
  nome: z.string().min(2, 'Informe o nome da pessoa'),
  email: z.string().email('E-mail invalido'),
  papel: z.enum(['admin', 'membro']).default('membro'),
  cargo: z.string().max(80).nullish(),
  mensagem: z.string().max(600).nullish(),
  projetoIds: z.array(z.string().uuid()).default([]),
  validade: z.enum(['7d', '14d', '30d']).default('7d'),
})

const atualizarUsuarioSchema = z.object({
  nome: z.string().min(2).optional(),
  cargo: z.string().max(80).nullable().optional(),
  papel: z.enum(['admin', 'membro']).optional(),
  ativo: z.boolean().optional(),
  projetoIds: z.array(z.string().uuid()).optional(),
})

export function montarUrlConvite(token: string): string {
  return `${env.APP_PUBLIC_URL.replace(/\/$/, '')}/convite/${token}`
}

/** Expiracao avaliada na leitura, como nos links de aprovacao. */
export function estadoEfetivoConvite(convite: Convite, agora = new Date()) {
  if (convite.estado === 'pendente' && convite.expiraEm && convite.expiraEm <= agora) {
    return 'expirado' as const
  }
  return convite.estado
}

/**
 * O que sai da API sobre uma pessoa.
 *
 * `senhaHash` nunca sai. `avatarCaminho` e `avatarFileId` tambem nao: sao o
 * endereco no storage, que abre sem token — mesma regra dos anexos. A foto vai
 * como caminho do proxy, e so quando existe.
 */
export function usuarioPublico(u: typeof usuarios.$inferSelect) {
  const {
    senhaHash: _senha,
    avatarFileId: _fid,
    avatarCaminho: _caminho,
    avatarUrl: _antigo,
    ...resto
  } = u
  return {
    ...resto,
    temFoto: u.avatarCaminho !== null,
    // muda quando a foto muda: forca o navegador a buscar a nova
    fotoUrl: u.avatarCaminho ? `/usuarios/${u.id}/avatar` : null,
  }
}

function semSenha(u: typeof usuarios.$inferSelect) {
  return usuarioPublico(u)
}

export async function rotasEquipe(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', autenticar)

  /* ------------------------------------------------------------------ *
   * Equipe
   * ------------------------------------------------------------------ */

  /**
   * Pessoas do tenant com os projetos de cada uma. Colaborador recebe a lista
   * reduzida (sem e-mail e sem convite) — ele precisa dela para os avatares e
   * o seletor de responsavel, nao para administrar ninguem.
   */
  app.get('/equipe', async (req) => {
    const { tenantId } = req.user
    const eu = await usuarioAtual(req)
    const ehAdmin = eu.papel === 'admin'

    const pessoas = await db.query.usuarios.findMany({
      where: eq(usuarios.tenantId, tenantId),
      orderBy: (u, { asc }) => [asc(u.nome)],
    })

    const participacoes = await db
      .select({
        usuarioId: projetoMembros.usuarioId,
        projetoId: projetoMembros.projetoId,
        projetoNome: projetos.nome,
      })
      .from(projetoMembros)
      .innerJoin(projetos, eq(projetos.id, projetoMembros.projetoId))
      .where(eq(projetos.tenantId, tenantId))

    const membros = pessoas.map((p) => {
      const seus = participacoes
        .filter((x) => x.usuarioId === p.id)
        .map((x) => ({ id: x.projetoId, nome: x.projetoNome }))

      if (!ehAdmin) {
        // versao reduzida: sem e-mail e sem tenantId. Tem foto, papel e desde
        // quando participa, que e o que a tela de equipe mostra para todos.
        return {
          id: p.id,
          nome: p.nome,
          cargo: p.cargo,
          papel: p.papel,
          ativo: p.ativo,
          criadoEm: p.criadoEm,
          temFoto: p.avatarCaminho !== null,
          fotoUrl: p.avatarCaminho ? `/usuarios/${p.id}/avatar` : null,
          projetos: seus,
        }
      }
      return { ...semSenha(p), projetos: seus }
    })

    if (!ehAdmin) return { membros, convites: [] }

    return { membros, convites: await listarConvites(tenantId) }
  })

  /* ------------------------------------------------------------------ *
   * Convites
   * ------------------------------------------------------------------ */

  app.get('/convites', { preHandler: somenteAdmin }, async (req) => {
    return { convites: await listarConvites(req.user.tenantId) }
  })

  app.post('/convites', { preHandler: somenteAdmin }, async (req, reply) => {
    const dados = validar(convidarSchema, req.body)
    const { tenantId } = req.user
    const eu = await usuarioAtual(req)
    const email = dados.email.toLowerCase().trim()

    // e-mail e unico no banco inteiro: conta em outro tenant tambem bloqueia
    const jaTemConta = await db.query.usuarios.findFirst({ where: eq(usuarios.email, email) })
    if (jaTemConta) {
      throw conflito('Ja existe uma conta com este e-mail.')
    }

    const pendente = await db.query.convites.findFirst({
      where: and(
        eq(convites.tenantId, tenantId),
        eq(convites.email, email),
        eq(convites.estado, 'pendente'),
      ),
    })
    if (pendente && estadoEfetivoConvite(pendente) === 'pendente') {
      throw conflito('Ja existe um convite pendente para este e-mail. Reenvie ou revogue o atual.')
    }

    const escolhidos = await projetosDoTenant(tenantId, dados.projetoIds)
    if (dados.papel === 'membro' && escolhidos.length === 0) {
      throw invalido('Escolha ao menos um projeto: colaborador sem projeto nao enxerga nada.')
    }

    const expiraEm = new Date(Date.now() + VALIDADES[dados.validade] * 24 * 3_600_000)

    const convite = await db.transaction(async (tx) => {
      const [criado] = await tx
        .insert(convites)
        .values({
          tenantId,
          email,
          nome: dados.nome.trim(),
          papel: dados.papel,
          cargo: dados.cargo?.trim() || null,
          mensagem: dados.mensagem?.trim() || null,
          token: nanoid(32),
          expiraEm,
          convidadoPorId: eu.id,
        })
        .returning()
      if (!criado) throw invalido('Nao foi possivel criar o convite.')

      if (escolhidos.length > 0) {
        await tx
          .insert(conviteProjetos)
          .values(escolhidos.map((p) => ({ conviteId: criado.id, projetoId: p.id })))
      }
      return criado
    })

    // o convite ja esta gravado: falha de e-mail nao desfaz nada, vira modo link
    const envio = await despacharConvite(convite, escolhidos.map((p) => p.nome), eu.nome, tenantId)

    return reply.code(201).send({
      convite: {
        ...convite,
        estado: estadoEfetivoConvite(convite),
        projetos: escolhidos.map((p) => ({ id: p.id, nome: p.nome })),
      },
      url: montarUrlConvite(convite.token),
      emailEnviado: envio.enviado,
      motivoEnvio: envio.motivo ?? null,
    })
  })

  app.post('/convites/:id/reenviar', { preHandler: somenteAdmin }, async (req) => {
    const { id } = validar(idParam, req.params)
    const { tenantId } = req.user
    const eu = await usuarioAtual(req)

    const convite = await db.query.convites.findFirst({
      where: and(eq(convites.id, id), eq(convites.tenantId, tenantId)),
    })
    if (!convite) throw naoEncontrado('Convite')
    if (convite.estado === 'aceito') throw invalido('Este convite ja foi aceito.')
    if (convite.estado === 'revogado') throw invalido('Este convite foi revogado.')

    // token novo: o antigo pode ter vazado em e-mail encaminhado
    const [atualizado] = await db
      .update(convites)
      .set({
        token: nanoid(32),
        estado: 'pendente',
        expiraEm: new Date(Date.now() + 7 * 24 * 3_600_000),
      })
      .where(eq(convites.id, id))
      .returning()
    if (!atualizado) throw naoEncontrado('Convite')

    const nomes = await nomesDosProjetosDoConvite(id)
    const envio = await despacharConvite(atualizado, nomes, eu.nome, tenantId)

    return {
      convite: { ...atualizado, estado: estadoEfetivoConvite(atualizado) },
      url: montarUrlConvite(atualizado.token),
      emailEnviado: envio.enviado,
      motivoEnvio: envio.motivo ?? null,
    }
  })

  app.post('/convites/:id/revogar', { preHandler: somenteAdmin }, async (req) => {
    const { id } = validar(idParam, req.params)

    const convite = await db.query.convites.findFirst({
      where: and(eq(convites.id, id), eq(convites.tenantId, req.user.tenantId)),
    })
    if (!convite) throw naoEncontrado('Convite')
    if (convite.estado === 'aceito') throw invalido('Este convite ja foi aceito.')

    const [atualizado] = await db
      .update(convites)
      .set({ estado: 'revogado' })
      .where(eq(convites.id, id))
      .returning()
    if (!atualizado) throw naoEncontrado('Convite')
    return { convite: atualizado }
  })

  /* ------------------------------------------------------------------ *
   * Perfil de outra pessoa (admin)
   * ------------------------------------------------------------------ */

  app.patch('/usuarios/:id', { preHandler: somenteAdmin }, async (req) => {
    const { id } = validar(idParam, req.params)
    const dados = validar(atualizarUsuarioSchema, req.body)
    const { tenantId } = req.user

    const alvo = await db.query.usuarios.findFirst({
      where: and(eq(usuarios.id, id), eq(usuarios.tenantId, tenantId)),
    })
    if (!alvo) throw naoEncontrado('Usuario')

    // o workspace nao pode ficar sem dono
    const perdeAdmin = dados.papel === 'membro' || dados.ativo === false
    if (perdeAdmin && alvo.papel === 'admin' && (await ehUltimoAdmin(tenantId, alvo.id))) {
      throw invalido('Este e o unico administrador ativo. Promova outra pessoa antes.')
    }

    const atualizado = await db.transaction(async (tx) => {
      const campos = {
        ...(dados.nome !== undefined ? { nome: dados.nome.trim() } : {}),
        ...(dados.cargo !== undefined ? { cargo: dados.cargo } : {}),
        ...(dados.papel !== undefined ? { papel: dados.papel } : {}),
        ...(dados.ativo !== undefined ? { ativo: dados.ativo } : {}),
      }

      const [linha] = Object.keys(campos).length
        ? await tx.update(usuarios).set(campos).where(eq(usuarios.id, id)).returning()
        : [alvo]
      if (!linha) throw naoEncontrado('Usuario')

      if (dados.projetoIds) {
        const escolhidos = await projetosDoTenant(tenantId, dados.projetoIds, tx)
        await tx.delete(projetoMembros).where(eq(projetoMembros.usuarioId, id))
        if (escolhidos.length > 0) {
          await tx
            .insert(projetoMembros)
            .values(escolhidos.map((p) => ({ projetoId: p.id, usuarioId: id })))
        }
      }

      return linha
    })

    return { usuario: semSenha(atualizado) }
  })

  /* ------------------------------------------------------------------ *
   * Foto de perfil
   * ------------------------------------------------------------------ */

  /** Envia a propria foto. Sempre vira webp quadrado de 256px. */
  app.post('/auth/eu/avatar', async (req, reply) => {
    const eu = await usuarioAtual(req)

    const parte = await req.file()
    if (!parte) throw invalido('Envie um arquivo no campo "arquivo".')

    let buffer: Buffer
    try {
      buffer = await parte.toBuffer()
    } catch {
      throw invalido('Imagem grande demais.')
    }
    if (parte.file.truncated) throw invalido('Imagem grande demais.')

    const { mimeType } = validarArquivo(buffer, parte.filename, parte.mimetype)
    if (!podeGerarMiniatura(mimeType)) throw invalido('Envie uma imagem (JPG, PNG ou WebP).')

    const foto = await prepararAvatar(buffer, mimeType)
    if (!foto) throw invalido('Nao consegui processar esta imagem. Tente outra.')

    const salvo = await enviar({
      buffer: foto.buffer,
      nome: `avatar-${eu.id}.webp`,
      mimeType: foto.mimeType,
      pastaVirtual: `tenants/${eu.tenantId}/avatares`,
    })

    // a foto anterior sai do storage: nao serve mais para ninguem
    if (eu.avatarFileId && eu.avatarCaminho) {
      await apagar({
        fileId: eu.avatarFileId,
        storage: salvo.storage,
        caminho: eu.avatarCaminho,
        mimeType: 'image/webp',
        tamanho: 0,
        checksum: null,
      })
    }

    const [atualizado] = await db
      .update(usuarios)
      .set({
        avatarFileId: salvo.fileId,
        avatarCaminho: salvo.caminho,
        avatarAtualizadoEm: new Date(),
      })
      .where(eq(usuarios.id, eu.id))
      .returning()
    if (!atualizado) throw naoEncontrado('Usuario')

    return reply.code(201).send({ usuario: usuarioPublico(atualizado) })
  })

  app.delete('/auth/eu/avatar', async (req, reply) => {
    const eu = await usuarioAtual(req)

    if (eu.avatarFileId && eu.avatarCaminho) {
      await apagar({
        fileId: eu.avatarFileId,
        storage: bucketAtivo ? 'bucket' : 'disco',
        caminho: eu.avatarCaminho,
        mimeType: 'image/webp',
        tamanho: 0,
        checksum: null,
      })
    }

    await db
      .update(usuarios)
      .set({ avatarFileId: null, avatarCaminho: null, avatarAtualizadoEm: null })
      .where(eq(usuarios.id, eu.id))

    return reply.code(204).send()
  })

  /** Proxy da foto: escopado no tenant, como o dos anexos. */
  app.get('/usuarios/:id/avatar', async (req, reply) => {
    const { id } = validar(idParam, req.params)

    const pessoa = await db.query.usuarios.findFirst({
      where: and(eq(usuarios.id, id), eq(usuarios.tenantId, req.user.tenantId)),
    })
    if (!pessoa?.avatarCaminho || !pessoa.avatarFileId) throw naoEncontrado('Foto')

    const conteudo = await baixar({
      fileId: pessoa.avatarFileId,
      storage: bucketAtivo ? 'bucket' : 'disco',
      caminho: pessoa.avatarCaminho,
      mimeType: 'image/webp',
      tamanho: 0,
      checksum: null,
    })

    return reply
      .header('content-type', 'image/webp')
      .header('content-length', conteudo.tamanho)
      .header('cache-control', 'private, max-age=300')
      .header('x-content-type-options', 'nosniff')
      .send(conteudo.corpo)
  })

  /* ------------------------------------------------------------------ *
   * Projetos visiveis para o seletor do dialog de convite
   * ------------------------------------------------------------------ */

  app.get('/equipe/projetos', async (req) => {
    const { tenantId } = req.user
    const visiveis = await projetosVisiveis(req)
    if (visiveis !== 'todos' && visiveis.length === 0) return { projetos: [] }

    const lista = await db.query.projetos.findMany({
      where:
        visiveis === 'todos'
          ? eq(projetos.tenantId, tenantId)
          : and(eq(projetos.tenantId, tenantId), inArray(projetos.id, visiveis)),
      columns: { id: true, nome: true, cliente: true, cor: true },
      orderBy: (p, { asc }) => [asc(p.nome)],
    })
    return { projetos: lista }
  })
}

/* ------------------------------------------------------------------ *
 * Apoio
 * ------------------------------------------------------------------ */

type Transacao = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function projetosDoTenant(
  tenantId: string,
  ids: string[],
  tx: Transacao | typeof db = db,
): Promise<Array<{ id: string; nome: string }>> {
  if (ids.length === 0) return []
  const lista = await tx
    .select({ id: projetos.id, nome: projetos.nome })
    .from(projetos)
    .where(and(eq(projetos.tenantId, tenantId), inArray(projetos.id, ids)))

  if (lista.length !== ids.length) throw naoEncontrado('Projeto')
  return lista
}

async function nomesDosProjetosDoConvite(conviteId: string): Promise<string[]> {
  const linhas = await db
    .select({ nome: projetos.nome })
    .from(conviteProjetos)
    .innerJoin(projetos, eq(projetos.id, conviteProjetos.projetoId))
    .where(eq(conviteProjetos.conviteId, conviteId))
  return linhas.map((l) => l.nome)
}

async function listarConvites(tenantId: string) {
  const lista = await db.query.convites.findMany({
    where: eq(convites.tenantId, tenantId),
    orderBy: desc(convites.criadoEm),
  })
  if (lista.length === 0) return []

  const vinculos = await db
    .select({
      conviteId: conviteProjetos.conviteId,
      projetoId: conviteProjetos.projetoId,
      nome: projetos.nome,
    })
    .from(conviteProjetos)
    .innerJoin(projetos, eq(projetos.id, conviteProjetos.projetoId))
    .where(
      inArray(
        conviteProjetos.conviteId,
        lista.map((c) => c.id),
      ),
    )

  return lista.map((c) => ({
    ...c,
    estado: estadoEfetivoConvite(c),
    url: montarUrlConvite(c.token),
    projetos: vinculos
      .filter((v) => v.conviteId === c.id)
      .map((v) => ({ id: v.projetoId, nome: v.nome })),
  }))
}

async function despacharConvite(
  convite: Convite,
  nomesProjetos: string[],
  convidadoPor: string,
  tenantId: string,
) {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) })

  const corpo = emailDeConvite({
    nome: convite.nome,
    organizacao: tenant?.nome ?? 'SysAceite',
    convidadoPor,
    papel: convite.papel,
    projetos: nomesProjetos,
    mensagem: convite.mensagem,
    url: montarUrlConvite(convite.token),
    expiraEm: convite.expiraEm,
  })

  const envio = await enviarEmail({ para: convite.email, ...corpo })
  if (envio.enviado) {
    await db.update(convites).set({ emailEnviadoEm: new Date() }).where(eq(convites.id, convite.id))
  }
  return envio
}
