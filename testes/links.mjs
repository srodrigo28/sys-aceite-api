/**
 * Base da API. `BASE_URL` aponta a suite para outro ambiente — a URL publica,
 * por exemplo, onde o proxy entra no caminho e o comportamento pode diferir do
 * que se ve em localhost.
 */
const API = (process.env.BASE_URL ?? 'http://localhost:3333').replace(/\/+$/, '')
const WEB = process.env.WEB ?? 'http://localhost:3001'

const login = await (
  await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'demo@sysaceite.dev', senha: 'demo12345' }),
  })
).json()

const h = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' }

const { projetos } = await (await fetch(`${API}/projetos`, { headers: h })).json()
const projeto = projetos[0]
const quadro = await (await fetch(`${API}/projetos/${projeto.id}/os`, { headers: h })).json()
const os = quadro.ordens.find((o) => o.status !== 'finalizado') ?? quadro.ordens[0]

const { link } = await (
  await fetch(`${API}/os/${os.id}/links`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      aprovadorNome: 'Maria Silva',
      mensagem: 'Oi Maria, pode conferir antes de publicarmos?',
      validade: '7d',
      moverParaAprovacao: false,
    }),
  })
).json()

console.log('=== rotas para conferir no navegador ===')
console.log(`login      ${WEB}/login`)
console.log(`dashboard  ${WEB}/dashboard`)
console.log(`kanban     ${WEB}/projetos/${projeto.id}`)
console.log(`detalhe    ${WEB}/projetos/${projeto.id}/os/${os.id}`)
console.log(`aprovacao  ${WEB}/a/${link.token}`)
console.log()

// checa se o servidor web responde 200 em cada uma
for (const [nome, rota] of [
  ['/', '/'],
  ['/login', '/login'],
  ['/cadastro', '/cadastro'],
  ['/dashboard', '/dashboard'],
  ['/projetos', '/projetos'],
  ['/sla', '/sla'],
  ['/perfil', '/perfil'],
  ['/configuracoes', '/configuracoes'],
  ['/projetos/[id]', `/projetos/${projeto.id}`],
  ['/projetos/[id]/os/[osId]', `/projetos/${projeto.id}/os/${os.id}`],
  ['/a/[token]', `/a/${link.token}`],
]) {
  const r = await fetch(WEB + rota)
  console.log(`  ${r.status === 200 ? 'OK ' : 'ERRO'} ${r.status}  ${nome}`)
}

// a pagina publica busca os dados no cliente; valida a resposta que ela vai receber
const pub = await (await fetch(`${API}/publico/aprovacao/${link.token}`)).json()
console.log(`\npayload publico: estado=${pub.estado} os=${pub.os.codigo} anexos=${pub.os.anexos.length}`)
console.log(`vazou comentario interno? ${JSON.stringify(pub).includes('SEGREDO') || JSON.stringify(pub).includes('margem') ? 'SIM (FALHA)' : 'nao'}`)
