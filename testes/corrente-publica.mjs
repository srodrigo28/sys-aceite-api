/**
 * A corrente inteira: navegador → Nginx → API → bucket.
 *
 * Por que existe, separada das outras suites: elas rodam contra `localhost:3333`
 * e falam com a API direto. O proxy fica de fora, e foi exatamente lá que o
 * problema se escondeu em 12/09/2026 — o `client_max_body_size` padrao do Nginx
 * (1m) recusava todo anexo maior que 1 MB com um 413 em HTML. A API nunca era
 * chamada, entao NENHUM teste da suite local podia pegar: do ponto de vista
 * deles, estava tudo certo.
 *
 * O que se verifica aqui, e so aqui:
 *   - imagem grande chega na API e volta reduzida (prova que o proxy deixa passar);
 *   - arquivo grande demais e recusado pela APLICACAO, em JSON — nao pelo proxy,
 *     em HTML, que o cliente nao sabe ler;
 *   - rota inexistente responde 404 rapido (prova que o proxy encaminha e nao
 *     engole; um timeout aqui significa upstream inalcancavel).
 *
 * Uso:
 *   BASE_URL=https://99dev.pro/sys-aceite-api node testes/corrente-publica.mjs
 *
 * Cria a propria conta: nao depende de seed e pode rodar contra producao.
 */

const API = (process.env.BASE_URL ?? 'http://localhost:3333').replace(/\/+$/, '')

let falhas = 0
const ok = (m) => console.log('  OK    ' + m)
const falhar = (m) => {
  console.error('  FALHA ' + m)
  falhas += 1
}
const conferir = (condicao, m) => (condicao ? ok(m) : falhar(m))

async function json(rota, init = {}) {
  const r = await fetch(API + rota, init)
  const texto = await r.text()
  let corpo = null
  try {
    corpo = texto ? JSON.parse(texto) : null
  } catch {
    /* resposta que nao e JSON: quem chama decide o que fazer */
  }
  return { status: r.status, corpo, texto, tipo: r.headers.get('content-type') ?? '' }
}

/** PNG sem compressao, do tamanho pedido — grande o bastante para exercitar o proxy. */
async function pngDeAproximadamente(mb) {
  const { default: sharp } = await import('sharp')
  const lado = Math.ceil(Math.sqrt((mb * 1024 * 1024) / 3))
  const cru = Buffer.alloc(lado * lado * 3)
  for (let i = 0; i < cru.length; i++) cru[i] = (i * 2654435761) % 256
  return sharp(cru, { raw: { width: lado, height: lado, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer()
}

async function enviar(token, osId, buffer, nome, mime) {
  const form = new FormData()
  form.append('arquivo', new Blob([new Uint8Array(buffer)], { type: mime }), nome)
  const r = await fetch(`${API}/atividades/${osId}/anexos`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  })
  const texto = await r.text()
  let corpo = null
  try {
    corpo = texto ? JSON.parse(texto) : null
  } catch {
    /* 413 do Nginx vem em HTML */
  }
  return { status: r.status, corpo, texto, tipo: r.headers.get('content-type') ?? '' }
}

console.log(`\n=== corrente publica — ${API} ===\n`)

/* ------------------------------------------------------------------ *
 * 1. O proxy encaminha, e nao engole
 * ------------------------------------------------------------------ */
console.log('  -- roteamento --')

const inicio = Date.now()
const inexistente = await json('/rota-que-nao-existe-' + Date.now())
const demorou = Date.now() - inicio

conferir(inexistente.status === 404, `rota inexistente responde 404 (veio ${inexistente.status})`)
conferir(
  demorou < 10_000,
  `404 chega rapido: ${demorou}ms — timeout aqui significa upstream inalcancavel`,
)

const saude = await json('/healthz')
conferir(saude.status === 200 && saude.corpo?.ok === true, 'GET /healthz responde 200')

const health = await json('/health')
conferir(health.status === 200, 'GET /health responde 200')
conferir(health.corpo?.banco?.conectado === true, 'banco conectado')

const tetoAnexo = health.corpo?.limites?.anexoBytes
conferir(typeof tetoAnexo === 'number' && tetoAnexo > 0, `/health publica o teto: ${tetoAnexo} bytes`)

/* ------------------------------------------------------------------ *
 * 2. Conta, projeto e O.S. proprios
 * ------------------------------------------------------------------ */
console.log('\n  -- preparo --')

const sufixo = Date.now()
const cadastro = await json('/auth/registrar', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    nome: 'Corrente Publica',
    email: `corrente.${sufixo}@sysaceite.test`,
    senha: 'senha-de-teste-123',
    empresa: `Corrente ${sufixo}`,
  }),
})
conferir(cadastro.status === 201, `cadastro cria a conta (${cadastro.status})`)

const token = cadastro.corpo?.token
if (!token) {
  console.error('\n  sem token: o resto da suite nao tem como rodar\n')
  process.exit(1)
}
const comToken = { authorization: `Bearer ${token}` }

