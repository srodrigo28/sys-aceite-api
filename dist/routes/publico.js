import bcrypt from 'bcryptjs';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { anexos, categorias, comentarios, convites, conviteProjetos, historico, linksAprovacao, atividades, politicasSla, projetoMembros, projetos, tenants, usuarios, } from '../db/schema.js';
import { ehImagem, responderArquivo, versaoParaServir } from '../lib/anexo.js';
import { baixar } from '../lib/bucket.js';
import { doc } from '../lib/doc.js';
import { sessaoSchema, slaSchema } from '../lib/esquemas.js';
import { conflito, invalido, naoEncontrado, validar } from '../lib/http.js';
import { interessadosNaOs, notificar } from '../lib/notificacao.js';
import { estadoEfetivoConvite } from './equipe.js';
import { calcularSla } from '../lib/sla.js';
const tokenParam = z.object({ token: z.string().min(10).max(64) });
const decidirSchema = z
    .object({
    decisao: z.enum(['aprovado', 'ajustes']),
    observacao: z.string().max(4000).default(''),
    aprovadorNome: z.string().min(2, 'Informe seu nome'),
    aprovadorEmail: z.string().email('E-mail invalido').or(z.literal('')).nullish(),
    ciente: z.literal(true, { message: 'Confirme que revisou o conteudo' }),
})
    .refine((d) => d.decisao === 'aprovado' || d.observacao.trim().length >= 10, {
    path: ['observacao'],
    message: 'Descreva o ajuste necessario (minimo 10 caracteres)',
});
const aceitarConviteSchema = z
    .object({
    nome: z.string().min(2, 'Informe seu nome'),
    senha: z.string().min(8, 'A senha precisa ter ao menos 8 caracteres'),
    confirmacao: z.string().optional(),
    ciente: z.literal(true, { message: 'Confirme que aceita o convite' }),
})
    .refine((d) => d.confirmacao === undefined || d.confirmacao === d.senha, {
    path: ['confirmacao'],
    message: 'As senhas nao conferem',
});
const anexoParam = z.object({ token: z.string().min(10).max(64), anexoId: z.string().uuid() });
const miniaturaQuery = z.object({
    miniatura: z.string().optional().describe('1 serve a miniatura webp, que e o que a grade usa'),
});
/**
 * O que o aprovador ve. Cada bloco opcional obedece a uma chave do link:
 * `mostrarDatas`, `mostrarSla` e `mostrarAnexos`. Desligado vira `null` ou
 * lista vazia — nao vem escondido no corpo esperando o front nao mostrar.
 */
