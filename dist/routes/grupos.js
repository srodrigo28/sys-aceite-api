import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { grupoMembros, grupos, usuarios } from '../db/schema.js';
import { autenticar, somenteAdmin } from '../lib/auth.js';
import { conflito, invalido, naoEncontrado, validar } from '../lib/http.js';
/**
 * Grupos de pessoas.
 *
 * Grupo organiza o time — quem e do campo, quem e do escritorio. Ele **nao**
 * concede acesso: quem enxerga qual projeto continua sendo `projeto_membros`.
 * Se um dia grupo precisar dar acesso, isso vira uma tabela `grupo_projetos`;
 * nao junte as duas coisas aqui.
 *
 * Leitura e de todos (a tela de Equipe e de todos); escrita e so do admin.
 */
const idParam = z.object({ id: z.string().uuid() });
const corHex = z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Cor deve estar no formato #RRGGBB');
const criarSchema = z.object({
    nome: z.string().min(2, 'Informe o nome do grupo').max(60),
    cor: corHex.default('#6366f1'),
    descricao: z.string().max(300).nullish(),
});
const atualizarSchema = z.object({
    nome: z.string().min(2).max(60).optional(),
    cor: corHex.optional(),
    descricao: z.string().max(300).nullable().optional(),
    ordem: z.number().int().min(0).optional(),
});
const membrosSchema = z.object({
    usuarioIds: z.array(z.string().uuid()).max(200),
});
export async function rotasGrupos(app) {
    app.addHook('preHandler', autenticar);
    /** Grupos do tenant com os integrantes de cada um. */
    app.get('/grupos', async (req) => {
        const { tenantId } = req.user;
        const lista = await db.query.grupos.findMany({
            where: eq(grupos.tenantId, tenantId),
            orderBy: [asc(grupos.ordem), asc(grupos.nome)],
        });
        if (lista.length === 0)
            return { grupos: [] };
        const vinculos = await db
            .select({ grupoId: grupoMembros.grupoId, usuarioId: grupoMembros.usuarioId })
            .from(grupoMembros)
            .where(inArray(grupoMembros.grupoId, lista.map((g) => g.id)));
        return {
            grupos: lista.map((g) => ({
                ...g,
                usuarioIds: vinculos.filter((v) => v.grupoId === g.id).map((v) => v.usuarioId),
            })),
        };
    });
    app.post('/grupos', { preHandler: somenteAdmin }, async (req, reply) => {
        const dados = validar(criarSchema, req.body);
        const { tenantId } = req.user;
        const repetido = await db.query.grupos.findFirst({
            where: and(eq(grupos.tenantId, tenantId), eq(grupos.nome, dados.nome.trim())),
        });
        if (repetido)
            throw conflito('Ja existe um grupo com este nome.');
        const [criado] = await db
            .insert(grupos)
            .values({
            tenantId,
            nome: dados.nome.trim(),
            cor: dados.cor,
            descricao: dados.descricao?.trim() || null,
        })
            .returning();
        if (!criado)
            throw invalido('Nao foi possivel criar o grupo.');
        return reply.code(201).send({ grupo: { ...criado, usuarioIds: [] } });
    });
    app.patch('/grupos/:id', { preHandler: somenteAdmin }, async (req) => {
        const { id } = validar(idParam, req.params);
        const dados = validar(atualizarSchema, req.body);
        const { tenantId } = req.user;
        await buscarGrupo(id, tenantId);
        if (dados.nome) {
            const repetido = await db.query.grupos.findFirst({
                where: and(eq(grupos.tenantId, tenantId), eq(grupos.nome, dados.nome.trim())),
            });
            if (repetido && repetido.id !== id)
                throw conflito('Ja existe um grupo com este nome.');
        }
        const [atualizado] = await db
            .update(grupos)
            .set({
            ...(dados.nome !== undefined ? { nome: dados.nome.trim() } : {}),
            ...(dados.cor !== undefined ? { cor: dados.cor } : {}),
            ...(dados.descricao !== undefined ? { descricao: dados.descricao } : {}),
            ...(dados.ordem !== undefined ? { ordem: dados.ordem } : {}),
        })
            .where(and(eq(grupos.id, id), eq(grupos.tenantId, tenantId)))
            .returning();
        if (!atualizado)
            throw naoEncontrado('Grupo');
        return { grupo: atualizado };
    });
    /** Apaga o grupo. As pessoas continuam — o cascade so leva `grupo_membros`. */
    app.delete('/grupos/:id', { preHandler: somenteAdmin }, async (req, reply) => {
        const { id } = validar(idParam, req.params);
        const [removido] = await db
            .delete(grupos)
            .where(and(eq(grupos.id, id), eq(grupos.tenantId, req.user.tenantId)))
            .returning({ id: grupos.id });
        if (!removido)
            throw naoEncontrado('Grupo');
        return reply.code(204).send();
    });
    /**
     * Define a lista inteira de integrantes.
     *
     * E um PUT com o estado final de proposito: arrastar dispara eventos em
     * sequencia, e "remover de A" e "adicionar em B" chegando fora de ordem
     * fariam a pessoa sumir dos dois grupos.
     */
    app.put('/grupos/:id/membros', { preHandler: somenteAdmin }, async (req) => {
        const { id } = validar(idParam, req.params);
        const { usuarioIds } = validar(membrosSchema, req.body);
        const { tenantId } = req.user;
        await buscarGrupo(id, tenantId);
        const ids = [...new Set(usuarioIds)];
        if (ids.length > 0) {
            // so gente deste tenant: sem isto da para puxar alguem de outro workspace
            const doTenant = await db
                .select({ id: usuarios.id })
                .from(usuarios)
                .where(and(eq(usuarios.tenantId, tenantId), inArray(usuarios.id, ids)));
            if (doTenant.length !== ids.length)
                throw naoEncontrado('Usuario');
        }
        await db.transaction(async (tx) => {
            await tx.delete(grupoMembros).where(eq(grupoMembros.grupoId, id));
            if (ids.length > 0) {
                await tx.insert(grupoMembros).values(ids.map((usuarioId) => ({ grupoId: id, usuarioId })));
            }
        });
        return { grupo: { id, usuarioIds: ids } };
    });
}
async function buscarGrupo(id, tenantId) {
    const grupo = await db.query.grupos.findFirst({
        where: and(eq(grupos.id, id), eq(grupos.tenantId, tenantId)),
    });
    if (!grupo)
        throw naoEncontrado('Grupo');
    return grupo;
}
//# sourceMappingURL=grupos.js.map