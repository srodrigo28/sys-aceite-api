import { relations } from 'drizzle-orm';
import { boolean, index, integer, pgEnum, pgTable, real, text, timestamp, uniqueIndex, uuid, } from 'drizzle-orm/pg-core';
/* ------------------------------------------------------------------ *
 * Enums
 * ------------------------------------------------------------------ */
export const prioridadeEnum = pgEnum('prioridade', ['critica', 'alta', 'media', 'baixa']);
export const nivelEnum = pgEnum('nivel', ['n1', 'n2', 'n3']);
export const statusOsEnum = pgEnum('status_os', [
    'a_fazer',
    'atendendo',
    'pausado',
    'em_aprovacao',
    'finalizado',
]);
export const tipoOsEnum = pgEnum('tipo_os', ['evento', 'tarefa']);
export const papelEnum = pgEnum('papel', ['admin', 'membro']);
export const estadoLinkEnum = pgEnum('estado_link', [
    'pendente',
    'aprovado',
    'ajustes',
    'expirado',
    'revogado',
]);
export const decisaoEnum = pgEnum('decisao', ['aprovado', 'ajustes']);
/* ------------------------------------------------------------------ *
 * Tenants  (multi-tenant: banco compartilhado, isolamento por tenant_id)
 * ------------------------------------------------------------------ */
export const tenants = pgTable('tenants', {
    id: uuid('id').primaryKey().defaultRandom(),
    nome: text('nome').notNull(),
    slug: text('slug').notNull(),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('tenants_slug_idx').on(t.slug)]);
/* ------------------------------------------------------------------ *
 * Usuarios
 * ------------------------------------------------------------------ */
export const usuarios = pgTable('usuarios', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
        .notNull()
        .references(() => tenants.id, { onDelete: 'cascade' }),
    nome: text('nome').notNull(),
    email: text('email').notNull(),
    senhaHash: text('senha_hash').notNull(),
    cargo: text('cargo'),
    avatarUrl: text('avatar_url'),
    papel: papelEnum('papel').notNull().default('membro'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
    // e-mail unico globalmente: simplifica o login (nao precisa informar o tenant)
    uniqueIndex('usuarios_email_idx').on(t.email),
    index('usuarios_tenant_idx').on(t.tenantId),
]);
/* ------------------------------------------------------------------ *
 * Categorias  (multiplicador afeta o prazo de SLA)
 * ------------------------------------------------------------------ */
export const categorias = pgTable('categorias', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
        .notNull()
        .references(() => tenants.id, { onDelete: 'cascade' }),
    nome: text('nome').notNull(),
    cor: text('cor').notNull().default('#6366f1'),
    multiplicadorSla: real('multiplicador_sla').notNull().default(1),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('categorias_tenant_nome_idx').on(t.tenantId, t.nome)]);
/* ------------------------------------------------------------------ *
 * Politicas de SLA
 * Resolucao da mais especifica para a mais generica:
 *   prioridade + categoria + nivel  >  prioridade + categoria  >  prioridade
 * ------------------------------------------------------------------ */
export const politicasSla = pgTable('politicas_sla', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
        .notNull()
        .references(() => tenants.id, { onDelete: 'cascade' }),
    prioridade: prioridadeEnum('prioridade').notNull(),
    categoriaId: uuid('categoria_id').references(() => categorias.id, { onDelete: 'cascade' }),
    nivel: nivelEnum('nivel'),
    minutosPrimeiraResposta: integer('minutos_primeira_resposta').notNull(),
    minutosResolucao: integer('minutos_resolucao').notNull(),
    ativa: boolean('ativa').notNull().default(true),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('politicas_tenant_idx').on(t.tenantId, t.prioridade)]);
/* ------------------------------------------------------------------ *
 * Projetos
 * ------------------------------------------------------------------ */
export const projetos = pgTable('projetos', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
        .notNull()
        .references(() => tenants.id, { onDelete: 'cascade' }),
    nome: text('nome').notNull(),
    cliente: text('cliente').notNull(),
    descricao: text('descricao'),
    cor: text('cor').notNull().default('#6366f1'),
    responsavelId: uuid('responsavel_id').references(() => usuarios.id, { onDelete: 'set null' }),
    arquivado: boolean('arquivado').notNull().default(false),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('projetos_tenant_idx').on(t.tenantId)]);