const paginaAprovacaoSchema = z.object({
    estado: z.enum(['pendente', 'aprovado', 'ajustes', 'expirado', 'revogado']),
    link: z.object({
        mensagem: z.string().nullable(),
        expiraEm: z.string().nullable(),
        mostrarAnexos: z.boolean(),
        mostrarDatas: z.boolean(),
        mostrarSla: z.boolean(),
        aprovadorNomeSugerido: z.string().nullable(),
        aprovadorEmailSugerido: z.string().nullable(),
    }),
    parecer: z
        .object({
        decisao: z.enum(['aprovado', 'ajustes']),
        observacao: z.string().nullable(),
        aprovadorNome: z.string().nullable(),
        decididoEm: z.string(),
    })
        .nullable()
        .describe('Preenchido depois que alguem decidiu; e o que a tela de somente-leitura mostra'),
    os: z.object({
        codigo: z.string(),
        titulo: z.string(),
        descricao: z.string().nullable(),
        prioridade: z.enum(['critica', 'alta', 'media', 'baixa']),
        tipo: z.enum(['evento', 'tarefa']),
        categoria: z.object({ nome: z.string(), cor: z.string() }).nullable(),
        datas: z
            .object({
            abertaEm: z.string(),
            inicioAtendimentoEm: z.string().nullable(),
            concluidaEm: z.string().nullable(),
        })
            .nullable(),
        sla: slaSchema.nullable(),
        anexos: z.array(z.object({
            id: z.string().uuid(),
            nome: z.string(),
            mimeType: z.string(),
            tamanho: z.number().int(),
            ehImagem: z.boolean(),
            urlArquivo: z.string().describe('Caminho escopado neste token, nao a URL do bucket'),
            urlMiniatura: z.string().nullable(),
        })),
    }),
    projeto: z.object({ nome: z.string(), cliente: z.string(), cor: z.string() }).nullable(),
    organizacao: z.object({ nome: z.string() }).nullable(),
});
const pareceRegistradoSchema = z.object({
    ok: z.boolean(),
    estado: z.enum(['aprovado', 'ajustes']),
    mensagem: z.string().describe('Texto pronto para a tela de confirmacao'),
});
const paginaConviteSchema = z.object({
    estado: z.enum(['pendente', 'aceito', 'expirado', 'revogado']),
    convite: z.object({
        nome: z.string(),
        email: z.string().email(),
        papel: z.enum(['admin', 'membro']),
        cargo: z.string().nullable(),
        mensagem: z.string().nullable(),
        expiraEm: z.string().nullable(),
        convidadoPor: z.string().nullable(),
    }),
    organizacao: z.object({ nome: z.string() }).nullable(),
    projetos: z.array(z.object({ nome: z.string(), cor: z.string() })),
});
/** Expiracao e avaliada na leitura: link vencido vira 'expirado'. */
function estadoEfetivo(link, agora = new Date()) {
    if (link.estado === 'pendente' && link.expiraEm && link.expiraEm <= agora)
        return 'expirado';
    return link.estado;
}
function ipDe(req) {
    const encaminhado = req.headers['x-forwarded-for'];
    if (typeof encaminhado === 'string')
        return encaminhado.split(',')[0]?.trim() ?? req.ip;
    return req.ip;
}
export async function rotasPublicas(app) {
    /**
     * Pagina de aprovacao. Sem login: o segredo e o proprio token.
     * Devolve apenas o que o link autoriza — comentario interno nunca sai daqui.
     */
    app.get('/publico/aprovacao/:token', {
        schema: doc({
            tag: 'Publico',
            resumo: 'Abre a pagina de aprovacao — sem login e sem conta',
            descricao: 'O token da URL **e** a credencial: nao ha cabecalho de autorizacao aqui. Devolve so o ' +
                'que o link autorizou, e a filtragem acontece no servidor: bloco desligado volta `null` ' +
                'ou vazio, nunca escondido no corpo. **Comentario interno jamais sai por aqui.** ' +
                'Link vencido nao precisa de rotina para virar `expirado`: o estado e calculado na ' +
                'leitura. Token invalido responde 404, igual a token inexistente.',
            publico: true,
            params: tokenParam,
            ok: { schema: paginaAprovacaoSchema },
        }),
    }, async (req) => {
        const { token } = validar(tokenParam, req.params);
        const link = await db.query.linksAprovacao.findFirst({
            where: eq(linksAprovacao.token, token),
        });
        if (!link)
            throw naoEncontrado('Link de aprovacao');
        const estado = estadoEfetivo(link);
        const os = await db.query.atividades.findFirst({ where: eq(atividades.id, link.osId) });
        if (!os)
            throw naoEncontrado('O.S.');
        const [projeto, tenant, categoria] = await Promise.all([
            db.query.projetos.findFirst({ where: eq(projetos.id, os.projetoId) }),
            db.query.tenants.findFirst({ where: eq(tenants.id, link.tenantId) }),
            os.categoriaId
                ? db.query.categorias.findFirst({ where: eq(categorias.id, os.categoriaId) })
                : Promise.resolve(undefined),
        ]);
        const arquivos = link.mostrarAnexos
            ? await db.query.anexos.findMany({ where: eq(anexos.osId, os.id), orderBy: asc(anexos.criadoEm) })
            : [];
        let sla = null;
        if (link.mostrarSla) {
            const [politicas, cats] = await Promise.all([
                db.query.politicasSla.findMany({ where: eq(politicasSla.tenantId, link.tenantId) }),
                db.query.categorias.findMany({ where: eq(categorias.tenantId, link.tenantId) }),
            ]);
            sla = calcularSla(os, politicas, cats, new Date());
        }
        return {
            estado,
            link: {
                mensagem: link.mensagem,
                expiraEm: link.expiraEm,
                mostrarAnexos: link.mostrarAnexos,
                mostrarDatas: link.mostrarDatas,
                mostrarSla: link.mostrarSla,
                aprovadorNomeSugerido: link.aprovadorNomeSugerido,
                aprovadorEmailSugerido: link.aprovadorEmailSugerido,
            },
            parecer: link.decisao && link.decididoEm
                ? {
                    decisao: link.decisao,
                    observacao: link.observacao,
                    aprovadorNome: link.aprovadorNome,
                    decididoEm: link.decididoEm,
                }
                : null,
            os: {
                codigo: os.codigo,
                titulo: os.titulo,
                descricao: os.descricao,
                prioridade: os.prioridade,
                tipo: os.tipo,
                categoria: categoria ? { nome: categoria.nome, cor: categoria.cor } : null,
                datas: link.mostrarDatas
                    ? { abertaEm: os.abertaEm, inicioAtendimentoEm: os.inicioAtendimentoEm, concluidaEm: os.concluidaEm }
                    : null,
                sla,
                // sem URL do bucket: o arquivo vem pela rota abaixo, escopada no token
                anexos: arquivos.map((a) => ({
                    id: a.id,
                    nome: a.nome,
                    mimeType: a.mimeType,
                    tamanho: a.tamanho,
                    ehImagem: ehImagem(a.mimeType),
                    urlArquivo: `/publico/aprovacao/${token}/anexos/${a.id}`,
                    // a grade usa esta; o original so quando a pessoa amplia
                    urlMiniatura: a.miniaturaCaminho
                        ? `/publico/aprovacao/${token}/anexos/${a.id}?miniatura=1`
                        : null,
                })),
            },
            projeto: projeto ? { nome: projeto.nome, cliente: projeto.cliente, cor: projeto.cor } : null,
            organizacao: tenant ? { nome: tenant.nome } : null,
        };
    });
    /**
     * Arquivo do anexo para quem abriu o link — sem login.
     * Quatro checagens, e qualquer falha vira 404 (nunca confirmar que o id existe):
     *   1. o link existe
     *   2. o estado ainda serve conteudo (expirado e revogado NAO servem)
     *   3. o link autoriza ver anexos
     *   4. o anexo pertence a O.S. daquele link
     */
    app.get('/publico/aprovacao/:token/anexos/:anexoId', {
        schema: doc({
            tag: 'Publico',
            resumo: 'Baixa um anexo pelo link de aprovacao — sem login',
            descricao: 'Quatro checagens, e qualquer falha vira **404**, nunca 403: o link existe; o estado ' +
                'ainda serve conteudo (expirado e revogado nao servem); o link tem `mostrarAnexos`; e o ' +
                'anexo pertence aquela O.S. Um 403 ja confirmaria que o arquivo existe. ' +
                'A miniatura importa mais aqui do que em qualquer outro lugar: o cliente decide pelo ' +
                'celular, muitas vezes no 4G.',
            publico: true,
            params: anexoParam,
            query: miniaturaQuery,
            binario: { descricao: 'O arquivo, com o content-type real' },
        }),
    }, async (req, reply) => {
        const { token, anexoId } = validar(anexoParam, req.params);
        // e aqui que a miniatura mais importa: o cliente decide pelo celular
        const { miniatura } = validar(miniaturaQuery, req.query);
        const link = await db.query.linksAprovacao.findFirst({
            where: eq(linksAprovacao.token, token),
        });
        if (!link)
            throw naoEncontrado('Arquivo');
        const estado = estadoEfetivo(link);
        if (estado === 'expirado' || estado === 'revogado')
            throw naoEncontrado('Arquivo');
        if (!link.mostrarAnexos)
            throw naoEncontrado('Arquivo');
        const anexo = await db.query.anexos.findFirst({
            where: and(eq(anexos.id, anexoId), eq(anexos.osId, link.osId)),
        });
        if (!anexo)
            throw naoEncontrado('Arquivo');
        const versao = versaoParaServir(anexo, miniatura === '1');
        if (versao.checksum && req.headers['if-none-match'] === `"${versao.checksum}"`) {
            return reply.code(304).send();
        }
        const conteudo = await baixar(versao);
        // pagina publica: nada de cache compartilhado
        return responderArquivo(reply, anexo, conteudo, { cache: 'private, no-store' });
    });
    /** Registra o parecer. O card e marcado, mas NAO muda de coluna sozinho. */
    app.post('/publico/aprovacao/:token', {
        config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
        schema: doc({
            tag: 'Publico',
            resumo: 'Registra o parecer do aprovador — sem login',
            descricao: 'Em `ajustes` a observacao e obrigatoria e precisa de ao menos 10 caracteres: "nao gostei" ' +
                'nao e um pedido de ajuste acionavel. `ciente` tem de vir `true` — e a confirmacao de ' +
                'leitura que fica registrada. A gravacao usa trava otimista no estado `pendente`, entao ' +
                'dois cliques simultaneos nao geram dois pareceres; o segundo recebe 400. ' +
                '**O card nao muda de coluna:** o parecer marca a O.S., vira comentario publico e entra ' +
                'no historico, mas o Kanban continua sendo movido a mao. ' +
                'Depois disso o link fica somente leitura. Limite de 20 por hora por IP.',
            publico: true,
            params: tokenParam,
            body: decidirSchema,
            ok: { status: 201, schema: pareceRegistradoSchema, descricao: 'Parecer registrado' },
            erros: [429],
        }),
    }, async (req, reply) => {
        const { token } = validar(tokenParam, req.params);
        const dados = validar(decidirSchema, req.body);
        const link = await db.query.linksAprovacao.findFirst({
            where: eq(linksAprovacao.token, token),
        });
        if (!link)
            throw naoEncontrado('Link de aprovacao');
        const estado = estadoEfetivo(link);
        if (estado === 'expirado')
            throw invalido('Este link expirou. Peca um novo ao responsavel.');
        if (estado === 'revogado')
            throw invalido('Este link foi cancelado pelo responsavel.');
        if (estado !== 'pendente')
            throw invalido('Este link ja recebeu um parecer.');
        const agora = new Date();
        const aprovado = dados.decisao === 'aprovado';
        const observacao = dados.observacao.trim();
        const atualizado = await db.transaction(async (tx) => {
            // trava otimista: so grava se ainda estiver pendente
            const [gravado] = await tx
                .update(linksAprovacao)
                .set({
                estado: aprovado ? 'aprovado' : 'ajustes',
                decisao: dados.decisao,
                observacao: observacao || null,
                aprovadorNome: dados.aprovadorNome.trim(),
                aprovadorEmail: dados.aprovadorEmail || null,
                decididoEm: agora,
                ipDecisao: ipDe(req),
            })
                .where(and(eq(linksAprovacao.id, link.id), eq(linksAprovacao.estado, 'pendente')))
                .returning();
            if (!gravado)
                throw invalido('Este link ja recebeu um parecer.');
            await tx
                .update(atividades)
                .set({
                aprovado,
                aprovadorNome: dados.aprovadorNome.trim(),
                aprovacaoObservacao: observacao || null,
                aprovadoEm: agora,
                atualizadoEm: agora,
            })
                .where(eq(atividades.id, link.osId));
            if (observacao) {
                await tx.insert(comentarios).values({
                    osId: link.osId,
                    autorNome: `${dados.aprovadorNome.trim()} (aprovador)`,
                    texto: observacao,
                    interno: false,
                });
            }
            await tx.insert(historico).values({
                osId: link.osId,
                tipo: 'aprovacao',
                descricao: aprovado
                    ? `Aprovado por ${dados.aprovadorNome.trim()}`
                    : `Ajustes solicitados por ${dados.aprovadorNome.trim()}`,
                autorNome: dados.aprovadorNome.trim(),
            });
            return gravado;
        });
        // quem aprova nao e usuario do sistema: autorId fica null e o nome vai
        // como texto, para o sino mostrar quem decidiu
        const osDoLink = await db.query.atividades.findFirst({
            where: eq(atividades.id, link.osId),
        });
        if (osDoLink) {
            await notificar({
                tenantId: osDoLink.tenantId,
                destinatarios: await interessadosNaOs(osDoLink.tenantId, osDoLink.responsavelId),
                tipo: 'os_parecer',
                titulo: aprovado
                    ? `${osDoLink.codigo} aprovada pelo cliente`
                    : `${osDoLink.codigo}: cliente pediu ajustes`,
                descricao: observacao ? observacao.slice(0, 160) : osDoLink.titulo,
                osId: osDoLink.id,
                projetoId: osDoLink.projetoId,
                autorId: null,
                autorNome: dados.aprovadorNome.trim(),
            });
        }
        return reply.code(201).send({
            ok: true,
            estado: atualizado.estado,
            mensagem: aprovado
                ? 'Aprovacao registrada. Obrigado!'
                : 'Solicitacao de ajustes registrada. Obrigado!',
        });
    });
    /* ------------------------------------------------------------------ *
     * Convite de equipe — sem login, so o token secreto
     * ------------------------------------------------------------------ */
    /** O que a pessoa convidada ve antes de aceitar. Nada alem disto. */
    app.get('/publico/convite/:token', {
        config: { rateLimit: { max: 60, timeWindow: '15 minutes' } },
        schema: doc({
            tag: 'Publico',
            resumo: 'O que a pessoa convidada ve antes de aceitar',
            descricao: 'Organizacao, quem convidou, papel oferecido e os projetos prometidos. Nada alem disso: ' +
                'quem ainda nao aceitou nao e do time.',
            publico: true,
            params: tokenParam,
            ok: { schema: paginaConviteSchema },
            erros: [429],
        }),
    }, async (req) => {
        const { token } = validar(tokenParam, req.params);
        const convite = await db.query.convites.findFirst({ where: eq(convites.token, token) });
        if (!convite)
            throw naoEncontrado('Convite');
        const estado = estadoEfetivoConvite(convite);
        const organizacao = await db.query.tenants.findFirst({
            where: eq(tenants.id, convite.tenantId),
        });
        const nomesProjetos = await db
            .select({ nome: projetos.nome, cor: projetos.cor })
            .from(conviteProjetos)
            .innerJoin(projetos, eq(projetos.id, conviteProjetos.projetoId))
            .where(eq(conviteProjetos.conviteId, convite.id));
        let convidadoPor = null;
        if (convite.convidadoPorId) {
            const autor = await db.query.usuarios.findFirst({
                where: eq(usuarios.id, convite.convidadoPorId),
                columns: { nome: true },
            });
            convidadoPor = autor?.nome ?? null;
        }
        return {
            estado,
            convite: {
                nome: convite.nome,
                email: convite.email,
                papel: convite.papel,
                cargo: convite.cargo,
                mensagem: convite.mensagem,
                expiraEm: convite.expiraEm,
                convidadoPor,
            },
            organizacao: organizacao ? { nome: organizacao.nome } : null,
            projetos: nomesProjetos,
        };
    });
    /** Aceite: cria a conta, entra nos projetos e devolve o JWT ja logado. */
    app.post('/publico/convite/:token', {
        config: { rateLimit: { max: 15, timeWindow: '1 hour' } },
        schema: doc({
            tag: 'Publico',
            resumo: 'Aceita o convite, cria a conta e ja devolve a sessao',
            descricao: 'A linha em `usuarios` so nasce aqui — o convite nao cria usuario antes, porque conta sem ' +
                'senha vira zumbi no login. No aceite a pessoa entra nos projetos prometidos e quem ' +
                'convidou recebe notificacao. Convite ja aceito, expirado ou revogado da 400 com a ' +
                'mensagem certa para a tela. Limite de 15 por hora por IP.',
            publico: true,
            params: tokenParam,
            body: aceitarConviteSchema,
            ok: { status: 201, schema: sessaoSchema, descricao: 'Conta criada e sessao aberta' },
            erros: [409, 429],
        }),
    }, async (req, reply) => {
        const { token } = validar(tokenParam, req.params);
        const dados = validar(aceitarConviteSchema, req.body);
        const convite = await db.query.convites.findFirst({ where: eq(convites.token, token) });
        if (!convite)
            throw naoEncontrado('Convite');
        const estado = estadoEfetivoConvite(convite);
        if (estado !== 'pendente') {
            throw invalido(estado === 'aceito'
                ? 'Este convite ja foi aceito. Faca login com sua senha.'
                : estado === 'expirado'
                    ? 'Este convite expirou. Peca um novo ao administrador.'
                    : 'Este convite foi revogado.');
        }
        const senhaHash = await bcrypt.hash(dados.senha, 10);
        const criado = await db.transaction(async (tx) => {
            // trava contra uso duplo: so segue se ainda estava pendente
            const [travado] = await tx
                .update(convites)
                .set({ estado: 'aceito', aceitoEm: new Date() })
                .where(and(eq(convites.id, convite.id), eq(convites.estado, 'pendente')))
                .returning();
            if (!travado)
                throw conflito('Este convite ja foi usado.');
            // o e-mail pode ter sido cadastrado entre o convite e o aceite
            const ocupado = await tx.query.usuarios.findFirst({
                where: eq(usuarios.email, convite.email),
            });
            if (ocupado)
                throw conflito('Ja existe uma conta com este e-mail.');
            const [usuario] = await tx
                .insert(usuarios)
                .values({
                tenantId: convite.tenantId,
                nome: dados.nome.trim(),
                email: convite.email,
                senhaHash,
                cargo: convite.cargo,
                papel: convite.papel,
            })
                .returning();
            if (!usuario)
                throw invalido('Nao foi possivel criar a conta.');
            const vinculos = await tx
                .select({ projetoId: conviteProjetos.projetoId })
                .from(conviteProjetos)
                .where(eq(conviteProjetos.conviteId, convite.id));
            if (vinculos.length > 0) {
                await tx
                    .insert(projetoMembros)
                    .values(vinculos.map((v) => ({ projetoId: v.projetoId, usuarioId: usuario.id })))
                    .onConflictDoNothing();
            }
            await tx.update(convites).set({ usuarioId: usuario.id }).where(eq(convites.id, convite.id));
            return usuario;
        });
        const organizacao = await db.query.tenants.findFirst({
            where: eq(tenants.id, criado.tenantId),
        });
        // quem convidou fica sabendo que a pessoa entrou
        await notificar({
            tenantId: criado.tenantId,
            destinatarios: [convite.convidadoPorId],
            tipo: 'convite_aceito',
            titulo: `${criado.nome} aceitou o convite`,
            descricao: criado.email,
            autorId: criado.id,
            autorNome: criado.nome,
        });
        const jwt = app.jwt.sign({
            sub: criado.id,
            tenantId: criado.tenantId,
            nome: criado.nome,
            email: criado.email,
            papel: criado.papel,
        });
        const { senhaHash: _senha, ...publico } = criado;
        return reply.code(201).send({
            token: jwt,
            usuario: publico,
            tenant: organizacao
                ? { id: organizacao.id, nome: organizacao.nome, slug: organizacao.slug }
                : null,
        });
    });
}
//# sourceMappingURL=publico.js.map