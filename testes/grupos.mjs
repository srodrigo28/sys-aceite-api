/**
 * Grupos de pessoas: quem cria, quem lê, e o que o grupo NÃO faz.
 * Cria o próprio tenant, então não encosta nos dados de demonstração.
 */
const API = 'http://localhost:3333'
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

console.log('\n=== SMOKE TEST — grupos ===\n')

/* --- cenário: um admin, um colaborador, um projeto --------------------- */

const emailAdmin = `admin.${sufixo}@sysaceite.dev`
const cadastro = await req('POST', '/auth/registrar', {
  nome: 'Admin Grupos',
  email: emailAdmin,
  senha: 'admin12345',
  empresa: `Grupos Teste ${sufixo}`,
})
const tokenAdmin = cadastro.corpo.token
const idAdmin = cadastro.corpo.usuario.id
conferir(cadastro.status === 201, 'tenant e admin criados')

const projeto = (
  await req('POST', '/projetos', { nome: 'Projeto Alfa', cliente: 'Cliente Alfa' }, tokenAdmin)
).corpo.projeto

const emailColab = `colab.${sufixo}@sysaceite.dev`
const convite = await req(
  'POST',
  '/convites',
  {
    nome: 'Colaborador Grupos',
    email: emailColab,
    papel: 'membro',
    projetoIds: [projeto.id],
  },
  tokenAdmin,
)
const tokenConvite = convite.corpo.url.split('/convite/')[1]
const aceite = await req('POST', `/publico/convite/${tokenConvite}`, {
  nome: 'Colaborador Grupos',
  senha: 'colab12345',
  ciente: true,
})
const tokenColab = aceite.corpo.token
const idColab = aceite.corpo.usuario.id
conferir(Boolean(tokenColab), 'colaborador entrou no workspace')

/* --- 1. admin cria grupo ----------------------------------------------- */

const criado = await req(
  'POST',
  '/grupos',
  { nome: 'Campo', cor: '#f97316', descricao: 'Quem atende presencialmente' },
  tokenAdmin,
)
conferir(criado.status === 201, `admin cria grupo (${criado.status})`)
const grupo = criado.corpo.grupo
conferir(grupo?.nome === 'Campo' && grupo?.cor === '#f97316', 'grupo guarda nome e cor')

const lista = await req('GET', '/grupos', undefined, tokenAdmin)
conferir(
  lista.corpo.grupos?.length === 1 && lista.corpo.grupos[0].id === grupo.id,
  'grupo aparece em GET /grupos',
)

const repetido = await req('POST', '/grupos', { nome: 'Campo' }, tokenAdmin)
conferir(repetido.status === 409, `nome repetido da 409 (${repetido.status})`)

const corInvalida = await req('POST', '/grupos', { nome: 'Outro', cor: 'laranja' }, tokenAdmin)
conferir(corInvalida.status === 400, `cor fora do formato da 400 (${corInvalida.status})`)

/* --- 2. colaborador não escreve ---------------------------------------- */

const colabCria = await req('POST', '/grupos', { nome: 'Pirata' }, tokenColab)
conferir(colabCria.status === 403, `colaborador nao cria grupo (${colabCria.status})`)

const colabEdita = await req('PATCH', `/grupos/${grupo.id}`, { nome: 'Invadido' }, tokenColab)
conferir(colabEdita.status === 403, `colaborador nao edita grupo (${colabEdita.status})`)

const colabApaga = await req('DELETE', `/grupos/${grupo.id}`, undefined, tokenColab)
conferir(colabApaga.status === 403, `colaborador nao apaga grupo (${colabApaga.status})`)

/* --- 3. colaborador lê -------------------------------------------------- */

const colabLe = await req('GET', '/grupos', undefined, tokenColab)
conferir(
  colabLe.status === 200 && colabLe.corpo.grupos?.length === 1,
  `colaborador le os grupos (${colabLe.status})`,
)

/* --- 4. PUT troca a lista inteira -------------------------------------- */

const doisMembros = await req(
  'PUT',
  `/grupos/${grupo.id}/membros`,
  { usuarioIds: [idAdmin, idColab] },
  tokenAdmin,
)
conferir(doisMembros.status === 200, `PUT define os integrantes (${doisMembros.status})`)
conferir(
  (await req('GET', '/grupos', undefined, tokenAdmin)).corpo.grupos[0].usuarioIds.length === 2,
  'grupo passa a ter 2 integrantes',
)

const umMembro = await req(
  'PUT',
  `/grupos/${grupo.id}/membros`,
  { usuarioIds: [idColab] },
  tokenAdmin,
)
const depoisDeTrocar = (await req('GET', '/grupos', undefined, tokenAdmin)).corpo.grupos[0]
conferir(
  umMembro.status === 200 &&
    depoisDeTrocar.usuarioIds.length === 1 &&
    depoisDeTrocar.usuarioIds[0] === idColab,
  'PUT substitui a lista, nao acrescenta',
)

