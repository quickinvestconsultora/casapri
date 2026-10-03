import express from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { q, tx } from './db.mjs';
import { leerConfig, guardarConfig } from './config.mjs';
import { precioHoy, precioFinal, serie, avance, hoyAR } from './precio.mjs';
import { enviarMail, plantilla } from './mail.mjs';
import { textoContrato, hashContrato } from './contratos.mjs';

class ErrorUsuario extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

const n = (v) => (v == null ? 0 : Number(v));
const aCents = (usd) => Math.round(Number(usd) * 100);
const aMicro = (cp) => Math.round(Number(cp) * 1e6);
const token = () => crypto.randomBytes(32).toString('base64url');
const esProd = process.env.NODE_ENV === 'production';
const admins = () => (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const fUsd = (c) => 'US$ ' + (c / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fCp = (m) => (m / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 4 });
const TIPOS = { deposito: 'Depósito', compra: 'Compra', venta: 'Venta', retiro: 'Retiro' };

function baseUrl(req) {
  return process.env.APP_URL?.replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
}

// ───────── límites de intentos (en memoria) ─────────
const intentos = new Map();
function limitar(clave, max, ventanaMs) {
  const ahora = Date.now();
  const lista = (intentos.get(clave) || []).filter((t) => ahora - t < ventanaMs);
  if (lista.length >= max) throw new ErrorUsuario('Demasiados intentos. Esperá unos minutos.', 429);
  lista.push(ahora);
  intentos.set(clave, lista);
}

// ───────── sesión ─────────
function leerCookie(req, nombre) {
  const c = req.headers.cookie || '';
  const m = c.split(';').map((s) => s.trim()).find((s) => s.startsWith(nombre + '='));
  return m ? decodeURIComponent(m.slice(nombre.length + 1)) : null;
}

async function crearSesion(res, usuarioId) {
  const t = token();
  await q("insert into sesiones (token, usuario_id, vence) values ($1,$2, now() + interval '30 days')", [t, usuarioId]);
  res.cookie('sid', t, { httpOnly: true, sameSite: 'lax', secure: esProd, maxAge: 30 * 86400000, path: '/' });
}

async function auth(req, res, next) {
  const t = leerCookie(req, 'sid');
  if (!t) return res.status(401).json({ error: 'Tenés que ingresar.' });
  const { rows } = await q(
    'select u.* from sesiones s join usuarios u on u.id = s.usuario_id where s.token = $1 and s.vence > now()',
    [t],
  );
  if (!rows[0]) return res.status(401).json({ error: 'Tu sesión venció. Ingresá de nuevo.' });
  req.usuario = rows[0];
  next();
}

const soloAdmin = (req, res, next) =>
  req.usuario.rol === 'admin' ? next() : res.status(403).json({ error: 'Solo administradores.' });

function exigirOperable(u) {
  if (!u.email_ok) throw new ErrorUsuario('Primero confirmá tu mail (te mandamos un enlace al registrarte).');
  if (!u.documento || !u.domicilio) throw new ErrorUsuario('Completá tu DNI/CUIT y domicilio en «Mi perfil» para poder firmar contratos.');
}

const publico = (u) => ({
  id: u.id, email: u.email, nombre: u.nombre, apellido: u.apellido, documento: u.documento,
  domicilio: u.domicilio, telefono: u.telefono, cbu: u.cbu, rol: u.rol, email_ok: u.email_ok,
});

// ───────── posiciones ─────────
async function vencerFirmas(db) {
  await db.query("update operaciones set estado = 'vencida', resuelto = now() where estado = 'firma_pendiente' and firma_vence < now()");
}

async function posicion(db, usuarioId) {
  const { rows } = await db.query(
    `select tipo, estado, coalesce(sum(usd_cents),0)::float8 as usd, coalesce(sum(cp_micro),0)::float8 as cp
       from operaciones where usuario_id = $1 group by tipo, estado`,
    [usuarioId],
  );
  const suma = (tipo, estados, campo) =>
    rows.filter((r) => r.tipo === tipo && estados.includes(r.estado)).reduce((a, r) => a + n(r[campo]), 0);
  const saldo =
    suma('deposito', ['confirmada'], 'usd') -
    suma('compra', ['confirmada', 'firma_pendiente'], 'usd') +
    suma('venta', ['confirmada'], 'usd') -
    suma('retiro', ['confirmada', 'revision', 'firma_pendiente'], 'usd');
  const cp = suma('compra', ['confirmada'], 'cp') - suma('venta', ['confirmada', 'revision', 'firma_pendiente'], 'cp');
  return { saldo_cents: Math.round(saldo), cp_micro: Math.round(cp) };
}

async function cuotapartesDisponibles(db) {
  const tot = await db.query("select coalesce(sum(cuotapartes),0)::float8 as t from unidades where estado <> 'retirada'");
  const em = await db.query(
    `select coalesce(sum(case when tipo='compra' and estado in ('confirmada','firma_pendiente') then cp_micro
                              when tipo='venta' and estado='confirmada' then -cp_micro else 0 end),0)::float8 as e
       from operaciones`,
  );
  const total = n(tot.rows[0].t) * 1e6;
  const emitidas = n(em.rows[0].e);
  return { total, emitidas, disponibles: total - emitidas };
}

// Costo promedio de las cuotapartes que tiene hoy, para calcular la ganancia.
function costoPromedio(ops) {
  let cp = 0, costo = 0;
  const conf = ops.filter((o) => o.estado === 'confirmada' && (o.tipo === 'compra' || o.tipo === 'venta'))
    .sort((a, b) => new Date(a.resuelto || a.creado) - new Date(b.resuelto || b.creado));
  for (const o of conf) {
    if (o.tipo === 'compra') { cp += n(o.cp_micro); costo += n(o.usd_cents); }
    else if (cp > 0) { const f = Math.min(1, n(o.cp_micro) / cp); costo -= costo * f; cp -= n(o.cp_micro); }
  }
  return Math.max(0, Math.round(costo));
}

function opPublica(o) {
  return {
    id: o.id, tipo: o.tipo, estado: o.estado, usd: n(o.usd_cents) / 100, comision: n(o.comision_cents) / 100,
    cp: n(o.cp_micro) / 1e6, precio: o.precio == null ? null : Number(o.precio), referencia: o.referencia,
    nota_admin: o.nota_admin, creado: o.creado, resuelto: o.resuelto, firmado: o.firmado,
    firma_vence: o.firma_vence, tiene_contrato: !!o.contrato,
  };
}

// ───────── mails ─────────
async function mandarVerificacion(req, u) {
  const t = token();
  await q("insert into tokens_mail (token, usuario_id, tipo, vence) values ($1,$2,'verificar', now() + interval '3 days')", [t, u.id]);
  const url = `${baseUrl(req)}/api/verificar?token=${t}`;
  await enviarMail({
    para: u.email,
    asunto: 'Confirmá tu mail — Casapri',
    html: plantilla({ titulo: `Hola ${u.nombre}`, parrafos: ['Confirmá tu correo para empezar a operar. Por este mail vas a recibir y firmar tus contratos.'], boton: { texto: 'Confirmar mi mail', url } }),
    texto: `Confirmá tu mail: ${url}`,
  });
  return url;
}

async function mandarFirma(req, op, u) {
  const url = `${baseUrl(req)}/firmar?t=${op.firma_token}`;
  const resumen = op.tipo === 'retiro'
    ? `Retiro de ${fUsd(n(op.usd_cents))} (comisión ${fUsd(n(op.comision_cents))}, neto ${fUsd(n(op.usd_cents) - n(op.comision_cents))}).`
    : `${TIPOS[op.tipo]} de ${fCp(n(op.cp_micro))} cuotapartes a US$ ${Number(op.precio).toFixed(6)} por ${fUsd(n(op.usd_cents))}.`;
  await enviarMail({
    para: u.email,
    asunto: `Firmá tu ${TIPOS[op.tipo].toLowerCase()} N° ${op.id} — Casapri`,
    html: plantilla({
      titulo: `Confirmá tu ${TIPOS[op.tipo].toLowerCase()}`,
      parrafos: [resumen, 'Para que la operación sea válida, leé el contrato y firmalo desde el botón. El enlace vence en ' + (await leerConfig()).firma_horas + ' horas.'],
      boton: { texto: 'Leer y firmar el contrato', url },
      pie: 'Si no pediste esta operación, ignorá este mail y avisanos.',
    }),
    texto: `${resumen}\nLeé y firmá el contrato: ${url}`,
  });
  return url;
}

async function avisarAdmins(asunto, linea) {
  const para = admins();
  if (!para.length) return;
  await enviarMail({ para, asunto, html: plantilla({ titulo: asunto, parrafos: [linea, 'Revisalo en el panel de administración.'] }), texto: linea }).catch((e) => console.error(e));
}

// ───────── rutas ─────────
export function rutasApi() {
  const r = express.Router();
  const h = (fn) => async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (e) {
      if (e instanceof ErrorUsuario) return res.status(e.status).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: 'Error interno. Probá de nuevo.' });
    }
  };

  // Los POST/PUT tienen que venir como JSON (protege contra formularios de otros sitios).
  r.use((req, res, next) => {
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'Formato inválido.' });
    }
    next();
  });

  // ── Público ──
  r.get('/publico', h(async (req, res) => {
    const cfg = await leerConfig();
    const precio = precioHoy(cfg);
    const final = precioFinal(cfg);
    const { rows: unidades } = await q("select * from unidades where estado <> 'retirada' order by orden, id");
    const cp = await cuotapartesDisponibles({ query: q });
    const { rows: inv } = await q("select count(distinct usuario_id)::int as n from operaciones where tipo='compra' and estado='confirmada'");
    res.json({
      proyecto: { nombre: cfg.nombre_proyecto, ciudad: cfg.ciudad, emisor: cfg.emisor, garante: cfg.garante },
      parametros: {
        valor_inicial: cfg.valor_inicial, tasa_anual: cfg.tasa_anual, fecha_inicio: cfg.fecha_inicio,
        fecha_fin: cfg.fecha_fin, comision_retiro: cfg.comision_retiro, min_compra_usd: cfg.min_compra_usd,
      },
      hoy: hoyAR(), precio_hoy: precio, precio_final: final, avance_tiempo: avance(cfg), serie: serie(cfg),
      unidades: unidades.map((u) => ({
        id: u.id, nombre: u.nombre, piso: u.piso, tipologia: u.tipologia, m2: u.m2 == null ? null : Number(u.m2),
        cuotapartes: n(u.cuotapartes), estado: u.estado,
        valor_hoy: Math.round(n(u.cuotapartes) * precio * 100) / 100,
        valor_final: Math.round(n(u.cuotapartes) * final * 100) / 100,
      })),
      totales: {
        cuotapartes: cp.total / 1e6, emitidas: cp.emitidas / 1e6, disponibles: cp.disponibles / 1e6,
        inversores: n(inv[0].n), valor_edificio_hoy: Math.round((cp.total / 1e6) * precio * 100) / 100,
      },
    });
  }));

  // ── Cuenta ──
  r.post('/registro', h(async (req, res) => {
    limitar('reg:' + req.ip, 10, 3600000);
    const { nombre, apellido, email, password } = req.body || {};
    const mail = String(email || '').trim().toLowerCase();
    if (!nombre?.trim() || !apellido?.trim()) throw new ErrorUsuario('Completá nombre y apellido.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new ErrorUsuario('El mail no es válido.');
    if (String(password || '').length < 8) throw new ErrorUsuario('La contraseña tiene que tener al menos 8 caracteres.');
    const existe = await q('select 1 from usuarios where email = $1', [mail]);
    if (existe.rows[0]) throw new ErrorUsuario('Ya hay una cuenta con ese mail. Ingresá o recuperá la contraseña.');
    const hash = await bcrypt.hash(password, 11);
    const rol = admins().includes(mail) ? 'admin' : 'inversor';
    const { rows } = await q(
      'insert into usuarios (email, nombre, apellido, hash, rol) values ($1,$2,$3,$4,$5) returning *',
      [mail, nombre.trim(), apellido.trim(), hash, rol],
    );
    await crearSesion(res, rows[0].id);
    const url = await mandarVerificacion(req, rows[0]);
    res.json({ ok: true, ...(!esProd && !process.env.RESEND_API_KEY ? { dev_link: url } : {}) });
  }));

  r.post('/ingresar', h(async (req, res) => {
    const mail = String(req.body?.email || '').trim().toLowerCase();
    limitar('login:' + req.ip, 20, 900000);
    limitar('login:' + mail, 8, 900000);
    const { rows } = await q('select * from usuarios where email = $1', [mail]);
    const u = rows[0];
    if (!u || !(await bcrypt.compare(String(req.body?.password || ''), u.hash))) throw new ErrorUsuario('Mail o contraseña incorrectos.', 401);
    if (u.rol !== 'admin' && admins().includes(mail)) await q("update usuarios set rol='admin' where id=$1", [u.id]);
    await crearSesion(res, u.id);
    res.json({ ok: true });
  }));

  r.post('/salir', h(async (req, res) => {
    const t = leerCookie(req, 'sid');
    if (t) await q('delete from sesiones where token = $1', [t]);
    res.clearCookie('sid', { path: '/' });
    res.json({ ok: true });
  }));

  r.get('/verificar', h(async (req, res) => {
    const { rows } = await q(
      "update tokens_mail set usado = true where token = $1 and tipo = 'verificar' and not usado and vence > now() returning usuario_id",
      [String(req.query.token || '')],
    );
    if (!rows[0]) return res.redirect('/app?verificado=0');
    await q('update usuarios set email_ok = true where id = $1', [rows[0].usuario_id]);
    res.redirect('/app?verificado=1');
  }));

  r.post('/reenviar-verificacion', auth, h(async (req, res) => {
    limitar('verif:' + req.usuario.id, 5, 3600000);
    if (req.usuario.email_ok) return res.json({ ok: true });
    const url = await mandarVerificacion(req, req.usuario);
    res.json({ ok: true, ...(!esProd && !process.env.RESEND_API_KEY ? { dev_link: url } : {}) });
  }));

  r.post('/olvide', h(async (req, res) => {
    limitar('olvide:' + req.ip, 5, 3600000);
    const mail = String(req.body?.email || '').trim().toLowerCase();
    const { rows } = await q('select * from usuarios where email = $1', [mail]);
    let dev;
    if (rows[0]) {
      const t = token();
      await q("insert into tokens_mail (token, usuario_id, tipo, vence) values ($1,$2,'clave', now() + interval '1 hour')", [t, rows[0].id]);
      const url = `${baseUrl(req)}/app#restablecer=${t}`;
      dev = url;
      await enviarMail({
        para: mail, asunto: 'Restablecer contraseña — Casapri',
        html: plantilla({ titulo: 'Restablecer contraseña', parrafos: ['Pediste cambiar tu contraseña. El enlace vale por una hora.'], boton: { texto: 'Elegir nueva contraseña', url }, pie: 'Si no fuiste vos, ignorá este mail.' }),
        texto: `Restablecé tu contraseña: ${url}`,
      });
    }
    res.json({ ok: true, ...(!esProd && !process.env.RESEND_API_KEY && dev ? { dev_link: dev } : {}) });
  }));

  r.post('/restablecer', h(async (req, res) => {
    const { token: t, password } = req.body || {};
    if (String(password || '').length < 8) throw new ErrorUsuario('La contraseña tiene que tener al menos 8 caracteres.');
    const { rows } = await q(
      "update tokens_mail set usado = true where token = $1 and tipo = 'clave' and not usado and vence > now() returning usuario_id",
      [String(t || '')],
    );
    if (!rows[0]) throw new ErrorUsuario('El enlace venció o ya se usó. Pedí uno nuevo.');
    await q('update usuarios set hash = $1, email_ok = true where id = $2', [await bcrypt.hash(password, 11), rows[0].usuario_id]);
    await q('delete from sesiones where usuario_id = $1', [rows[0].usuario_id]);
    await crearSesion(res, rows[0].usuario_id);
    res.json({ ok: true });
  }));

  // ── Inversor ──
  r.get('/yo', auth, h(async (req, res) => {
    const u = req.usuario;
    const cfg = await leerConfig();
    await vencerFirmas({ query: q });
    const pos = await posicion({ query: q }, u.id);
    const { rows: ops } = await q('select * from operaciones where usuario_id = $1 order by creado desc, id desc', [u.id]);
    const precio = precioHoy(cfg);
    const valor = Math.round((pos.cp_micro / 1e6) * precio * 100);
    const costo = costoPromedio(ops);
    const { rows: dep } = await q("select coalesce(sum(usd_cents),0)::float8 as t from operaciones where usuario_id=$1 and tipo='deposito' and estado='confirmada'", [u.id]);
    res.json({
      usuario: publico(u),
      precio_hoy: precio,
      precio_final: precioFinal(cfg),
      parametros: { tasa_anual: cfg.tasa_anual, comision_retiro: cfg.comision_retiro, min_compra_usd: cfg.min_compra_usd, fecha_fin: cfg.fecha_fin, venta_requiere_aprobacion: cfg.venta_requiere_aprobacion },
      banco: { titular: cfg.banco_titular, nombre: cfg.banco_nombre, cbu: cfg.banco_cbu, alias: cfg.banco_alias, usdt_red: cfg.usdt_red, usdt_direccion: cfg.usdt_direccion },
      posicion: {
        saldo: pos.saldo_cents / 100,
        cuotapartes: pos.cp_micro / 1e6,
        valor: valor / 100,
        costo: costo / 100,
        ganancia: (valor - costo) / 100,
        valor_final_estimado: Math.round((pos.cp_micro / 1e6) * precioFinal(cfg) * 100) / 100,
        depositado: n(dep[0].t) / 100,
      },
      operaciones: ops.map(opPublica),
    });
  }));

  r.put('/perfil', auth, h(async (req, res) => {
    const b = req.body || {};
    const limpio = (v, max = 200) => (v == null ? null : String(v).trim().slice(0, max) || null);
    if (!limpio(b.nombre) || !limpio(b.apellido)) throw new ErrorUsuario('Nombre y apellido son obligatorios.');
    await q(
      'update usuarios set nombre=$1, apellido=$2, documento=$3, domicilio=$4, telefono=$5, cbu=$6 where id=$7',
      [limpio(b.nombre), limpio(b.apellido), limpio(b.documento, 30), limpio(b.domicilio), limpio(b.telefono, 40), limpio(b.cbu, 120), req.usuario.id],
    );
    res.json({ ok: true });
  }));

  r.post('/depositos', auth, h(async (req, res) => {
    const u = req.usuario;
    if (!u.email_ok) throw new ErrorUsuario('Primero confirmá tu mail.');
    const cents = aCents(req.body?.usd);
    if (!Number.isFinite(cents) || cents < 100 || cents > 1e10) throw new ErrorUsuario('Monto inválido.');
    const ref = String(req.body?.referencia || '').trim().slice(0, 200);
    if (!ref) throw new ErrorUsuario('Indicá el número de operación o comprobante de la transferencia.');
    const { rows } = await q(
      "insert into operaciones (usuario_id, tipo, usd_cents, estado, referencia) values ($1,'deposito',$2,'revision',$3) returning *",
      [u.id, cents, ref],
    );
    await avisarAdmins(`Nuevo depósito informado: ${fUsd(cents)}`, `${u.nombre} ${u.apellido} (${u.email}) informó una transferencia de ${fUsd(cents)}. Referencia: ${ref}.`);
    res.json({ ok: true, operacion: opPublica(rows[0]) });
  }));

  // Crea una operación que se firma por mail (compra, venta o retiro).
  async function operacionConFirma(req, res, tipo) {
    const u = req.usuario;
    exigirOperable(u);
    const cfg = await leerConfig();
    const precio = precioHoy(cfg);
    const op = await tx(async (db) => {
      await db.query('select pg_advisory_xact_lock(4242)');
      await vencerFirmas(db);
      const pos = await posicion(db, u.id);
      let usd = 0, cp = 0, com = 0, prec = precio;
      if (tipo === 'compra') {
        usd = aCents(req.body?.usd);
        if (!Number.isFinite(usd) || usd <= 0) throw new ErrorUsuario('Monto inválido.');
        if (usd < aCents(cfg.min_compra_usd)) throw new ErrorUsuario(`La compra mínima es de ${fUsd(aCents(cfg.min_compra_usd))}.`);
        if (usd > pos.saldo_cents) throw new ErrorUsuario(`Saldo insuficiente. Tenés ${fUsd(pos.saldo_cents)} disponibles.`);
        cp = Math.floor((usd / 100 / precio) * 1e6);
        const disp = await cuotapartesDisponibles(db);
        if (cp > disp.disponibles) throw new ErrorUsuario(`Solo quedan ${fCp(Math.max(0, disp.disponibles))} cuotapartes disponibles.`);
      } else if (tipo === 'venta') {
        cp = aMicro(req.body?.cp);
        if (!Number.isFinite(cp) || cp <= 0) throw new ErrorUsuario('Cantidad inválida.');
        if (cp > pos.cp_micro) throw new ErrorUsuario(`Tenés ${fCp(pos.cp_micro)} cuotapartes disponibles para vender.`);
        usd = Math.floor((cp / 1e6) * precio * 100);
        if (usd < 1) throw new ErrorUsuario('El monto es demasiado chico.');
      } else {
        if (!u.cbu) throw new ErrorUsuario('Cargá tu CBU/CVU o alias en «Mi perfil» para poder retirar.');
        usd = aCents(req.body?.usd);
        if (!Number.isFinite(usd) || usd < 100) throw new ErrorUsuario('El retiro mínimo es US$ 1.');
        if (usd > pos.saldo_cents) throw new ErrorUsuario(`Saldo insuficiente. Tenés ${fUsd(pos.saldo_cents)} disponibles.`);
        com = Math.round(usd * cfg.comision_retiro);
        prec = null;
      }
      const { rows } = await db.query(
        `insert into operaciones (usuario_id, tipo, usd_cents, comision_cents, cp_micro, precio, estado, firma_token, firma_vence)
         values ($1,$2,$3,$4,$5,$6,'firma_pendiente',$7, now() + make_interval(hours => $8::int)) returning *`,
        [u.id, tipo, usd, com, cp, prec, token(), Math.round(cfg.firma_horas)],
      );
      const op = rows[0];
      const contrato = textoContrato({ tipo, op: { ...op, usd_cents: n(op.usd_cents), comision_cents: n(op.comision_cents), cp_micro: n(op.cp_micro) }, usuario: u, cfg });
      await db.query('update operaciones set contrato = $1, contrato_hash = $2 where id = $3', [contrato, hashContrato(contrato), op.id]);
      return { ...op, contrato };
    });
    const url = await mandarFirma(req, op, u);
    res.json({ ok: true, operacion: opPublica(op), ...(!esProd && !process.env.RESEND_API_KEY ? { dev_link: url } : {}) });
  }

  r.post('/compras', auth, h((req, res) => operacionConFirma(req, res, 'compra')));
  r.post('/ventas', auth, h((req, res) => operacionConFirma(req, res, 'venta')));
  r.post('/retiros', auth, h((req, res) => operacionConFirma(req, res, 'retiro')));

  r.post('/operaciones/:id/cancelar', auth, h(async (req, res) => {
    const { rows } = await q(
      "update operaciones set estado='cancelada', resuelto=now() where id=$1 and usuario_id=$2 and (estado='firma_pendiente' or (tipo='deposito' and estado='revision')) returning id",
      [Number(req.params.id), req.usuario.id],
    );
    if (!rows[0]) throw new ErrorUsuario('Esa operación ya no se puede cancelar.');
    res.json({ ok: true });
  }));

  r.post('/operaciones/:id/reenviar', auth, h(async (req, res) => {
    limitar('reenv:' + req.usuario.id, 6, 3600000);
    const { rows } = await q("select * from operaciones where id=$1 and usuario_id=$2 and estado='firma_pendiente' and firma_vence > now()", [Number(req.params.id), req.usuario.id]);
    if (!rows[0]) throw new ErrorUsuario('Esa operación ya no está esperando firma.');
    const url = await mandarFirma(req, rows[0], req.usuario);
    res.json({ ok: true, ...(!esProd && !process.env.RESEND_API_KEY ? { dev_link: url } : {}) });
  }));

  r.get('/operaciones/:id/contrato', auth, h(async (req, res) => {
    const esAdmin = req.usuario.rol === 'admin';
    const { rows } = await q(
      `select id, tipo, estado, contrato, contrato_hash, firmado, firmado_ip from operaciones where id=$1 ${esAdmin ? '' : 'and usuario_id=$2'}`,
      esAdmin ? [Number(req.params.id)] : [Number(req.params.id), req.usuario.id],
    );
    if (!rows[0]?.contrato) throw new ErrorUsuario('No hay contrato para esa operación.', 404);
    res.json(rows[0]);
  }));

  // ── Firma por mail (el token secreto del mail es la credencial) ──
  r.get('/firma/:token', h(async (req, res) => {
    await vencerFirmas({ query: q });
    const { rows } = await q(
      'select o.*, u.nombre, u.apellido, u.email from operaciones o join usuarios u on u.id=o.usuario_id where o.firma_token=$1',
      [req.params.token],
    );
    const o = rows[0];
    if (!o) throw new ErrorUsuario('El enlace no es válido.', 404);
    res.json({ ...opPublica(o), contrato: o.contrato, contrato_hash: o.contrato_hash, nombre: `${o.nombre} ${o.apellido}`, email: o.email });
  }));

  r.post('/firma/:token', h(async (req, res) => {
    if (req.body?.acepto !== true) throw new ErrorUsuario('Tenés que aceptar el contrato.');
    const cfg = await leerConfig();
    const resultado = await tx(async (db) => {
      await db.query('select pg_advisory_xact_lock(4242)');
      await vencerFirmas(db);
      const { rows } = await db.query('select * from operaciones where firma_token=$1 for update', [req.params.token]);
      const o = rows[0];
      if (!o) throw new ErrorUsuario('El enlace no es válido.', 404);
      if (o.estado !== 'firma_pendiente') throw new ErrorUsuario(o.estado === 'vencida' ? 'El enlace venció. Volvé a hacer la operación.' : 'Esta operación ya fue firmada o cancelada.');
      const nuevo = o.tipo === 'compra' ? 'confirmada' : o.tipo === 'venta' ? (cfg.venta_requiere_aprobacion ? 'revision' : 'confirmada') : 'revision';
      const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
      const { rows: act } = await db.query(
        `update operaciones set estado=$1, firmado=now(), firmado_ip=$2, firmado_agente=$3, resuelto = case when $1='confirmada' then now() else null end
          where id=$4 returning *`,
        [nuevo, ip, String(req.headers['user-agent'] || '').slice(0, 300), o.id],
      );
      return act[0];
    });
    const { rows: us } = await q('select * from usuarios where id=$1', [resultado.usuario_id]);
    const u = us[0];
    await enviarMail({
      para: u.email,
      asunto: `Contrato firmado: ${TIPOS[resultado.tipo].toLowerCase()} N° ${resultado.id}`,
      html: plantilla({
        titulo: 'Tu contrato quedó firmado',
        parrafos: [
          `Firmaste el ${new Date(resultado.firmado).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })} desde la IP ${resultado.firmado_ip}.`,
          resultado.estado === 'confirmada' ? 'La operación ya está confirmada.' : 'La operación quedó en revisión; te avisamos cuando se complete.',
          `Código de verificación del contrato (SHA-256): ${resultado.contrato_hash}`,
        ],
        pre: resultado.contrato,
      }),
      texto: resultado.contrato,
    }).catch((e) => console.error(e));
    if (resultado.estado === 'revision') {
      await avisarAdmins(`${TIPOS[resultado.tipo]} para aprobar: N° ${resultado.id}`, `${u.nombre} ${u.apellido} firmó ${TIPOS[resultado.tipo].toLowerCase()} por ${fUsd(n(resultado.usd_cents))}.`);
    }
    res.json({ ok: true, estado: resultado.estado });
  }));

  // ── Admin ──
  r.get('/admin/resumen', auth, soloAdmin, h(async (req, res) => {
    await vencerFirmas({ query: q });
    const cfg = await leerConfig();
    const precio = precioHoy(cfg);
    const { rows: pend } = await q(
      "select o.*, u.nombre, u.apellido, u.email, u.cbu from operaciones o join usuarios u on u.id=o.usuario_id where o.estado='revision' order by o.creado",
    );
    const { rows: tot } = await q(
      `select tipo, coalesce(sum(usd_cents),0)::float8 as usd, coalesce(sum(comision_cents),0)::float8 as com, coalesce(sum(cp_micro),0)::float8 as cp, count(*)::int as n
         from operaciones where estado='confirmada' group by tipo`,
    );
    const t = Object.fromEntries(tot.map((x) => [x.tipo, x]));
    const cp = await cuotapartesDisponibles({ query: q });
    const { rows: us } = await q('select count(*)::int as n, count(*) filter (where email_ok)::int as v from usuarios');
    const { rows: mensual } = await q(
      `select to_char(date_trunc('month', resuelto), 'YYYY-MM') as mes, tipo, coalesce(sum(usd_cents),0)::float8 as usd
         from operaciones where estado='confirmada' and resuelto is not null group by 1,2 order by 1`,
    );
    const g = (k, c = 'usd') => n(t[k]?.[c]);
    res.json({
      precio_hoy: precio,
      pendientes: pend.map((o) => ({ ...opPublica(o), nombre: `${o.nombre} ${o.apellido}`, email: o.email, cbu: o.cbu })),
      stats: {
        usuarios: n(us[0].n), verificados: n(us[0].v),
        depositado: g('deposito') / 100, retirado: g('retiro') / 100, comisiones: g('retiro', 'com') / 100,
        comprado: g('compra') / 100, vendido: g('venta') / 100,
        fondos_en_custodia: (g('deposito') - g('retiro')) / 100,
        capital_en_obra: (g('compra') - g('venta')) / 100,
        cp_total: cp.total / 1e6, cp_emitidas: cp.emitidas / 1e6,
        pasivo_a_valor_hoy: Math.round(((g('compra', 'cp') - g('venta', 'cp')) / 1e6) * precio * 100) / 100,
      },
      mensual: mensual.map((m) => ({ mes: m.mes, tipo: m.tipo, usd: n(m.usd) / 100 })),
    });
  }));

  r.get('/admin/inversores', auth, soloAdmin, h(async (req, res) => {
    const cfg = await leerConfig();
    const precio = precioHoy(cfg);
    const { rows } = await q('select * from usuarios order by creado desc');
    const lista = [];
    for (const u of rows) {
      const p = await posicion({ query: q }, u.id);
      lista.push({ ...publico(u), creado: u.creado, saldo: p.saldo_cents / 100, cuotapartes: p.cp_micro / 1e6, valor: Math.round((p.cp_micro / 1e6) * precio * 100) / 100 });
    }
    res.json(lista);
  }));

  r.get('/admin/operaciones', auth, soloAdmin, h(async (req, res) => {
    const { rows } = await q(
      'select o.*, u.nombre, u.apellido, u.email from operaciones o join usuarios u on u.id=o.usuario_id order by o.creado desc limit 500',
    );
    res.json(rows.map((o) => ({ ...opPublica(o), nombre: `${o.nombre} ${o.apellido}`, email: o.email })));
  }));

  r.post('/admin/operaciones/:id/:accion', auth, soloAdmin, h(async (req, res) => {
    const { id, accion } = req.params;
    if (!['aprobar', 'rechazar'].includes(accion)) throw new ErrorUsuario('Acción inválida.');
    const nota = String(req.body?.nota || '').trim().slice(0, 500) || null;
    const op = await tx(async (db) => {
      await db.query('select pg_advisory_xact_lock(4242)');
      const { rows } = await db.query("select * from operaciones where id=$1 and estado='revision' for update", [Number(id)]);
      const o = rows[0];
      if (!o) throw new ErrorUsuario('La operación ya no está pendiente.');
      let usd = n(o.usd_cents);
      if (accion === 'aprobar' && o.tipo === 'deposito' && req.body?.usd != null) {
        usd = aCents(req.body.usd);
        if (!Number.isFinite(usd) || usd <= 0) throw new ErrorUsuario('Monto inválido.');
      }
      const { rows: act } = await db.query(
        'update operaciones set estado=$1, nota_admin=$2, usd_cents=$3, resuelto=now() where id=$4 returning *',
        [accion === 'aprobar' ? 'confirmada' : 'rechazada', nota, usd, o.id],
      );
      return act[0];
    });
    const { rows: us } = await q('select * from usuarios where id=$1', [op.usuario_id]);
    const textos = {
      deposito: `acreditamos tu depósito de ${fUsd(n(op.usd_cents))}. Ya podés comprar cuotapartes.`,
      venta: `se aprobó tu venta de ${fCp(n(op.cp_micro))} cuotapartes. Se acreditaron ${fUsd(n(op.usd_cents))} en tu saldo.`,
      retiro: `transferimos tu retiro: ${fUsd(n(op.usd_cents) - n(op.comision_cents))} netos a ${us[0].cbu}.`,
    };
    const linea = accion === 'aprobar' ? `Hola ${us[0].nombre}, ${textos[op.tipo]}` : `Hola ${us[0].nombre}, tu ${TIPOS[op.tipo].toLowerCase()} N° ${op.id} fue rechazado/a.${nota ? ' Motivo: ' + nota : ''}`;
    await enviarMail({ para: us[0].email, asunto: `${TIPOS[op.tipo]} N° ${op.id}: ${accion === 'aprobar' ? 'listo' : 'rechazado'}`, html: plantilla({ titulo: TIPOS[op.tipo], parrafos: [linea] }), texto: linea }).catch((e) => console.error(e));
    res.json({ ok: true });
  }));

  r.get('/admin/config', auth, soloAdmin, h(async (req, res) => res.json(await leerConfig())));
  r.put('/admin/config', auth, soloAdmin, h(async (req, res) => {
    try {
      await guardarConfig(req.body || {});
    } catch (e) {
      throw new ErrorUsuario(e.message);
    }
    res.json(await leerConfig());
  }));

  r.get('/admin/unidades', auth, soloAdmin, h(async (req, res) => {
    const { rows } = await q('select * from unidades order by orden, id');
    res.json(rows.map((u) => ({ ...u, cuotapartes: n(u.cuotapartes), m2: u.m2 == null ? null : Number(u.m2) })));
  }));

  r.post('/admin/unidades', auth, soloAdmin, h(async (req, res) => {
    const b = req.body || {};
    if (!b.nombre || !(Number(b.cuotapartes) > 0)) throw new ErrorUsuario('Nombre y cuotapartes son obligatorios.');
    const { rows } = await q(
      'insert into unidades (nombre, piso, tipologia, m2, cuotapartes, estado, orden) values ($1,$2,$3,$4,$5,$6,$7) returning id',
      [b.nombre, b.piso || null, b.tipologia || null, b.m2 || null, Math.round(Number(b.cuotapartes)), b.estado || 'disponible', Number(b.orden) || 0],
    );
    res.json({ ok: true, id: rows[0].id });
  }));

  r.put('/admin/unidades/:id', auth, soloAdmin, h(async (req, res) => {
    const b = req.body || {};
    if (!b.nombre || !(Number(b.cuotapartes) > 0)) throw new ErrorUsuario('Nombre y cuotapartes son obligatorios.');
    await q(
      'update unidades set nombre=$1, piso=$2, tipologia=$3, m2=$4, cuotapartes=$5, estado=$6, orden=$7 where id=$8',
      [b.nombre, b.piso || null, b.tipologia || null, b.m2 || null, Math.round(Number(b.cuotapartes)), b.estado || 'disponible', Number(b.orden) || 0, Number(req.params.id)],
    );
    res.json({ ok: true });
  }));

  r.delete('/admin/unidades/:id', auth, soloAdmin, h(async (req, res) => {
    await q('delete from unidades where id=$1', [Number(req.params.id)]);
    res.json({ ok: true });
  }));

  return r;
}
