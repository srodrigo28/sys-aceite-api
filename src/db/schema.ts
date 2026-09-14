import { relations } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/* ------------------------------------------------------------------ *
 * Enums
 * ------------------------------------------------------------------ */

export const prioridadeEnum = pgEnum('prioridade', ['critica', 'alta', 'media', 'baixa'])
export const nivelEnum = pgEnum('nivel', ['n1', 'n2', 'n3'])
export const statusOsEnum = pgEnum('status_os', [
  'a_fazer',
  'atendendo',
  'pausado',
  'em_aprovacao',
  'finalizado',
])
export const tipoOsEnum = pgEnum('tipo_os', ['evento', 'tarefa'])
export const papelEnum = pgEnum('papel', ['admin', 'membro'])
export const estadoLinkEnum = pgEnum('estado_link', [
  'pendente',
  'aprovado',
  'ajustes',
  'expirado',
  'revogado',
])
export const decisaoEnum = pgEnum('decisao', ['aprovado', 'ajustes'])
export const tipoNotificacaoEnum = pgEnum('tipo_notificacao', [
  'os_atribuida',
  'os_status',
  'os_comentario',
  'os_parecer',
  'convite_aceito',
])
export const estadoConviteEnum = pgEnum('estado_convite', [
  'pendente',
  'aceito',
  'expirado',
  'revogado',
])

/* ------------------------------------------------------------------ *
 * Tenants  (multi-tenant: banco compartilhado, isolamento por tenant_id)
 * ------------------------------------------------------------------ */

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nome: text('nome').notNull(),
    slug: text('slug').notNull(),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tenants_slug_idx').on(t.slug)],
)

/* ------------------------------------------------------------------ *
 * Usuarios
 * ------------------------------------------------------------------ */

export const usuarios = pgTable(
  'usuarios',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    nome: text('nome').notNull(),
    email: text('email').notNull(),
    senhaHash: text('senha_hash').notNull(),
    cargo: text('cargo'),
    // avatar_url ficou para tras: a foto agora mora no storage e e servida pelo
    // proxy /usuarios/:id/avatar, igual aos anexos. O caminho nunca vai ao cliente.
    avatarUrl: text('avatar_url'),
    avatarFileId: text('avatar_file_id'),
    avatarCaminho: text('avatar_caminho'),
    avatarAtualizadoEm: timestamp('avatar_atualizado_em', { withTimezone: true }),
    papel: papelEnum('papel').notNull().default('membro'),
    // desativar em vez de apagar: responsavelId e historico apontam para o usuario
    ativo: boolean('ativo').notNull().default(true),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // e-mail unico globalmente: simplifica o login (nao precisa informar o tenant)
    uniqueIndex('usuarios_email_idx').on(t.email),
    index('usuarios_tenant_idx').on(t.tenantId),
  ],
)

/* ------------------------------------------------------------------ *
 * Categorias  (multiplicador afeta o prazo de SLA)
 * ------------------------------------------------------------------ */

export const categorias = pgTable(
  'categorias',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    nome: text('nome').notNull(),
    cor: text('cor').notNull().default('#6366f1'),
    multiplicadorSla: real('multiplicador_sla').notNull().default(1),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('categorias_tenant_nome_idx').on(t.tenantId, t.nome)],
)

/* ------------------------------------------------------------------ *
 * Politicas de SLA
 * Resolucao da mais especifica para a mais generica:
 *   prioridade + categoria + nivel  >  prioridade + categoria  >  prioridade
 * ------------------------------------------------------------------ */

export const politicasSla = pgTable(
  'politicas_sla',
  {
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
  },
  (t) => [index('politicas_tenant_idx').on(t.tenantId, t.prioridade)],
)

/* ------------------------------------------------------------------ *
 * Projetos
 * ------------------------------------------------------------------ */

export const projetos = pgTable(
  'projetos',
  {
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
  },
  (t) => [index('projetos_tenant_idx').on(t.tenantId)],
)

