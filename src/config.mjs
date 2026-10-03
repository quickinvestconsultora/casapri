import { q } from './db.mjs';

export const DEFAULTS = {
  nombre_proyecto: 'Edificio Casapri I',
  ciudad: 'Mar del Plata',
  valor_inicial: '1',
  tasa_anual: '0.09',
  fecha_inicio: '2026-10-01',
  fecha_fin: '2030-10-01',
  comision_retiro: '0.005',
  min_compra_usd: '100',
  venta_requiere_aprobacion: '1',
  firma_horas: '48',
  emisor: 'Casadei & Pringles',
  garante: 'Lucorin Avicola Mdp S.R.L.',
  banco_titular: '',
  banco_nombre: '',
  banco_cbu: '',
  banco_alias: '',
  banco_ars_titular: '',
  banco_ars_nombre: '',
  banco_ars_cbu: '',
  banco_ars_alias: '',
  usdt_red: '',
  usdt_direccion: '',
  mep_manual: '',
};

const NUMERICAS = ['valor_inicial', 'tasa_anual', 'comision_retiro', 'min_compra_usd', 'firma_horas', 'mep_manual'];

export async function leerConfig() {
  const { rows } = await q('select clave, valor from config');
  const cfg = { ...DEFAULTS };
  for (const r of rows) if (r.clave in DEFAULTS) cfg[r.clave] = r.valor;
  for (const k of NUMERICAS) cfg[k] = Number(cfg[k]);
  cfg.venta_requiere_aprobacion = cfg.venta_requiere_aprobacion === '1' || cfg.venta_requiere_aprobacion === true;
  return cfg;
}

export async function guardarConfig(cambios) {
  for (const [k, v] of Object.entries(cambios)) {
    if (!(k in DEFAULTS)) continue;
    let valor = typeof v === 'boolean' ? (v ? '1' : '0') : String(v ?? '').trim();
    if (NUMERICAS.includes(k) && !Number.isFinite(Number(valor))) throw new Error(`Valor inválido para ${k}`);
    if ((k === 'fecha_inicio' || k === 'fecha_fin') && !/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
      throw new Error(`Fecha inválida para ${k} (usar AAAA-MM-DD)`);
    }
    await q(
      'insert into config (clave, valor) values ($1,$2) on conflict (clave) do update set valor = excluded.valor',
      [k, valor],
    );
  }
}
