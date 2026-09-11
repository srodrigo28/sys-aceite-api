import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { categorias, politicasSla } from '../db/schema.js';
import { autenticar, somenteAdmin } from '../lib/auth.js';
import { invalido, naoEncontrado, validar } from '../lib/http.js';
import { LIMIAR_ESTOURO, LIMIAR_RISCO, SLA_PADRAO } from '../lib/sla.js';
const prioridade = z.enum(['critica', 'alta', 'media', 'baixa']);
const nivel = z.enum(['n1', 'n2', 'n3']);
const politicaSchema = z.object({
    prioridade,
    categoriaId: z.string().uuid().nullish(),
    nivel: nivel.nullish(),
    minutosPrimeiraResposta: z.number().int().positive('Informe um prazo maior que zero'),
    minutosResolucao: z.number().int().positive('Informe um prazo maior que zero'),
    ativa: z.boolean().default(true),
});
const categoriaSchema = z.object({
    nome: z.string().min(2, 'Informe o nome da categoria'),
    cor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Cor deve estar no formato #RRGGBB').default('#6366f1'),
    multiplicadorSla: z.number().positive().max(10).default(1),
});
export async function rotasSla(app) {
    app.addHook('preHandler', autenticar);
    /**
     * Leitura aberta a todo mundo do tenant: o colaborador precisa entender de
     * onde vem o prazo do card dele. Escrita e so do admin (preHandler abaixo).
     */
    app.get('/sla', async (req) => {
        const { tenantId } = req.user;
        const [politicas, cats] = await Promise.all([
            db.query.politicasSla.findMany({ where: eq(politicasSla.tenantId, tenantId) }),
            db.query.categorias.findMany({ where: eq(categorias.tenantId, tenantId) }),
        ]);
        return {
            politicas,
            categorias: cats,
            padroes: SLA_PADRAO,
            limiares: { risco: LIMIAR_RISCO, estouro: LIMIAR_ESTOURO },
        };
    });
    app.post('/sla/politicas', { preHandler: somenteAdmin }, async (req, reply) => {
        const dados = validar(politicaSchema, req.body);
        const [criada] = await db
            .insert(politicasSla)
            .values({ ...dados, tenantId: req.user.tenantId })
            .returning();
        if (!criada)
            throw invalido('Nao foi possivel criar a politica.');
        return reply.code(201).send({ politica: criada });
    });
    app.patch('/sla/politicas/:id', { preHandler: somenteAdmin }, async (req) => {
        const { id } = validar(z.object({ id: z.string().uuid() }), req.params);
        const dados = validar(politicaSchema.partial(), req.body);
        const [atualizada] = await db
            .update(politicasSla)
            .set(dados)
            .where(and(eq(politicasSla.id, id), eq(politicasSla.tenantId, req.user.tenantId)))
            .returning();
        if (!atualizada)
            throw naoEncontrado('Politica');
        return { politica: atualizada };
    });
    app.delete('/sla/politicas/:id', { preHandler: somenteAdmin }, async (req, reply) => {
        const { id } = validar(z.object({ id: z.string().uuid() }), req.params);
        const [removida] = await db
            .delete(politicasSla)
            .where(and(eq(politicasSla.id, id), eq(politicasSla.tenantId, req.user.tenantId)))
            .returning({ id: politicasSla.id });
        if (!removida)
            throw naoEncontrado('Politica');
        return reply.code(204).send();
    });
    app.post('/sla/categorias', { preHandler: somenteAdmin }, async (req, reply) => {
        const dados = validar(categoriaSchema, req.body);
        const [criada] = await db
            .insert(categorias)
            .values({ ...dados, tenantId: req.user.tenantId })
            .returning();
        if (!criada)
            throw invalido('Nao foi possivel criar a categoria.');
        return reply.code(201).send({ categoria: criada });
    });
    app.patch('/sla/categorias/:id', { preHandler: somenteAdmin }, async (req) => {
        const { id } = validar(z.object({ id: z.string().uuid() }), req.params);
        const dados = validar(categoriaSchema.partial(), req.body);
        const [atualizada] = await db
            .update(categorias)
            .set(dados)
            .where(and(eq(categorias.id, id), eq(categorias.tenantId, req.user.tenantId)))
            .returning();
        if (!atualizada)
            throw naoEncontrado('Categoria');
        return { categoria: atualizada };
    });
    app.delete('/sla/categorias/:id', { preHandler: somenteAdmin }, async (req, reply) => {
        const { id } = validar(z.object({ id: z.string().uuid() }), req.params);
        const [removida] = await db
            .delete(categorias)
            .where(and(eq(categorias.id, id), eq(categorias.tenantId, req.user.tenantId)))
            .returning({ id: categorias.id });
        if (!removida)
            throw naoEncontrado('Categoria');
        return reply.code(204).send();
    });
}
//# sourceMappingURL=sla.js.map