const repetidos = await req(
  'PUT',
  `/grupos/${grupo.id}/membros`,
  { usuarioIds: [idColab, idColab] },
  tokenAdmin,
)
conferir(
  repetidos.status === 200 &&
    (await req('GET', '/grupos', undefined, tokenAdmin)).corpo.grupos[0].usuarioIds.length === 1,
  'id repetido no corpo nao duplica o integrante',
)

const colabMove = await req(
  'PUT',
  `/grupos/${grupo.id}/membros`,
  { usuarioIds: [idAdmin] },
  tokenColab,
)
conferir(colabMove.status === 403, `colaborador nao move ninguem (${colabMove.status})`)

/* --- 5. isolamento entre tenants --------------------------------------- */

const outro = await req('POST', '/auth/registrar', {
  nome: 'Admin Outro',
  email: `outro.${sufixo}@sysaceite.dev`,
  senha: 'admin12345',
  empresa: `Outro Workspace ${sufixo}`,
})
const idDeOutroTenant = outro.corpo.usuario.id

const intruso = await req(
  'PUT',
  `/grupos/${grupo.id}/membros`,
  { usuarioIds: [idDeOutroTenant] },
  tokenAdmin,
)
conferir(intruso.status === 404, `usuario de outro tenant e recusado (${intruso.status})`)
conferir(
  (await req('GET', '/grupos', undefined, tokenAdmin)).corpo.grupos[0].usuarioIds.length === 1,
  'a recusa nao mexeu na lista que ja estava la',
)

const grupoAlheio = await req('GET', '/grupos', undefined, outro.corpo.token)
conferir(grupoAlheio.corpo.grupos?.length === 0, 'grupo nao vaza para outro tenant')

const editarAlheio = await req(
  'PATCH',
  `/grupos/${grupo.id}`,
  { nome: 'Sequestrado' },
  outro.corpo.token,
)
conferir(editarAlheio.status === 404, `editar grupo de outro tenant da 404 (${editarAlheio.status})`)

/* --- 6. apagar o grupo não apaga as pessoas ---------------------------- */

const apagou = await req('DELETE', `/grupos/${grupo.id}`, undefined, tokenAdmin)
conferir(apagou.status === 204, `admin apaga o grupo (${apagou.status})`)
conferir(
  (await req('GET', '/grupos', undefined, tokenAdmin)).corpo.grupos.length === 0,
  'grupo sumiu da lista',
)

const equipe = await req('GET', '/equipe', undefined, tokenAdmin)
conferir(
  equipe.corpo.membros?.length === 2,
  `apagar o grupo NAO apagou as pessoas (${equipe.corpo.membros?.length} na equipe)`,
)
conferir(
  (await req('POST', '/auth/login', { email: emailColab, senha: 'colab12345' })).status === 200,
  'o colaborador continua entrando normalmente',
)

/* --- grupo não concede acesso ------------------------------------------ */

const projetoB = (
  await req('POST', '/projetos', { nome: 'Projeto Beta', cliente: 'Cliente Beta' }, tokenAdmin)
).corpo.projeto
const grupoB = (await req('POST', '/grupos', { nome: 'Escritorio' }, tokenAdmin)).corpo.grupo
await req('PUT', `/grupos/${grupoB.id}/membros`, { usuarioIds: [idColab] }, tokenAdmin)

const vistos = await req('GET', '/projetos', undefined, tokenColab)
conferir(
  vistos.corpo.projetos?.length === 1 && vistos.corpo.projetos[0].id === projeto.id,
  `entrar num grupo NAO da acesso a projeto (ve ${vistos.corpo.projetos?.length})`,
)
conferir(
  (await req('GET', `/projetos/${projetoB.id}`, undefined, tokenColab)).status === 404,
  'projeto fora da participacao continua 404 mesmo com grupo',
)

/* --- 7 a 14. notificações -------------------------------------------- */

console.log('\n  -- sino --')

const naoLidas = async (token) =>
  (await req('GET', '/notificacoes', undefined, token)).corpo.naoLidas

conferir((await naoLidas(tokenColab)) === 0, 'colaborador comeca sem notificacao')

// o admin NAO comeca do zero: o convite aceito la em cima ja avisou quem convidou.
// E o 5o gatilho, e a partir daqui tudo e medido por diferenca em cima desta base.
const baseAdmin = await naoLidas(tokenAdmin)
conferir(baseAdmin === 1, `quem convidou foi avisado do aceite (base ${baseAdmin})`)
const tipoDaBase = (await req('GET', '/notificacoes', undefined, tokenAdmin)).corpo.itens[0]?.tipo
conferir(tipoDaBase === 'convite_aceito', `a notificacao da base e do convite (${tipoDaBase})`)

// 8. atribuir gera notificacao PARA O RESPONSAVEL
const atividade = await req(
  'POST',
  '/os',
  { projetoId: projeto.id, titulo: 'Trocar o filtro do ar', responsavelId: idColab },
  tokenAdmin,
)
conferir(atividade.status === 201, `admin cria atividade atribuida (${atividade.status})`)

const doColab = await req('GET', '/notificacoes', undefined, tokenColab)
conferir(doColab.corpo.naoLidas === 1, `responsavel recebe a atribuicao (${doColab.corpo.naoLidas})`)
conferir(
  doColab.corpo.itens[0]?.tipo === 'os_atribuida' &&
    doColab.corpo.itens[0]?.osId === atividade.corpo.os.id,
  'notificacao aponta para a O.S. certa',
)

