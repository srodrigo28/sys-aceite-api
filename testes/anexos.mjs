import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

/**
 * Base da API. `BASE_URL` aponta a suite para outro ambiente — a URL publica,
 * por exemplo, onde o proxy entra no caminho e o comportamento pode diferir do
 * que se ve em localhost.
 */
const API = (process.env.BASE_URL ?? 'http://localhost:3333').replace(/\/+$/, '')
const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]
    }),
)

const ok = (m) => console.log('  OK   ' + m)
const falhar = (m) => {
  console.error('  FALHA ' + m)
  process.exitCode = 1
  throw new Error(m)
}

async function login(email, senha) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, senha }),
  })
  if (!r.ok) throw new Error(`login ${email}: ${r.status} ${await r.text()}`)
  return (await r.json()).token
}

async function jsonComToken(token, rota, init = {}) {
  const r = await fetch(API + rota, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
  })
  const t = await r.text()
  if (!r.ok) throw new Error(`${rota} -> ${r.status}: ${t}`)
  return t ? JSON.parse(t) : null
}

/** Total de arquivos no bucket — usado para provar que nao sobrou orfao. */
async function contarArquivosDoBucket() {
  const r = await fetch(`${env.BUCKET_URL}/files?bucket=${env.BUCKET_SLUG}&per_page=1`, {
    headers: { 'X-API-Token': env.BUCKET_TOKEN },
  })
  const j = await r.json()
  return j.pagination?.total_items ?? 0
}

async function enviarArquivo(token, osId, buffer, nome, mime) {
  const form = new FormData()
  form.append('arquivo', new Blob([new Uint8Array(buffer)], { type: mime }), nome)
  const r = await fetch(`${API}/os/${osId}/anexos`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  })
  return { status: r.status, corpo: await r.text() }
}

console.log('\n=== SMOKE TEST — upload de anexos ===\n')

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const shaPng = createHash('sha256').update(PNG).digest('hex')

