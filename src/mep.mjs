// Cotización del dólar MEP. Se toma de dolarapi.com (valor de venta) y se guarda
// una por día; si la API no responde se usa la última guardada. Desde /admin se
// puede fijar un valor manual (config mep_manual) que tiene prioridad.
import { q } from './db.mjs';
import { hoyAR } from './precio.mjs';

let cache = null; // { valor, fecha, fuente, leido }

async function traerDeApi() {
  const r = await fetch('https://dolarapi.com/v1/dolares/bolsa', { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('dolarapi ' + r.status);
  const d = await r.json();
  const valor = Number(d.venta);
  if (!(valor > 0)) throw new Error('cotización inválida');
  await q(
    `insert into cotizaciones (fecha, compra, venta, actualizado) values ($1,$2,$3, now())
     on conflict (fecha) do update set compra = excluded.compra, venta = excluded.venta, actualizado = now()`,
    [hoyAR(), Number(d.compra) || valor, valor],
  );
  return { valor, fecha: d.fechaActualizacion || new Date().toISOString(), fuente: 'dolarapi' };
}

export async function mepHoy(cfg) {
  if (cfg?.mep_manual > 0) return { valor: cfg.mep_manual, fecha: new Date().toISOString(), fuente: 'manual' };
  if (cache && Date.now() - cache.leido < 15 * 60000) return cache;
  try {
    cache = { ...(await traerDeApi()), leido: Date.now() };
  } catch (e) {
    console.error('No se pudo leer el MEP:', e.message);
    const { rows } = await q('select fecha::text as fecha, venta::float8 as venta from cotizaciones order by fecha desc limit 1');
    if (!rows[0]) return null;
    cache = { valor: Number(rows[0].venta), fecha: rows[0].fecha, fuente: 'guardada', leido: Date.now() - 10 * 60000 };
  }
  return cache;
}
