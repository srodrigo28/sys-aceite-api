import { ZodError } from 'zod';
export class ErroApp extends Error {
    status;
    codigo;
    constructor(status, codigo, mensagem) {
        super(mensagem);
        this.status = status;
        this.codigo = codigo;
        this.name = 'ErroApp';
    }
}
export const naoEncontrado = (o = 'Registro') => new ErroApp(404, 'nao_encontrado', `${o} nao encontrado.`);
export const invalido = (m) => new ErroApp(400, 'invalido', m);
export const conflito = (m) => new ErroApp(409, 'conflito', m);
/** Valida com zod e lanca ErroApp 400 com as mensagens de campo. */
export function validar(schema, dados) {
    try {
        return schema.parse(dados);
    }
    catch (e) {
        if (e instanceof ZodError) {
            const detalhe = e.issues.map((i) => `${i.path.join('.') || 'corpo'}: ${i.message}`).join('; ');
            throw new ErroApp(400, 'validacao', detalhe);
        }
        throw e;
    }
}
export async function responderErro(erro, reply) {
    if (erro instanceof ErroApp) {
        await reply.code(erro.status).send({ erro: erro.codigo, mensagem: erro.message });
        return;
    }
    reply.log.error(erro);
    await reply
        .code(500)
        .send({ erro: 'erro_interno', mensagem: 'Algo deu errado. Tente novamente.' });
}
//# sourceMappingURL=http.js.map