export const LOGO = `<svg viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="10" fill="#0E3B43"/><rect x="8.5" y="21" width="6.5" height="11" rx="1.6" fill="#E9C46A"/><rect x="16.75" y="14" width="6.5" height="18" rx="1.6" fill="#F4E9D8"/><rect x="25" y="7" width="6.5" height="25" rx="1.6" fill="#2A9D8F"/><rect x="18.6" y="17.5" width="2.8" height="2.8" rx=".5" fill="#0E3B43" opacity=".35"/><rect x="18.6" y="23" width="2.8" height="2.8" rx=".5" fill="#0E3B43" opacity=".35"/></svg>`;

export const marcaHtml = `<a class="marca" href="/">${LOGO}<b>casapri</b></a>`;

export async function api(url, { method, body } = {}) {
  const r = await fetch('/api' + url, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(d.error || 'Error de conexión.');
    e.status = r.status;
    throw e;
  }
  return d;
}

const nf = (min, max) => new Intl.NumberFormat('es-AR', { minimumFractionDigits: min, maximumFractionDigits: max });
const f2 = nf(2, 2), f0 = nf(0, 0), fcp = nf(0, 4), f6 = nf(6, 6);
export const usd = (n) => 'US$ ' + f2.format(n || 0);
export const usd0 = (n) => 'US$ ' + f0.format(n || 0);
export const cp = (n) => fcp.format(n || 0);
export const precio = (n) => 'US$ ' + f6.format(n || 0);
export const pct = (n, d = 2) => nf(0, d).format((n || 0) * 100) + '%';
export const fecha = (s) => (s ? new Date(s.length === 10 ? s + 'T12:00:00' : s).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fechaHora = (s) => (s ? new Date(s).toLocaleString('es-AR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const TIPOS = { deposito: 'Depósito', compra: 'Compra', venta: 'Venta', retiro: 'Retiro' };
export const ESTADOS = { firma_pendiente: 'Falta firmar', revision: 'En revisión', confirmada: 'Confirmada', rechazada: 'Rechazada', vencida: 'Vencida', cancelada: 'Cancelada' };
export const etiquetaEstado = (e) => `<span class="etiqueta ${e}">${ESTADOS[e] || e}</span>`;

export function toast(msg, error = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (error ? ' error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), error ? 6000 : 3500);
}

export function modal(html) {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="caja">${html}</div>`;
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-cerrar]')) m.remove(); });
  document.body.appendChild(m);
  return m;
}

export async function verContrato(id) {
  try {
    const c = await api(`/operaciones/${id}/contrato`);
    modal(`<h3>Contrato N° ${c.id}</h3>
      <div class="contrato">${esc(c.contrato)}</div>
      <p class="chico tenue" style="margin-top:12px">${c.firmado ? `Firmado el ${fechaHora(c.firmado)} desde IP ${esc(c.firmado_ip)}` : 'Todavía sin firmar'} · SHA-256 ${esc(c.contrato_hash)}</p>
      <button class="btn sec" data-cerrar>Cerrar</button>`);
  } catch (e) { toast(e.message, true); }
}

// Envía un formulario con el botón deshabilitado mientras tanto.
export async function conBoton(boton, fn) {
  const txt = boton.textContent;
  boton.disabled = true;
  boton.textContent = 'Un momento…';
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { boton.disabled = false; boton.textContent = txt; }
}
