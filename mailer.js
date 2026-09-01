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

module.exports = { sendEmail, sendVerificationEmail, generateVerificationCode, sendPasswordResetEmail };
