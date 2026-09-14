import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db, fecharConexao } from './client.js';
import { categorias, comentarios, historico, atividades, politicasSla, projetoMembros, projetos, tenants, usuarios, } from './schema.js';
import { SLA_PADRAO } from '../lib/sla.js';
const SLUG_DEMO = 'estudio-demo';
const EMAIL_DEMO = 'demo@sysaceite.dev';
const SENHA_DEMO = 'demo12345';
const MIN = 60_000;
const CATEGORIAS = [
    { nome: 'Desenvolvimento', cor: '#6366f1', multiplicadorSla: 1 },
    { nome: 'Design', cor: '#ec4899', multiplicadorSla: 1 },
    { nome: 'Infraestrutura', cor: '#f97316', multiplicadorSla: 1.5 },
    { nome: 'Suporte', cor: '#0ea5e9', multiplicadorSla: 0.5 },
    { nome: 'Conteudo', cor: '#14b8a6', multiplicadorSla: 1 },
    { nome: 'Comercial', cor: '#a855f7', multiplicadorSla: 2 },
];
const EQUIPE = [
    { nome: 'Ana Ribeiro', email: 'ana@sysaceite.dev', cargo: 'Gerente de projetos' },
    { nome: 'Bruno Tavares', email: 'bruno@sysaceite.dev', cargo: 'Desenvolvedor' },
    { nome: 'Carla Menezes', email: 'carla@sysaceite.dev', cargo: 'Designer' },
    { nome: 'Diego Alves', email: 'diego@sysaceite.dev', cargo: 'Infraestrutura' },
];
/** indices de EQUIPE que participam de cada projeto, na ordem de PROJETOS */
const MEMBROS_POR_PROJETO = [
    [0, 1], // Site institucional: Ana e Bruno
    [0, 1, 3], // App de pedidos: Ana, Bruno e Diego
    [0, 2], // Campanha de setembro: Ana e Carla
];
const PROJETOS = [
    { nome: 'Site institucional', cliente: 'Padaria do Ze', cor: '#6366f1' },
    { nome: 'App de pedidos', cliente: 'Rede Bom Prato', cor: '#0ea5e9' },
    { nome: 'Campanha de setembro', cliente: 'Otica Visao', cor: '#ec4899' },
];
/** titulo, categoria, prioridade, nivel, status, horas desde a abertura */
const MODELOS = [
    ['Publicar nova home com o banner de setembro', 'Desenvolvimento', 'alta', 'n2', 'a_fazer', 1, 'tarefa'],
    ['Corrigir formulario de contato no mobile', 'Desenvolvimento', 'critica', 'n1', 'atendendo', 3, 'tarefa'],
    ['Trocar fotos da galeria de produtos', 'Design', 'media', 'n1', 'a_fazer', 6, 'tarefa'],
    ['Certificado SSL vencendo em 5 dias', 'Infraestrutura', 'critica', 'n3', 'atendendo', 5, 'tarefa'],
    ['Revisar textos da pagina Sobre', 'Conteudo', 'baixa', 'n1', 'em_aprovacao', 20, 'tarefa'],
    ['Reuniao de alinhamento quinzenal', 'Comercial', 'baixa', 'n1', 'finalizado', 72, 'evento'],
    ['Migrar hospedagem para o novo servidor', 'Infraestrutura', 'alta', 'n3', 'pausado', 30, 'tarefa'],
    ['Ajustar carrinho: frete nao calcula', 'Desenvolvimento', 'critica', 'n2', 'atendendo', 9, 'tarefa'],
    ['Criar 6 artes para o Instagram', 'Design', 'media', 'n1', 'em_aprovacao', 26, 'tarefa'],
    ['Backup semanal automatizado', 'Infraestrutura', 'media', 'n2', 'finalizado', 100, 'tarefa'],
    ['Cliente pediu troca da paleta de cores', 'Design', 'alta', 'n1', 'a_fazer', 2, 'tarefa'],
    ['Onboarding do novo time de suporte', 'Suporte', 'baixa', 'n1', 'finalizado', 200, 'evento'],
    ['Integrar gateway de pagamento', 'Desenvolvimento', 'alta', 'n3', 'atendendo', 14, 'tarefa'],
    ['Otimizar imagens: pagina pesada', 'Desenvolvimento', 'media', 'n2', 'a_fazer', 40, 'tarefa'],
    ['Texto da campanha de dia das criancas', 'Conteudo', 'media', 'n1', 'em_aprovacao', 30, 'tarefa'],
    ['Suporte: e-mail corporativo fora do ar', 'Suporte', 'critica', 'n1', 'finalizado', 48, 'tarefa'],
    ['Proposta comercial para novo cliente', 'Comercial', 'alta', 'n1', 'a_fazer', 4, 'tarefa'],
    ['Ajustar responsividade do menu', 'Desenvolvimento', 'media', 'n1', 'pausado', 55, 'tarefa'],
    ['Reunir material para o case de sucesso', 'Conteudo', 'baixa', 'n1', 'a_fazer', 90, 'tarefa'],
    ['Configurar monitoramento de uptime', 'Infraestrutura', 'media', 'n2', 'atendendo', 22, 'tarefa'],
    ['Revisao final antes do go-live', 'Desenvolvimento', 'critica', 'n3', 'em_aprovacao', 7, 'tarefa'],
    ['Kickoff do projeto', 'Comercial', 'baixa', 'n1', 'finalizado', 300, 'evento'],
    ['Ajustes pos-feedback do cliente', 'Design', 'alta', 'n2', 'atendendo', 11, 'tarefa'],
    ['Documentar processo de deploy', 'Infraestrutura', 'baixa', 'n2', 'a_fazer', 120, 'tarefa'],
];
async function semear() {
    console.log('\nSemeando dados de demonstracao...\n');
    // recomeca do zero: o cascade limpa tudo que pende do tenant demo
    const existente = await db.query.tenants.findFirst({ where: eq(tenants.slug, SLUG_DEMO) });
    if (existente) {
        await db.delete(tenants).where(eq(tenants.id, existente.id));
        console.log('  - workspace demo anterior removido');
    }
    const [tenant] = await db
        .insert(tenants)
        .values({ nome: 'Estudio Demo', slug: SLUG_DEMO })
        .returning();
    if (!tenant)
        throw new Error('falha ao criar o tenant');
    const senhaHash = await bcrypt.hash(SENHA_DEMO, 10);
    const equipe = await db
        .insert(usuarios)
        .values([
        {
            tenantId: tenant.id,
            nome: 'Voce (demo)',
            email: EMAIL_DEMO,
            senhaHash,
            cargo: 'Administrador',
            papel: 'admin',
        },
        ...EQUIPE.map((u) => ({ ...u, tenantId: tenant.id, senhaHash, papel: 'membro' })),
    ])
        .returning();
    console.log(`  - ${equipe.length} usuarios`);
    const cats = await db
        .insert(categorias)
        .values(CATEGORIAS.map((c) => ({ ...c, tenantId: tenant.id })))
        .returning();
    console.log(`  - ${cats.length} categorias`);
    const politicas = await db
        .insert(politicasSla)
        .values(Object.keys(SLA_PADRAO).map((prioridade) => ({
        tenantId: tenant.id,
        prioridade,
        minutosPrimeiraResposta: SLA_PADRAO[prioridade].minutosPrimeiraResposta,
        minutosResolucao: SLA_PADRAO[prioridade].minutosResolucao,
    })))
        .returning();
    console.log(`  - ${politicas.length} politicas de SLA`);
    const projs = await db
        .insert(projetos)
        .values(PROJETOS.map((p, i) => ({
        ...p,
        tenantId: tenant.id,
        responsavelId: equipe[i % equipe.length]?.id ?? null,
        descricao: `Projeto de demonstracao para ${p.cliente}.`,
    })))
        .returning();
    console.log(`  - ${projs.length} projetos`);
    // o admin enxerga tudo sem linha aqui; estas sao as participacoes da equipe
    const membros = await db
        .insert(projetoMembros)
        .values(projs.flatMap((projeto, i) => (MEMBROS_POR_PROJETO[i] ?? []).flatMap((indice) => {
        // equipe[0] e o admin demo; a EQUIPE comeca no indice 1
        const usuario = equipe[indice + 1];
        return usuario ? [{ projetoId: projeto.id, usuarioId: usuario.id }] : [];
    })))
        .returning();
    console.log(`  - ${membros.length} participacoes em projetos`);
    const agora = Date.now();
    const ano = new Date().getFullYear();
    const valores = MODELOS.map((modelo, i) => {
        const [titulo, nomeCategoria, prioridade, nivel, status, horas, tipo] = modelo;
        const abertaEm = new Date(agora - horas * 60 * MIN);
        const projeto = projs[i % projs.length];
        const responsavel = equipe[(i + 1) % equipe.length];
        const iniciou = status !== 'a_fazer';
        const inicioAtendimentoEm = iniciou ? new Date(abertaEm.getTime() + 20 * MIN) : null;
        return {
            tenantId: tenant.id,
            projetoId: projeto.id,
            codigo: `OS-${ano}-${String(i + 1).padStart(4, '0')}`,
            tipo,
            titulo,
            descricao: `${titulo}. Registro criado pelo seed para demonstrar o quadro e os prazos.`,
            categoriaId: cats.find((c) => c.nome === nomeCategoria)?.id ?? null,
            prioridade,
            nivel,
            status,
            ordem: i,
            responsavelId: responsavel.id,
            solicitante: projeto.cliente,
            abertaEm,
            inicioAtendimentoEm,
            primeiraRespostaEm: iniciou ? new Date(abertaEm.getTime() + 25 * MIN) : null,
            concluidaEm: status === 'finalizado' ? new Date(agora - (horas - 2) * 60 * MIN) : null,
            pausadaEm: status === 'pausado' ? new Date(agora - 90 * MIN) : null,
            minutosPausados: status === 'pausado' ? 120 : 0,
        };
    });
    const ordens = await db.insert(atividades).values(valores).returning();
    console.log(`  - ${ordens.length} ordens de servico`);
    // um pouco de conversa e historico nas primeiras O.S.
    const conversa = ordens.slice(0, 6).flatMap((os, i) => [
        {
            osId: os.id,
            autorNome: equipe[i % equipe.length].nome,
            texto: 'Comecei a olhar isso agora, aviso quando tiver a primeira versao.',
            interno: false,
        },
        {
            osId: os.id,
            autorNome: equipe[(i + 2) % equipe.length].nome,
            texto: 'Lembrete interno: conferir a margem antes de enviar para o cliente.',
            interno: true,
        },
    ]);
    await db.insert(comentarios).values(conversa);
    await db.insert(historico).values(ordens.map((os) => ({
        osId: os.id,
        tipo: 'criacao',
        descricao: 'O.S. aberta',
        autorNome: 'Seed',
    })));
    console.log('\nPronto. Entre com:');
    console.log(`  e-mail: ${EMAIL_DEMO}`);
    console.log(`  senha:  ${SENHA_DEMO}\n`);
}
semear()
    .then(() => fecharConexao())
    .then(() => process.exit(0))
    .catch(async (erro) => {
    console.error('\nFalha ao semear:', erro);
    await fecharConexao();
    process.exit(1);
});
//# sourceMappingURL=seed.js.map