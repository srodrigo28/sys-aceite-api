import sharp from 'sharp';
/**
 * Miniatura dos anexos de imagem.
 *
 * Foto de celular tem 4-8 MB. A pagina publica de aprovacao, que e onde o
 * cliente decide e quase sempre abre no celular, nao pode baixar isso so para
 * mostrar uma grade de quadradinhos.
 *
 * `gerarMiniatura` NUNCA lanca: anexo e o dado do usuario, miniatura e
 * conveniencia. Se falhar, o anexo entra sem miniatura e o proxy serve o
 * original — que e exatamente como o sistema funcionava antes.
 */
/** Lado maior da miniatura, em pixels. Serve a grade e o card. */
export const LADO_MINIATURA = 480;
export const MIME_MINIATURA = 'image/webp';
/** gif animado vira miniatura estatica do primeiro quadro, de proposito. */
const GERAVEIS = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
export function podeGerarMiniatura(mimeType) {
    return GERAVEIS.has(mimeType);
}
/**
 * Encolhe uma imagem ate caber no limite do storage.
 *
 * O bucket recusa acima de ~1 MB e foto de celular tem 4-8 MB: sem isto o
 * upload simplesmente falha, e anexar foto e o caso de uso central do produto.
 * So entra em acao quando o original NAO cabe — imagem dentro do limite e
 * guardada intacta, byte a byte.
 *
 * Devolve null quando nao ha o que fazer (nao e imagem, ou nem no menor
 * ajuste coube): ai o chamador recusa com mensagem clara.
 */
export async function encolherParaLimite(original, mimeType, limite) {
    if (!podeGerarMiniatura(mimeType))
        return null;
    if (original.byteLength <= limite)
        return null;
    // do menos destrutivo para o mais: primeiro qualidade, depois dimensao
    const tentativas = [
        { largura: 2400, qualidade: 82 },
        { largura: 2000, qualidade: 78 },
        { largura: 1600, qualidade: 72 },
        { largura: 1280, qualidade: 68 },
        { largura: 1024, qualidade: 62 },
    ];
    for (const { largura, qualidade } of tentativas) {
        try {
            const buffer = await sharp(original, { failOn: 'none' })
                .rotate()
                .resize({ width: largura, height: largura, fit: 'inside', withoutEnlargement: true })
                .webp({ quality: qualidade })
                .toBuffer();
            if (buffer.byteLength <= limite) {
                return { buffer, mimeType: MIME_MINIATURA, tamanho: buffer.byteLength };
            }
        }
        catch (e) {
            console.error(`[imagem] encolher falhou (${largura}px q${qualidade}): ${e.message}`);
            return null;
        }
    }
    return null;
}
/** Lado do avatar. Quadrado: o recorte e sempre no centro. */
export const LADO_AVATAR = 256;
/**
 * Prepara a foto de perfil: recorte quadrado no centro, 256px, webp.
 * Ao contrario da miniatura, aqui a conversao e sempre feita — a foto e
 * decoracao, nao documento, e queremos todas do mesmo tamanho e formato.
 */
export async function prepararAvatar(original, mimeType) {
    if (!podeGerarMiniatura(mimeType))
        return null;
    try {
        const buffer = await sharp(original, { failOn: 'none' })
            .rotate()
            .resize({ width: LADO_AVATAR, height: LADO_AVATAR, fit: 'cover', position: 'centre' })
            .webp({ quality: 80 })
            .toBuffer();
        return { buffer, mimeType: MIME_MINIATURA, tamanho: buffer.byteLength };
    }
    catch (e) {
        console.error(`[avatar] falhou (${mimeType}): ${e.message}`);
        return null;
    }
}
export async function gerarMiniatura(original, mimeType) {
    if (!podeGerarMiniatura(mimeType))
        return null;
    try {
        const buffer = await sharp(original, { failOn: 'none' })
            .rotate() // respeita o EXIF: foto de celular vem deitada
            .resize({
            width: LADO_MINIATURA,
            height: LADO_MINIATURA,
            fit: 'inside',
            withoutEnlargement: true,
        })
            .webp({ quality: 72 })
            .toBuffer();
        // imagem ja pequena pode gerar "miniatura" maior que o original
        if (buffer.byteLength >= original.byteLength)
            return null;
        return { buffer, mimeType: MIME_MINIATURA, tamanho: buffer.byteLength };
    }
    catch (e) {
        console.error(`[miniatura] falhou (${mimeType}): ${e.message}`);
        return null;
    }
}
//# sourceMappingURL=imagem.js.map