/* ------------------------------------------------------------------ *
 * Ordens de servico
 * ------------------------------------------------------------------ */
export const ordensServico = pgTable('ordens_servico', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
        .notNull()
        .references(() => tenants.id, { onDelete: 'cascade' }),
    projetoId: uuid('projeto_id')
        .notNull()
        .references(() => projetos.id, { onDelete: 'cascade' }),
    codigo: text('codigo').notNull(),
    tipo: tipoOsEnum('tipo').notNull().default('tarefa'),
    titulo: text('titulo').notNull(),
    descricao: text('descricao'),
    categoriaId: uuid('categoria_id').references(() => categorias.id, { onDelete: 'set null' }),
    prioridade: prioridadeEnum('prioridade').notNull().default('media'),
    nivel: nivelEnum('nivel').notNull().default('n1'),
    status: statusOsEnum('status').notNull().default('a_fazer'),
    ordem: integer('ordem').notNull().default(0),
    responsavelId: uuid('responsavel_id').references(() => usuarios.id, { onDelete: 'set null' }),
    solicitante: text('solicitante'),
    // relogios de SLA
    abertaEm: timestamp('aberta_em', { withTimezone: true }).notNull().defaultNow(),
    inicioAtendimentoEm: timestamp('inicio_atendimento_em', { withTimezone: true }),
    primeiraRespostaEm: timestamp('primeira_resposta_em', { withTimezone: true }),
    concluidaEm: timestamp('concluida_em', { withTimezone: true }),
    pausadaEm: timestamp('pausada_em', { withTimezone: true }),
    minutosPausados: integer('minutos_pausados').notNull().default(0),
    // resultado da aprovacao por link (nao move o card: status continua manual)
    aprovado: boolean('aprovado'),
    aprovadorNome: text('aprovador_nome'),
    aprovacaoObservacao: text('aprovacao_observacao'),
    aprovadoEm: timestamp('aprovado_em', { withTimezone: true }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
    uniqueIndex('os_tenant_codigo_idx').on(t.tenantId, t.codigo),
    index('os_projeto_status_idx').on(t.projetoId, t.status),
    index('os_tenant_idx').on(t.tenantId),
]);
/* ------------------------------------------------------------------ *
 * Filhos da O.S.
 * ------------------------------------------------------------------ */
