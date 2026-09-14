import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { atividadeResponsaveis, notificacoes, usuarios, type TipoNotificacao } from '../db/schema.js'

/**
 * Notificacoes do sino.
 *
 * Diferente de `historico`, que responde "o que aconteceu nesta O.S.": aqui a
 * pergunta e "o que e novo PARA MIM". Por isso a linha tem dono (`usuarioId`).
 *
 * DUAS REGRAS QUE FAZEM O SINO SER UTIL:
 *
 * 1. Ninguem e notificado do que fez. Sino que avisa voce do seu proprio
 *    clique treina a pessoa a ignorar o sino.
 * 2. Falha ao notificar NAO derruba a acao. Mover um card e o trabalho;
 *    a notificacao e o aviso. Se o aviso falhar, o card continua movido.
 */

export interface Notificar {
  tenantId: string
  /** ids de quem recebe; duplicados e o proprio autor sao descartados */
  destinatarios: Array<string | null | undefined>
  tipo: TipoNotificacao
  titulo: string
  descricao?: string | null
  osId?: string | null
  projetoId?: string | null
  /** null quando quem causou nao e usuario do sistema (o cliente que aprova) */
  autorId?: string | null
  autorNome: string
}

export async function notificar(dados: Notificar): Promise<void> {
  try {
    const alvos = [...new Set(dados.destinatarios.filter((id): id is string => Boolean(id)))].filter(
      (id) => id !== dados.autorId,
    )
    if (alvos.length === 0) return

    await db.insert(notificacoes).values(
      alvos.map((usuarioId) => ({
        tenantId: dados.tenantId,
        usuarioId,
        tipo: dados.tipo,
        titulo: dados.titulo,
        descricao: dados.descricao ?? null,
        osId: dados.osId ?? null,
        projetoId: dados.projetoId ?? null,
        autorId: dados.autorId ?? null,
        autorNome: dados.autorNome,
      })),
    )
  } catch (e) {
    // registra e segue: o aviso nao pode custar a acao
    console.error(`[notificacao] falhou (${dados.tipo}): ${(e as Error).message}`)
  }
}

/** Admins ativos do tenant — o time que acompanha o quadro. */
export async function adminsDoTenant(tenantId: string): Promise<string[]> {
  const lista = await db
    .select({ id: usuarios.id })
    .from(usuarios)
    .where(
      and(eq(usuarios.tenantId, tenantId), eq(usuarios.papel, 'admin'), eq(usuarios.ativo, true)),
    )
  return lista.map((u) => u.id)
}

/** Quem acompanha uma O.S.: o responsavel e os admins do tenant. */
/**
 * Quem deve saber do que acontece numa atividade: os admins e TODOS os
 * responsaveis.
 *
 * Antes recebia um `responsavelId` so. Com varios responsaveis, mandar apenas o
 * principal deixaria os demais sem notificacao de comentario e de mudanca de
 * status — justamente quem esta tocando o trabalho.
 */
export async function interessadosNaOs(
  tenantId: string,
  atividadeId: string,
): Promise<string[]> {
  const responsaveis = await db
    .select({ usuarioId: atividadeResponsaveis.usuarioId })
    .from(atividadeResponsaveis)
    .where(eq(atividadeResponsaveis.atividadeId, atividadeId))
  return [...(await adminsDoTenant(tenantId)), ...responsaveis.map((r) => r.usuarioId)]
}
