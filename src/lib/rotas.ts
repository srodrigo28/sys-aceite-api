/**
 * Ponte dos caminhos antigos: `/os/*` continua respondendo como `/atividades/*`.
 *
 * POR QUE EXISTE
 *
 * API e web sao containers separados, com redeploys independentes, e o painel
 * nao roda migration. Renomear a rota nos dois ao mesmo tempo e impossivel:
 * sempre ha uma janela em que um esta novo e o outro velho, e nessa janela o
 * app fica quebrado inteiro.
 *
 * Esta funcao roda em `rewriteUrl`, ANTES do roteamento. Por isso ela nao
 * duplica rota, nao aparece no contrato OpenAPI e nao cria um segundo handler
 * que possa sair de sincronia com o primeiro.
 *
 * Nao toca em `/oscar` nem em `/atividades/...`: o lookahead exige que `/os`
 * termine ali ou seja seguido de `/` ou `?`. E e idempotente — aplicar duas
 * vezes da o mesmo resultado.
 *
 * CAI NO A-4, quando o web ja estiver chamando `/atividades` e nenhum cliente
 * antigo restar.
 */
export function reescreverUrlAntiga(url: string): string {
  return url
    .replace(/^\/os(?=$|[/?])/, '/atividades')
    .replace(/^(\/projetos\/[^/?]+)\/os(?=$|[/?])/, '$1/atividades')
}
