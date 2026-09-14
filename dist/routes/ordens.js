import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { atividadeResponsaveis, atividades, ordensServico, projetos, usuarios } from '../db/schema.js';
import { autenticar, projetosVisiveis, somenteAdmin } from '../lib/auth.js';
import { doc } from '../lib/doc.js';
import { invalido, naoEncontrado, validar } from '../lib/http.js';
import { totaisDaOs } from '../lib/ordem.js';
const idParam = z.object({ id: z.string().uuid() });
const PASSOS = ['aberta', 'em_execucao', 'em_revisao', 'aprovada', 'finalizada'];
/** A data que cada passo carimba ao ser atingido. */
const CARIMBO = {
    aberta: 'abertaEm',
    em_execucao: 'execucaoEm',
    em_revisao: 'revisaoEm',
    aprovada: 'aprovadaEm',
    finalizada: 'finalizadaEm',
};
const totaisSchema = z.object({
    atividades: z.number().int(),
    concluidas: z.number().int(),
    faturaveis: z.number().int().describe('Concluidas E aprovadas — o numero da fatura'),
    emAtraso: z.number().int(),
    minutosEstimados: z.number().int(),
    minutosApontados: z.number().int(),
    minutosConcluidos: z.number().int(),
    minutosFaturaveis: z.number().int(),
});
const ordemSchema = z.object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    projetoId: z.string().uuid(),
    codigo: z.string(),
    ano: z.number().int(),
    mes: z.number().int(),
    status: z.enum(PASSOS),
    responsavelId: z.string().uuid().nullable(),
    observacao: z.string().nullable(),
    abertaEm: z.string(),
    execucaoEm: z.string().nullable(),
    revisaoEm: z.string().nullable(),
    aprovadaEm: z.string().nullable(),
    finalizadaEm: z.string().nullable(),
    criadoEm: z.string(),
    atualizadoEm: z.string(),
    projetoNome: z.string().optional(),
    empresa: z.string().optional().describe('O cliente do projeto — vem junto, nao se escolhe'),
    totais: totaisSchema.optional(),
});
const atualizarSchema = z.object({
    status: z.enum(PASSOS).optional(),
    responsavelId: z.string().uuid().nullable().optional(),
    observacao: z.string().max(2000).nullable().optional(),
});
export async function rotasOrdens(app) {
    app.addHook('preHandler', autenticar);
    /**
     * As O.S. que a pessoa enxerga, da mais recente para a mais antiga.
     *
     * Cada uma ja vem com os totais: a lista existe para decidir qual abrir, e
     * sem as horas essa decisao nao da para tomar.
     */
    app.get('/ordens', {
        schema: doc({
            tag: 'Ordens de servico',
            resumo: 'As O.S. do workspace, com os totais de cada uma',
            descricao: 'Uma O.S. por projeto por mes. Ela **nasce sozinha** na primeira atividade do mes — ' +
                'nao ha rota de criacao, e nao se escolhe O.S. em formulario. ' +
                'Colaborador so ve as O.S. dos projetos em que participa.',
            ok: { schema: z.object({ ordens: z.array(ordemSchema) }) },
        }),
    }, async (req) => {
        const { tenantId } = req.user;
        const visiveis = await projetosVisiveis(req);
        if (visiveis !== 'todos' && visiveis.length === 0)
            return { ordens: [] };
        const lista = await db
            .select({
            ordem: ordensServico,
            projetoNome: projetos.nome,
            empresa: projetos.cliente,
        })
            .from(ordensServico)
            .innerJoin(projetos, eq(projetos.id, ordensServico.projetoId))
            .where(visiveis === 'todos'
            ? eq(ordensServico.tenantId, tenantId)
            : and(eq(ordensServico.tenantId, tenantId), inArray(ordensServico.projetoId, visiveis)))
            .orderBy(desc(ordensServico.ano), desc(ordensServico.mes), asc(projetos.nome));
        return {
            ordens: await Promise.all(lista.map(async (l) => ({
                ...l.ordem,
                projetoNome: l.projetoNome,
                empresa: l.empresa,
                totais: await totaisDaOs(l.ordem.id),
            }))),
        };
    });
    /** Uma O.S. com as atividades dela. E a tela "Fluxo de Execucao". */
    app.get('/ordens/:id', {
        schema: doc({
            tag: 'Ordens de servico',
            resumo: 'Uma O.S. com suas atividades e totais',
            descricao: 'Alimenta a tela de fluxo de execucao: o stepper, os indicadores, o mapa de ' +
                'colaboradores e a tabela de atividades saem todos daqui.',
            params: idParam,
            ok: {
                schema: z.object({
                    ordem: ordemSchema,
                    atividades: z.array(z.record(z.string(), z.unknown())),
                    responsaveis: z.record(z.string(), z.array(z.string().uuid())),
                }),
            },
        }),
    }, async (req) => {
        const { id } = validar(idParam, req.params);
        const ordem = await buscarVisivel(id, req);
        const lista = await db.query.atividades.findMany({
            where: eq(atividades.osId, id),
            orderBy: [asc(atividades.previstoInicioEm), asc(atividades.criadoEm)],
        });
        const projeto = await db.query.projetos.findFirst({
            where: eq(projetos.id, ordem.projetoId),
            columns: { nome: true, cliente: true },
        });
        // quem responde por cada atividade, num mapa: o mapa de colaboradores da
        // tela precisa saber em quais linhas cada atividade aparece
        const vinculos = lista.length
            ? await db
                .select({
                atividadeId: atividadeResponsaveis.atividadeId,
                usuarioId: atividadeResponsaveis.usuarioId,
                principal: atividadeResponsaveis.principal,
            })
                .from(atividadeResponsaveis)
                .where(inArray(atividadeResponsaveis.atividadeId, lista.map((a) => a.id)))
            : [];
        const responsaveis = {};
        // principal primeiro: o front usa o [0] onde so cabe um nome
        for (const v of vinculos.sort((a, b) => Number(b.principal) - Number(a.principal))) {
            responsaveis[v.atividadeId] = [...(responsaveis[v.atividadeId] ?? []), v.usuarioId];
        }
        return {
            ordem: {
                ...ordem,
                projetoNome: projeto?.nome,
                empresa: projeto?.cliente,
                totais: await totaisDaOs(id),
            },
            atividades: lista,
            responsaveis,
        };
    });
    /**
     * Avanca o passo, troca o responsavel ou anota uma observacao.
     *
     * Decisao 14: **so administrador move a O.S. de passo.** Para colaborador o
     * stepper e leitura.
     */
    app.patch('/ordens/:id', {
        preHandler: somenteAdmin,
        schema: doc({
            tag: 'Ordens de servico',
            resumo: 'Avanca o passo, troca o responsavel ou anota (admin)',
            descricao: 'O passo so anda **para frente e de um em um**: pular de `aberta` para `aprovada` da 400. ' +
                'Um fluxo que aceita salto nao e fluxo, e um campo de texto com cara de fluxo — e a data ' +
                'dos passos pulados ficaria vazia para sempre. ' +
                'Cada avanco carimba a data do passo alcancado.',
            params: idParam,
            body: atualizarSchema,
            ok: { schema: z.object({ ordem: ordemSchema }) },
            erros: [403],
        }),
    }, async (req) => {
        const { id } = validar(idParam, req.params);
        const dados = validar(atualizarSchema, req.body);
        const antes = await buscarVisivel(id, req);
        const campos = { atualizadoEm: new Date() };
        if (dados.status && dados.status !== antes.status) {
            const de = PASSOS.indexOf(antes.status);
            const para = PASSOS.indexOf(dados.status);
            if (para < de)
                throw invalido('A O.S. nao volta de passo.');
            if (para > de + 1)
                throw invalido('O passo anda de um em um.');
            campos.status = dados.status;
            campos[CARIMBO[dados.status]] = new Date();
        }
        if (dados.responsavelId !== undefined) {
            if (dados.responsavelId) {
                const pessoa = await db.query.usuarios.findFirst({
                    where: and(eq(usuarios.id, dados.responsavelId), eq(usuarios.tenantId, req.user.tenantId), eq(usuarios.ativo, true)),
                    columns: { id: true },
                });
                if (!pessoa)
                    throw naoEncontrado('Responsavel');
            }
            campos.responsavelId = dados.responsavelId;
        }
        if (dados.observacao !== undefined)
            campos.observacao = dados.observacao;
        const [atualizada] = await db
            .update(ordensServico)
            .set(campos)
            .where(eq(ordensServico.id, id))
            .returning();
        if (!atualizada)
            throw naoEncontrado('O.S.');
        return { ordem: { ...atualizada, totais: await totaisDaOs(id) } };
    });
}
/** A O.S. existe, e do tenant, e o projeto dela e visivel para quem pergunta. */
async function buscarVisivel(id, req) {
    const ordem = await db.query.ordensServico.findFirst({
        where: and(eq(ordensServico.id, id), eq(ordensServico.tenantId, req.user.tenantId)),
    });
    if (!ordem)
        throw naoEncontrado('O.S.');
    const visiveis = await projetosVisiveis(req);
    if (visiveis !== 'todos' && !visiveis.includes(ordem.projetoId))
        throw naoEncontrado('O.S.');
    return ordem;
}
//# sourceMappingURL=ordens.js.map