/** PNG de ruido: nao comprime, entao serve para estourar o limite do storage. */
function pngDeRuido(largura, altura) {
  const linhas = Buffer.alloc(altura * (1 + largura * 3))
  let p = 0
  for (let y = 0; y < altura; y++) {
    linhas[p++] = 0
    for (let x = 0; x < largura * 3; x++) linhas[p++] = Math.floor(Math.random() * 256)
  }
  const bloco = (tipo, dados) => {
    const tam = Buffer.alloc(4)
    tam.writeUInt32BE(dados.length)
    const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(corpo) >>> 0)
    return Buffer.concat([tam, corpo, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(largura, 0)
  ihdr.writeUInt32BE(altura, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloco('IHDR', ihdr),
    bloco('IDAT', deflateSync(linhas, { level: 1 })),
    bloco('IEND', Buffer.alloc(0)),
  ])
}

let tabelaCrc
function crc32(buf) {
  if (!tabelaCrc) {
    tabelaCrc = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      tabelaCrc[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = tabelaCrc[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

// storage ativo
const saude = await (await fetch(`${API}/health`)).json()
ok(`storage em uso: ${saude.storage}`)

const token = await login('demo@sysaceite.dev', 'demo12345')
const { projetos } = await jsonComToken(token, '/projetos')
const quadro = await jsonComToken(token, `/projetos/${projetos[0].id}/os`)
const os = quadro.ordens[0]
const outraOs = quadro.ordens[1]
ok(`O.S. de teste: ${os.codigo}`)

// 1. upload
const envio = await enviarArquivo(token, os.id, PNG, 'foto da home.png', 'image/png')
if (envio.status !== 201) falhar(`upload devolveu ${envio.status}: ${envio.corpo}`)
const anexo = JSON.parse(envio.corpo).anexo
ok(`upload: ${anexo.nome} (${anexo.mimeType}, ${anexo.tamanho} bytes)`)

// 2. a resposta nao pode conter a URL do bucket
if (JSON.stringify(anexo).includes('99dev') || 'caminho' in anexo || 'fileId' in anexo) {
  falhar('a resposta do upload vazou caminho/fileId')
}
const detalhe = await jsonComToken(token, `/os/${os.id}`)
if (JSON.stringify(detalhe).includes('99dev')) falhar('GET /os/:id vazou a URL do bucket')
ok('nenhuma resposta da API contem a URL do bucket')

// 3. download autenticado devolve os bytes certos
const baixado = await fetch(`${API}/anexos/${anexo.id}/arquivo`, {
  headers: { authorization: `Bearer ${token}` },
})
const bytes = Buffer.from(await baixado.arrayBuffer())
if (baixado.status !== 200) falhar(`download autenticado ${baixado.status}`)
if (createHash('sha256').update(bytes).digest('hex') !== shaPng) falhar('bytes diferentes do original')
ok(`download autenticado: ${bytes.length} bytes, checksum confere`)

// 3b. miniatura: o PNG de 70 bytes e menor que qualquer webp, entao nao gera
// miniatura — e a rota tem que cair no original em vez de dar 404
if (anexo.temMiniatura !== false) falhar('imagem minima nao deveria gerar miniatura')
const semMini = await fetch(`${API}/anexos/${anexo.id}/arquivo?miniatura=1`, {
  headers: { authorization: `Bearer ${token}` },
})
const bytesMini = Buffer.from(await semMini.arrayBuffer())
if (semMini.status !== 200) falhar(`?miniatura=1 sem miniatura deu ${semMini.status}`)
if (bytesMini.length !== bytes.length) falhar('sem miniatura, deveria servir o original')
ok('sem miniatura, ?miniatura=1 cai no original (nao 404)')

// 3c. foto de celular: acima do teto do bucket, a API encolhe em vez de recusar
const grande = pngDeRuido(1400, 1000) // ~4 MB, bem acima do limite de ~977 KB
if (grande.length < 1_000_000) falhar(`PNG de teste ficou pequeno demais (${grande.length} bytes)`)
const envioGrande = await enviarArquivo(token, os.id, grande, 'foto do celular.png', 'image/png')
if (envioGrande.status !== 201) {
  falhar(`foto grande recusada (${envioGrande.status}): ${envioGrande.corpo.slice(0, 160)}`)
}
const corpoGrande = JSON.parse(envioGrande.corpo)
if (corpoGrande.reduzida !== true) falhar('foto grande deveria vir marcada como reduzida')
if (corpoGrande.anexo.tamanho > 1_000_000) {
  falhar(`foto reduzida ainda tem ${corpoGrande.anexo.tamanho} bytes`)
}
if (!corpoGrande.anexo.nome.endsWith('.webp')) falhar('foto reduzida deveria virar .webp')
ok(
  `foto de ${Math.round(grande.length / 1024)} KB entrou com ${Math.round(corpoGrande.anexo.tamanho / 1024)} KB (encolhida)`,
)

// e o que nao e imagem continua sendo recusado, com o limite na mensagem
const pdfGrande = Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(1_500_000, 7)])
const envioPdf = await enviarArquivo(token, os.id, pdfGrande, 'contrato.pdf', 'application/pdf')
if (envioPdf.status === 201) falhar('PDF acima do limite nao deveria entrar')
if (!envioPdf.corpo.includes('limite')) {
  falhar(`mensagem do PDF grande nao cita o limite: ${envioPdf.corpo.slice(0, 160)}`)
}
ok('arquivo nao-imagem acima do limite e recusado com o limite na mensagem')

// 3d. retencao: apagar a O.S. tem que tirar os arquivos do bucket tambem
const antesDeApagar = await contarArquivosDoBucket()
const { os: osDescartavel } = await jsonComToken(token, '/os', {
  method: 'POST',
  body: JSON.stringify({ projetoId: os.projetoId, titulo: 'O.S. que vai ser apagada' }),
})
await enviarArquivo(token, osDescartavel.id, PNG, 'sera apagada.png', 'image/png')
const comAnexo = await contarArquivosDoBucket()
if (comAnexo <= antesDeApagar) falhar('o upload de controle nao chegou ao bucket')

const apagouOs = await fetch(`${API}/os/${osDescartavel.id}`, {
  method: 'DELETE',
  headers: { authorization: `Bearer ${token}` },
})
if (apagouOs.status !== 204) falhar(`DELETE /os deu ${apagouOs.status}`)
const depoisDeApagar = await contarArquivosDoBucket()
if (depoisDeApagar !== antesDeApagar) {
  falhar(`apagar a O.S. deixou ${depoisDeApagar - antesDeApagar} arquivo(s) orfao(s) no bucket`)
}
ok('apagar a O.S. levou os anexos do bucket junto (sem orfaos)')
ok(`  headers: ${baixado.headers.get('content-type')} | ${baixado.headers.get('content-disposition')} | nosniff=${baixado.headers.get('x-content-type-options')}`)

// 4. ETag / 304
const etag = baixado.headers.get('etag')
const r304 = await fetch(`${API}/anexos/${anexo.id}/arquivo`, {
  headers: { authorization: `Bearer ${token}`, 'if-none-match': etag },
})
if (r304.status !== 304) falhar(`esperava 304, veio ${r304.status}`)
ok('ETag funciona (304 na segunda visita)')

// 5. sem token -> 401
const semAuth = await fetch(`${API}/anexos/${anexo.id}/arquivo`)
if (semAuth.status !== 401) falhar(`sem token devia dar 401, veio ${semAuth.status}`)
ok('sem token: 401')

// 6. outro tenant -> 404
const sufixo = Date.now().toString(36)
const intruso = await fetch(`${API}/auth/registrar`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ nome: 'Intruso', email: `intruso.${sufixo}@x.dev`, senha: 'senha12345', empresa: `Outra ${sufixo}` }),
})
const tokenIntruso = (await intruso.json()).token
const outroTenant = await fetch(`${API}/anexos/${anexo.id}/arquivo`, {
  headers: { authorization: `Bearer ${tokenIntruso}` },
})
if (outroTenant.status !== 404) falhar(`outro tenant devia dar 404, veio ${outroTenant.status}`)
ok('anexo de outro tenant: 404')

