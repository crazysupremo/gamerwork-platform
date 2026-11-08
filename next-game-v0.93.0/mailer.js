// mailer.js
// Envio de e-mail transacional via Resend (https://resend.com). Usado hoje
// só pra confirmação de cadastro (código de 6 dígitos), mas escrito genérico
// o bastante pra outros e-mails futuros (recuperação de senha, avisos etc).
//
// Sem RESEND_API_KEY configurada, não quebra o app — só avisa no log e volta
// { sent: false, skipped: true }, do mesmo jeito que moderateImageWithGroq/
// callGroqText fazem quando falta GROQ_API_KEY. Quem chama decide o que fazer
// (aqui: registro segue normal, mas a pessoa fica bloqueada até confirmar —
// então sem e-mail configurado, ninguém consegue confirmar sozinho; é o
// dono do app que precisa configurar a chave, não um bug silencioso).

const RESEND_FROM = process.env.RESEND_FROM || 'NEXT GAME <onboarding@resend.dev>';

async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[mailer] RESEND_API_KEY não configurada — e-mail não enviado (assunto: "' + subject + '")');
    return { sent: false, skipped: true };
  }
  try {
    const apiRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [to],
        subject,
        html,
        text: text || undefined,
      }),
    });
    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('[mailer] Erro da Resend:', apiRes.status, errText);
      return { sent: false, error: true };
    }
    return { sent: true };
  } catch (err) {
    console.error('[mailer] Falha ao enviar e-mail:', err.message);
    return { sent: false, error: true };
  }
}

async function sendVerificationEmail(to, code, username) {
  const safeUsername = String(username || '').slice(0, 60);
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 420px; margin: 0 auto; padding: 24px; background:#1e1f22; color:#e6e6e6; border-radius: 12px;">
      <h2 style="color:#5865f2; margin-top:0;">NEXT GAME</h2>
      <p>Oi${safeUsername ? ', ' + safeUsername : ''}! Confirme seu e-mail com o código abaixo:</p>
      <p style="font-size: 32px; font-weight: 800; letter-spacing: 6px; text-align: center; background:#2b2d31; padding: 16px; border-radius: 8px; margin: 20px 0;">${code}</p>
      <p style="color:#949ba4; font-size: 13px;">Esse código expira em 15 minutos. Se você não pediu isso, pode ignorar este e-mail.</p>
    </div>
  `.trim();
  const result = await sendEmail({
    to,
    subject: `${code} é o seu código de confirmação — NEXT GAME`,
    html,
    text: `Seu código de confirmação do NEXT GAME é: ${code} (expira em 15 minutos)`,
  });
  if (!result.sent) {
    // Sem Resend configurada (ou falha no envio), o código fica só no log do
    // servidor — assim quem tem acesso ao Render (você) consegue destravar
    // qualquer conta, inclusive a sua própria, mesmo sem e-mail configurado.
    console.warn(`[mailer] Código de verificação para ${to}: ${code} (não enviado por e-mail)`);
  }
  return result;
}

function generateVerificationCode() {
  // 6 dígitos, sempre com zero à esquerda se precisar (ex: "004521").
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendPasswordResetEmail(to, resetUrl, username) {
  const safeUsername = String(username || '').slice(0, 60);
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 420px; margin: 0 auto; padding: 24px; background:#1e1f22; color:#e6e6e6; border-radius: 12px;">
      <h2 style="color:#5865f2; margin-top:0;">NEXT GAME</h2>
      <p>Oi${safeUsername ? ', ' + safeUsername : ''}! Pediram pra trocar a senha dessa conta. Clique no botão abaixo pra escolher uma nova:</p>
      <p style="text-align:center; margin: 24px 0;">
        <a href="${resetUrl}" style="background:#5865f2; color:white; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:700; display:inline-block;">Trocar minha senha</a>
      </p>
      <p style="color:#949ba4; font-size: 13px;">Esse link expira em 1 hora. Se você não pediu isso, pode ignorar este e-mail — sua senha continua a mesma.</p>
    </div>
  `.trim();
  const result = await sendEmail({
    to,
    subject: 'Trocar sua senha — NEXT GAME',
    html,
    text: `Pediram pra trocar a senha da sua conta NEXT GAME. Link (expira em 1 hora): ${resetUrl}`,
  });
  if (!result.sent) {
    // Sem Resend configurada, o link fica só no log do servidor — dá pra
    // você (que tem acesso ao Render) ainda destravar sua própria conta.
    console.warn(`[mailer] Link de troca de senha para ${to}: ${resetUrl} (não enviado por e-mail)`);
  }
  return result;
}

