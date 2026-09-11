import { extname } from 'node:path';
import { invalido } from './http.js';
/**
 * Validacao e serializacao de anexos.
 *
 * O tipo do arquivo e decidido pela assinatura dos primeiros bytes, nao pelo
 * que o navegador declarou — um .exe renomeado para .jpg chega com
 * mime "image/jpeg" e precisa ser recusado.
 */
export const TIPOS_ACEITOS = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'application/pdf',
    'text/plain',
    'text/csv',
    'application/zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];
/** SVG fica de fora de proposito: e documento e pode carregar script. */
const EXTENSOES_BLOQUEADAS = new Set([
    '.exe', '.bat', '.cmd', '.sh', '.js', '.mjs', '.cjs', '.html', '.htm',
    '.svg', '.com', '.scr', '.msi', '.ps1', '.vbs', '.jar', '.dll', '.app',
]);
export const MAX_ANEXOS_POR_OS = 20;
export const MAX_NOME = 200;
const ASSINATURAS = [
    { bytes: [0xff, 0xd8, 0xff], tipo: 'image/jpeg' },
    { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], tipo: 'image/png' },
    { bytes: [0x47, 0x49, 0x46, 0x38], tipo: 'image/gif' },
    { bytes: [0x25, 0x50, 0x44, 0x46], tipo: 'application/pdf' },
    // zip cobre docx/xlsx/pptx tambem; o mime declarado desempata
    { bytes: [0x50, 0x4b, 0x03, 0x04], tipo: 'application/zip' },
    { bytes: [0x50, 0x4b, 0x05, 0x06], tipo: 'application/zip' },
    { bytes: [0x50, 0x4b, 0x07, 0x08], tipo: 'application/zip' },
    // executaveis, so para dar mensagem melhor
    { bytes: [0x4d, 0x5a], tipo: 'application/x-executable' },
    { bytes: [0x7f, 0x45, 0x4c, 0x46], tipo: 'application/x-executable' },
];
const OFFICE_ZIP = new Set([
    'application/zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
function combina(buffer, a) {
    const inicio = a.deslocamento ?? 0;
    if (buffer.length < inicio + a.bytes.length)
        return false;
    return a.bytes.every((b, i) => buffer[inicio + i] === b);
}
function ehWebp(buffer) {
    return (buffer.length >= 12 &&
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP');
}
function pareceTexto(buffer) {
    const amostra = buffer.subarray(0, 4096);
    if (amostra.includes(0))
        return false; // byte nulo = binario
    try {
        return Buffer.from(new TextDecoder('utf-8', { fatal: true }).decode(amostra)).length >= 0;
    }
    catch {
        return false;
    }
}
/** Tira caminho, aspas e quebras de linha — o nome vai para o content-disposition. */
export function sanitizarNome(bruto) {
    const base = bruto.split(/[\\/]/).pop() ?? 'arquivo';
    const limpo = base
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f"\\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return (limpo || 'arquivo').slice(0, MAX_NOME);
}
/**
 * Decide o mime real. Lanca ErroApp 400 quando o arquivo nao e aceito.
 * `mimeDeclarado` so serve para desempatar formatos que compartilham assinatura.
 */
export function validarArquivo(buffer, nomeBruto, mimeDeclarado) {
    const nome = sanitizarNome(nomeBruto);
    const extensao = extname(nome).toLowerCase();
    if (EXTENSOES_BLOQUEADAS.has(extensao)) {
        throw invalido(`Arquivos ${extensao} nao sao aceitos por seguranca.`);
    }
    if (buffer.byteLength === 0)
        throw invalido('O arquivo esta vazio.');
    const detectado = ehWebp(buffer)
        ? 'image/webp'
        : (ASSINATURAS.find((a) => combina(buffer, a))?.tipo ?? null);
    if (detectado === 'application/x-executable') {
        throw invalido('O conteudo do arquivo e um executavel. Envio recusado.');
    }
    // Formatos zipados: aceita o mime declarado quando ele e um dos do Office
    if (detectado === 'application/zip') {
        const declarado = mimeDeclarado.split(';')[0]?.trim() ?? '';
        return { nome, mimeType: OFFICE_ZIP.has(declarado) ? declarado : 'application/zip' };
    }
    if (detectado) {
        if (!TIPOS_ACEITOS.includes(detectado)) {
            throw invalido('Tipo de arquivo nao aceito.');
        }
        return { nome, mimeType: detectado };
    }
    // Sem assinatura conhecida: so passa se for texto de verdade
    const declarado = mimeDeclarado.split(';')[0]?.trim() ?? '';
    if ((declarado === 'text/plain' || declarado === 'text/csv') && pareceTexto(buffer)) {
        return { nome, mimeType: declarado };
    }
    throw invalido('Tipo de arquivo nao aceito. Envie imagem, PDF, texto ou documento do Office.');
}
export function ehImagem(mimeType) {
    return mimeType.startsWith('image/');
}
/**
 * O que a API devolve ao cliente.
 * `caminho`, `fileId` e `storage` NUNCA saem daqui: a URL do bucket abre sem
 * token e entrega-la tornaria o anexo publico para sempre.
 */
export function anexoPublico(a) {
    return {
        id: a.id,
        nome: a.nome,
        mimeType: a.mimeType,
        tamanho: a.tamanho,
        ehImagem: ehImagem(a.mimeType),
        // o cliente so precisa saber SE existe miniatura, nunca onde ela esta
        temMiniatura: a.miniaturaCaminho !== null,
        criadoEm: a.criadoEm,
    };
}
/**
 * Qual arquivo o proxy vai servir. Anexo antigo, ou imagem cuja miniatura
 * falhou, cai no original — a rota nunca devolve 404 por falta de miniatura.
 */
export function versaoParaServir(a, querMiniatura) {
    if (querMiniatura && a.miniaturaCaminho && a.miniaturaFileId) {
        return {
            fileId: a.miniaturaFileId,
            storage: a.storage,
            caminho: a.miniaturaCaminho,
            mimeType: a.miniaturaMime ?? 'image/webp',
            tamanho: a.miniaturaTamanho ?? 0,
            // etag proprio: miniatura e original nao podem compartilhar cache
            checksum: a.checksum ? `${a.checksum}-mini` : null,
        };
    }
    return {
        fileId: a.fileId,
        storage: a.storage,
        caminho: a.caminho,
        mimeType: a.mimeType,
        tamanho: a.tamanho,
        checksum: a.checksum,
    };
}
/**
 * Arquivos que um anexo ocupa no storage: o original e, quando existe, a
 * miniatura. Usado ao apagar — o cascade do banco leva a linha, nao o arquivo.
 */
export function arquivosDoAnexo(a) {
    const lista = [
        {
            fileId: a.fileId,
            storage: a.storage,
            caminho: a.caminho,
            mimeType: a.mimeType,
            tamanho: a.tamanho,
            checksum: a.checksum,
        },
    ];
    if (a.miniaturaFileId && a.miniaturaCaminho) {
        lista.push({
            fileId: a.miniaturaFileId,
            storage: a.storage,
            caminho: a.miniaturaCaminho,
            mimeType: a.miniaturaMime ?? 'image/webp',
            tamanho: a.miniaturaTamanho ?? 0,
            checksum: null,
        });
    }
    return lista;
}
/**
 * Resposta das duas rotas de download (a autenticada e a do link de aprovacao).
 * O content-type vem do mime validado no upload, nunca do que o cliente diz.
 */
export function responderArquivo(reply, anexo, conteudo, opcoes) {
    // imagem e PDF abrem na propria pagina; o resto baixa
    const podeInline = ehImagem(anexo.mimeType) || anexo.mimeType === 'application/pdf';
    const disposicao = opcoes.anexar || !podeInline ? 'attachment' : 'inline';
    const nomeSeguro = sanitizarNome(anexo.nome);
    reply
        .header('content-type', anexo.mimeType)
        .header('content-length', conteudo.tamanho)
        .header('content-disposition', `${disposicao}; filename="${nomeSeguro}"`)
        .header('cache-control', opcoes.cache)
        .header('x-content-type-options', 'nosniff');
    if (anexo.checksum)
        reply.header('etag', `"${anexo.checksum}"`);
    return reply.send(conteudo.corpo);
}
//# sourceMappingURL=anexo.js.map