// 7. link com anexos ligados -> imagem abre sem login
const comAnexos = await jsonComToken(token, `/os/${os.id}/links`, {
  method: 'POST',
  body: JSON.stringify({ validade: '7d', mostrarAnexos: true, moverParaAprovacao: false }),
})
const t1 = comAnexos.link.token
const publico = await (await fetch(`${API}/publico/aprovacao/${t1}`)).json()
if (JSON.stringify(publico).includes('99dev')) falhar('payload publico vazou a URL do bucket')
const arquivoPublico = await fetch(`${API}/publico/aprovacao/${t1}/anexos/${anexo.id}`)
if (arquivoPublico.status !== 200) falhar(`arquivo publico ${arquivoPublico.status}`)
ok(`link publico serve a imagem: ${(await arquivoPublico.arrayBuffer()).byteLength} bytes, sem login`)
ok(`  cache-control: ${arquivoPublico.headers.get('cache-control')}`)

// 8. anexo de outra O.S. pelo mesmo token -> 404
const envioOutra = await enviarArquivo(token, outraOs.id, PNG, 'outra.png', 'image/png')
const anexoOutra = JSON.parse(envioOutra.corpo).anexo
const cruzado = await fetch(`${API}/publico/aprovacao/${t1}/anexos/${anexoOutra.id}`)
if (cruzado.status !== 404) falhar(`anexo de outra O.S. devia dar 404, veio ${cruzado.status}`)
ok('anexo de outra O.S. pelo mesmo token: 404')

// 9. revogar o link corta o acesso ao arquivo
await jsonComToken(token, `/links/${comAnexos.link.id}/revogar`, { method: 'POST' })
const aposRevogar = await fetch(`${API}/publico/aprovacao/${t1}/anexos/${anexo.id}`)
if (aposRevogar.status !== 404) falhar(`link revogado devia dar 404, veio ${aposRevogar.status}`)
ok('link revogado: imagem para de abrir (404)')

// 10. link com mostrarAnexos:false
const semAnexos = await jsonComToken(token, `/os/${os.id}/links`, {
  method: 'POST',
  body: JSON.stringify({ validade: '7d', mostrarAnexos: false, moverParaAprovacao: false }),
})
const bloqueado = await fetch(`${API}/publico/aprovacao/${semAnexos.link.token}/anexos/${anexo.id}`)
if (bloqueado.status !== 404) falhar(`mostrarAnexos:false devia dar 404, veio ${bloqueado.status}`)
ok('link com mostrarAnexos:false: 404')

// 11. executavel renomeado para .jpg
const exe = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(200, 1)])
const tentativaExe = await enviarArquivo(token, os.id, exe, 'inocente.jpg', 'image/jpeg')
if (tentativaExe.status !== 400) falhar(`exe renomeado devia dar 400, veio ${tentativaExe.status}`)
ok(`exe renomeado para .jpg recusado: ${JSON.parse(tentativaExe.corpo).mensagem}`)

// 12. .svg bloqueado por extensao
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
const tentativaSvg = await enviarArquivo(token, os.id, svg, 'logo.svg', 'image/svg+xml')
if (tentativaSvg.status !== 400) falhar(`svg devia dar 400, veio ${tentativaSvg.status}`)
ok('svg recusado por extensao')

// 13. arquivo acima do limite
const gigante = Buffer.concat([PNG, Buffer.alloc(16 * 1024 * 1024, 7)])
const tentativaGrande = await enviarArquivo(token, os.id, gigante, 'grande.png', 'image/png')
if (tentativaGrande.status === 201) falhar('arquivo de 16MB foi aceito')
ok(`arquivo de 16 MB recusado (${tentativaGrande.status})`)

// 14. apagar remove do bucket
const antes = await (await fetch(`${env.BUCKET_URL}/files?bucket=${env.BUCKET_SLUG}&per_page=1`, {
  headers: { 'X-API-Token': env.BUCKET_TOKEN },
})).json()

const del = await fetch(`${API}/os/${os.id}/anexos/${anexo.id}`, {
  method: 'DELETE',
  headers: { authorization: `Bearer ${token}` },
})
if (del.status !== 204) falhar(`delete devolveu ${del.status}`)

const depois = await (await fetch(`${env.BUCKET_URL}/files?bucket=${env.BUCKET_SLUG}&per_page=1`, {
  headers: { 'X-API-Token': env.BUCKET_TOKEN },
})).json()
ok(`apagado: bucket foi de ${antes.pagination.total_items} para ${depois.pagination.total_items} arquivos`)

const sumiu = await fetch(`${API}/anexos/${anexo.id}/arquivo`, {
  headers: { authorization: `Bearer ${token}` },
})
if (sumiu.status !== 404) falhar(`anexo apagado devia dar 404, veio ${sumiu.status}`)
ok('anexo apagado: 404')

// limpa o segundo anexo
await fetch(`${API}/os/${outraOs.id}/anexos/${anexoOutra.id}`, {
  method: 'DELETE',
  headers: { authorization: `Bearer ${token}` },
})

console.log('\n=== TUDO PASSOU ===\n')