/* ------------------------------------------------------------------ *
 * Atividades  (a "ordem de servico" de antes)
 *
 * A unidade de trabalho: titulo, prioridade, nivel, responsavel, coluna do
 * kanban e os relogios de SLA. Nada disso e atributo de fatura — por isso ela
 * deixou de se chamar O.S. O nome "ordem de servico" passa a designar o
 * agrupador mensal que soma estas atividades, e que ainda nao existe.
 *
 * As colunas `os_id` das tabelas filhas continuam com o nome antigo de
 * proposito: elas vivem em tabelas que nao foram renomeadas, onde nenhuma view
 * de compatibilidade alcanca. Viram `atividade_id` quando nao houver mais
 * codigo antigo rodando.
 * ------------------------------------------------------------------ */

export const atividades = pgTable(
  'atividades',
  {
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

    // `responsavel_id` saiu: quem responde pela atividade vive em
    // `atividade_responsaveis`. Enquanto os dois existiam, um PATCH que mandasse
    // so a lista deixava a coluna com o valor velho — duas fontes de verdade que
    // divergem, que e exatamente o que a nota de `grupos` alerta.
    // A API continua devolvendo `responsavelId` na resposta, mas DERIVADO do
    // principal: uma fonte, duas representacoes.
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
  },
  (t) => [
    uniqueIndex('os_tenant_codigo_idx').on(t.tenantId, t.codigo),
    index('os_projeto_status_idx').on(t.projetoId, t.status),
    index('os_tenant_idx').on(t.tenantId),
  ],
)

/**
 * Quem responde por uma atividade. Uma atividade pode ter varios.
 *
 * `principal` e atributo do VINCULO, nao coluna da atividade. A tentacao e
 * guardar "o principal" em `atividades.responsavel_id` e usar esta tabela so
 * para os demais — e o erro que a nota de `grupos` descreve: dois caminhos para
 * a mesma resposta, que divergem com o tempo. Aqui ha um caminho so.
 *
 * Exatamente um principal por atividade, garantido pelo indice parcial.
 */
export const atividadeResponsaveis = pgTable(
  'atividade_responsaveis',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    atividadeId: uuid('atividade_id')
      .notNull()
      .references(() => atividades.id, { onDelete: 'cascade' }),
    usuarioId: uuid('usuario_id')
      .notNull()
      .references(() => usuarios.id, { onDelete: 'cascade' }),
    principal: boolean('principal').notNull().default(false),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('atividade_responsaveis_idx').on(t.atividadeId, t.usuarioId),
    index('atividade_responsaveis_usuario_idx').on(t.usuarioId),
  ],
)

/* ------------------------------------------------------------------ *
 * Filhos da O.S.
 * ------------------------------------------------------------------ */

export const checklistItens = pgTable(
  'checklist_itens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    osId: uuid('os_id')
      .notNull()
      .references(() => atividades.id, { onDelete: 'cascade' }),
    texto: text('texto').notNull(),
    feito: boolean('feito').notNull().default(false),
    ordem: integer('ordem').notNull().default(0),
  },
  (t) => [index('checklist_os_idx').on(t.osId)],
)

export const anexos = pgTable(
  'anexos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    osId: uuid('os_id')
      .notNull()
      .references(() => atividades.id, { onDelete: 'cascade' }),
    // redundante com a O.S., mas evita join em toda checagem de posse no download
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    nome: text('nome').notNull(),
    fileId: text('file_id').notNull(),
    storage: text('storage').$type<'bucket' | 'disco'>().notNull(),
    // URL publica do bucket ou caminho no disco. NUNCA serializar para o cliente.
    caminho: text('caminho').notNull(),
    mimeType: text('mime_type').notNull(),
    tamanho: integer('tamanho').notNull(),
    checksum: text('checksum'),
    // miniatura: mesmo storage do original. Nulo em anexo antigo ou quando a
    // geracao falha — nesses casos o proxy serve o arquivo original.
    miniaturaFileId: text('miniatura_file_id'),
    miniaturaCaminho: text('miniatura_caminho'),
    miniaturaMime: text('miniatura_mime'),
    miniaturaTamanho: integer('miniatura_tamanho'),
    enviadoPorId: uuid('enviado_por_id').references(() => usuarios.id, { onDelete: 'set null' }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('anexos_os_idx').on(t.osId), index('anexos_tenant_idx').on(t.tenantId)],
)