// 9. quem atribuiu NAO e notificado do proprio ato
conferir(
  (await naoLidas(tokenAdmin)) === baseAdmin,
  'quem criou a atividade nao e notificado do proprio ato',
)

// 10. o responsavel move o status -> o admin recebe
const moveu = await req(
  'PATCH',
  `/os/${atividade.corpo.os.id}/status`,
  { status: 'atendendo' },
  tokenColab,
)
conferir(moveu.status === 200, `responsavel move o card (${moveu.status})`)
conferir((await naoLidas(tokenAdmin)) === baseAdmin + 1, 'admin recebe o movimento no quadro')

// 11. quem moveu continua sem notificacao do proprio movimento
conferir(
  (await naoLidas(tokenColab)) === 1,
  'quem moveu nao recebe aviso do proprio movimento (segue com a 1 de antes)',
)

// 12. comentario interno nao notifica
await req(
  'POST',
  `/os/${atividade.corpo.os.id}/comentarios`,
  { texto: 'Lembrete so para o time', interno: true },
  tokenColab,
)
conferir(
  (await naoLidas(tokenAdmin)) === baseAdmin + 1,
  'comentario interno NAO gera notificacao',
)

const comentario = await req(
  'POST',
  `/os/${atividade.corpo.os.id}/comentarios`,
  { texto: 'Cliente confirmou o horario', interno: false },
  tokenColab,
)
conferir(
  comentario.status === 201 && (await naoLidas(tokenAdmin)) === baseAdmin + 2,
  'comentario publico notifica',
)

// 13. isolamento entre pessoas
const idsDoAdmin = (
  await req('GET', '/notificacoes', undefined, tokenAdmin)
).corpo.itens.map((n) => n.id)
const idsDoColab = (
  await req('GET', '/notificacoes', undefined, tokenColab)
).corpo.itens.map((n) => n.id)
conferir(
  idsDoAdmin.every((id) => !idsDoColab.includes(id)),
  'notificacao de um usuario nunca aparece para outro',
)

const marcarAlheia = await req('POST', `/notificacoes/${idsDoAdmin[0]}/lida`, {}, tokenColab)
conferir(marcarAlheia.status === 404, `marcar notificacao alheia da 404 (${marcarAlheia.status})`)
conferir(
  (await naoLidas(tokenAdmin)) === baseAdmin + 2,
  'a tentativa nao mexeu no contador do dono',
)

// 14. marcar lida: uma e todas
const marcarUma = await req('POST', `/notificacoes/${idsDoAdmin[0]}/lida`, {}, tokenAdmin)
conferir(
  marcarUma.status === 200 && (await naoLidas(tokenAdmin)) === baseAdmin + 1,
  'marcar uma como lida derruba o contador',
)

const todas = await req('POST', '/notificacoes/lidas', {}, tokenAdmin)
conferir(
  todas.status === 200 && (await naoLidas(tokenAdmin)) === 0,
  `marcar todas zera o contador (marcou ${todas.corpo.marcadas})`,
)

const soNaoLidas = await req('GET', '/notificacoes?apenasNaoLidas=1', undefined, tokenAdmin)
conferir(soNaoLidas.corpo.itens.length === 0, 'filtro apenasNaoLidas respeita o que ja foi lido')


// 15. parecer do cliente: quem aprova nao e usuario, mas o time e avisado
const linkAprovacao = await req(
  'POST',
  `/os/${atividade.corpo.os.id}/links`,
  { validade: '7d' },
  tokenAdmin,
)
conferir(linkAprovacao.status === 201, `link de aprovacao gerado (${linkAprovacao.status})`)

const tokenPublico = linkAprovacao.corpo.link.url.split('/a/')[1]
const antesDoParecer = await naoLidas(tokenAdmin)

const parecer = await req('POST', `/publico/aprovacao/${tokenPublico}`, {
  decisao: 'aprovado',
  observacao: 'Ficou bom, pode seguir',
  aprovadorNome: 'Cliente Teste',
  ciente: true,
})
conferir(parecer.status === 201, `cliente registra o parecer sem login (${parecer.status})`)

const depoisDoParecer = await req('GET', '/notificacoes', undefined, tokenAdmin)
conferir(
  depoisDoParecer.corpo.naoLidas > antesDoParecer,
  'parecer do cliente chega no sino do time',
)
const doParecer = depoisDoParecer.corpo.itens.find((n) => n.tipo === 'os_parecer')
conferir(Boolean(doParecer), 'a notificacao do parecer tem o tipo os_parecer')
conferir(
  doParecer?.autorId === null && doParecer?.autorNome === 'Cliente Teste',
  'aprovador externo entra como nome, sem autorId (ele nao e usuario)',
)


console.log(falhas === 0 ? '\n=== TUDO PASSOU ===\n' : `\n=== ${falhas} FALHA(S) ===\n`)
process.exit(falhas === 0 ? 0 : 1)
