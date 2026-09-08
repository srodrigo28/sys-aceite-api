/* ------------------------------------------------------------------ *
 * Padroes de SLA (usados quando o tenant ainda nao tem politica propria)
 * ------------------------------------------------------------------ */
export const SLA_PADRAO = {
    critica: { minutosPrimeiraResposta: 15, minutosResolucao: 4 * 60 },
    alta: { minutosPrimeiraResposta: 60, minutosResolucao: 8 * 60 },
    media: { minutosPrimeiraResposta: 4 * 60, minutosResolucao: 24 * 60 },
    baixa: { minutosPrimeiraResposta: 8 * 60, minutosResolucao: 72 * 60 },
};
export const LIMIAR_RISCO = 0.7;
export const LIMIAR_ESTOURO = 1;
/* ------------------------------------------------------------------ *
 * Resolucao da politica: da mais especifica para a mais generica
 *   prioridade + categoria + nivel > prioridade + categoria > prioridade
 * ------------------------------------------------------------------ */
export function resolverPolitica(politicas, prioridade, categoriaId, nivel) {
    const ativas = politicas.filter((p) => p.ativa && p.prioridade === prioridade);
    const candidatas = [
        ativas.find((p) => p.categoriaId === categoriaId && p.nivel === nivel),
        ativas.find((p) => p.categoriaId === categoriaId && p.nivel === null),
        ativas.find((p) => p.categoriaId === null && p.nivel === nivel),
        ativas.find((p) => p.categoriaId === null && p.nivel === null),
    ];
    const escolhida = candidatas.find(Boolean);
    if (escolhida) {
        return {
            minutosPrimeiraResposta: escolhida.minutosPrimeiraResposta,
            minutosResolucao: escolhida.minutosResolucao,
        };
    }
    return SLA_PADRAO[prioridade];
}
const MIN = 60_000;
function minutosEntre(inicio, fim) {
    return Math.max(0, (fim.getTime() - inicio.getTime()) / MIN);
}
/** Minutos que o relogio ficou parado, incluindo a pausa em andamento. */
function pausaTotal(os, agora) {
    const emAndamento = os.status === 'pausado' && os.pausadaEm ? minutosEntre(os.pausadaEm, agora) : 0;
    return os.minutosPausados + emAndamento;
}
function classificar(consumo, encerrado) {
    if (encerrado)
        return consumo >= LIMIAR_ESTOURO ? 'descumprido' : 'cumprido';
    if (consumo >= LIMIAR_ESTOURO)
        return 'estourado';
    if (consumo >= LIMIAR_RISCO)
        return 'em_risco';
    return 'no_prazo';
}
export function formatarDuracao(minutos) {
    const abs = Math.abs(Math.round(minutos));
    const dias = Math.floor(abs / 1440);
    const horas = Math.floor((abs % 1440) / 60);
    const mins = abs % 60;
    if (dias > 0)
        return `${dias}d ${horas}h`;
    if (horas > 0)
        return `${horas}h${String(mins).padStart(2, '0')}`;
    return `${mins}min`;
}
function montarRelogio(os, prazoBaseMinutos, multiplicador, marcoFinal, agora) {
    const prazoMinutos = Math.round(prazoBaseMinutos * multiplicador);
    const encerrado = marcoFinal !== null;
    const referencia = marcoFinal ?? agora;
    const pausados = encerrado ? os.minutosPausados : pausaTotal(os, agora);
    const decorridos = Math.max(0, minutosEntre(os.abertaEm, referencia) - pausados);
    const restantes = prazoMinutos - decorridos;
    const consumo = prazoMinutos > 0 ? decorridos / prazoMinutos : 0;
    // o prazo alvo desliza junto com o tempo pausado
    const prazoEm = new Date(os.abertaEm.getTime() + (prazoMinutos + pausados) * MIN);
    const estado = classificar(consumo, encerrado);
    const restanteLegivel = encerrado
        ? `Concluido em ${formatarDuracao(decorridos)}`
        : restantes >= 0
            ? `${formatarDuracao(restantes)} restantes`
            : `${formatarDuracao(restantes)} de atraso`;
    return {
        prazoMinutos,
        prazoEm: prazoEm.toISOString(),
        minutosDecorridos: Math.round(decorridos),
        minutosRestantes: Math.round(restantes),
        consumo: Number(consumo.toFixed(4)),
        estado,
        restanteLegivel,
        parado: encerrado || os.status === 'pausado',
    };
}
/**
 * Dois relogios por O.S.: primeira resposta e resolucao.
 * MVP roda em tempo corrido (24/7); o calendario de horario comercial entra
 * depois como um transformador de `minutosEntre` (TODO).
 */
export function calcularSla(os, politicas, categorias, agora = new Date()) {
    const politica = resolverPolitica(politicas, os.prioridade, os.categoriaId, os.nivel);
    const categoria = categorias.find((c) => c.id === os.categoriaId);
    const multiplicador = categoria?.multiplicadorSla ?? 1;
    // o relogio de primeira resposta para no primeiro retorno ao solicitante;
    // na falta dele, o inicio do atendimento ja conta como resposta
    const marcoResposta = os.primeiraRespostaEm ?? os.inicioAtendimentoEm ?? os.concluidaEm;
    return {
        resposta: montarRelogio(os, politica.minutosPrimeiraResposta, multiplicador, marcoResposta, agora),
        resolucao: montarRelogio(os, politica.minutosResolucao, multiplicador, os.concluidaEm, agora),
    };
}
//# sourceMappingURL=sla.js.map