export const comentarios = pgTable(
  'comentarios',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    osId: uuid('os_id')
      .notNull()
      .references(() => atividades.id, { onDelete: 'cascade' }),
    autorId: uuid('autor_id').references(() => usuarios.id, { onDelete: 'set null' }),
    autorNome: text('autor_nome').notNull(),
    texto: text('texto').notNull(),
    // interno = nunca aparece na pagina publica de aprovacao
    interno: boolean('interno').notNull().default(false),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('comentarios_os_idx').on(t.osId)],
)

export const historico = pgTable(
  'historico',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    osId: uuid('os_id')
      .notNull()
      .references(() => atividades.id, { onDelete: 'cascade' }),
    tipo: text('tipo').notNull(),
    descricao: text('descricao').notNull(),
    autorNome: text('autor_nome').notNull(),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('historico_os_idx').on(t.osId)],
)

/* ------------------------------------------------------------------ *
 * Links de aprovacao  (o coracao do produto)
 * ------------------------------------------------------------------ */

export const linksAprovacao = pgTable(
  'links_aprovacao',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    osId: uuid('os_id')
      .notNull()
      .references(() => atividades.id, { onDelete: 'cascade' }),
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
  },
  (t) => [
    uniqueIndex('links_token_idx').on(t.token),
    index('links_os_idx').on(t.osId),
    index('links_tenant_idx').on(t.tenantId),
  ],
)

/* ------------------------------------------------------------------ *
 * Equipe: quem participa de qual projeto, e os convites pendentes
 *
 * Admin enxerga todo projeto do tenant sem precisar de linha em
 * projeto_membros. Colaborador so enxerga o que esta aqui.
 * ------------------------------------------------------------------ */

export const projetoMembros = pgTable(
  'projeto_membros',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projetoId: uuid('projeto_id')
      .notNull()
      .references(() => projetos.id, { onDelete: 'cascade' }),
    usuarioId: uuid('usuario_id')
      .notNull()
      .references(() => usuarios.id, { onDelete: 'cascade' }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('projeto_membros_idx').on(t.projetoId, t.usuarioId),
    index('projeto_membros_usuario_idx').on(t.usuarioId),
  ],
)

/**
 * Convite por e-mail. Nao cria usuario: a linha em `usuarios` so nasce no
 * aceite, porque senhaHash e NOT NULL e conta sem senha vira zumbi no login.
 */
export const convites = pgTable(
  'convites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    nome: text('nome').notNull(),
    papel: papelEnum('papel').notNull().default('membro'),
    cargo: text('cargo'),
    mensagem: text('mensagem'),
    token: text('token').notNull(),
    estado: estadoConviteEnum('estado').notNull().default('pendente'),
    expiraEm: timestamp('expira_em', { withTimezone: true }),
    convidadoPorId: uuid('convidado_por_id').references(() => usuarios.id, {
      onDelete: 'set null',
    }),
    /** preenchido no aceite */
    usuarioId: uuid('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
    aceitoEm: timestamp('aceito_em', { withTimezone: true }),
    emailEnviadoEm: timestamp('email_enviado_em', { withTimezone: true }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('convites_token_idx').on(t.token),
    index('convites_tenant_estado_idx').on(t.tenantId, t.estado),
    index('convites_email_idx').on(t.email),
  ],
)

/** Projetos prometidos no convite; viram projeto_membros no aceite. */
export const conviteProjetos = pgTable(
  'convite_projetos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conviteId: uuid('convite_id')
      .notNull()
      .references(() => convites.id, { onDelete: 'cascade' }),
    projetoId: uuid('projeto_id')
      .notNull()
      .references(() => projetos.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('convite_projetos_idx').on(t.conviteId, t.projetoId)],
)

/* ------------------------------------------------------------------ *
 * Grupos de pessoas
 *
 * Grupo organiza o time (campo, escritorio, plantao) e NAO concede acesso:
 * quem ve o que continua sendo `projeto_membros`. Sao duas perguntas
 * diferentes; junta-las cria dois caminhos para a mesma resposta e eles
 * divergem com o tempo.
 * ------------------------------------------------------------------ */

export const grupos = pgTable(
  'grupos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    nome: text('nome').notNull(),
    cor: text('cor').notNull().default('#6366f1'),
    descricao: text('descricao'),
    ordem: integer('ordem').notNull().default(0),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('grupos_tenant_nome_idx').on(t.tenantId, t.nome)],
)

