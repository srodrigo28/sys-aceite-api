import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../db/client.js'
import { categorias, politicasSla } from '../db/schema.js'
import { autenticar, somenteAdmin } from '../lib/auth.js'
import { doc } from '../lib/doc.js'
import {
  categoriaSchema as categoriaResposta,
  politicaSchema as politicaResposta,
  uuidParam,
} from '../lib/esquemas.js'
import { invalido, naoEncontrado, validar } from '../lib/http.js'
import { LIMIAR_ESTOURO, LIMIAR_RISCO, SLA_PADRAO } from '../lib/sla.js'

const prioridade = z.enum(['critica', 'alta', 'media', 'baixa'])
const nivel = z.enum(['n1', 'n2', 'n3'])

const politicaSchema = z.object({
  prioridade,
  categoriaId: z.string().uuid().nullish(),
  nivel: nivel.nullish(),
  minutosPrimeiraResposta: z.number().int().positive('Informe um prazo maior que zero'),
  minutosResolucao: z.number().int().positive('Informe um prazo maior que zero'),
  ativa: z.boolean().default(true),
})

const categoriaSchema = z.object({
  nome: z.string().min(2, 'Informe o nome da categoria'),
  cor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Cor deve estar no formato #RRGGBB').default('#6366f1'),
  multiplicadorSla: z.number().positive().max(10).default(1),
})

const painelSchema = z.object({
  politicas: z.array(politicaResposta),
  categorias: z.array(categoriaResposta),
  padroes: z
    .record(
      z.string(),
      z.object({ minutosPrimeiraResposta: z.number().int(), minutosResolucao: z.number().int() }),
    )
    .describe('Os prazos de fabrica por prioridade, para comparar com o que o tenant editou'),
  limiares: z
    .object({ risco: z.number(), estouro: z.number() })
    .describe('Fracoes do semaforo: 0.7 vira amarelo, 1 vira vermelho'),
})

