import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL e obrigatoria'),
  PORT: z.coerce.number().int().positive().default(3333),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET precisa ter ao menos 16 caracteres'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  APP_PUBLIC_URL: z.string().default('http://localhost:3000'),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  console.error('\n[env] Variaveis de ambiente invalidas. Confira o arquivo api/.env:\n')
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`)
  }
  console.error('\nUse api/.env.example como referencia.\n')
  process.exit(1)
}

export const env = parsed.data
export type Env = typeof env
