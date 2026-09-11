import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { anexoTamanhoMax, bucketAtivo, env } from '../env.js';
import { ErroApp, invalido } from './http.js';
const erroBucket = (detalhe) => {
    console.error(`[bucket] ${detalhe}`);
    return new ErroApp(502, 'bucket', 'Nao foi possivel guardar o arquivo. Tente de novo.');
};
function sinal() {
    return AbortSignal.timeout(env.BUCKET_TIMEOUT);
}
function cabecalhos() {
    return { 'X-API-Token': env.BUCKET_TOKEN };
}
/* ------------------------------------------------------------------ *
 * Enviar
 * ------------------------------------------------------------------ */
export async function enviar(entrada) {
    return bucketAtivo ? enviarBucket(entrada) : enviarDisco(entrada);
}
function limiteLegivel() {
    const mb = anexoTamanhoMax / 1024 / 1024;
    return mb >= 1 ? `${mb.toFixed(mb % 1 === 0 ? 0 : 1)} MB` : `${Math.round(anexoTamanhoMax / 1024)} KB`;
}
async function enviarBucket(entrada) {
    // barra antes de gastar a subida: o nginx do bucket responde 413 e o usuario
    // veria "nao foi possivel guardar o arquivo", que nao explica nada
    if (entrada.buffer.byteLength > env.BUCKET_TAMANHO_MAX) {
        throw invalido(`O arquivo tem ${(entrada.buffer.byteLength / 1024 / 1024).toFixed(1)} MB e o limite atual e ${limiteLegivel()}.`);
    }
    const form = new FormData();
    form.append('bucket', env.BUCKET_SLUG);
    form.append('pasta_virtual', entrada.pastaVirtual);
    // sem definir content-type: o fetch monta o boundary do multipart
    form.append('arquivo', new Blob([new Uint8Array(entrada.buffer)], { type: entrada.mimeType }), entrada.nome);
    let resposta;
    try {
        resposta = await fetch(`${env.BUCKET_URL}/upload`, {
            method: 'POST',
            headers: cabecalhos(),
            body: form,
            signal: sinal(),
        });
    }
    catch (e) {
        throw erroBucket(`upload falhou: ${e.message}`);
    }
    const texto = await resposta.text();
    if (resposta.status === 413) {
        throw invalido(`O arquivo passou do limite que o storage aceita (${limiteLegivel()}).`);
    }
    if (!resposta.ok)
        throw erroBucket(`upload ${resposta.status}: ${texto.slice(0, 300)}`);
    let dados;
    try {
        dados = JSON.parse(texto);
    }
    catch {
        throw erroBucket(`upload devolveu resposta invalida: ${texto.slice(0, 200)}`);
    }
    if (!dados.ok || !dados.file_id || !dados.url) {
        throw erroBucket(`upload sem file_id/url: ${texto.slice(0, 300)}`);
    }
    return {
        fileId: String(dados.file_id),
        storage: 'bucket',
        caminho: dados.url,
        mimeType: dados.mime_type ?? entrada.mimeType,
        tamanho: dados.size_bytes ?? entrada.buffer.byteLength,
        checksum: dados.checksum_sha256 ?? null,
    };
}
async function enviarDisco(entrada) {
    const extensao = extname(entrada.nome).slice(0, 12) || '';
    const relativo = join(entrada.pastaVirtual, `${randomUUID()}${extensao}`).replace(/\\/g, '/');
    const absoluto = caminhoAbsoluto(relativo);
    await mkdir(dirname(absoluto), { recursive: true });
    await writeFile(absoluto, entrada.buffer);
    return {
        fileId: relativo,
        storage: 'disco',
        caminho: relativo,
        mimeType: entrada.mimeType,
        tamanho: entrada.buffer.byteLength,
        checksum: createHash('sha256').update(entrada.buffer).digest('hex'),
    };
}
/* ------------------------------------------------------------------ *
 * Baixar  (o proxy — nunca redirecione o cliente para `caminho`)
 * ------------------------------------------------------------------ */
export async function baixar(arquivo) {
    if (arquivo.storage === 'disco') {
        const corpo = await readFile(caminhoAbsoluto(arquivo.caminho));
        return { corpo, mimeType: arquivo.mimeType, tamanho: corpo.byteLength };
    }
    // A API do bucket nao expoe rota de download (/files/:id/download da 404,
    // verificado em 08/09/2026). Buscamos a URL publica pelo servidor, com o
    // token junto: o cliente segue sem ver o endereco real.
    let resposta;
    try {
        resposta = await fetch(arquivo.caminho, { headers: cabecalhos(), signal: sinal() });
    }
    catch (e) {
        throw erroBucket(`download falhou: ${e.message}`);
    }
    if (!resposta.ok)
        throw erroBucket(`download ${resposta.status} em ${arquivo.fileId}`);
    const corpo = Buffer.from(await resposta.arrayBuffer());
    return {
        corpo,
        mimeType: resposta.headers.get('content-type')?.split(';')[0]?.trim() || arquivo.mimeType,
        tamanho: corpo.byteLength,
    };
}
/* ------------------------------------------------------------------ *
 * Apagar  (some do storage; falta do arquivo nao e erro)
 * ------------------------------------------------------------------ */
export async function apagar(arquivo) {
    if (arquivo.storage === 'disco') {
        await unlink(caminhoAbsoluto(arquivo.caminho)).catch(() => { });
        return;
    }
    try {
        const r = await fetch(`${env.BUCKET_URL}/files/${arquivo.fileId}`, {
            method: 'DELETE',
            headers: cabecalhos(),
            signal: sinal(),
        });
        // 404 = ja nao existe la; seguimos para remover a linha do banco
        if (!r.ok && r.status !== 404) {
            console.error(`[bucket] delete ${r.status} em ${arquivo.fileId}`);
        }
    }
    catch (e) {
        // falha ao apagar nao pode travar a interface: registra e segue
        console.error(`[bucket] delete falhou em ${arquivo.fileId}: ${e.message}`);
    }
}
/* ------------------------------------------------------------------ *
 * Disco: resolve e trava o caminho dentro de UPLOAD_DIR
 * ------------------------------------------------------------------ */
function caminhoAbsoluto(relativo) {
    const raiz = resolve(env.UPLOAD_DIR);
    const alvo = resolve(raiz, relativo);
    if (alvo !== raiz && !alvo.startsWith(raiz + (process.platform === 'win32' ? '\\' : '/'))) {
        throw new ErroApp(400, 'caminho_invalido', 'Caminho de arquivo invalido.');
    }
    return alvo;
}
//# sourceMappingURL=bucket.js.map