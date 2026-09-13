/**
 * O contrato OpenAPI.
 *
 * Por que existe: o Swagger e gerado a partir dos schemas das rotas, e uma rota
 * nova sobe perfeitamente bem sem `schema` nenhum — ela so some da documentacao,
 * em silencio. Foi exatamente assim que as 59 rotas ficaram sem contrato ate
 * 13/09/2026, com `/doc` no ar o tempo todo, parecendo pronto. Este teste e o
 * que transforma esse esquecimento num erro visivel.
 *
 * Verifica tambem a consequencia mais perigosa de declarar `response` no
 * Fastify: o serializador padrao apaga, sem avisar, todo campo ausente do
 * schema. Por isso `index.ts` registra compiladores neutros, e as duas ultimas
 * checagens aqui existem para provar que eles continuam de pe — uma resposta
 * podada e um bug que nenhum teste de status code pega.
 *
 * Uso:
 *   node testes/doc.mjs
 *   BASE_URL=https://99dev.pro/sys-aceite-api node testes/doc.mjs
 */

const API = (process.env.BASE_URL ?? 'http://localhost:3333').replace(/\/+$/, '')
const METODOS = ['get', 'post', 'patch', 'put', 'delete']

let falhas = 0
const ok = (m) => console.log('  OK    ' + m)
const falhar = (m) => {
  console.error('  FALHA ' + m)
  falhas += 1
}
const conferir = (condicao, m) => (condicao ? ok(m) : falhar(m))

function operacoes(doc) {
  return Object.entries(doc.paths).flatMap(([rota, metodos]) =>
    METODOS.filter((m) => metodos[m]).map((m) => ({
      nome: `${m.toUpperCase()} ${rota}`,
      op: metodos[m],
    })),
  )
}

/** Lista os nomes que falham na regra, para o erro dizer ONDE consertar. */
function quebram(ops, regra) {
  return ops.filter(({ op }) => !regra(op)).map(({ nome }) => nome)
}

function relatar(nomes, mensagem) {
  if (nomes.length === 0) return ok(mensagem)
  falhar(`${mensagem} — ${nomes.length}: ${nomes.slice(0, 6).join(', ')}`)
}

async function main() {
  console.log(`\n=== Contrato OpenAPI em ${API} ===\n`)

  /* ---------------------------- as tres rotas ---------------------------- */

  const ui = await fetch(`${API}/doc/`)
  conferir(ui.status === 200, `/doc responde ${ui.status}`)
  conferir(
    (ui.headers.get('content-type') ?? '').includes('text/html'),
    'a UI vem como HTML',
  )

  const yaml = await fetch(`${API}/doc/yaml`)
  conferir(yaml.status === 200, `/doc/yaml responde ${yaml.status}`)

  const resposta = await fetch(`${API}/doc/json`)
  conferir(resposta.status === 200, `/doc/json responde ${resposta.status}`)
  if (resposta.status !== 200) return

  const doc = await resposta.json()
  conferir(String(doc.openapi ?? '').startsWith('3.'), `documento OpenAPI ${doc.openapi}`)
  conferir(Boolean(doc.info?.title), `titulo: ${doc.info?.title}`)
  conferir(
    doc.components?.securitySchemes?.bearerAuth?.scheme === 'bearer',
    'bearerAuth declarado como JWT',
  )

  /* --------------------------- cobertura total --------------------------- */

  const ops = operacoes(doc)
  conferir(ops.length >= 61, `${ops.length} operacoes no contrato`)

  relatar(quebram(ops, (o) => o.tags?.length > 0), 'toda operacao tem tag')
  relatar(quebram(ops, (o) => Boolean(o.summary)), 'toda operacao tem resumo')
  relatar(
    quebram(ops, (o) => Object.keys(o.responses ?? {}).some((c) => c.startsWith('2'))),
    'toda operacao documenta o sucesso',
  )
  relatar(
    quebram(ops, (o) => o.responses?.['400'] && o.responses?.['500']),
    'toda operacao documenta 400 e 500',
  )

  // o cadeado: `security: []` e o que marca uma rota como publica. Rota privada
  // sem 401 documentado engana quem for integrar.
  const privadas = ops.filter(({ op }) => !Array.isArray(op.security) || op.security.length > 0)
  const publicas = ops.filter(({ op }) => Array.isArray(op.security) && op.security.length === 0)
  conferir(privadas.length > 40, `${privadas.length} operacoes exigem JWT`)
  relatar(
    quebram(privadas, (o) => Boolean(o.responses?.['401'])),
    'toda rota privada documenta 401',
  )

  // A lista de rotas sem token e curta e conhecida. Se ela crescer sem que
  // alguem mude esta linha, foi engano — e e a falha mais cara possivel.
  const ESPERADAS_PUBLICAS = [
    'GET /health',
    'GET /healthz',
    'GET /publico/aprovacao/{token}',
    'GET /publico/aprovacao/{token}/anexos/{anexoId}',
    'GET /publico/convite/{token}',
    'POST /auth/login',
    'POST /auth/registrar',
    'POST /publico/aprovacao/{token}',
    'POST /publico/convite/{token}',
  ]
  const achadas = publicas.map((x) => x.nome).sort()
  const inesperadas = achadas.filter((n) => !ESPERADAS_PUBLICAS.includes(n))
  conferir(
    inesperadas.length === 0,
    inesperadas.length === 0
      ? `as ${achadas.length} rotas sem JWT sao exatamente as esperadas`
      : `rota publica NAO esperada: ${inesperadas.join(', ')}`,
  )

  // upload e a parte do contrato que mais confunde quem integra
  const multipart = ops.filter(
    ({ op }) => op.requestBody?.content?.['multipart/form-data'],
  )
  conferir(multipart.length === 2, `${multipart.length} rotas multipart documentadas`)

  /* ------------------- os compiladores neutros continuam ------------------ */

  // 1. A entrada. O JSON Schema convertido do zod traz
  //    `additionalProperties: false`; se o ajv voltasse a validar, este corpo
  //    com campo extra viraria 400 em ingles, antes do zod ver qualquer coisa.
  const extra = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ninguem@exemplo.test', senha: 'x', campoExtra: 1 }),
  })
  conferir(
    extra.status === 401,
    `campo extra no corpo chega ao zod e para em 401, nao em 400 do ajv (veio ${extra.status})`,
  )

  // 2. A mensagem de erro continua sendo a nossa, em portugues e com o campo.
  const invalido = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'nao-e-email', senha: '' }),
  })
  const corpo = await invalido.json()
  conferir(
    invalido.status === 400 && corpo.erro === 'validacao' && corpo.mensagem.includes('email:'),
    `erro de validacao vem do zod: ${corpo.mensagem ?? invalido.status}`,
  )

  // 3. A saida. `/health` declara `response` e tem campos aninhados; se o
  //    serializador do Fastify voltasse a filtrar, os que escapassem do schema
  //    sumiriam em silencio.
  const saude = await (await fetch(`${API}/health`)).json()
  conferir(
    ['ok', 'servico', 'ambiente', 'banco', 'storage', 'limites', 'em'].every(
      (c) => saude[c] !== undefined,
    ) && saude.banco?.latenciaMs !== undefined,
    'resposta com schema sai inteira, sem poda do serializador',
  )

  console.log(falhas === 0 ? '\n=== TUDO PASSOU ===\n' : `\n=== ${falhas} FALHA(S) ===\n`)
  process.exit(falhas === 0 ? 0 : 1)
}

main().catch((erro) => {
  console.error('\nerro inesperado:', erro.message)
  process.exit(1)
})
