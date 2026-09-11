import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env.js'
import * as schema from './schema.js'

/**
 * postgres.js repassa ao servidor qualquer parametro da query string que ele
 * nao reconheca. `channel_binding` nao e um GUC do Postgres e derrubaria a
 * conexao com "unrecognized configuration parameter", entao removemos aqui.
 */
function normalizarUrl(url: string): string {
  const u = new URL(url)
  u.searchParams.delete('channel_binding')
  return u.toString()
}

export const sql = postgres(normalizarUrl(env.DATABASE_URL), {
  ssl: 'require',
  max: env.NODE_ENV === 'production' ? 10 : 3,
  idle_timeout: 20,
  connect_timeout: 15,
  // o endpoint "-pooler" do Neon e um PgBouncer em transaction mode,
  // que nao suporta prepared statements nomeados
  prepare: false,
})

export const db = drizzle(sql, { schema })

export type DB = typeof db

/** Ping usado pelo /health e pelo boot do servidor. */
export async function verificarConexao(): Promise<{ ok: true; versao: string; latenciaMs: number }> {
  const inicio = Date.now()
  const linhas = await sql<{ versao: string }[]>`select version() as versao`
  return {
    ok: true,
    versao: linhas[0]?.versao?.split(',')[0] ?? 'postgres',
    latenciaMs: Date.now() - inicio,
  }
}

export type PingBanco =
  | { ok: true; versao: string; latenciaMs: number }
  | { ok: false; erro: string; latenciaMs: number }

/**
 * Ping que nunca estoura e nunca pendura.
 *
 * `/health` precisa responder mesmo com o banco fora — ela e a sonda que diz se
 * a API esta viva. Sem o teto de tempo, uma conexao pendurada segura a resposta
 * ate o timeout do proxy, e quem observa de fora conclui que a API inteira
 * morreu quando so o banco esta lento.
 */
export async function pingBanco(tetoMs = 5_000): Promise<PingBanco> {
  const inicio = Date.now()
  let expirar: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      verificarConexao(),
      new Promise<never>((_, rejeitar) => {
        expirar = setTimeout(
          () => rejeitar(new Error(`banco nao respondeu em ${tetoMs}ms`)),
          tetoMs,
        )
        expirar.unref()
      }),
    ])
  } catch (e) {
    return {
      ok: false,
      erro: e instanceof Error ? e.message : 'falha ao consultar o banco',
      latenciaMs: Date.now() - inicio,
    }
  } finally {
    if (expirar) clearTimeout(expirar)
  }
}

export async function fecharConexao(): Promise<void> {
  await sql.end({ timeout: 5 })
}