async function sendBackupEmailCode(to, code, username) {
  const safeUsername = String(username || '').slice(0, 60);
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 420px; margin: 0 auto; padding: 24px; background:#1e1f22; color:#e6e6e6; border-radius: 12px;">
      <h2 style="color:#5865f2; margin-top:0;">NEXT GAME</h2>
      <p>Oi${safeUsername ? ', ' + safeUsername : ''}! Pediram pra usar esse endereço como e-mail alternativo (de recuperação) da conta NEXT GAME @${safeUsername || ''}. Confirme com o código abaixo:</p>
      <p style="font-size: 32px; font-weight: 800; letter-spacing: 6px; text-align: center; background:#2b2d31; padding: 16px; border-radius: 8px; margin: 20px 0;">${code}</p>
      <p style="color:#949ba4; font-size: 13px;">Esse código expira em 15 minutos. Se você não pediu isso, pode ignorar este e-mail — nada muda na conta.</p>
    </div>
  `.trim();
  const result = await sendEmail({
    to,
    subject: `${code} é o seu código de confirmação de e-mail alternativo — NEXT GAME`,
    html,
    text: `Código pra confirmar seu e-mail alternativo no NEXT GAME: ${code} (expira em 15 minutos)`,
  });
  if (!result.sent) {
    console.warn(`[mailer] Código de e-mail alternativo para ${to}: ${code} (não enviado por e-mail)`);
  }
  return result;
}

async function sendAccountRecoveryCode(to, code, username) {
  const safeUsername = String(username || '').slice(0, 60);
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 420px; margin: 0 auto; padding: 24px; background:#1e1f22; color:#e6e6e6; border-radius: 12px;">
      <h2 style="color:#5865f2; margin-top:0;">NEXT GAME</h2>
      <p>Oi${safeUsername ? ', ' + safeUsername : ''}! Pediram pra recuperar o acesso à conta NEXT GAME @${safeUsername || ''} usando este e-mail alternativo. Use o código abaixo pra continuar:</p>
      <p style="font-size: 32px; font-weight: 800; letter-spacing: 6px; text-align: center; background:#2b2d31; padding: 16px; border-radius: 8px; margin: 20px 0;">${code}</p>
      <p style="color:#949ba4; font-size: 13px;">Esse código expira em 15 minutos. Se você não pediu isso, ignore este e-mail e considere avisar o suporte — sua conta continua segura, ninguém consegue entrar só com este código sozinho sem acesso a este e-mail.</p>
    </div>
  `.trim();
  const result = await sendEmail({
    to,
    subject: `${code} é o seu código de recuperação de conta — NEXT GAME`,
    html,
    text: `Código de recuperação de conta do NEXT GAME: ${code} (expira em 15 minutos)`,
  });
  if (!result.sent) {
    console.warn(`[mailer] Código de recuperação de conta para ${to}: ${code} (não enviado por e-mail)`);
  }
  return result;
}

// Aviso por e-mail sempre que chega um ticket novo de suporte — além do
// badge/toast que já existe no painel de admin (ver /api/support/tickets em
// server.js), pra quem não está de olho na tela o tempo todo. Só manda se
// SUPPORT_NOTIFY_EMAIL estiver configurada (endereço de destino escolhido
// pelo dono do site); sem ela, o ticket continua sendo salvo normal, só não
// avisa por e-mail — igual o padrão do resto do mailer.
const CATEGORY_LABELS = {
  reclamacao: 'Reclamação',
  duvida: 'Dúvida',
  denuncia: 'Denúncia',
  conta_banida: 'Conta banida',
  cobranca: 'Cobrança',
  outro: 'Outro',
};

async function sendSupportTicketNotification(ticket) {
  const notifyTo = process.env.SUPPORT_NOTIFY_EMAIL;
  if (!notifyTo) {
    console.warn('[mailer] SUPPORT_NOTIFY_EMAIL não configurada — ticket salvo, mas sem aviso por e-mail.');
    return { sent: false, skipped: true };
  }
  const categoryLabel = CATEGORY_LABELS[ticket.category] || ticket.category || 'Outro';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; background:#1e1f22; color:#e6e6e6; border-radius: 12px;">
      <h2 style="color:#5865f2; margin-top:0;">📨 Novo ticket de suporte — NEXT GAME</h2>
      <p style="color:#949ba4; font-size: 13px; margin-bottom: 4px;">Categoria: <strong style="color:#e6e6e6;">${categoryLabel}</strong></p>
      <p style="color:#949ba4; font-size: 13px; margin-bottom: 16px;">
        De: <strong style="color:#e6e6e6;">${ticket.name || ticket.username || 'Anônimo'}</strong>
        (${ticket.email})${ticket.username ? ` — @${ticket.username}` : ''}
      </p>
      <p style="font-weight:700; font-size: 15px; margin-bottom: 6px;">${ticket.subject}</p>
      <p style="background:#2b2d31; padding: 14px; border-radius: 8px; white-space: pre-wrap; font-size: 13px; line-height: 1.5;">${ticket.message}</p>
      <p style="color:#6d7178; font-size: 12px; margin-top: 20px;">
        Responda pelo painel: nextgameblue.stream/admin.html → aba 📨 Suporte.
      </p>
    </div>
  `.trim();
  const result = await sendEmail({
    to: notifyTo,
    subject: `📨 Novo ticket de suporte: ${ticket.subject}`,
    html,
    text: `Novo ticket de suporte (${categoryLabel})\nDe: ${ticket.name || ticket.username || 'Anônimo'} (${ticket.email})\n\n${ticket.subject}\n\n${ticket.message}`,
  });
  if (!result.sent) {
    console.warn('[mailer] Falha ao avisar por e-mail sobre ticket novo (o ticket já foi salvo normal):', result);
  }
  return result;
}

module.exports = {
  sendEmail,
  sendVerificationEmail,
  generateVerificationCode,
  sendPasswordResetEmail,
  sendBackupEmailCode,
  sendAccountRecoveryCode,
  sendSupportTicketNotification,
};
