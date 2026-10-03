// Base de datos: Postgres en producción (DATABASE_URL) y PGlite en local,
// así se puede probar todo sin instalar nada.
import pg from 'pg';
import { fileURLToPath } from 'node:url';

let impl;
export let tipoDb = 'pglite';

export async function iniciarDb() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const local = /localhost|127\.0\.0\.1|railway\.internal/.test(url);
    const ssl = process.env.DATABASE_SSL === 'false' || local ? false : { rejectUnauthorized: false };
    const pool = new pg.Pool({ connectionString: url, ssl, max: 10 });
    tipoDb = 'postgres';
    impl = {
      query: (sql, params) => pool.query(sql, params),
      tx: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query('begin');
          const r = await fn({ query: (s, p) => c.query(s, p) });
          await c.query('commit');
          return r;
        } catch (e) {
          await c.query('rollback').catch(() => {});
          throw e;
        } finally {
          c.release();
        }
      },
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite(process.env.PGLITE_DIR || fileURLToPath(new URL('../.datos', import.meta.url)));
    impl = {
      query: (sql, params) => db.query(sql, params),
      tx: (fn) => db.transaction((t) => fn({ query: (s, p) => t.query(s, p) })),
    };
    console.log('Usando PGlite local (./.datos). Para producción definí DATABASE_URL.');
  }
  await migrar();
}

export const q = (sql, params) => impl.query(sql, params);
export const tx = (fn) => impl.tx(fn);

async function migrar() {
  const sentencias = [
    `create table if not exists usuarios (
      id serial primary key,
      email text unique not null,
      nombre text not null,
      apellido text not null,
      documento text,
      domicilio text,
      telefono text,
      cbu text,
      hash text not null,
      rol text not null default 'inversor',
      email_ok boolean not null default false,
      creado timestamptz not null default now()
    )`,
    `create table if not exists sesiones (
      token text primary key,
      usuario_id int not null references usuarios(id) on delete cascade,
      vence timestamptz not null
    )`,
    `create table if not exists tokens_mail (
      token text primary key,
      usuario_id int not null references usuarios(id) on delete cascade,
      tipo text not null,
      vence timestamptz not null,
      usado boolean not null default false
    )`,
    `create table if not exists config (
      clave text primary key,
      valor text not null
    )`,
    `create table if not exists unidades (
      id serial primary key,
      nombre text not null,
      piso int,
      tipologia text,
      m2 numeric(8,2),
      cuotapartes bigint not null,
      estado text not null default 'disponible',
      orden int not null default 0
    )`,
    // usd_cents: monto en centavos de dólar. cp_micro: cuotapartes × 1.000.000.
    // estado: firma_pendiente → (revision) → confirmada | rechazada | vencida | cancelada
    `create table if not exists operaciones (
      id serial primary key,
      usuario_id int not null references usuarios(id),
      tipo text not null check (tipo in ('deposito','compra','venta','retiro')),
      usd_cents bigint not null default 0,
      comision_cents bigint not null default 0,
      cp_micro bigint not null default 0,
      precio numeric(14,6),
      estado text not null,
      referencia text,
      nota_admin text,
      firma_token text unique,
      firma_vence timestamptz,
      contrato text,
      contrato_hash text,
      firmado timestamptz,
      firmado_ip text,
      firmado_agente text,
      creado timestamptz not null default now(),
      resuelto timestamptz
    )`,
    // Pesos: moneda del dinero que entra o sale, monto en pesos y dólar MEP usado.
    `alter table operaciones add column if not exists moneda text not null default 'USD'`,
    `alter table operaciones add column if not exists ars_cents bigint`,
    `alter table operaciones add column if not exists tipo_cambio numeric(14,4)`,
    // Firma dentro de la plataforma con código enviado por mail.
    `alter table operaciones add column if not exists codigo_hash text`,
    `alter table operaciones add column if not exists codigo_vence timestamptz`,
    `alter table operaciones add column if not exists codigo_intentos int not null default 0`,
    // Cuenta propia desde la que se transfiere un depósito (tiene que ser del titular).
    `alter table operaciones add column if not exists cuenta_origen text`,
    // usuarios.cbu = cuenta en pesos; cbu_usd = cuenta en dólares. Ambas a nombre del titular.
    `alter table usuarios add column if not exists cbu_usd text`,
    `create table if not exists cotizaciones (
      fecha date primary key,
      compra numeric(14,4) not null,
      venta numeric(14,4) not null,
      actualizado timestamptz not null default now()
    )`,
    `create index if not exists operaciones_usuario on operaciones(usuario_id)`,
    `create index if not exists operaciones_estado on operaciones(estado)`,
  ];
  for (const s of sentencias) await q(s);

  const { rows } = await q('select count(*)::int as n from unidades');
  if (Number(rows[0].n) === 0) {
    // Unidades de ejemplo para arrancar: se editan desde /admin.
    const tipos = [
      ['A', '2 ambientes', 48, 70000],
      ['B', '3 ambientes', 68, 95000],
    ];
    let orden = 0;
    for (let piso = 1; piso <= 4; piso++) {
      for (const [letra, tip, m2, cp] of tipos) {
        await q(
          'insert into unidades (nombre, piso, tipologia, m2, cuotapartes, orden) values ($1,$2,$3,$4,$5,$6)',
          [`${piso}°${letra}`, piso, tip, m2, cp, orden++],
        );
      }
    }
  }
}