/** Uma pessoa pode estar em varios grupos. */
export const grupoMembros = pgTable(
  'grupo_membros',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    grupoId: uuid('grupo_id')
      .notNull()
      .references(() => grupos.id, { onDelete: 'cascade' }),
    usuarioId: uuid('usuario_id')
      .notNull()
      .references(() => usuarios.id, { onDelete: 'cascade' }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('grupo_membros_idx').on(t.grupoId, t.usuarioId),
    index('grupo_membros_usuario_idx').on(t.usuarioId),
  ],
)

/* ------------------------------------------------------------------ *
 * Notificacoes
 *
 * `historico` responde "o que aconteceu nesta O.S."; esta tabela responde
 * "o que e novo PARA MIM". Perguntas diferentes, leituras diferentes.
 * ------------------------------------------------------------------ */

export const notificacoes = pgTable(
  'notificacoes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    usuarioId: uuid('usuario_id')
      .notNull()
      .references(() => usuarios.id, { onDelete: 'cascade' }),
    tipo: tipoNotificacaoEnum('tipo').notNull(),
    titulo: text('titulo').notNull(),
    descricao: text('descricao'),
    /** para onde a notificacao leva; nulo em evento sem O.S. */
    osId: uuid('os_id').references(() => atividades.id, { onDelete: 'cascade' }),
    projetoId: uuid('projeto_id').references(() => projetos.id, { onDelete: 'cascade' }),
    /** quem causou — para nao notificar a si mesmo e para mostrar o avatar */
    autorId: uuid('autor_id').references(() => usuarios.id, { onDelete: 'set null' }),
    autorNome: text('autor_nome'),
    lidaEm: timestamp('lida_em', { withTimezone: true }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // o sino pergunta "minhas nao lidas, mais recentes primeiro" o tempo todo
    index('notificacoes_usuario_idx').on(t.usuarioId, t.lidaEm, t.criadoEm),
  ],
)

/* ------------------------------------------------------------------ *
 * Relations (para a query API do Drizzle)
 * ------------------------------------------------------------------ */

export const tenantsRelations = relations(tenants, ({ many }) => ({
  usuarios: many(usuarios),
  projetos: many(projetos),
  categorias: many(categorias),
  politicasSla: many(politicasSla),
}))

export const usuariosRelations = relations(usuarios, ({ one, many }) => ({
  tenant: one(tenants, { fields: [usuarios.tenantId], references: [tenants.id] }),
  projetos: many(projetoMembros),
}))

export const gruposRelations = relations(grupos, ({ one, many }) => ({
  tenant: one(tenants, { fields: [grupos.tenantId], references: [tenants.id] }),
  membros: many(grupoMembros),
}))

export const grupoMembrosRelations = relations(grupoMembros, ({ one }) => ({
  grupo: one(grupos, { fields: [grupoMembros.grupoId], references: [grupos.id] }),
  usuario: one(usuarios, { fields: [grupoMembros.usuarioId], references: [usuarios.id] }),
}))

export const notificacoesRelations = relations(notificacoes, ({ one }) => ({
  usuario: one(usuarios, { fields: [notificacoes.usuarioId], references: [usuarios.id] }),
  autor: one(usuarios, { fields: [notificacoes.autorId], references: [usuarios.id] }),
  os: one(atividades, { fields: [notificacoes.osId], references: [atividades.id] }),
}))

export const projetoMembrosRelations = relations(projetoMembros, ({ one }) => ({
  projeto: one(projetos, { fields: [projetoMembros.projetoId], references: [projetos.id] }),
  usuario: one(usuarios, { fields: [projetoMembros.usuarioId], references: [usuarios.id] }),
}))

export const convitesRelations = relations(convites, ({ one, many }) => ({
  tenant: one(tenants, { fields: [convites.tenantId], references: [tenants.id] }),
  convidadoPor: one(usuarios, { fields: [convites.convidadoPorId], references: [usuarios.id] }),
  projetos: many(conviteProjetos),
}))