const projeto = await json('/projetos', {
  method: 'POST',
  headers: { ...comToken, 'content-type': 'application/json' },
  body: JSON.stringify({ nome: 'Corrente', cliente: 'Teste' }),
})
const projetoId = projeto.corpo?.projeto?.id

const os = await json('/atividades', {
  method: 'POST',
  headers: { ...comToken, 'content-type': 'application/json' },
  body: JSON.stringify({
    projetoId,
    titulo: 'Ciclo de anexo pela URL publica',
    prioridade: 'media',
    tipo: 'tarefa',
  }),
})
const osId = os.corpo?.os?.id
conferir(Boolean(osId), 'projeto e O.S. criados')

/* ------------------------------------------------------------------ *
 * 3. O que so quebra com o proxy no meio
 * ------------------------------------------------------------------ */
console.log('\n  -- limites de tamanho --')

// Acima do teto do bucket de proposito: a API tem de aceitar e ENCOLHER.
const imagemGrande = await pngDeAproximadamente(6)
const envioImagem = await enviar(token, osId, imagemGrande, 'grande.png', 'image/png')

conferir(
  envioImagem.status === 201,
  `imagem de ${(imagemGrande.length / 1024 / 1024).toFixed(1)} MB e aceita (${envioImagem.status})` +
    (envioImagem.status === 413 ? ' — client_max_body_size do proxy esta baixo demais' : ''),
)
conferir(
  envioImagem.corpo?.reduzida === true,
  'a API reduziu a imagem para caber no storage',
)
conferir(
  (envioImagem.corpo?.anexo?.tamanho ?? Infinity) <= tetoAnexo,
  `o anexo guardado cabe no teto (${envioImagem.corpo?.anexo?.tamanho} <= ${tetoAnexo})`,
)
conferir(envioImagem.corpo?.anexo?.temMiniatura === true, 'miniatura foi gerada')

// Arquivo comum grande: a API nao tem como encolher, entao RECUSA — mas a
// recusa precisa ser dela, em JSON, e nao a pagina HTML do proxy.
const textoGrande = Buffer.alloc(Math.max(tetoAnexo * 3, 3 * 1024 * 1024), 'a')
const envioTexto = await enviar(token, osId, textoGrande, 'grande.txt', 'text/plain')

conferir(envioTexto.status === 400, `arquivo grande demais e recusado com 400 (${envioTexto.status})`)
conferir(
  envioTexto.tipo.includes('application/json'),
  `a recusa vem em JSON, nao HTML do proxy (tipo: ${envioTexto.tipo || 'ausente'})`,
)
conferir(
  typeof envioTexto.corpo?.mensagem === 'string' && /\d/.test(envioTexto.corpo.mensagem),
  `a mensagem diz o tamanho: ${JSON.stringify(envioTexto.corpo?.mensagem ?? null)}`,
)

/* ------------------------------------------------------------------ *
 * 4. Ciclo completo do arquivo
 * ------------------------------------------------------------------ */
console.log('\n  -- ciclo do anexo --')

const anexoId = envioImagem.corpo?.anexo?.id

const original = await fetch(`${API}/anexos/${anexoId}/arquivo`, { headers: comToken })
const bytesOriginal = (await original.arrayBuffer()).byteLength
conferir(original.status === 200, 'baixar o original responde 200')
conferir(bytesOriginal > 0, `o original volta com conteudo (${bytesOriginal} bytes)`)

const mini = await fetch(`${API}/anexos/${anexoId}/arquivo?miniatura=1`, { headers: comToken })
const bytesMini = (await mini.arrayBuffer()).byteLength
conferir(mini.status === 200, 'baixar a miniatura responde 200')
conferir(
  bytesMini > 0 && bytesMini < bytesOriginal,
  `a miniatura e menor que o original (${bytesMini} < ${bytesOriginal})`,
)

const semToken = await fetch(`${API}/anexos/${anexoId}/arquivo`)
conferir(semToken.status === 401, `sem token o arquivo nao vaza (${semToken.status})`)

const remocao = await fetch(`${API}/atividades/${osId}/anexos/${anexoId}`, {
  method: 'DELETE',
  headers: comToken,
})
conferir(remocao.status === 204, `remover o anexo responde 204 (${remocao.status})`)

const depois = await json(`/atividades/${osId}`, { headers: comToken })
conferir(
  (depois.corpo?.anexos ?? []).every((a) => a.id !== anexoId),
  'o anexo sumiu da listagem',
)

/* ------------------------------------------------------------------ *
 * 5. Limpeza
 * ------------------------------------------------------------------ */
console.log('\n  -- limpeza --')

await fetch(`${API}/atividades/${osId}`, { method: 'DELETE', headers: comToken })
const projetoRemovido = await fetch(`${API}/projetos/${projetoId}`, {
  method: 'DELETE',
  headers: comToken,
})
conferir(projetoRemovido.status === 204, 'projeto de teste removido')

if (falhas > 0) {
  console.error(`\n=== ${falhas} FALHA(S) ===\n`)
  process.exit(1)
}
console.log('\n=== TUDO PASSOU ===\n')
