import { driverEmail, env } from '../env.js'

/**
 * Envio de e-mail com degradacao, no mesmo desenho do bucket: sem provedor
 * configurado o sistema continua funcionando — o convite vira um link que o
 * admin copia e manda por onde quiser.
 *
 * `enviarEmail` NUNCA lanca. Quem chama decide o que dizer na tela.
 */

export interface Email {
  para: string
  assunto: string
  html: string
  texto: string
}

export interface ResultadoEnvio {
  enviado: boolean
  motivo?: string
}

export async function enviarEmail(email: Email): Promise<ResultadoEnvio> {
  if (driverEmail === null) {
    return { enviado: false, motivo: 'Envio de e-mail nao esta configurado nesta instalacao.' }
  }

  try {
    return driverEmail === 'resend' ? await viaResend(email) : await viaSmtp(email)
  } catch (e) {
    return { enviado: false, motivo: e instanceof Error ? e.message : 'Falha ao enviar o e-mail.' }
  }
}

/* ------------------------------------------------------------------ *
 * Resend: HTTP puro, sem dependencia nova
 * ------------------------------------------------------------------ */

async function viaResend(email: Email): Promise<ResultadoEnvio> {
  const resposta = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_REMETENTE,
      to: [email.para],
      subject: email.assunto,
      html: email.html,
      text: email.texto,
    }),
    signal: AbortSignal.timeout(env.EMAIL_TIMEOUT),
  })

  if (!resposta.ok) {
    const corpo = await resposta.text()
    return { enviado: false, motivo: `Resend respondeu ${resposta.status}: ${corpo.slice(0, 200)}` }
  }
  return { enviado: true }
}

/* ------------------------------------------------------------------ *
 * SMTP: exige `npm i nodemailer @types/nodemailer`.
 * O import e dinamico de proposito — quem usa Resend nao precisa do pacote.
 * ------------------------------------------------------------------ */

interface TransporteSmtp {
  sendMail(opcoes: {
    from: string
    to: string
    subject: string
    html: string
    text: string
  }): Promise<unknown>
}

interface ModuloNodemailer {
  createTransport(url: string, padroes?: Record<string, unknown>): TransporteSmtp
}

async function viaSmtp(email: Email): Promise<ResultadoEnvio> {
  const especificador = 'nodemailer'
  let modulo: ModuloNodemailer
  try {
    // especificador em variavel: o TS nao resolve o modulo em tempo de build,
    // entao o projeto compila sem o pacote instalado
    const importado: unknown = await import(especificador)
    const candidato = importado as { default?: ModuloNodemailer } & Partial<ModuloNodemailer>
    const resolvido = candidato.default ?? candidato
    if (typeof resolvido.createTransport !== 'function') {
      throw new Error('modulo sem createTransport')
    }
    modulo = resolvido as ModuloNodemailer
  } catch {
    return {
      enviado: false,
      motivo: 'SMTP_URL esta definida mas o pacote nodemailer nao esta instalado (npm i nodemailer).',
    }
  }

  const transporte = modulo.createTransport(env.SMTP_URL as string, {
    connectionTimeout: env.EMAIL_TIMEOUT,
    greetingTimeout: env.EMAIL_TIMEOUT,
  })

  await transporte.sendMail({
    from: env.EMAIL_REMETENTE,
    to: email.para,
    subject: email.assunto,
    html: email.html,
    text: email.texto,
  })

  return { enviado: true }
}

/* ------------------------------------------------------------------ *
 * Modelo do convite
 * ------------------------------------------------------------------ */

function escapar(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function emailDeConvite(dados: {
  nome: string
  organizacao: string
  convidadoPor: string
  papel: 'admin' | 'membro'
  projetos: string[]
  mensagem: string | null
  url: string
  expiraEm: Date | null
}): Omit<Email, 'para'> {
  const papel = dados.papel === 'admin' ? 'administrador' : 'colaborador'
  const validade = dados.expiraEm
    ? `O link vale ate ${dados.expiraEm.toLocaleDateString('pt-BR')}.`
    : 'O link nao expira.'

  const listaProjetos = dados.projetos.length
    ? `Projetos: ${dados.projetos.join(', ')}.`
    : 'Os projetos serao definidos depois.'

  const texto = [
    `Ola, ${dados.nome}.`,
    '',
    `${dados.convidadoPor} convidou voce para participar de ${dados.organizacao} no SysAceite como ${papel}.`,
    listaProjetos,
    dados.mensagem ? `\nRecado: "${dados.mensagem}"` : '',
    '',
    'Para aceitar e criar sua senha, abra:',
    dados.url,
    '',
    validade,
    'Se voce nao esperava este convite, ignore este e-mail.',
  ]
    .filter((l) => l !== '')
    .join('\n')

  const html = `<!doctype html>
<html lang="pt-BR"><body style="margin:0;background:#f6f6f7;padding:32px 16px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#18181b">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e4e4e7;border-radius:14px;padding:32px">
    <p style="margin:0 0 24px;font-size:15px;font-weight:600">SysAceite</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6">Ola, ${escapar(dados.nome)}.</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6">
      <strong>${escapar(dados.convidadoPor)}</strong> convidou voce para participar de
      <strong>${escapar(dados.organizacao)}</strong> como ${papel}.
    </p>
    <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#52525b">${escapar(listaProjetos)}</p>
    ${
      dados.mensagem
        ? `<p style="margin:0 0 24px;padding:12px 14px;background:#f4f4f5;border-radius:10px;font-size:14px;line-height:1.6;color:#3f3f46">${escapar(dados.mensagem)}</p>`
        : ''
    }
    <p style="margin:0 0 24px">
      <a href="${escapar(dados.url)}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-size:14px;font-weight:500">Aceitar convite e criar senha</a>
    </p>
    <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#71717a">${escapar(validade)}</p>
    <p style="margin:0;font-size:13px;line-height:1.6;color:#71717a">Se voce nao esperava este convite, ignore este e-mail.</p>
  </div>
</body></html>`

  return {
    assunto: `${dados.convidadoPor} convidou voce para ${dados.organizacao}`,
    texto,
    html,
  }
}