export const conviteProjetosRelations = relations(conviteProjetos, ({ one }) => ({
  convite: one(convites, { fields: [conviteProjetos.conviteId], references: [convites.id] }),
  projeto: one(projetos, { fields: [conviteProjetos.projetoId], references: [projetos.id] }),
}))

export const projetosRelations = relations(projetos, ({ one, many }) => ({
  tenant: one(tenants, { fields: [projetos.tenantId], references: [tenants.id] }),
  responsavel: one(usuarios, { fields: [projetos.responsavelId], references: [usuarios.id] }),
  ordens: many(atividades),
  membros: many(projetoMembros),
}))

export const atividadesRelations = relations(atividades, ({ one, many }) => ({
  projeto: one(projetos, { fields: [atividades.projetoId], references: [projetos.id] }),
  categoria: one(categorias, { fields: [atividades.categoriaId], references: [categorias.id] }),
  responsaveis: many(atividadeResponsaveis),
  checklist: many(checklistItens),
  anexos: many(anexos),
  comentarios: many(comentarios),
  historico: many(historico),
  links: many(linksAprovacao),
}))

export const atividadeResponsaveisRelations = relations(atividadeResponsaveis, ({ one }) => ({
  atividade: one(atividades, {
    fields: [atividadeResponsaveis.atividadeId],
    references: [atividades.id],
  }),
  usuario: one(usuarios, {
    fields: [atividadeResponsaveis.usuarioId],
    references: [usuarios.id],
  }),
}))

export const checklistRelations = relations(checklistItens, ({ one }) => ({
  os: one(atividades, { fields: [checklistItens.osId], references: [atividades.id] }),
}))

export const anexosRelations = relations(anexos, ({ one }) => ({
  os: one(atividades, { fields: [anexos.osId], references: [atividades.id] }),
}))

export const comentariosRelations = relations(comentarios, ({ one }) => ({
  os: one(atividades, { fields: [comentarios.osId], references: [atividades.id] }),
}))

export const historicoRelations = relations(historico, ({ one }) => ({
  os: one(atividades, { fields: [historico.osId], references: [atividades.id] }),
}))

export const linksAprovacaoRelations = relations(linksAprovacao, ({ one }) => ({
  os: one(atividades, { fields: [linksAprovacao.osId], references: [atividades.id] }),
  tenant: one(tenants, { fields: [linksAprovacao.tenantId], references: [tenants.id] }),
}))

/* ------------------------------------------------------------------ *
 * Tipos inferidos
 * ------------------------------------------------------------------ */

export type Tenant = typeof tenants.$inferSelect
export type Usuario = typeof usuarios.$inferSelect
export type Categoria = typeof categorias.$inferSelect
export type PoliticaSla = typeof politicasSla.$inferSelect
export type Projeto = typeof projetos.$inferSelect
export type Atividade = typeof atividades.$inferSelect
export type AtividadeResponsavel = typeof atividadeResponsaveis.$inferSelect
export type ChecklistItem = typeof checklistItens.$inferSelect
export type Anexo = typeof anexos.$inferSelect
export type Comentario = typeof comentarios.$inferSelect
export type EventoHistorico = typeof historico.$inferSelect
export type LinkAprovacao = typeof linksAprovacao.$inferSelect
export type ProjetoMembro = typeof projetoMembros.$inferSelect
export type Grupo = typeof grupos.$inferSelect
export type GrupoMembro = typeof grupoMembros.$inferSelect
export type Notificacao = typeof notificacoes.$inferSelect
export type Convite = typeof convites.$inferSelect

export type Prioridade = (typeof prioridadeEnum.enumValues)[number]
export type Nivel = (typeof nivelEnum.enumValues)[number]
export type StatusOS = (typeof statusOsEnum.enumValues)[number]
export type TipoOS = (typeof tipoOsEnum.enumValues)[number]
export type EstadoLink = (typeof estadoLinkEnum.enumValues)[number]
export type EstadoConvite = (typeof estadoConviteEnum.enumValues)[number]
export type TipoNotificacao = (typeof tipoNotificacaoEnum.enumValues)[number]
export type Papel = (typeof papelEnum.enumValues)[number]
