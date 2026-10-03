# Casapri

Plataforma web para invertir en cuotapartes de un edificio en construcción (Mar del Plata).
Socios: Casadei & Pringles. Garante: Lucorin Avicola Mdp S.R.L.

## Cómo funciona

- **Cuotaparte**: arranca en `valor_inicial` (US$ 1) y sube día a día a `tasa_anual` (9%) compuesta,
  desde `fecha_inicio` hasta `fecha_fin` (4 años). `precio = inicial × (1 + tasa)^(días/365)`.
- **Unidades**: cada departamento equivale a una cantidad fija de cuotapartes (ej. 70.000 CP).
  Su valor en dólares es `cuotapartes × precio del día`. El total vendible es la suma de las unidades.
- **Ingreso de fondos**: el inversor transfiere e informa la transferencia; un admin la aprueba. Sin costo.
- **Compra / venta**: se genera el contrato, le llega por mail y la operación vale cuando lo firma
  desde el enlace (queda IP, fecha y hash SHA-256 del texto). La venta, si está configurado, la aprueba un admin.
- **Retiro**: se confirma por mail, comisión `comision_retiro` (0,5%) y el admin lo marca como transferido.

Todo lo parametrizable (tasa, fechas, comisión, datos bancarios, unidades) se edita en `/admin`.

## Páginas

- `/` sitio público con valor de la cuotaparte, gráfico, unidades y simulador
- `/app` cuenta del inversor (registro, resumen, comprar/vender, ingresar/retirar, movimientos, perfil)
- `/firmar?t=…` lectura y firma del contrato (enlace del mail)
- `/admin` aprobaciones, estadísticas, inversores, operaciones, unidades y configuración

## Local

```
npm install
npm run dev
```

Sin `DATABASE_URL` usa PGlite (Postgres embebido) en `./.datos`. Sin `RESEND_API_KEY` los mails
se imprimen en la consola y la app abre el enlace en otra pestaña. Los mails de `ADMIN_EMAILS`
quedan como administradores al registrarse.

## Producción (Railway)

1. Nuevo proyecto desde el repo de GitHub.
2. Agregar un servicio **Postgres** y en la app la variable `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
3. Variables: `NODE_ENV=production`, `ADMIN_EMAILS`, `RESEND_API_KEY`, `MAIL_FROM` (dominio verificado en Resend), `APP_URL`.
4. Generar dominio público.

## Pendiente antes de operar con dinero real

- Revisión legal del contrato (`src/contratos.mjs` es un modelo provisorio) y del encuadre ante la CNV.
- Instrumento de garantía de Lucorin Avicola Mdp S.R.L.
- Verificación de identidad (KYC) y prevención de lavado (UIF).
