import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projetoMembros, projetos, usuarios } from '../db/schema.js';
import { naoEncontrado, semPermissao } from './http.js';
/**
 * preHandler das rotas privadas. Valida o Bearer token e deixa o usuario
 * (com o tenant) disponivel em `req.user` — todo acesso a dados filtra por ele.
 */
export async function autenticar(req, reply) {
    try {
        await req.jwtVerify();
    }
    catch {
        await reply.code(401).send({ erro: 'nao_autenticado', mensagem: 'Faca login para continuar.' });
    }
}
/** Atalho tipado para o contexto do usuario logado. */
export function contexto(req) {
    return { usuarioId: req.user.sub, tenantId: req.user.tenantId, nome: req.user.nome };
}
/* ------------------------------------------------------------------ *
 * Autorizacao
 *
 * O JWT vale 7 dias e carrega `papel`. Se a decisao saisse dali, rebaixar
 * ou desativar alguem so teria efeito na proxima semana. Por isso as guardas
 * leem o usuario do banco — uma busca por chave primaria, guardada por
 * requisicao no cache abaixo.
 * ------------------------------------------------------------------ */
const cachePorRequisicao = new WeakMap();
/** Usuario do JWT, lido do banco. Uma consulta por requisicao, no maximo. */
export async function usuarioAtual(req) {
    const guardado = cachePorRequisicao.get(req);
    if (guardado)
        return guardado;
    const usuario = await db.query.usuarios.findFirst({
        where: and(eq(usuarios.id, req.user.sub), eq(usuarios.tenantId, req.user.tenantId)),
    });
    if (!usuario)
        throw semPermissao('Sua conta nao esta mais disponivel.');
    if (!usuario.ativo)
        throw semPermissao('Sua conta foi desativada. Fale com um administrador.');
    cachePorRequisicao.set(req, usuario);
    return usuario;
}
/** preHandler para rota que so o admin do tenant executa. */
export async function somenteAdmin(req) {
    const usuario = await usuarioAtual(req);
    if (usuario.papel !== 'admin') {
        throw semPermissao('So um administrador pode fazer isso.');
    }
}
/**
 * Ids dos projetos que o usuario enxerga. Admin ve todos os do tenant e
 * recebe 'todos' — a rota que chamar nao precisa filtrar por id.
 */
export async function projetosVisiveis(req) {
    const usuario = await usuarioAtual(req);
    if (usuario.papel === 'admin')
        return 'todos';
    const linhas = await db
        .select({ projetoId: projetoMembros.projetoId })
        .from(projetoMembros)
        .innerJoin(projetos, eq(projetos.id, projetoMembros.projetoId))
        .where(and(eq(projetoMembros.usuarioId, usuario.id), eq(projetos.tenantId, usuario.tenantId)));
    return linhas.map((l) => l.projetoId);
}
/**
 * 404 quando o projeto nao existe, e de outro tenant, ou existe mas o
 * colaborador nao participa — a resposta e a mesma nos tres casos, para nao
 * revelar que o projeto existe.
 */
export async function garantirAcessoProjeto(req, projetoId) {
    const projeto = await db.query.projetos.findFirst({
        where: and(eq(projetos.id, projetoId), eq(projetos.tenantId, req.user.tenantId)),
        columns: { id: true },
    });
    if (!projeto)
        throw naoEncontrado('Projeto');
    const visiveis = await projetosVisiveis(req);
    if (visiveis === 'todos')
        return;
    if (!visiveis.includes(projetoId))
        throw naoEncontrado('Projeto');
}
/** true quando o usuario e o unico admin ativo do tenant. */
export async function ehUltimoAdmin(tenantId, usuarioId) {
    const admins = await db
        .select({ id: usuarios.id })
        .from(usuarios)
        .where(and(eq(usuarios.tenantId, tenantId), eq(usuarios.papel, 'admin'), eq(usuarios.ativo, true)));
    return admins.length === 1 && admins[0]?.id === usuarioId;
}
//# sourceMappingURL=auth.js.map