import type { Categoria, Nivel, PoliticaSla, Prioridade, StatusOS } from '../db/schema.js'

/* ------------------------------------------------------------------ *
 * Padroes de SLA (usados quando o tenant ainda nao tem politica propria)
 * ------------------------------------------------------------------ */

export const SLA_PADRAO: Record<
  Prioridade,
  { minutosPrimeiraResposta: number; minutosResolucao: number }
> = {
  critica: { minutosPrimeiraResposta: 15, minutosResolucao: 4 * 60 },
  alta: { minutosPrimeiraResposta: 60, minutosResolucao: 8 * 60 },
  media: { minutosPrimeiraResposta: 4 * 60, minutosResolucao: 24 * 60 },
  baixa: { minutosPrimeiraResposta: 8 * 60, minutosResolucao: 72 * 60 },
}

export const LIMIAR_RISCO = 0.7
export const LIMIAR_ESTOURO = 1

export type EstadoSla = 'no_prazo' | 'em_risco' | 'estourado' | 'cumprido' | 'descumprido'

export interface RelogioSla {
  prazoMinutos: number
  prazoEm: string
  minutosDecorridos: number
  minutosRestantes: number
  consumo: number
  estado: EstadoSla
  restanteLegivel: string
  parado: boolean
}

export interface ResultadoSla {
  resposta: RelogioSla
  resolucao: RelogioSla
}

/* ------------------------------------------------------------------ *
 * Resolucao da politica: da mais especifica para a mais generica
 *   prioridade + categoria + nivel > prioridade + categoria > prioridade
 * ------------------------------------------------------------------ */

export function resolverPolitica(
  politicas: PoliticaSla[],
  prioridade: Prioridade,
  categoriaId: string | null,
  nivel: Nivel,
): { minutosPrimeiraResposta: number; minutosResolucao: number } {
  const ativas = politicas.filter((p) => p.ativa && p.prioridade === prioridade)

  const candidatas = [
    ativas.find((p) => p.categoriaId === categoriaId && p.nivel === nivel),
    ativas.find((p) => p.categoriaId === categoriaId && p.nivel === null),
    ativas.find((p) => p.categoriaId === null && p.nivel === nivel),
    ativas.find((p) => p.categoriaId === null && p.nivel === null),
  ]

  const escolhida = candidatas.find(Boolean)
  if (escolhida) {
    return {
      minutosPrimeiraResposta: escolhida.minutosPrimeiraResposta,
      minutosResolucao: escolhida.minutosResolucao,
    }
  }
  return SLA_PADRAO[prioridade]
}

/* ------------------------------------------------------------------ *
 * Calculo
 * ------------------------------------------------------------------ */

export interface OsParaSla {
  prioridade: Prioridade
  nivel: Nivel
  categoriaId: string | null
  status: StatusOS
  abertaEm: Date
  inicioAtendimentoEm: Date | null
  primeiraRespostaEm: Date | null
  concluidaEm: Date | null
  pausadaEm: Date | null
  minutosPausados: number
}

const MIN = 60_000

function minutosEntre(inicio: Date, fim: Date): number {
  return Math.max(0, (fim.getTime() - inicio.getTime()) / MIN)
}

/** Minutos que o relogio ficou parado, incluindo a pausa em andamento. */
function pausaTotal(os: OsParaSla, agora: Date): number {
  const emAndamento = os.status === 'pausado' && os.pausadaEm ? minutosEntre(os.pausadaEm, agora) : 0
  return os.minutosPausados + emAndamento
}

function classificar(consumo: number, encerrado: boolean): EstadoSla {
  if (encerrado) return consumo >= LIMIAR_ESTOURO ? 'descumprido' : 'cumprido'
  if (consumo >= LIMIAR_ESTOURO) return 'estourado'
  if (consumo >= LIMIAR_RISCO) return 'em_risco'
  return 'no_prazo'
}

export function formatarDuracao(minutos: number): string {
  const abs = Math.abs(Math.round(minutos))
  const dias = Math.floor(abs / 1440)
  const horas = Math.floor((abs % 1440) / 60)
  const mins = abs % 60

  if (dias > 0) return `${dias}d ${horas}h`
  if (horas > 0) return `${horas}h${String(mins).padStart(2, '0')}`
  return `${mins}min`
}

function montarRelogio(
  os: OsParaSla,
  prazoBaseMinutos: number,
  multiplicador: number,
  marcoFinal: Date | null,
  agora: Date,
): RelogioSla {
  const prazoMinutos = Math.round(prazoBaseMinutos * multiplicador)
  const encerrado = marcoFinal !== null
  const referencia = marcoFinal ?? agora
  const pausados = encerrado ? os.minutosPausados : pausaTotal(os, agora)

  const decorridos = Math.max(0, minutosEntre(os.abertaEm, referencia) - pausados)
  const restantes = prazoMinutos - decorridos
  const consumo = prazoMinutos > 0 ? decorridos / prazoMinutos : 0

  // o prazo alvo desliza junto com o tempo pausado
  const prazoEm = new Date(os.abertaEm.getTime() + (prazoMinutos + pausados) * MIN)

  const estado = classificar(consumo, encerrado)
  const restanteLegivel = encerrado
    ? `Concluido em ${formatarDuracao(decorridos)}`
    : restantes >= 0
      ? `${formatarDuracao(restantes)} restantes`
      : `${formatarDuracao(restantes)} de atraso`

  return {
    prazoMinutos,
    prazoEm: prazoEm.toISOString(),
    minutosDecorridos: Math.round(decorridos),
    minutosRestantes: Math.round(restantes),
    consumo: Number(consumo.toFixed(4)),
    estado,
    restanteLegivel,
    parado: encerrado || os.status === 'pausado',
  }
}

/**
 * Dois relogios por O.S.: primeira resposta e resolucao.
 * MVP roda em tempo corrido (24/7); o calendario de horario comercial entra
 * depois como um transformador de `minutosEntre` (TODO).
 */
export function calcularSla(
  os: OsParaSla,
  politicas: PoliticaSla[],
  categorias: Categoria[],
  agora: Date = new Date(),
): ResultadoSla {
  const politica = resolverPolitica(politicas, os.prioridade, os.categoriaId, os.nivel)
  const categoria = categorias.find((c) => c.id === os.categoriaId)
  const multiplicador = categoria?.multiplicadorSla ?? 1

  // o relogio de primeira resposta para no primeiro retorno ao solicitante;
  // na falta dele, o inicio do atendimento ja conta como resposta
  const marcoResposta = os.primeiraRespostaEm ?? os.inicioAtendimentoEm ?? os.concluidaEm

  return {
    resposta: montarRelogio(
      os,
      politica.minutosPrimeiraResposta,
      multiplicador,
      marcoResposta,
      agora,
    ),
    resolucao: montarRelogio(os, politica.minutosResolucao, multiplicador, os.concluidaEm, agora),
  }
}
