// Textos de los contratos. MODELO PROVISORIO: lo tiene que revisar un abogado
// antes de operar con dinero real.
import crypto from 'node:crypto';

const usd = (c) => 'US$ ' + (c / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cp = (m) => (m / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 6 });
const fecha = (d) => new Date(d).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'long', timeStyle: 'short' });
const pct = (n) => (n * 100).toLocaleString('es-AR', { maximumFractionDigits: 2 }) + '%';
const sinPunto = (s) => String(s || '').replace(/\.+$/, '');

export function textoContrato({ tipo, op, usuario, cfg }) {
  const inversor = `${usuario.nombre} ${usuario.apellido}, DNI/CUIT ${usuario.documento}, con domicilio en ${usuario.domicilio}, correo electrónico ${usuario.email}`;
  const encabezado = `MODELO PROVISORIO — SUJETO A REVISIÓN LEGAL

${titulo(tipo)} N° ${String(op.id).padStart(6, '0')}
Proyecto: ${cfg.nombre_proyecto} (${cfg.ciudad})
Fecha de emisión: ${fecha(op.creado)}

PARTES
• EL DESARROLLADOR: ${sinPunto(cfg.emisor)}.
• EL CUOTAPARTISTA: ${inversor}.
• EL GARANTE: ${sinPunto(cfg.garante)}.`;

  if (tipo === 'compra') {
    return `${encabezado}

PRIMERA — OBJETO. EL CUOTAPARTISTA adquiere ${cp(op.cp_micro)} cuotapartes del proyecto ${cfg.nombre_proyecto}, a un valor de US$ ${Number(op.precio).toFixed(6)} por cuotaparte, por un total de ${usd(op.usd_cents)}, que se debita de su saldo disponible en la plataforma.

SEGUNDA — VALOR DE LA CUOTAPARTE. El valor de la cuotaparte se actualiza diariamente a una tasa de referencia de ${pct(cfg.tasa_anual)} anual compuesta, desde el ${cfg.fecha_inicio} hasta la fecha estimada de finalización de obra (${cfg.fecha_fin}). Cada unidad funcional del edificio equivale a una cantidad fija de cuotapartes, informada en la plataforma.

TERCERA — PLAZO. El plazo estimado del proyecto es de aproximadamente cuatro (4) años. El CUOTAPARTISTA podrá solicitar la venta de sus cuotapartes en cualquier momento al valor vigente, conforme a las condiciones de la plataforma.

CUARTA — COMISIONES. El ingreso de fondos no tiene costo. Los retiros de fondos tienen una comisión de ${pct(cfg.comision_retiro)} sobre el monto retirado.

QUINTA — GARANTÍA. ${cfg.garante} se constituye en garante de las obligaciones asumidas por EL DESARROLLADOR frente al CUOTAPARTISTA, en los términos que se establezcan en el instrumento de garantía correspondiente.

SEXTA — REGISTRO. Las cuotapartes se registran a nombre del CUOTAPARTISTA en el registro digital de la plataforma, que da cuenta de su titularidad.

SÉPTIMA — FIRMA ELECTRÓNICA. Las partes acuerdan que la aceptación de este contrato mediante el enlace enviado al correo electrónico registrado del CUOTAPARTISTA constituye su firma electrónica (Ley 25.506) y prestación de consentimiento.

OCTAVA — JURISDICCIÓN. Para cualquier controversia, las partes se someten a los tribunales ordinarios de la ciudad de Mar del Plata.`;
  }

  if (tipo === 'venta') {
    return `${encabezado}

PRIMERA — OBJETO. EL CUOTAPARTISTA vende y transfiere a EL DESARROLLADOR ${cp(op.cp_micro)} cuotapartes del proyecto ${cfg.nombre_proyecto}, a un valor de US$ ${Number(op.precio).toFixed(6)} por cuotaparte, por un total de ${usd(op.usd_cents)}.

SEGUNDA — PAGO. El importe se acredita en el saldo del CUOTAPARTISTA en la plataforma${cfg.venta_requiere_aprobacion ? ', una vez aprobada la operación por EL DESARROLLADOR' : ''}. El CUOTAPARTISTA podrá retirarlo conforme a las condiciones vigentes (comisión de retiro: ${pct(cfg.comision_retiro)}).

TERCERA — GARANTÍA. ${cfg.garante} garantiza el pago de la presente operación en los términos del instrumento de garantía correspondiente.

CUARTA — FIRMA ELECTRÓNICA. La aceptación mediante el enlace enviado al correo electrónico registrado del CUOTAPARTISTA constituye su firma electrónica (Ley 25.506).

QUINTA — JURISDICCIÓN. Tribunales ordinarios de la ciudad de Mar del Plata.`;
  }

  // retiro
  return `${encabezado}

PRIMERA — OBJETO. EL CUOTAPARTISTA solicita el retiro de ${usd(op.usd_cents)} de su saldo disponible.

SEGUNDA — COMISIÓN. Se aplica una comisión de ${pct(cfg.comision_retiro)} (${usd(op.comision_cents)}). Monto neto a transferir: ${usd(op.usd_cents - op.comision_cents)}.

TERCERA — DESTINO. El monto se transferirá a la cuenta declarada por EL CUOTAPARTISTA: ${usuario.cbu}.

CUARTA — FIRMA ELECTRÓNICA. La aceptación mediante el enlace enviado al correo electrónico registrado constituye la firma electrónica del CUOTAPARTISTA (Ley 25.506).`;
}

function titulo(tipo) {
  return { compra: 'CONTRATO DE SUSCRIPCIÓN DE CUOTAPARTES', venta: 'CONTRATO DE VENTA DE CUOTAPARTES', retiro: 'SOLICITUD DE RETIRO DE FONDOS' }[tipo];
}

export const hashContrato = (texto) => crypto.createHash('sha256').update(texto, 'utf8').digest('hex');
