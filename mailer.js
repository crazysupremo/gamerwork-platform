// mailer.js - envio de e-mail de verificação via Resend (https://resend.com)
//
// Configuração (variáveis de ambiente):
//   RESEND_API_KEY - obrigatória pra enviar de verdade. Sem ela, o código
//                     só aparece no log do servidor (modo desenvolvimento).
//   EMAIL_FROM      - remetente. Padrão usa o domínio de testes do Resend
//                     (onboarding@resend.dev), que só entrega pro e-mail com
//                     que você criou a conta Resend. Pra mandar pra qualquer
//                     pessoa, verifique um domínio próprio no painel do
//                     Resend e troque essa variável.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.EMAIL_FROM || 'NEXT GAME <onboarding@resend.dev>';

async function sendVerificationEmail(to, code) {
  if (!RESEND_API_KEY) {
    console.log(`[DEV] RESEND_API_KEY não configurada — código de verificação para ${to}: ${code}`);
    return { sent: false, dev: true };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to,
        subject: 'Seu código de confirmação — NEXT GAME',
        html: `
          <div style="font-family: sans-serif; max-width: 420px; margin: 0 auto;">
            <h2 style="color:#5865f2;">NEXT GAME</h2>
            <p>Use o código abaixo para confirmar seu e-mail:</p>
            <p style="font-size: 32px; font-weight: 700; letter-spacing: 6px; text-align: center; background: #f4f4f7; padding: 16px; border-radius: 8px;">${code}</p>
            <p style="color: #666; font-size: 13px;">Esse código expira em 15 minutos. Se você não pediu isso, pode ignorar este e-mail.</p>
          </div>
        `,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error('Erro ao enviar e-mail via Resend:', res.status, text);
      return { sent: false };
    }
    return { sent: true };
  } catch (err) {
    console.error('Erro de rede ao enviar e-mail via Resend:', err.message);
    return { sent: false };
  }
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 dígitos
}

module.exports = { sendVerificationEmail, generateCode };
