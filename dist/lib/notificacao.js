import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notificacoes, usuarios } from '../db/schema.js';
export async function notificar(dados) {
    try {
        const alvos = [...new Set(dados.destinatarios.filter((id) => Boolean(id)))].filter((id) => id !== dados.autorId);
        if (alvos.length === 0)
            return;
        await db.insert(notificacoes).values(alvos.map((usuarioId) => ({
            tenantId: dados.tenantId,
            usuarioId,
            tipo: dados.tipo,
            titulo: dados.titulo,
            descricao: dados.descricao ?? null,
            osId: dados.osId ?? null,
            projetoId: dados.projetoId ?? null,
            autorId: dados.autorId ?? null,
            autorNome: dados.autorNome,
        })));
    }
    catch (e) {
        // registra e segue: o aviso nao pode custar a acao
        console.error(`[notificacao] falhou (${dados.tipo}): ${e.message}`);
    }
}
/** Admins ativos do tenant — o time que acompanha o quadro. */
export async function adminsDoTenant(tenantId) {
    const lista = await db
        .select({ id: usuarios.id })
        .from(usuarios)
        .where(and(eq(usuarios.tenantId, tenantId), eq(usuarios.papel, 'admin'), eq(usuarios.ativo, true)));
    return lista.map((u) => u.id);
}
/** Quem acompanha uma O.S.: o responsavel e os admins do tenant. */
export async function interessadosNaOs(tenantId, responsavelId) {
    return [...(await adminsDoTenant(tenantId)), ...(responsavelId ? [responsavelId] : [])];
}
//# sourceMappingURL=notificacao.js.map