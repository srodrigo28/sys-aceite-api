import { and, asc, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { anexos, categorias, checklistItens, comentarios, historico, linksAprovacao, ordensServico, politicasSla, projetos, projetoMembros, usuarios, } from '../db/schema.js';
import { anexoTamanhoMax } from '../env.js';
import { anexoPublico, arquivosDoAnexo, MAX_ANEXOS_POR_OS, responderArquivo, validarArquivo, versaoParaServir, } from '../lib/anexo.js';
import { encolherParaLimite, gerarMiniatura, podeGerarMiniatura } from '../lib/imagem.js';
import { interessadosNaOs, notificar } from '../lib/notificacao.js';
import { autenticar, contexto, garantirAcessoProjeto, projetosVisiveis, } from '../lib/auth.js';
import { apagar, baixar, enviar } from '../lib/bucket.js';
import { invalido, naoEncontrado, validar } from '../lib/http.js';
import { calcularSla } from '../lib/sla.js';
const idParam = z.object({ id: z.string().uuid() });
/** O limite que vale de verdade depende do storage ativo (bucket ou disco). */
function limiteAnexo() {
    const mb = anexoTamanhoMax / 1024 / 1024;
    return mb >= 1 ? `${mb.toFixed(mb % 1 === 0 ? 0 : 1)} MB` : `${Math.round(anexoTamanhoMax / 1024)} KB`;
}
const criarSchema = z.object({
    projetoId: z.string().uuid(),
    tipo: z.enum(['evento', 'tarefa']).default('tarefa'),
    titulo: z.string().min(3, 'Informe um titulo com ao menos 3 caracteres'),
    descricao: z.string().max(20000).nullish(),
    categoriaId: z.string().uuid().nullish(),
    prioridade: z.enum(['critica', 'alta', 'media', 'baixa']).default('media'),
    nivel: z.enum(['n1', 'n2', 'n3']).default('n1'),
    status: z.enum(['a_fazer', 'atendendo', 'pausado', 'em_aprovacao', 'finalizado']).default('a_fazer'),
    responsavelId: z.string().uuid().nullish(),
    solicitante: z.string().max(120).nullish(),
});
const atualizarSchema = criarSchema.partial().omit({ projetoId: true, status: true });
/* ------------------------------------------------------------------ *
 * Transicoes de status: e aqui que os relogios de SLA param e voltam
 * ------------------------------------------------------------------ */
function aplicarTransicao(os, novo, agora) {
    const mudanca = {
        status: novo,
        atualizadoEm: agora,
    };
    // saindo de "pausado": acumula o tempo parado e zera o marcador
    if (os.status === 'pausado' && novo !== 'pausado') {
        const parados = os.pausadaEm ? (agora.getTime() - os.pausadaEm.getTime()) / 60_000 : 0;
        mudanca.minutosPausados = os.minutosPausados + Math.round(parados);
        mudanca.pausadaEm = null;
    }
    if (novo === 'pausado' && os.status !== 'pausado') {
        mudanca.pausadaEm = agora;
    }
    if (novo === 'atendendo' && !os.inicioAtendimentoEm) {
        mudanca.inicioAtendimentoEm = agora;
    }
    if (novo === 'finalizado') {
        mudanca.concluidaEm = os.concluidaEm ?? agora;
    }
    else if (os.status === 'finalizado') {
        // reabertura: o relogio de resolucao volta a correr
        mudanca.concluidaEm = null;
    }
    return mudanca;
}
/** Gera OS-<ano>-<sequencial> por tenant. */
async function gerarCodigo(tenantId) {
    const ano = new Date().getFullYear();
    const prefixo = `OS-${ano}-`;
    const [linha] = await db
        .select({ total: sql `count(*)::int` })
        .from(ordensServico)
        .where(and(eq(ordensServico.tenantId, tenantId), like(ordensServico.codigo, `${prefixo}%`)));
    return `${prefixo}${String((linha?.total ?? 0) + 1).padStart(4, '0')}`;
}
async function registrar(osId, tipo, descricao, autorNome) {
    await db.insert(historico).values({ osId, tipo, descricao, autorNome });
}
/** Carrega a O.S. garantindo que ela pertence ao tenant do usuario. */
/**
 * Ponto unico de acesso a uma O.S.: filtra pelo tenant e, para colaborador,
 * tambem pelo projeto. O.S. de projeto que ele nao participa responde 404,
 * igual a O.S. que nao existe — nao revela que existe.
 */
/**
 * Tira do storage todos os anexos das O.S. informadas. Falha em um arquivo nao
 * interrompe os outros: sobrar arquivo e ruim, mas travar a exclusao e pior.
 */
export async function apagarArquivosDasOs(osIds) {
    if (osIds.length === 0)
        return 0;
    const lista = await db.query.anexos.findMany({ where: inArray(anexos.osId, osIds) });
    let apagados = 0;
    for (const anexo of lista) {
        for (const arquivo of arquivosDoAnexo(anexo)) {
            await apagar(arquivo);
            apagados++;
        }
    }
    return apagados;
}
async function buscarOsVisivel(id, req) {
    const os = await db.query.ordensServico.findFirst({
        where: and(eq(ordensServico.id, id), eq(ordensServico.tenantId, req.user.tenantId)),
    });
    if (!os)
        throw naoEncontrado('O.S.');
    const visiveis = await projetosVisiveis(req);
    if (visiveis !== 'todos' && !visiveis.includes(os.projetoId))
        throw naoEncontrado('O.S.');
    return os;
}
async function validarResponsavel(projetoId, responsavelId, req) {
    if (!responsavelId)
        return;
    const usuario = await db.query.usuarios.findFirst({
        where: and(eq(usuarios.id, responsavelId), eq(usuarios.tenantId, req.user.tenantId), eq(usuarios.ativo, true)),
        columns: { id: true, papel: true },
    });
    if (!usuario)
        throw naoEncontrado('Responsavel');
    if (usuario.papel === 'admin')
        return;
    const membro = await db.query.projetoMembros.findFirst({
        where: and(eq(projetoMembros.projetoId, projetoId), eq(projetoMembros.usuarioId, responsavelId)),
    });
    if (!membro)
        throw invalido('O responsavel precisa participar deste projeto.');
}
export async function rotasOs(app) {
    app.addHook('preHandler', autenticar);
    /** Quadro Kanban de um projeto: todas as O.S. com o SLA ja calculado. */
    app.get('/projetos/:id/os', async (req) => {
        const { id: projetoId } = validar(idParam, req.params);
        const { tenantId } = req.user;
        await garantirAcessoProjeto(req, projetoId);
        const projeto = await db.query.projetos.findFirst({
            where: and(eq(projetos.id, projetoId), eq(projetos.tenantId, tenantId)),
        });
        if (!projeto)
            throw naoEncontrado('Projeto');
        const [lista, politicas, cats] = await Promise.all([
            db.query.ordensServico.findMany({
                where: and(eq(ordensServico.projetoId, projetoId), eq(ordensServico.tenantId, tenantId)),
                orderBy: [asc(ordensServico.ordem), desc(ordensServico.criadoEm)],
            }),
            db.query.politicasSla.findMany({ where: eq(politicasSla.tenantId, tenantId) }),
            db.query.categorias.findMany({ where: eq(categorias.tenantId, tenantId) }),
        ]);
        const agora = new Date();
        return {
            projeto,
            categorias: cats,
            ordens: lista.map((os) => ({ ...os, sla: calcularSla(os, politicas, cats, agora) })),
        };
    });
    app.post('/os', async (req, reply) => {
        const dados = validar(criarSchema, req.body);
        const { tenantId, usuarioId, nome } = contexto(req);
        await garantirAcessoProjeto(req, dados.projetoId);
        const projeto = await db.query.projetos.findFirst({
            where: and(eq(projetos.id, dados.projetoId), eq(projetos.tenantId, tenantId)),
        });
        if (!projeto)
            throw naoEncontrado('Projeto');
        await validarResponsavel(dados.projetoId, dados.responsavelId, req);
        const agora = new Date();
        const [criada] = await db
            .insert(ordensServico)
            .values({
            ...dados,
            tenantId,
            codigo: await gerarCodigo(tenantId),
            abertaEm: agora,
            inicioAtendimentoEm: dados.status === 'atendendo' ? agora : null,
            pausadaEm: dados.status === 'pausado' ? agora : null,
            concluidaEm: dados.status === 'finalizado' ? agora : null,
        })
            .returning();
        if (!criada)
            throw invalido('Nao foi possivel criar a O.S.');
        await registrar(criada.id, 'criacao', `O.S. aberta em ${projeto.nome}`, nome);
        // atividade ja nasce atribuida: avisa quem vai tocar
        if (criada.responsavelId) {
            await notificar({
                tenantId,
                destinatarios: [criada.responsavelId],
                tipo: 'os_atribuida',
                titulo: `Nova atividade: ${criada.titulo}`,
                descricao: `${criada.codigo} em ${projeto.nome}`,
                osId: criada.id,
                projetoId: criada.projetoId,
                autorId: usuarioId,
                autorNome: nome,
            });
        }
        return reply.code(201).send({ os: criada });
    });
    /** Atividades atribuídas ao usuário logado, agrupáveis por status no front. */
    app.get('/os/minhas', async (req) => {
        const { tenantId, usuarioId } = contexto(req);
        const [lista, politicas, cats] = await Promise.all([
            db.query.ordensServico.findMany({
                where: and(eq(ordensServico.tenantId, tenantId), eq(ordensServico.responsavelId, usuarioId)),
                orderBy: [asc(ordensServico.status), asc(ordensServico.ordem), desc(ordensServico.criadoEm)],
            }),
            db.query.politicasSla.findMany({ where: eq(politicasSla.tenantId, tenantId) }),
            db.query.categorias.findMany({ where: eq(categorias.tenantId, tenantId) }),
        ]);
        return { ordens: lista.map((os) => ({ ...os, sla: calcularSla(os, politicas, cats, new Date()) })) };
    });
    /** Detalhe completo: filhos + SLA + links de aprovacao. */
    app.get('/os/:id', async (req) => {
        const { id } = validar(idParam, req.params);
        const { tenantId } = req.user;
        const os = await buscarOsVisivel(id, req);
        const [checklist, arquivos, comentariosOs, eventos, links, politicas, cats] = await Promise.all([
            db.query.checklistItens.findMany({
                where: eq(checklistItens.osId, id),
                orderBy: asc(checklistItens.ordem),
            }),
            db.query.anexos.findMany({ where: eq(anexos.osId, id), orderBy: asc(anexos.criadoEm) }),
            db.query.comentarios.findMany({
                where: eq(comentarios.osId, id),
                orderBy: asc(comentarios.criadoEm),
            }),
            db.query.historico.findMany({
                where: eq(historico.osId, id),
                orderBy: desc(historico.criadoEm),
            }),
            db.query.linksAprovacao.findMany({
                where: eq(linksAprovacao.osId, id),
                orderBy: desc(linksAprovacao.criadoEm),
            }),
            db.query.politicasSla.findMany({ where: eq(politicasSla.tenantId, tenantId) }),
            db.query.categorias.findMany({ where: eq(categorias.tenantId, tenantId) }),
        ]);
        return {
            os: { ...os, sla: calcularSla(os, politicas, cats, new Date()) },
            checklist,
            anexos: arquivos.map(anexoPublico),
            comentarios: comentariosOs,
            historico: eventos,
            links,
        };
    });
    app.patch('/os/:id', async (req) => {
        const { id } = validar(idParam, req.params);
        const dados = validar(atualizarSchema, req.body);
        const { tenantId, usuarioId, nome } = contexto(req);
        const antes = await buscarOsVisivel(id, req);
        if (dados.responsavelId !== undefined && dados.responsavelId !== antes.responsavelId) {
            await validarResponsavel(antes.projetoId, dados.responsavelId, req);
        }
        const [atualizada] = await db
            .update(ordensServico)
            .set({ ...dados, atualizadoEm: new Date() })
            .where(and(eq(ordensServico.id, id), eq(ordensServico.tenantId, tenantId)))
            .returning();
        if (!atualizada)
            throw naoEncontrado('O.S.');
        await registrar(id, 'edicao', 'O.S. atualizada', nome);
        // trocou de dono: quem passou a ser responsavel precisa saber
        if (atualizada.responsavelId && atualizada.responsavelId !== antes.responsavelId) {
            await notificar({
                tenantId,
                destinatarios: [atualizada.responsavelId],
                tipo: 'os_atribuida',
                titulo: `Atividade atribuida a voce: ${atualizada.titulo}`,
                descricao: atualizada.codigo,
                osId: atualizada.id,
                projetoId: atualizada.projetoId,
                autorId: usuarioId,
                autorNome: nome,
            });
        }
        return { os: atualizada };
    });
    /** Movimento do Kanban. Sempre manual — a aprovacao nao move o card sozinha. */
    app.patch('/os/:id/status', async (req) => {
        const { id } = validar(idParam, req.params);
        const { status, ordem } = validar(z.object({
            status: z.enum(['a_fazer', 'atendendo', 'pausado', 'em_aprovacao', 'finalizado']),
            ordem: z.number().int().min(0).optional(),
        }), req.body);
        const { tenantId, usuarioId, nome } = contexto(req);
        const os = await buscarOsVisivel(id, req);
        if (os.status === status && ordem === undefined)
            return { os };
        const agora = new Date();
        const mudanca = aplicarTransicao(os, status, agora);
        if (ordem !== undefined)
            mudanca.ordem = ordem;
        const [atualizada] = await db
            .update(ordensServico)
            .set(mudanca)
            .where(and(eq(ordensServico.id, id), eq(ordensServico.tenantId, tenantId)))
            .returning();
        if (!atualizada)
            throw naoEncontrado('O.S.');
        if (os.status !== status) {
            await registrar(id, 'status', `Movido de ${rotulo(os.status)} para ${rotulo(status)}`, nome);
            // e daqui que sai o aviso do quadro para quem acompanha
            await notificar({
                tenantId,
                destinatarios: await interessadosNaOs(tenantId, atualizada.responsavelId),
                tipo: 'os_status',
                titulo: `${atualizada.codigo} foi para ${rotulo(status)}`,
                descricao: atualizada.titulo,
                osId: atualizada.id,
                projetoId: atualizada.projetoId,
                autorId: usuarioId,
                autorNome: nome,
            });
        }
        return { os: atualizada };
    });
    app.delete('/os/:id', async (req, reply) => {
        const { id } = validar(idParam, req.params);
        await buscarOsVisivel(id, req);
        // o cascade do banco leva as linhas, nao os arquivos: sem isto o bucket
        // acumula anexo de O.S. que nao existe mais, para sempre
        await apagarArquivosDasOs([id]);
        const [removida] = await db
            .delete(ordensServico)
            .where(and(eq(ordensServico.id, id), eq(ordensServico.tenantId, req.user.tenantId)))
            .returning({ id: ordensServico.id });
        if (!removida)
            throw naoEncontrado('O.S.');
        return reply.code(204).send();
    });
    /* ---------------------------- comentarios ---------------------------- */
    app.post('/os/:id/comentarios', async (req, reply) => {
        const { id } = validar(idParam, req.params);
        const { texto, interno } = validar(z.object({ texto: z.string().min(1, 'Escreva algo'), interno: z.boolean().default(false) }), req.body);
        const { tenantId, usuarioId, nome } = contexto(req);
        const os = await buscarOsVisivel(id, req);
        const [criado] = await db
            .insert(comentarios)
            .values({ osId: id, autorId: usuarioId, autorNome: nome, texto, interno })
            .returning();
        // o primeiro comentario publico marca a primeira resposta do SLA
        if (!interno && !os.primeiraRespostaEm) {
            await db
                .update(ordensServico)
                .set({ primeiraRespostaEm: new Date() })
                .where(eq(ordensServico.id, id));
        }
        // comentario interno nao sai do time: nao vira notificacao
        if (!interno) {
            await notificar({
                tenantId,
                destinatarios: await interessadosNaOs(tenantId, os.responsavelId),
                tipo: 'os_comentario',
                titulo: `Novo comentario em ${os.codigo}`,
                descricao: texto.slice(0, 160),
                osId: os.id,
                projetoId: os.projetoId,
                autorId: usuarioId,
                autorNome: nome,
            });
        }
        return reply.code(201).send({ comentario: criado });
    });
    /* ------------------------------ anexos ------------------------------- */
    /** Upload multipart. O arquivo vai para o bucket (ou disco) e so a linha fica no banco. */
    app.post('/os/:id/anexos', async (req, reply) => {
        const { id } = validar(idParam, req.params);
        const { tenantId, usuarioId, nome: autor } = contexto(req);
        // valida a posse ANTES de tocar no storage
        await buscarOsVisivel(id, req);
        const [{ total } = { total: 0 }] = await db
            .select({ total: sql `count(*)::int` })
            .from(anexos)
            .where(eq(anexos.osId, id));
        if (total >= MAX_ANEXOS_POR_OS) {
            throw invalido(`Esta O.S. ja tem ${MAX_ANEXOS_POR_OS} anexos.`);
        }
        const parte = await req.file();
        if (!parte)
            throw invalido('Envie um arquivo no campo "arquivo".');
        let buffer;
        try {
            buffer = await parte.toBuffer();
        }
        catch {
            // estourou o limite do @fastify/multipart
            throw invalido(`Arquivo maior que o limite de ${limiteAnexo()}.`);
        }
        if (parte.file.truncated) {
            throw invalido(`Arquivo maior que o limite de ${limiteAnexo()}.`);
        }
        const validado = validarArquivo(buffer, parte.filename, parte.mimetype);
        let { nome, mimeType } = validado;
        let reduzida = false;
        // Imagem acima do teto do storage: encolhe em vez de recusar. Foto de
        // celular tem 4-8 MB e o bucket corta em ~1 MB — sem isto o caso de uso
        // central (anexar a foto da O.S.) simplesmente nao funciona. Imagem que
        // ja cabe passa intacta; o que nao e imagem continua sendo recusado.
        if (buffer.byteLength > anexoTamanhoMax) {
            if (!podeGerarMiniatura(mimeType)) {
                throw invalido(`O arquivo tem ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB e o limite e ${limiteAnexo()}.`);
            }
            const menor = await encolherParaLimite(buffer, mimeType, anexoTamanhoMax);
            if (!menor) {
                throw invalido(`Nao consegui reduzir esta imagem para caber em ${limiteAnexo()}. Tente uma menor.`);
            }
            buffer = menor.buffer;
            mimeType = menor.mimeType;
            nome = `${nome.replace(/\.[^.]+$/, '')}.webp`;
            reduzida = true;
        }
        const pastaVirtual = `tenants/${tenantId}/os/${id}`;
        const salvo = await enviar({ buffer, nome, mimeType, pastaVirtual });
        // Miniatura e conveniencia: se falhar, o anexo entra sem ela e o proxy
        // serve o original. Nunca derruba o upload.
        let mini = null;
        const geradaMini = await gerarMiniatura(buffer, mimeType);
        if (geradaMini) {
            try {
                const salvoMini = await enviar({
                    buffer: geradaMini.buffer,
                    nome: `mini-${nome.replace(/\.[^.]+$/, '')}.webp`,
                    mimeType: geradaMini.mimeType,
                    pastaVirtual,
                });
                mini = {
                    miniaturaFileId: salvoMini.fileId,
                    miniaturaCaminho: salvoMini.caminho,
                    miniaturaMime: salvoMini.mimeType,
                    miniaturaTamanho: salvoMini.tamanho,
                };
            }
            catch (e) {
                console.error(`[miniatura] upload falhou: ${e.message}`);
            }
        }
        try {
            const [criado] = await db
                .insert(anexos)
                .values({ osId: id, tenantId, nome, enviadoPorId: usuarioId, ...salvo, ...mini })
                .returning();
            if (!criado)
                throw invalido('Nao foi possivel registrar o anexo.');
            await registrar(id, 'anexo', `Anexou ${nome}`, autor);
            return reply.code(201).send({ anexo: anexoPublico(criado), reduzida });
        }
        catch (erro) {
            // nao deixa orfao no bucket se o banco falhar depois do upload
            await apagar(salvo);
            throw erro;
        }
    });
    /**
     * Proxy de download. O cliente nunca recebe a URL do bucket — ela abre sem
     * token, entao entrega-la tornaria o anexo publico para sempre.
     */
    app.get('/anexos/:id/arquivo', async (req, reply) => {
        const { id } = validar(idParam, req.params);
        const { download, miniatura } = validar(z.object({ download: z.string().optional(), miniatura: z.string().optional() }), req.query);
        // filtra pelo tenant do JWT: anexo de outro tenant e 404, nao 403
        const anexo = await db.query.anexos.findFirst({
            where: and(eq(anexos.id, id), eq(anexos.tenantId, req.user.tenantId)),
        });
        if (!anexo)
            throw naoEncontrado('Anexo');
        // e pelo projeto: sem isto, o id do anexo abriria arquivo de projeto alheio
        await buscarOsVisivel(anexo.osId, req);
        const versao = versaoParaServir(anexo, miniatura === '1');
        if (versao.checksum && req.headers['if-none-match'] === `"${versao.checksum}"`) {
            return reply.code(304).send();
        }
        const conteudo = await baixar(versao);
        return responderArquivo(reply, { ...anexo, ...versao }, conteudo, {
            cache: 'private, max-age=3600',
            anexar: download === '1',
        });
    });
    app.delete('/os/:id/anexos/:anexoId', async (req, reply) => {
        const { id, anexoId } = validar(z.object({ id: z.string().uuid(), anexoId: z.string().uuid() }), req.params);
        const { tenantId, nome: autor } = contexto(req);
        await buscarOsVisivel(id, req);
        const anexo = await db.query.anexos.findFirst({
            where: and(eq(anexos.id, anexoId), eq(anexos.osId, id), eq(anexos.tenantId, tenantId)),
        });
        if (!anexo)
            throw naoEncontrado('Anexo');
        // some do storage primeiro; falha la nao trava a remocao da linha
        for (const arquivo of arquivosDoAnexo(anexo))
            await apagar(arquivo);
        await db.delete(anexos).where(eq(anexos.id, anexoId));
        await registrar(id, 'anexo', `Removeu ${anexo.nome}`, autor);
        return reply.code(204).send();
    });
    /* ----------------------------- checklist ----------------------------- */
    app.post('/os/:id/checklist', async (req, reply) => {
        const { id } = validar(idParam, req.params);
        const { texto, ordem } = validar(z.object({ texto: z.string().min(1), ordem: z.number().int().min(0).default(0) }), req.body);
        await buscarOsVisivel(id, req);
        const [criado] = await db.insert(checklistItens).values({ osId: id, texto, ordem }).returning();
        return reply.code(201).send({ item: criado });
    });
    app.patch('/os/:id/checklist/:itemId', async (req) => {
        const { id, itemId } = validar(z.object({ id: z.string().uuid(), itemId: z.string().uuid() }), req.params);
        const dados = validar(z.object({ texto: z.string().min(1).optional(), feito: z.boolean().optional() }), req.body);
        await buscarOsVisivel(id, req);
        const [atualizado] = await db
            .update(checklistItens)
            .set(dados)
            .where(and(eq(checklistItens.id, itemId), eq(checklistItens.osId, id)))
            .returning();
        if (!atualizado)
            throw naoEncontrado('Item');
        return { item: atualizado };
    });
    app.delete('/os/:id/checklist/:itemId', async (req, reply) => {
        const { id, itemId } = validar(z.object({ id: z.string().uuid(), itemId: z.string().uuid() }), req.params);
        await buscarOsVisivel(id, req);
        await db.delete(checklistItens).where(and(eq(checklistItens.id, itemId), eq(checklistItens.osId, id)));
        return reply.code(204).send();
    });
}
function rotulo(status) {
    const mapa = {
        a_fazer: 'A Fazer',
        atendendo: 'Em Atendimento',
        pausado: 'Pausado',
        em_aprovacao: 'Em Aprovacao',
        finalizado: 'Finalizado',
    };
    return mapa[status];
}
//# sourceMappingURL=os.js.map