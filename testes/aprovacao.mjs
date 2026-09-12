/**
 * Base da API. `BASE_URL` aponta a suite para outro ambiente — a URL publica,
 * por exemplo, onde o proxy entra no caminho e o comportamento pode diferir do
 * que se ve em localhost.
 */
const API = (process.env.BASE_URL ?? 'http://localhost:3333').replace(/\/+$/, '')
let token = ''

async function req(metodo, rota, corpo, comAuth = true) {
  const r = await fetch(API + rota, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      ...(comAuth && token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  })
  const texto = await r.text()
  let json
  try { json = JSON.parse(texto) } catch { json = texto }
  if (!r.ok) throw new Error(`${metodo} ${rota} -> ${r.status}: ${texto}`)
  return json
}

const ok = (m) => console.log('  OK  ' + m)

const sufixo = Date.now().toString(36)
const email = `teste.${sufixo}@sysaceite.dev`

console.log('\n=== SMOKE TEST SysAceite ===\n')

// 1. cadastro (cria tenant + admin + categorias + politicas)
const cadastro = await req('POST', '/auth/registrar', {
  nome: 'Rodrigo Teste',
  email,
  senha: 'senha12345',
  empresa: `Agencia ${sufixo}`,
}, false)
token = cadastro.token
ok(`cadastro: tenant "${cadastro.tenant.nome}" (slug ${cadastro.tenant.slug})`)

// 2. login
const login = await req('POST', '/auth/login', { email, senha: 'senha12345' }, false)
token = login.token
ok('login com o mesmo e-mail')

// 3. dados semeados
const sla = await req('GET', '/sla')
ok(`workspace semeado: ${sla.categorias.length} categorias, ${sla.politicas.length} politicas`)

// 4. projeto
const { projeto } = await req('POST', '/projetos', {
  nome: 'Site institucional',
  cliente: 'Padaria do Ze',
  cor: '#6366f1',
})
ok(`projeto criado: ${projeto.nome}`)

// 5. O.S. critica (SLA curto, para ver o relogio andar)
const catInfra = sla.categorias.find((c) => c.nome === 'Infraestrutura')
const { os } = await req('POST', '/os', {
  projetoId: projeto.id,
  titulo: 'Publicar nova home com o banner de setembro',
  descricao: 'Subir a home revisada, trocar o banner e validar no mobile.',
  categoriaId: catInfra.id,
  prioridade: 'critica',
  nivel: 'n2',
})
ok(`O.S. criada: ${os.codigo}`)

// 6. kanban com SLA calculado
const quadro = await req('GET', `/projetos/${projeto.id}/os`)
const cardSla = quadro.ordens[0].sla
ok(`SLA calculado -> resolucao ${cardSla.resolucao.prazoMinutos}min (critica 240 x infra 1.5 = 360), estado ${cardSla.resolucao.estado}, ${cardSla.resolucao.restanteLegivel}`)

// 7. mover no kanban (manual)
await req('PATCH', `/os/${os.id}/status`, { status: 'atendendo' })
await req('PATCH', `/os/${os.id}/status`, { status: 'pausado' })
await req('PATCH', `/os/${os.id}/status`, { status: 'atendendo' })
ok('transicoes de status: a_fazer -> atendendo -> pausado -> atendendo')

// 8. comentario interno nao pode vazar no link publico
await req('POST', `/os/${os.id}/comentarios`, { texto: 'SEGREDO INTERNO - margem do projeto', interno: true })
ok('comentario interno adicionado')

// 9. gerar link de aprovacao
const { link } = await req('POST', `/os/${os.id}/links`, {
  aprovadorNome: 'Maria Silva',
  aprovadorEmail: 'maria@padaria.com',
  mensagem: 'Oi Maria, pode conferir a home antes de publicarmos?',
  validade: '7d',
  mostrarSla: false,
  moverParaAprovacao: false,
})
ok(`link gerado: ${link.url}`)

// 10. abrir a pagina publica SEM token de auth
const publico = await req('GET', `/publico/aprovacao/${link.token}`, null, false)
ok(`pagina publica: estado "${publico.estado}", O.S. ${publico.os.codigo}, ${publico.os.anexos.length} anexos`)
if (JSON.stringify(publico).includes('SEGREDO INTERNO')) throw new Error('FALHA: comentario interno vazou no link publico!')
ok('comentario interno NAO vazou')

// 11. aprovar sem observacao suficiente em "ajustes" deve falhar
let barrou = false
try {
  await req('POST', `/publico/aprovacao/${link.token}`, {
    decisao: 'ajustes', observacao: 'curto', aprovadorNome: 'Maria Silva', ciente: true,
  }, false)
} catch { barrou = true }
if (!barrou) throw new Error('FALHA: aceitou "ajustes" sem observacao minima')
ok('validacao: "ajustes" exige observacao de 10+ caracteres')

// 12. aprovar de verdade
const decisao = await req('POST', `/publico/aprovacao/${link.token}`, {
  decisao: 'aprovado',
  observacao: 'Ficou otimo, pode publicar. So conferir o alt do banner.',
  aprovadorNome: 'Maria Silva',
  aprovadorEmail: 'maria@padaria.com',
  ciente: true,
}, false)
ok(`parecer registrado: ${decisao.mensagem}`)

// 13. link nao aceita segundo parecer
let bloqueou = false
try {
  await req('POST', `/publico/aprovacao/${link.token}`, {
    decisao: 'ajustes', observacao: 'tentando responder de novo agora', aprovadorNome: 'Outro', ciente: true,
  }, false)
} catch { bloqueou = true }
if (!bloqueou) throw new Error('FALHA: aceitou parecer duplicado')
ok('link virou somente leitura apos o parecer')

// 14. o card foi marcado, mas NAO mudou de coluna
const detalhe = await req('GET', `/os/${os.id}`)
if (detalhe.os.aprovado !== true) throw new Error('FALHA: card nao ficou marcado como aprovado')
if (detalhe.os.status !== 'atendendo') throw new Error(`FALHA: status mudou sozinho para ${detalhe.os.status}`)
ok(`card marcado: aprovado por ${detalhe.os.aprovadorNome}`)
ok(`status continua "${detalhe.os.status}" — movimento no Kanban segue manual`)

const comentarioAprovador = detalhe.comentarios.find((c) => c.autorNome.includes('aprovador'))
ok(`observacao virou comentario publico: "${comentarioAprovador.texto.slice(0, 40)}..."`)
ok(`historico registrou: "${detalhe.historico[0].descricao}"`)

// 15. dashboard
const dash = await req('GET', '/dashboard')
ok(`dashboard: ${dash.kpis.abertas} aberta(s), ${dash.kpis.emRisco} em risco, ${dash.kpis.estouradas} estourada(s)`)

console.log('\n=== TUDO PASSOU ===\n')
