/**
 * Fluxo de equipe: convite por e-mail, aceite, papeis e acesso por projeto.
 * Cria o proprio tenant, entao nao encosta nos dados de demonstracao.
 */
/**
 * Base da API. `BASE_URL` aponta a suite para outro ambiente — a URL publica,
 * por exemplo, onde o proxy entra no caminho e o comportamento pode diferir do
 * que se ve em localhost.
 */
const API = (process.env.BASE_URL ?? 'http://localhost:3333').replace(/\/+$/, '')
const sufixo = Date.now().toString(36)

async function req(metodo, rota, corpo, token) {
  const r = await fetch(API + rota, {
    method: metodo,
    headers: {
      ...(corpo ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  })
  const texto = await r.text()
  let json = texto
  try {
    json = JSON.parse(texto)
  } catch {
    /* resposta sem json */
  }
  return { status: r.status, corpo: json }
}

let falhas = 0
const ok = (m) => console.log(`  OK    ${m}`)
const conferir = (cond, m) => {
  if (cond) ok(m)
  else {
    falhas++
    console.log(`  FALHOU ${m}`)
  }
}

console.log('\n=== SMOKE TEST — equipe e convites ===\n')

/* 1. tenant, admin e dois projetos ------------------------------------- */

const emailAdmin = `admin.${sufixo}@sysaceite.dev`
const cadastro = await req('POST', '/auth/registrar', {
  nome: 'Admin Teste',
  email: emailAdmin,
  senha: 'admin12345',
  empresa: `Equipe Teste ${sufixo}`,
})
const tokenAdmin = cadastro.corpo.token
conferir(cadastro.status === 201, 'tenant e admin criados')

const alfa = (await req('POST', '/projetos', { nome: 'Alfa', cliente: 'Cliente Alfa' }, tokenAdmin))
  .corpo.projeto
const beta = (await req('POST', '/projetos', { nome: 'Beta', cliente: 'Cliente Beta' }, tokenAdmin))
  .corpo.projeto
const osBeta = await req(
  'POST',
  '/os',
  { projetoId: beta.id, titulo: 'O.S. que o colaborador nao pode ver' },
  tokenAdmin,
)
conferir(Boolean(alfa?.id && beta?.id) && osBeta.status === 201, '2 projetos e 1 O.S. criados')

/* 2. convite ------------------------------------------------------------ */

const emailColab = `colab.${sufixo}@sysaceite.dev`
const convite = await req(
  'POST',
  '/convites',
  {
    nome: 'Colaborador Teste',
    email: emailColab,
    papel: 'membro',
    cargo: 'Desenvolvedor',
    projetoIds: [alfa.id],
    validade: '7d',
    mensagem: 'Bem-vindo ao time.',
  },
  tokenAdmin,
)
conferir(convite.status === 201, `convite criado (${convite.status})`)
conferir(convite.corpo.convite?.estado === 'pendente', 'convite nasce pendente')
conferir(
  convite.corpo.convite?.projetos?.length === 1 && convite.corpo.convite.projetos[0].nome === 'Alfa',
  'convite guarda o projeto escolhido',
)
conferir(typeof convite.corpo.url === 'string' && convite.corpo.url.includes('/convite/'), 'devolve a URL do convite')
conferir(
  typeof convite.corpo.emailEnviado === 'boolean',
  `modo de envio informado (emailEnviado: ${convite.corpo.emailEnviado})`,
)

const tokenConvite = convite.corpo.url.split('/convite/')[1]

/* 3. colaborador sem projeto e recusado --------------------------------- */

const semProjeto = await req(
  'POST',
  '/convites',
  { nome: 'Sem Projeto', email: `vazio.${sufixo}@sysaceite.dev`, papel: 'membro', projetoIds: [] },
  tokenAdmin,
)
conferir(semProjeto.status === 400, `colaborador sem projeto e recusado (${semProjeto.status})`)

/* 4. e-mail duplicado --------------------------------------------------- */

const duplicado = await req(
  'POST',
  '/convites',
  { nome: 'Outro', email: emailColab, papel: 'membro', projetoIds: [alfa.id] },
  tokenAdmin,
)
conferir(duplicado.status === 409, `convite duplicado da 409 (${duplicado.status})`)

const jaTemConta = await req(
  'POST',
  '/convites',
  { nome: 'Admin de novo', email: emailAdmin, papel: 'membro', projetoIds: [alfa.id] },
  tokenAdmin,
)
conferir(jaTemConta.status === 409, `e-mail com conta da 409 (${jaTemConta.status})`)

/* 5. pagina publica do convite ------------------------------------------ */

const publico = await req('GET', `/publico/convite/${tokenConvite}`)
conferir(publico.status === 200 && publico.corpo.estado === 'pendente', 'pagina publica abre sem login')
conferir(publico.corpo.organizacao?.nome?.startsWith('Equipe Teste'), 'mostra o nome da organizacao')
conferir(publico.corpo.projetos?.[0]?.nome === 'Alfa', 'mostra o projeto do convite')
conferir(publico.corpo.convite?.convidadoPor === 'Admin Teste', 'mostra quem convidou')
conferir(!JSON.stringify(publico.corpo).includes('senhaHash'), 'nao vaza senhaHash')

/* 6. aceite ------------------------------------------------------------- */

const senhaCurta = await req('POST', `/publico/convite/${tokenConvite}`, {
  nome: 'Colaborador Teste',
  senha: '123',
  ciente: true,
})
conferir(senhaCurta.status === 400, `senha curta e recusada (${senhaCurta.status})`)

const semCiente = await req('POST', `/publico/convite/${tokenConvite}`, {
  nome: 'Colaborador Teste',
  senha: 'colab12345',
})
conferir(semCiente.status === 400, `aceite sem confirmacao e recusado (${semCiente.status})`)

const aceite = await req('POST', `/publico/convite/${tokenConvite}`, {
  nome: 'Colaborador Teste',
  senha: 'colab12345',
  confirmacao: 'colab12345',
  ciente: true,
})
const tokenColab = aceite.corpo.token
conferir(aceite.status === 201 && Boolean(tokenColab), `aceite cria a conta e ja entra logado (${aceite.status})`)
conferir(aceite.corpo.usuario?.papel === 'membro', 'conta nasce com o papel do convite')
conferir(aceite.corpo.usuario?.cargo === 'Desenvolvedor', 'cargo do convite vai para a conta')

/* 7. o token do convite nao serve duas vezes ---------------------------- */

const reuso = await req('POST', `/publico/convite/${tokenConvite}`, {
  nome: 'Impostor',
  senha: 'outra12345',
  ciente: true,
})
conferir(reuso.status === 400 || reuso.status === 409, `token usado nao serve de novo (${reuso.status})`)

/* 8. login e visibilidade ----------------------------------------------- */

const login = await req('POST', '/auth/login', { email: emailColab, senha: 'colab12345' })
conferir(login.status === 200, `login com a senha nova funciona (${login.status})`)

const listaColab = await req('GET', '/projetos', undefined, tokenColab)
conferir(
  listaColab.corpo.projetos?.length === 1 && listaColab.corpo.projetos[0].nome === 'Alfa',
  `colaborador ve so o projeto dele (viu ${listaColab.corpo.projetos?.length})`,
)

const listaAdmin = await req('GET', '/projetos', undefined, tokenAdmin)
conferir(listaAdmin.corpo.projetos?.length === 2, `admin ve os 2 projetos (viu ${listaAdmin.corpo.projetos?.length})`)

const osAlheia = await req('GET', `/os/${osBeta.corpo.os.id}`, undefined, tokenColab)
conferir(osAlheia.status === 404, `O.S. de projeto alheio da 404 (deu ${osAlheia.status})`)

/* 9. colaborador nao administra ----------------------------------------- */

const colabConvida = await req(
  'POST',
  '/convites',
  { nome: 'Alguem', email: `x.${sufixo}@sysaceite.dev`, papel: 'membro', projetoIds: [alfa.id] },
  tokenColab,
)
conferir(colabConvida.status === 403, `colaborador nao convida (${colabConvida.status})`)

const colabLista = await req('GET', '/convites', undefined, tokenColab)
conferir(colabLista.status === 403, `colaborador nao lista convites (${colabLista.status})`)

const equipeColab = await req('GET', '/equipe', undefined, tokenColab)
conferir(
  equipeColab.status === 200 && equipeColab.corpo.convites.length === 0,
  'colaborador ve a equipe, mas nenhum convite',
)
conferir(
  equipeColab.corpo.membros?.every((m) => m.email === undefined),
  'lista reduzida para colaborador: sem e-mail dos colegas',
)

/* 10. convite revogado e expirado --------------------------------------- */

const segundo = await req(
  'POST',
  '/convites',
  { nome: 'Revogado', email: `rev.${sufixo}@sysaceite.dev`, papel: 'membro', projetoIds: [alfa.id] },
  tokenAdmin,
)
const tokenRevogado = segundo.corpo.url.split('/convite/')[1]
await req('POST', `/convites/${segundo.corpo.convite.id}/revogar`, {}, tokenAdmin)

const lerRevogado = await req('GET', `/publico/convite/${tokenRevogado}`)
conferir(lerRevogado.corpo.estado === 'revogado', 'convite revogado aparece como revogado')

const aceitarRevogado = await req('POST', `/publico/convite/${tokenRevogado}`, {
  nome: 'Nao entra',
  senha: 'senha12345',
  ciente: true,
})
conferir(aceitarRevogado.status === 400, `convite revogado nao cria conta (${aceitarRevogado.status})`)

const inexistente = await req('GET', '/publico/convite/naoexisteestetokenaqui123456789')
conferir(inexistente.status === 404, `token inexistente da 404 (${inexistente.status})`)

/* 11. reenviar troca o token -------------------------------------------- */

const terceiro = await req(
  'POST',
  '/convites',
  { nome: 'Reenvio', email: `re.${sufixo}@sysaceite.dev`, papel: 'membro', projetoIds: [alfa.id] },
  tokenAdmin,
)
const tokenAntigo = terceiro.corpo.url.split('/convite/')[1]
const reenvio = await req('POST', `/convites/${terceiro.corpo.convite.id}/reenviar`, {}, tokenAdmin)
const tokenNovo = reenvio.corpo.url.split('/convite/')[1]
conferir(tokenNovo !== tokenAntigo, 'reenviar gera token novo')
conferir(
  (await req('GET', `/publico/convite/${tokenAntigo}`)).status === 404,
  'token antigo para de funcionar',
)

/* 12. admin edita o perfil de outra pessoa ------------------------------ */

const idColab = aceite.corpo.usuario.id
const promovido = await req(
  'PATCH',
  `/usuarios/${idColab}`,
  { cargo: 'Tech lead', projetoIds: [alfa.id, beta.id] },
  tokenAdmin,
)
conferir(promovido.status === 200 && promovido.corpo.usuario.cargo === 'Tech lead', 'admin edita o perfil')

const listaDepois = await req('GET', '/projetos', undefined, tokenColab)
conferir(
  listaDepois.corpo.projetos?.length === 2,
  `projeto novo aparece na hora para o colaborador (viu ${listaDepois.corpo.projetos?.length})`,
)

/* 13. ultimo admin e desativacao ---------------------------------------- */

const meuId = cadastro.corpo.usuario.id
const rebaixar = await req('PATCH', `/usuarios/${meuId}`, { papel: 'membro' }, tokenAdmin)
conferir(rebaixar.status === 400, `unico admin nao se rebaixa (${rebaixar.status})`)

const desativarme = await req('PATCH', `/usuarios/${meuId}`, { ativo: false }, tokenAdmin)
conferir(desativarme.status === 400, `unico admin nao se desativa (${desativarme.status})`)

const desativar = await req('PATCH', `/usuarios/${idColab}`, { ativo: false }, tokenAdmin)
conferir(desativar.status === 200, 'admin desativa o colaborador')

const loginMorto = await req('POST', '/auth/login', { email: emailColab, senha: 'colab12345' })
conferir(loginMorto.status === 401, `conta desativada nao entra (${loginMorto.status})`)

const tokenMorto = await req('GET', '/projetos', undefined, tokenColab)
conferir(tokenMorto.status === 403, `token da conta desativada para de valer (${tokenMorto.status})`)

/* 13b. o resto da barreira por projeto ---------------------------------- */

// reativa o colaborador para conferir as rotas de escrita
await req('PATCH', `/usuarios/${idColab}`, { ativo: true, projetoIds: [alfa.id] }, tokenAdmin)
const tokenColab2 = (await req('POST', '/auth/login', { email: emailColab, senha: 'colab12345' }))
  .corpo.token

const criarAlheia = await req(
  'POST',
  '/os',
  { projetoId: beta.id, titulo: 'nao deveria entrar' },
  tokenColab2,
)
conferir(criarAlheia.status === 404, `criar O.S. em projeto alheio da 404 (${criarAlheia.status})`)

const moverAlheia = await req(
  'PATCH',
  `/os/${osBeta.corpo.os.id}/status`,
  { status: 'atendendo' },
  tokenColab2,
)
conferir(moverAlheia.status === 404, `mover O.S. alheia da 404 (${moverAlheia.status})`)

const apagarAlheia = await req('DELETE', `/os/${osBeta.corpo.os.id}`, undefined, tokenColab2)
conferir(apagarAlheia.status === 404, `apagar O.S. alheia da 404 (${apagarAlheia.status})`)

const linkAlheio = await req(
  'POST',
  `/os/${osBeta.corpo.os.id}/links`,
  { validade: '7d' },
  tokenColab2,
)
conferir(linkAlheio.status === 404, `gerar link de aprovacao alheio da 404 (${linkAlheio.status})`)

const dashColab = await req('GET', '/dashboard', undefined, tokenColab2)
conferir(
  dashColab.corpo.kpis?.abertas === 0,
  `dashboard nao conta O.S. de projeto alheio (contou ${dashColab.corpo.kpis?.abertas})`,
)

const meuProjeto = await req('POST', '/projetos', { nome: 'Gama', cliente: 'Cliente Gama' }, tokenColab2)
const listaComGama = await req('GET', '/projetos', undefined, tokenColab2)
conferir(
  meuProjeto.status === 201 && listaComGama.corpo.projetos?.length === 2,
  `quem cria o projeto participa dele (ve ${listaComGama.corpo.projetos?.length})`,
)

/* 13c. SLA: leitura para todos, escrita so do admin --------------------- */

const slaColab = await req('GET', '/sla', undefined, tokenColab2)
conferir(
  slaColab.status === 200 && slaColab.corpo.politicas?.length > 0,
  'colaborador le as politicas de SLA',
)

const politicaId = slaColab.corpo.politicas[0].id
const editarSla = await req(
  'PATCH',
  `/sla/politicas/${politicaId}`,
  { minutosResolucao: 1 },
  tokenColab2,
)
conferir(editarSla.status === 403, `colaborador nao edita politica de SLA (${editarSla.status})`)

const criarCategoria = await req('POST', '/sla/categorias', { nome: 'Invadida' }, tokenColab2)
conferir(criarCategoria.status === 403, `colaborador nao cria categoria (${criarCategoria.status})`)

const adminEditaSla = await req(
  'PATCH',
  `/sla/politicas/${politicaId}`,
  { minutosResolucao: 300 },
  tokenAdmin,
)
conferir(adminEditaSla.status === 200, `admin edita a politica (${adminEditaSla.status})`)

/* 14. troca de senha ----------------------------------------------------- */

const senhaErrada = await req(
  'PATCH',
  '/auth/senha',
  { senhaAtual: 'errada123', novaSenha: 'novasenha123' },
  tokenAdmin,
)
conferir(senhaErrada.status === 400, `senha atual errada e recusada (${senhaErrada.status})`)

const trocou = await req(
  'PATCH',
  '/auth/senha',
  { senhaAtual: 'admin12345', novaSenha: 'novasenha123' },
  tokenAdmin,
)
conferir(trocou.status === 200, 'senha trocada')
conferir(
  (await req('POST', '/auth/login', { email: emailAdmin, senha: 'novasenha123' })).status === 200,
  'login com a senha nova',
)
conferir(
  (await req('POST', '/auth/login', { email: emailAdmin, senha: 'admin12345' })).status === 401,
  'senha antiga nao entra mais',
)

console.log(falhas === 0 ? '\n=== TUDO PASSOU ===\n' : `\n=== ${falhas} FALHA(S) ===\n`)
process.exit(falhas === 0 ? 0 : 1)
