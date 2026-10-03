// Valor de la cuotaparte: crece día a día con interés compuesto a la tasa anual.
// precio(d) = valor_inicial × (1 + tasa)^(días desde el inicio / 365)

const DIA = 86400000;

// Fecha de hoy en Argentina, como AAAA-MM-DD.
export function hoyAR(fecha = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(fecha);
}

const aUTC = (iso) => Date.parse(iso + 'T00:00:00Z');

export function diasEntre(desdeIso, hastaIso) {
  return Math.round((aUTC(hastaIso) - aUTC(desdeIso)) / DIA);
}

export function precioEnFecha(cfg, iso) {
  const total = diasEntre(cfg.fecha_inicio, cfg.fecha_fin);
  const dias = Math.min(Math.max(0, diasEntre(cfg.fecha_inicio, iso)), Math.max(total, 0));
  return redondear6(cfg.valor_inicial * Math.pow(1 + cfg.tasa_anual, dias / 365));
}

export const precioHoy = (cfg) => precioEnFecha(cfg, hoyAR());
export const precioFinal = (cfg) => precioEnFecha(cfg, cfg.fecha_fin);

export function redondear6(n) {
  return Math.round(n * 1e6) / 1e6;
}

// Un punto por mes desde el inicio hasta el fin, para el gráfico.
export function serie(cfg) {
  const puntos = [];
  const [a, m, d] = cfg.fecha_inicio.split('-').map(Number);
  for (let i = 0; ; i++) {
    const f = new Date(Date.UTC(a, m - 1 + i, d)).toISOString().slice(0, 10);
    if (f > cfg.fecha_fin) break;
    puntos.push({ fecha: f, precio: precioEnFecha(cfg, f) });
    if (i > 240) break;
  }
  if (puntos.at(-1)?.fecha !== cfg.fecha_fin) puntos.push({ fecha: cfg.fecha_fin, precio: precioFinal(cfg) });
  return puntos;
}

export function avance(cfg) {
  const total = diasEntre(cfg.fecha_inicio, cfg.fecha_fin);
  const hechos = diasEntre(cfg.fecha_inicio, hoyAR());
  return total > 0 ? Math.min(1, Math.max(0, hechos / total)) : 0;
}
