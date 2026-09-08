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

export async function fecharConexao(): Promise<void> {
  await sql.end({ timeout: 5 })
}
