// Envío de mails con Resend (API HTTPS). Sin RESEND_API_KEY, los mails se
// muestran en la consola para poder probar en local.

const MARCA = '#0E3B43';

export async function enviarMail({ para, asunto, html, texto }) {
  const key = process.env.RESEND_API_KEY;
  const desde = process.env.MAIL_FROM || 'Casapri <onboarding@resend.dev>';
  if (!key) {
    console.log(`\n[mail sin enviar: falta RESEND_API_KEY]\nPara: ${para}\nAsunto: ${asunto}\n${texto || html.replace(/<[^>]+>/g, ' ')}\n`);
    return { simulado: true };
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: desde, to: Array.isArray(para) ? para : [para], subject: asunto, html, text: texto }),
  });
  if (!r.ok) {
    const err = await r.text();
    console.error('Error enviando mail', r.status, err);
    throw new Error('No se pudo enviar el mail. Probá de nuevo en unos minutos.');
  }
  return r.json();
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function plantilla({ titulo, parrafos = [], boton, pie, pre }) {
  return `<!doctype html><html><body style="margin:0;background:#FAF7F2;font-family:Arial,Helvetica,sans-serif;color:#1D2A2E">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
  <table width="100%" style="max-width:560px;background:#fff;border-radius:12px;border:1px solid #E7E1D6" cellpadding="0" cellspacing="0">
  <tr><td style="background:${MARCA};color:#fff;padding:18px 24px;border-radius:12px 12px 0 0;font-size:20px;font-weight:bold;letter-spacing:.5px">casapri</td></tr>
  <tr><td style="padding:24px">
    <h1 style="font-size:20px;margin:0 0 12px">${esc(titulo)}</h1>
    ${parrafos.map((p) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${esc(p)}</p>`).join('')}
    ${pre ? `<pre style="white-space:pre-wrap;font-family:Georgia,serif;font-size:13px;line-height:1.5;background:#FAF7F2;border:1px solid #E7E1D6;border-radius:8px;padding:14px">${esc(pre)}</pre>` : ''}
    ${boton ? `<p style="margin:20px 0"><a href="${esc(boton.url)}" style="background:${MARCA};color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;display:inline-block">${esc(boton.texto)}</a></p>
    <p style="font-size:12px;color:#6B7B80">Si el botón no funciona, copiá este enlace: ${esc(boton.url)}</p>` : ''}
    ${pie ? `<p style="font-size:12px;color:#6B7B80;margin-top:20px">${esc(pie)}</p>` : ''}
  </td></tr></table></td></tr></table></body></html>`;
}
