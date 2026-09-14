import { and, eq, like, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { atividades, ordensServico } from '../db/schema.js';
/**
 * De qual mes e a atividade.
 *
 * `previsto_inicio_em` manda; `aberta_em` e o fallback. Sem ele, atividade sem
 * planejamento ficaria sem O.S., e a decisao 2 exige que toda atividade tenha
 * uma.
 *
 * So a data de INICIO conta. Uma atividade de 28/09 a 05/10 e de setembro, e
 * muda de mes so se o inicio mudar — mexer no fim nunca a move de fatura.
 */
export function periodoDaAtividade(a) {
    const base = a.previstoInicioEm ?? a.abertaEm ?? new Date();
    return { ano: base.getFullYear(), mes: base.getMonth() + 1 };
}
async function proximoCodigo(tenantId, ano) {
    const prefixo = `OS-${ano}-`;
    const [linha] = await db
        .select({ total: sql `count(*)::int` })
        .from(ordensServico)
        .where(and(eq(ordensServico.tenantId, tenantId), like(ordensServico.codigo, `${prefixo}%`)));
    return `${prefixo}${String((linha?.total ?? 0) + 1).padStart(4, '0')}`;
}
/**
 * A O.S. daquele projeto naquele mes, criando se ainda nao existe.
 *
 * Ninguem cria O.S. a mao: ela nasce na primeira atividade do mes. Por isso
 * esta funcao e chamada em toda criacao e em toda mudanca de data prevista.
 *
 * `onConflictDoNothing` seguido de leitura, em vez de "verifica e insere": duas
 * atividades criadas ao mesmo tempo no mesmo mes passariam as duas pela
 * verificacao e a segunda estouraria no indice unico.
 */
export async function garantirOsDoMes(tenantId, projetoId, quando) {
    const { ano, mes } = periodoDaAtividade(quando);
    const existente = await db.query.ordensServico.findFirst({
        where: and(eq(ordensServico.projetoId, projetoId), eq(ordensServico.ano, ano), eq(ordensServico.mes, mes)),
        columns: { id: true },
    });
    if (existente)
        return existente.id;
    const [criada] = await db
        .insert(ordensServico)
        .values({ tenantId, projetoId, ano, mes, codigo: await proximoCodigo(tenantId, ano) })
        .onConflictDoNothing()
        .returning({ id: ordensServico.id });
    if (criada)
        return criada.id;
    // perdeu a corrida: outra requisicao criou a mesma O.S. entre a leitura e o
    // insert. A que venceu serve para as duas.
    const vencedora = await db.query.ordensServico.findFirst({
        where: and(eq(ordensServico.projetoId, projetoId), eq(ordensServico.ano, ano), eq(ordensServico.mes, mes)),
        columns: { id: true },
    });
    if (!vencedora)
        throw new Error('nao foi possivel resolver a O.S. do mes');
    return vencedora.id;
}
/**
 * Os numeros de uma O.S.
 *
 * Tres, nao um. Cada um responde uma pergunta diferente, e esconder qualquer um
 * gera conversa desagradavel:
 *
 * - **faturavel**: quanto posso cobrar hoje (concluida E aprovada)
 * - **concluido**: o que esta pronto mas ainda nao aprovado
 * - **total**: o que ainda esta em aberto
 *
 * A diferenca entre concluido e faturavel e a fila de aprovacao — trabalho
 * pronto, sem cobrar, esperando alguem mandar o link.
 *
 * Calculado na leitura, nunca gravado.
 */
export async function totaisDaOs(osId) {
    const [linha] = await db
        .select({
        atividades: sql `count(*)::int`,
        minutosEstimados: sql `coalesce(sum(${atividades.minutosEstimados}), 0)::int`,
        minutosApontados: sql `coalesce(sum(${atividades.minutosApontados}), 0)::int`,
        concluidas: sql `count(*) filter (where ${atividades.status} = 'finalizado')::int`,
        minutosConcluidos: sql `coalesce(sum(${atividades.minutosApontados}) filter (where ${atividades.status} = 'finalizado'), 0)::int`,
        faturaveis: sql `count(*) filter (where ${atividades.status} = 'finalizado' and ${atividades.aprovado})::int`,
        minutosFaturaveis: sql `coalesce(sum(${atividades.minutosApontados}) filter (where ${atividades.status} = 'finalizado' and ${atividades.aprovado}), 0)::int`,
        emAtraso: sql `count(*) filter (where ${atividades.previstoFimEm} < now() and ${atividades.status} <> 'finalizado')::int`,
        colaboradores: sql `count(distinct ${atividades.id})::int`,
    })
        .from(atividades)
        .where(eq(atividades.osId, osId));
    return (linha ?? {
        atividades: 0,
        minutosEstimados: 0,
        minutosApontados: 0,
        concluidas: 0,
        minutosConcluidos: 0,
        faturaveis: 0,
        minutosFaturaveis: 0,
        emAtraso: 0,
        colaboradores: 0,
    });
}
//# sourceMappingURL=ordem.js.map