export async function rotasSla(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', autenticar)

  /**
   * Leitura aberta a todo mundo do tenant: o colaborador precisa entender de
   * onde vem o prazo do card dele. Escrita e so do admin (preHandler abaixo).
   */
  app.get('/sla', {
    schema: doc({
      tag: 'SLA',
      resumo: 'Politicas, categorias e os limiares do semaforo',
      descricao:
        'Leitura aberta a todo o tenant de proposito: quem recebe o card precisa entender de ' +
        'onde saiu o prazo dele. So a escrita e restrita ao admin. A politica que vale para uma ' +
        'O.S. e a mais especifica que casa: prioridade + categoria + nivel vence prioridade + ' +
        'categoria, que vence prioridade sozinha. O prazo resolvido ainda e multiplicado pelo ' +
        '`multiplicadorSla` da categoria.',
      ok: { schema: painelSchema },
    }),
  }, async (req) => {
    const { tenantId } = req.user
    const [politicas, cats] = await Promise.all([
      db.query.politicasSla.findMany({ where: eq(politicasSla.tenantId, tenantId) }),
      db.query.categorias.findMany({ where: eq(categorias.tenantId, tenantId) }),
    ])
    return {
      politicas,
      categorias: cats,
      padroes: SLA_PADRAO,
      limiares: { risco: LIMIAR_RISCO, estouro: LIMIAR_ESTOURO },
    }
  })

  app.post('/sla/politicas', {
    preHandler: somenteAdmin,
    schema: doc({
      tag: 'SLA',
      resumo: 'Cria uma politica de prazo (admin)',
      descricao:
        'Deixar `categoriaId` e `nivel` nulos cria a regra geral daquela prioridade. Preenche-los ' +
        'cria a excecao, que passa a vencer. Os prazos sao em minutos.',
      body: politicaSchema,
      ok: { status: 201, schema: z.object({ politica: politicaResposta }) },
      erros: [403],
    }),
  }, async (req, reply) => {
    const dados = validar(politicaSchema, req.body)
    const [criada] = await db
      .insert(politicasSla)
      .values({ ...dados, tenantId: req.user.tenantId })
      .returning()
    if (!criada) throw invalido('Nao foi possivel criar a politica.')
    return reply.code(201).send({ politica: criada })
  })

  app.patch('/sla/politicas/:id', {
    preHandler: somenteAdmin,
    schema: doc({
      tag: 'SLA',
      resumo: 'Edita uma politica (admin)',
      descricao:
        'Vale imediatamente para as O.S. ja abertas: o SLA e calculado na leitura, nunca gravado. ' +
        '`ativa: false` desliga a regra sem apagar o historico dela.',
      params: uuidParam,
      body: politicaSchema.partial(),
      ok: { schema: z.object({ politica: politicaResposta }) },
      erros: [403],
    }),
  }, async (req) => {
    const { id } = validar(uuidParam, req.params)
    const dados = validar(politicaSchema.partial(), req.body)
    const [atualizada] = await db
      .update(politicasSla)
      .set(dados)
      .where(and(eq(politicasSla.id, id), eq(politicasSla.tenantId, req.user.tenantId)))
      .returning()
    if (!atualizada) throw naoEncontrado('Politica')
    return { politica: atualizada }
  })

  app.delete('/sla/politicas/:id', {
    preHandler: somenteAdmin,
    schema: doc({
      tag: 'SLA',
      resumo: 'Apaga uma politica (admin)',
      descricao:
        'Sem a regra especifica, as O.S. que a usavam passam a cair na mais generica. Se nem essa ' +
        'existir, valem os prazos de fabrica.',
      params: uuidParam,
      ok: { status: 204, schema: null, descricao: 'Politica apagada. Sem corpo.' },
      erros: [403],
    }),
  }, async (req, reply) => {
    const { id } = validar(uuidParam, req.params)
    const [removida] = await db
      .delete(politicasSla)
      .where(and(eq(politicasSla.id, id), eq(politicasSla.tenantId, req.user.tenantId)))
      .returning({ id: politicasSla.id })
    if (!removida) throw naoEncontrado('Politica')
    return reply.code(204).send()
  })

  app.post('/sla/categorias', {
    preHandler: somenteAdmin,
    schema: doc({
      tag: 'SLA',
      resumo: 'Cria uma categoria (admin)',
      descricao:
        'O `multiplicadorSla` estica ou encurta o prazo da politica: 1.5 da 50% a mais para ' +
        'infraestrutura, 0.5 aperta o suporte pela metade.',
      body: categoriaSchema,
      ok: { status: 201, schema: z.object({ categoria: categoriaResposta }) },
      erros: [403, 409],
    }),
  }, async (req, reply) => {
    const dados = validar(categoriaSchema, req.body)
    const [criada] = await db
      .insert(categorias)
      .values({ ...dados, tenantId: req.user.tenantId })
      .returning()
    if (!criada) throw invalido('Nao foi possivel criar a categoria.')
    return reply.code(201).send({ categoria: criada })
  })

  app.patch('/sla/categorias/:id', {
    preHandler: somenteAdmin,
    schema: doc({
      tag: 'SLA',
      resumo: 'Edita uma categoria (admin)',
      descricao: 'Mudar o multiplicador reposiciona na hora o semaforo de toda O.S. da categoria.',
      params: uuidParam,
      body: categoriaSchema.partial(),
      ok: { schema: z.object({ categoria: categoriaResposta }) },
      erros: [403, 409],
    }),
  }, async (req) => {
    const { id } = validar(uuidParam, req.params)
    const dados = validar(categoriaSchema.partial(), req.body)
    const [atualizada] = await db
      .update(categorias)
      .set(dados)
      .where(and(eq(categorias.id, id), eq(categorias.tenantId, req.user.tenantId)))
      .returning()
    if (!atualizada) throw naoEncontrado('Categoria')
    return { categoria: atualizada }
  })

  app.delete('/sla/categorias/:id', {
    preHandler: somenteAdmin,
    schema: doc({
      tag: 'SLA',
      resumo: 'Apaga uma categoria (admin)',
      descricao:
        'As O.S. da categoria ficam com `categoriaId: null` e passam a usar o prazo sem ' +
        'multiplicador. As politicas presas a ela vao junto.',
      params: uuidParam,
      ok: { status: 204, schema: null, descricao: 'Categoria apagada. Sem corpo.' },
      erros: [403],
    }),
  }, async (req, reply) => {
    const { id } = validar(uuidParam, req.params)
    const [removida] = await db
      .delete(categorias)
      .where(and(eq(categorias.id, id), eq(categorias.tenantId, req.user.tenantId)))
      .returning({ id: categorias.id })
    if (!removida) throw naoEncontrado('Categoria')
    return reply.code(204).send()
  })
}
