import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// Mesma logica de src/carregar-env.ts, em versao curta: as migrations tambem
// precisam rodar de qualquer diretorio na VPS.
const raizApi = dirname(fileURLToPath(import.meta.url))
const ambiente = process.env.NODE_ENV ?? 'development'

for (const arquivo of [
  process.env.ENV_FILE,
  join(raizApi, `.env.${ambiente}.local`),
  join(raizApi, '.env.local'),
  join(raizApi, `.env.${ambiente}`),
  join(raizApi, '.env.vps'),
  join(raizApi, '.env'),
  join(dirname(raizApi), '.env'),
]) {
  if (arquivo && existsSync(arquivo)) config({ path: arquivo, override: false, quiet: true })
}

if (!process.env.DATABASE_URL) {
  console.error('\n[drizzle] DATABASE_URL nao definida.')
  console.error(`  Procurei arquivos .env em ${raizApi}`)
  console.error('  Rode "npm run env:check" para o diagnostico completo.\n')
  process.exit(1)
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL },
  verbose: true,
  strict: true,
})