export const checklistItens = pgTable('checklist_itens', {
    id: uuid('id').primaryKey().defaultRandom(),
    osId: uuid('os_id')
        .notNull()
        .references(() => ordensServico.id, { onDelete: 'cascade' }),
    texto: text('texto').notNull(),
    feito: boolean('feito').notNull().default(false),
    ordem: integer('ordem').notNull().default(0),
}, (t) => [index('checklist_os_idx').on(t.osId)]);
export const anexos = pgTable('anexos', {
    id: uuid('id').primaryKey().defaultRandom(),
    osId: uuid('os_id')
        .notNull()
        .references(() => ordensServico.id, { onDelete: 'cascade' }),
    nome: text('nome').notNull(),
    url: text('url').notNull(),
    tipo: text('tipo'),
    tamanho: integer('tamanho'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('anexos_os_idx').on(t.osId)]);
export const comentarios = pgTable('comentarios', {
    id: uuid('id').primaryKey().defaultRandom(),
    osId: uuid('os_id')
        .notNull()
        .references(() => ordensServico.id, { onDelete: 'cascade' }),
    autorId: uuid('autor_id').references(() => usuarios.id, { onDelete: 'set null' }),
    autorNome: text('autor_nome').notNull(),
    texto: text('texto').notNull(),
    // interno = nunca aparece na pagina publica de aprovacao
    interno: boolean('interno').notNull().default(false),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('comentarios_os_idx').on(t.osId)]);
export const historico = pgTable('historico', {
    id: uuid('id').primaryKey().defaultRandom(),
    osId: uuid('os_id')
        .notNull()
        .references(() => ordensServico.id, { onDelete: 'cascade' }),
    tipo: text('tipo').notNull(),
    descricao: text('descricao').notNull(),
    autorNome: text('autor_nome').notNull(),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('historico_os_idx').on(t.osId)]);
/* ------------------------------------------------------------------ *
 * Links de aprovacao  (o coracao do produto)
 * ------------------------------------------------------------------ */
export const linksAprovacao = pgTable('links_aprovacao', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
        .notNull()
        .references(() => tenants.id, { onDelete: 'cascade' }),
    osId: uuid('os_id')
        .notNull()
        .references(() => ordensServico.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    estado: estadoLinkEnum('estado').notNull().default('pendente'),
    // o que o aprovador enxerga
    mostrarAnexos: boolean('mostrar_anexos').notNull().default(true),
    mostrarDatas: boolean('mostrar_datas').notNull().default(true),
    mostrarSla: boolean('mostrar_sla').notNull().default(false),
    mensagem: text('mensagem'),
    // pre-preenchimento opcional
    aprovadorNomeSugerido: text('aprovador_nome_sugerido'),
    aprovadorEmailSugerido: text('aprovador_email_sugerido'),
    expiraEm: timestamp('expira_em', { withTimezone: true }),
    criadoPorId: uuid('criado_por_id').references(() => usuarios.id, { onDelete: 'set null' }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    // parecer
    decisao: decisaoEnum('decisao'),
    observacao: text('observacao'),
    aprovadorNome: text('aprovador_nome'),
    aprovadorEmail: text('aprovador_email'),
    decididoEm: timestamp('decidido_em', { withTimezone: true }),
    ipDecisao: text('ip_decisao'),
}, (t) => [
    uniqueIndex('links_token_idx').on(t.token),
    index('links_os_idx').on(t.osId),
    index('links_tenant_idx').on(t.tenantId),
]);
/* ------------------------------------------------------------------ *
 * Relations (para a query API do Drizzle)
 * ------------------------------------------------------------------ */
export const tenantsRelations = relations(tenants, ({ many }) => ({
    usuarios: many(usuarios),
    projetos: many(projetos),
    categorias: many(categorias),
    politicasSla: many(politicasSla),
}));
export const usuariosRelations = relations(usuarios, ({ one }) => ({
    tenant: one(tenants, { fields: [usuarios.tenantId], references: [tenants.id] }),
}));
export const projetosRelations = relations(projetos, ({ one, many }) => ({
    tenant: one(tenants, { fields: [projetos.tenantId], references: [tenants.id] }),
    responsavel: one(usuarios, { fields: [projetos.responsavelId], references: [usuarios.id] }),
    ordens: many(ordensServico),
}));
export const ordensServicoRelations = relations(ordensServico, ({ one, many }) => ({
    projeto: one(projetos, { fields: [ordensServico.projetoId], references: [projetos.id] }),
    categoria: one(categorias, { fields: [ordensServico.categoriaId], references: [categorias.id] }),
    responsavel: one(usuarios, { fields: [ordensServico.responsavelId], references: [usuarios.id] }),
    checklist: many(checklistItens),
    anexos: many(anexos),
    comentarios: many(comentarios),
    historico: many(historico),
    links: many(linksAprovacao),
}));
export const checklistRelations = relations(checklistItens, ({ one }) => ({
    os: one(ordensServico, { fields: [checklistItens.osId], references: [ordensServico.id] }),
}));
export const anexosRelations = relations(anexos, ({ one }) => ({
    os: one(ordensServico, { fields: [anexos.osId], references: [ordensServico.id] }),
}));
export const comentariosRelations = relations(comentarios, ({ one }) => ({
    os: one(ordensServico, { fields: [comentarios.osId], references: [ordensServico.id] }),
}));
export const historicoRelations = relations(historico, ({ one }) => ({
    os: one(ordensServico, { fields: [historico.osId], references: [ordensServico.id] }),
}));
export const linksAprovacaoRelations = relations(linksAprovacao, ({ one }) => ({
    os: one(ordensServico, { fields: [linksAprovacao.osId], references: [ordensServico.id] }),
    tenant: one(tenants, { fields: [linksAprovacao.tenantId], references: [tenants.id] }),
}));
//# sourceMappingURL=schema.js.map