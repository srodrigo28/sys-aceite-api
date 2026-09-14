/**
 * SMOKE TEST — a ponte /os -> /atividades.
 *
 * Roda contra a API publica, nao contra o localhost: o que precisa ser provado
 * e que o caminho antigo continua respondendo COM O PROXY NO MEIO, que e onde
 * o web bate. Um teste em memoria nao veria o nginx.
 *
 * Este arquivo morre no A-4, junto com a ponte.
 *
 *   BASE_URL=https://99dev.pro/sys-aceite-api node testes/ponte.mjs
 */

const BASE = (process.env.BASE_URL ?? 'http://localhost:3333').replace(/\/+$/, '')

let falhas = 0
function conferir(condicao, texto) {
  console.log(`  ${condicao ? 'OK  ' : 'FALHA'}  ${texto}`)
  if (!condicao) falhas++
}

async function req(metodo, caminho, corpo, token) {
  const r = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: {
      ...(corpo ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  })
  const texto = await r.text()
  let json
  try {
    json = JSON.parse(texto)
  } catch {
    json = texto
  }
  return { status: r.status, corpo: json }
}

console.log(`\n=== SMOKE TEST — ponte /os -> /atividades em ${BASE} ===\n`)

const email = process.env.TESTE_EMAIL
const senha = process.env.TESTE_SENHA
if (!email || !senha) {
  console.error('  Defina TESTE_EMAIL e TESTE_SENHA de uma conta existente.')
  console.error('  Este teste nao cria conta: /auth/registrar tem limite de 10 por hora.\n')
  process.exit(2)
}

const login = await req('POST', '/auth/login', { email, senha })
conferir(login.status === 200, `login (${login.status})`)
if (login.status !== 200) {
  console.error('\n  Sem sessao nao da para seguir.\n')
  process.exit(1)
}
const token = login.corpo.token

/* ------------------------------------------------------------------ *
 * O caminho novo e o antigo precisam devolver a MESMA coisa
 * ------------------------------------------------------------------ */

const novo = await req('GET', '/atividades/minhas', null, token)
const antigo = await req('GET', '/os/minhas', null, token)

conferir(novo.status === 200, `/atividades/minhas responde 200 (${novo.status})`)
conferir(antigo.status === 200, `/os/minhas responde 200 pela ponte (${antigo.status})`)
conferir(
  JSON.stringify(novo.corpo) === JSON.stringify(antigo.corpo),
  'os dois caminhos devolvem exatamente o mesmo corpo',
)

/* ------------------------------------------------------------------ *
 * A ponte nao pode pegar mais do que deve
 * ------------------------------------------------------------------ */

const oscar = await req('GET', '/oscar', null, token)
conferir(oscar.status === 404, `/oscar continua 404, a ponte nao o captura (${oscar.status})`)

const anexoInexistente = await req('GET', '/anexos/00000000-0000-0000-0000-000000000000/arquivo', null, token)
conferir(
  anexoInexistente.status === 404,
  `/anexos/... segue seu proprio caminho (${anexoInexistente.status})`,
)

/* ------------------------------------------------------------------ *
 * A rota aninhada tambem atravessa
 * ------------------------------------------------------------------ */

const projetos = await req('GET', '/projetos', null, token)
conferir(projetos.status === 200, `/projetos responde 200 (${projetos.status})`)

const projetoId = projetos.corpo?.projetos?.[0]?.id
if (projetoId) {
  const aninhadoNovo = await req('GET', `/projetos/${projetoId}/atividades`, null, token)
  const aninhadoAntigo = await req('GET', `/projetos/${projetoId}/os`, null, token)
  conferir(aninhadoNovo.status === 200, `/projetos/:id/atividades responde 200 (${aninhadoNovo.status})`)
  conferir(
    aninhadoAntigo.status === 200,
    `/projetos/:id/os responde 200 pela ponte (${aninhadoAntigo.status})`,
  )
  conferir(
    JSON.stringify(aninhadoNovo.corpo) === JSON.stringify(aninhadoAntigo.corpo),
    'a rota aninhada devolve o mesmo corpo nos dois caminhos',
  )
} else {
  console.log('  --    sem projeto no workspace; rota aninhada nao verificada')
}

/* ------------------------------------------------------------------ *
 * O contrato so anuncia o caminho novo
 * ------------------------------------------------------------------ */

const doc = await req('GET', '/doc/json')
conferir(doc.status === 200, `/doc/json responde 200 (${doc.status})`)
if (doc.status === 200) {
  const caminhos = Object.keys(doc.corpo.paths ?? {})
  conferir(
    caminhos.some((c) => c.startsWith('/atividades')),
    'o contrato anuncia /atividades',
  )
  conferir(
    !caminhos.some((c) => c === '/os' || c.startsWith('/os/')),
    'o contrato NAO anuncia /os — a ponte e compatibilidade, nao API publica',
  )
}

console.log(falhas ? `\n=== ${falhas} FALHA(S) ===\n` : '\n=== TUDO PASSOU ===\n')
process.exit(falhas ? 1 : 0)
