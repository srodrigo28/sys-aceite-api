import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as carregarArquivo } from 'dotenv'

/**
 * Carregamento de variaveis de ambiente pensado para a VPS.
 *
 * O `import 'dotenv/config'` procura `.env` a partir do CWD — o que quebra
 * quando o processo sobe de outro diretorio (systemd sem WorkingDirectory,
 * pm2, cron, `node /caminho/api/dist/index.js`). Aqui o caminho e resolvido a
 * partir do PROPRIO MODULO, entao funciona de onde quer que seja iniciado.
 *
 * Ordem de precedencia (o primeiro que define a variavel vence):
 *   1. variaveis ja presentes no processo  (systemd, pm2, Docker, CI)
 *   2. arquivo apontado por ENV_FILE
 *   3. <api>/.env.<NODE_ENV>.local
 *   4. <api>/.env.local
 *   5. <api>/.env.<NODE_ENV>
 *   6. <api>/.env.vps
 *   7. <api>/.env
 *   8. <raiz do repo>/.env
 *
 * Nada e sobrescrito: o que ja esta em process.env sempre ganha. Isso deixa a
 * VPS injetar segredos por variavel de ambiente sem precisar mexer em arquivo.
 */

export interface RelatorioEnv {
  /** Arquivos que existiam e foram lidos, na ordem de precedencia. */
  carregados: string[]
  /** Caminhos procurados e nao encontrados. */
  ausentes: string[]
  /** Diretorio raiz do pacote da API. */
  raizApi: string
  /** true quando nenhum arquivo foi achado (rodando so com env do processo). */
  somenteProcesso: boolean
}

/** Sobe a partir do modulo ate achar o package.json da API. */
function acharRaizApi(): string {
  let dir = dirname(fileURLToPath(import.meta.url))

  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      try {
        const nome = JSON.parse(readFileSync(pkg, 'utf8')).name
        if (nome === 'sysaceite-api') return dir
      } catch {
        /* package.json ilegivel: continua subindo */
      }
    }
    const acima = dirname(dir)
    if (acima === dir) break
    dir = acima
  }

  // fallback: dois niveis acima de src/ ou dist/
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

let relatorio: RelatorioEnv | null = null

export function carregarEnv(): RelatorioEnv {
  if (relatorio) return relatorio

  const raizApi = acharRaizApi()
  const raizRepo = dirname(raizApi)
  const ambiente = process.env.NODE_ENV ?? 'development'

  const candidatos = [
    process.env.ENV_FILE
      ? isAbsolute(process.env.ENV_FILE)
        ? process.env.ENV_FILE
        : resolve(raizApi, process.env.ENV_FILE)
      : null,
    join(raizApi, `.env.${ambiente}.local`),
    join(raizApi, '.env.local'),
    join(raizApi, `.env.${ambiente}`),
    join(raizApi, '.env.vps'),
    join(raizApi, '.env'),
    join(raizRepo, '.env'),
  ].filter((c): c is string => Boolean(c))

  const carregados: string[] = []
  const ausentes: string[] = []

  for (const caminho of candidatos) {
    if (!existsSync(caminho)) {
      ausentes.push(caminho)
      continue
    }
    // override: false — quem ja esta no processo, e os arquivos de maior
    // precedencia lidos antes, continuam valendo
    const r = carregarArquivo({ path: caminho, override: false, quiet: true })
    if (r.error) {
      console.error(`[env] nao consegui ler ${caminho}: ${r.error.message}`)
      continue
    }
    carregados.push(caminho)
  }

  relatorio = {
    carregados,
    ausentes,
    raizApi,
    somenteProcesso: carregados.length === 0,
  }
  return relatorio
}

/** Descricao curta para o log de boot. */
export function resumoEnv(r: RelatorioEnv): string {
  if (r.somenteProcesso) return 'variaveis do processo (nenhum arquivo .env encontrado)'
  return r.carregados.map((c) => c.replace(r.raizApi, '.')).join(' + ')
}

/** Esconde o valor, mostrando o suficiente para conferir qual segredo e. */
export function mascarar(valor: string | undefined): string {
  if (!valor) return '(vazio)'
  if (valor.length <= 8) return '***'
  if (valor.startsWith('postgres')) {
    try {
      const u = new URL(valor)
      return `${u.protocol}//${u.username}:***@${u.host}${u.pathname}`
    } catch {
      return '***'
    }
  }
  return `${valor.slice(0, 6)}…${valor.slice(-4)} (${valor.length} chars)`
}
