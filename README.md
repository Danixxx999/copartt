# copart — Réplica académica de una plataforma de subastas de vehículos online

> **Proyecto universitario no oficial.** Reproduce la experiencia visual y funcional de una plataforma pública de subastas de vehículos (referencia: copart.es/en) con **marca propia (copart)**, datos ficticios y pagos simulados. No está afiliado a Copart, no usa su logotipo ni su API y no capta datos ni dinero reales.

Plataforma completa y ejecutable: web pública, portal del comprador, portal del vendedor, paneles de administración, finanzas y logística, **subastas en tiempo real (WebSocket)**, facturación con PDF, pagos demo, transporte y retiro con PIN, todo sobre **PostgreSQL**.

---

## 1. Arranque rápido (este equipo)

Todo está instalado de forma portable dentro de `.tools/` (Node.js 24 y PostgreSQL 17), sin permisos de administrador.

**Doble clic en `INICIAR.bat`** → arranca PostgreSQL, aplica migraciones, inicia el servidor y abre http://localhost:3000.

O desde la terminal de VS Code (PowerShell):

```powershell
$env:Path = "$PWD\.tools\node;$env:Path"   # usar el Node portable
npm run db:start      # PostgreSQL en el puerto 5433
npm start             # http://localhost:3000
```

## 2. Instalación en una máquina nueva

**Windows (recomendado, sin admin):**
```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
```
Descarga Node y PostgreSQL portables, crea las bases `copart` y `copart_test`, genera `.env` con un secreto aleatorio, ejecuta `npm install`, migraciones y datos demo. Después: `INICIAR.bat`.

**Cualquier sistema con Docker:**
```bash
docker compose up --build      # http://localhost:3000
```
*(Archivos incluidos; no se pudo probar en este equipo porque no tiene Docker.)*

**Con Node 22+ y un PostgreSQL propio:** copia `.env.example` a `.env`, ajusta `DATABASE_URL`, y ejecuta `npm install && npm run setup && npm start`.

## 3. Cuentas de demostración

Contraseña de todas: **`Demo2026!`** (variable `DEMO_PASSWORD` del `.env`).

| Rol | Email | Para probar |
|---|---|---|
| Administrador | `admin@copart.test` | Todo el panel `/admin`, iniciar subastas, aprobar vehículos y documentos |
| Finanzas | `finanzas@copart.test` | `/finance`: aprobar/rechazar transferencias, conciliar, cancelar impagos |
| Logística | `logistica@copart.test` | `/ops`: validar PIN de retiro, gestionar transportes |
| Vendedor | `vendedor@copart.test` (elegir **Seller** en el login) | `/seller`: crear lotes, fotos, documentos, aceptar pujas bajo reserva |
| Vendedor 2 | `renting@copart.test` | Otra empresa vendedora |
| Comprador Guest | `guest@copart.test` | Ve y guarda favoritos, **no puede pujar** |
| Comprador Basic | `basic@copart.test` | Puja hasta 5.000 € por vehículo |
| Comprador Premium | `premium@copart.test`, `premium2@copart.test` | Hasta 30 vehículos / 300.000 € por subasta |
| Docs en revisión | `pendiente@copart.test` | Basic con documentos pendientes: no puede pujar |

## 3.1 Control total del propietario (cuenta `admin@copart.test`)

| Quiero… | Dónde |
|---|---|
| Crear cualquier usuario (comprador, vendedor, finanzas, logística, admin o rol propio) con plan y verificación | *Users › New user* (`/admin/users`) |
| **Entrar como otro usuario** y ver exactamente lo que ve (soporte) | *Users › Sign in as* → barra amarilla → *Return to my account*. Auditado, máx. 2 h, no se puede suplantar a otro admin ni cambiar su contraseña |
| Cambiar email, datos, contraseña, roles, plan, suspender, cerrar sesiones, enviar mensaje o borrar | Ficha del usuario (`/admin/users/:id`) |
| Crear roles propios y decidir qué puede hacer cada rol | *Roles & Permissions* (`/admin/roles`) — el rol Administrador conserva siempre usuarios y roles |
| Publicar un vehículo yo mismo (en nombre de un vendedor) con fotos, Buy It Now y destacado en la home | *Add Vehicle* (`/admin/vehicles/new`) → *Approve & publish* |
| Programar/iniciar subastas, cambiar salida, reserva y Buy It Now | *Auctions & Lots* |
| Publicar páginas propias y banners (arriba en todo el sitio o en la home) | *Content & Banners* |
| Ajustes, tarifas, incrementos, límites de planes | *Settings*, *Memberships & Limits* |
| Ver todo lo que pasó | *Audit Log*, *Demo Mailbox*, *Reports* |

## 3.2 Área del miembro (estilo *Member Dashboard*)

El portal del comprador se ajustó a las capturas aportadas: tema oscuro, navegación superior, tablero de finanzas/títulos/subastas/tareas, Mis Lotes, ofertas y pagos. La portada pública tiene su propio menú y muestra las membresías bajo los vehículos; al entrar como comprador, aparece Portal de Miembro y se omite ese bloque. Ver [estados de sesión](docs/ESTADOS_SESION.md) y [páginas, validación y diferencias respecto a las capturas](docs/PORTAL_REFERENCIAS.md). Capturas actuales en `docs/screenshots/session-states/`.

Comprador (`/dashboard`): widgets *My Buying Power*, *Lots I'm Bidding On*, *Payments Due*, *Watchlist*, *Recently Won*, *Saved Searches*, *Recently Viewed*, *Upcoming Auctions*, *Messages*. Menú: **Bid Status** (Current Bids / Lots Won / Lots Lost / **Counter Bids**), Watchlist & Searches, **Payments** (Due / History / Invoices / Purchases & Pickup), My Account (datos, membresía, Buying Power, documentos, mensajes).
Ficha de lote: **Buy It Now** (compra inmediata antes de la subasta), *Vehicle Information* y *Sale Information*.
Vendedor (`/seller`): mismo layout; en *Sales & Approvals* puede **aceptar, rechazar o contraofertar** cuando la puja no llega a la reserva.

## 4. Comandos

| Comando | Qué hace |
|---|---|
| `npm start` / `npm run dev` | Servidor (dev = recarga al editar) |
| `npm run db:start` / `db:stop` | PostgreSQL portable |
| `npm run migrate` | Aplica migraciones SQL pendientes (`db/migrations`) |
| `npm run seed` | Datos de referencia + demo (**idempotente**: se puede repetir) |
| `npm run reset-demo -- --yes` | Borra y recrea la BD demo (bloqueado en producción) |
| `npm test` | Pruebas unitarias + integración API/BD (usa `copart_test`) |
| `npm run test:e2e` | Playwright: visitante, roles, 2 navegadores en la sala en vivo (servidor en marcha) |
| `node scripts/crawl.js` | Recorre ~100 páginas con cada rol y falla si alguna da error |
| `node scripts/screenshots.js` | Capturas 1440×900 y 390×844 en `docs/screenshots` |

## 5. Guion de demostración (≈10 min)

1. **Home** (`/`) → comparar con la captura de referencia: cabecera, banda del calendario, hero de 3 pasos, membresías, vehículos populares, categorías, marcas, pie.
2. **Vehicle Finder** → marca *Toyota* (los modelos se cargan por API) → resultados con filtros, orden y paginación → ficha de lote con galería/zoom, VIN mascarado y calculadora de costes.
3. **Guest** (`guest@`) → intenta pujar: bloqueado por el servidor (no solo el botón). Añade a Watchlist.
4. **Vendedor** (`vendedor@`, modo Seller) → *New vehicle* → foto → *Submit*. **Admin** → *Vehicles & Approvals* → asigna a subasta con salida y reserva → el lote aparece en el buscador público.
5. **Subasta en vivo**: Admin → *Auctions* → **Start now** en “Sala demo”. Abre la sala con `premium@` en un navegador y `premium2@` en otro (o ventana privada): las pujas se ven al instante; el reloj lo controla el servidor y se extiende con pujas de último segundo. Al cerrar: un único ganador.
6. **Ganador** → *My Purchases* → factura (PDF) → paga tasas con tarjeta sandbox `4242 4242 4242 4242` y el vehículo por transferencia subiendo el justificante.
7. **Finanzas** → aprueba la transferencia → se emite el PIN. **Comprador** ve el PIN. **Logística** → *Pickup / PIN* → valida → pedido completado.
8. **Auditoría** (`/admin/audit`) y **Demo mailbox** (`/admin/mailbox`): todo queda registrado.
9. **Propietario**: Admin › *Users* › **Sign in as** `basic@` → se ve su *Member Dashboard* → *Return to my account*. Crear un rol “Content editor” en *Roles & Permissions*.
10. **Buy It Now**: con `premium@`, abrir un lote con la etiqueta marrón *Buy It Now* → comprar → aparece en *Lots Won* con su factura.
11. **Contraoferta**: `renting@` (Seller) › *Sales & Approvals* → *Counter* → `basic@` › *Bid Status › Counter Bids* → *Accept*.

### Mi cuenta (panel lateral desde su nombre, arriba a la derecha)

`/account/*`: Información personal (teléfono, correo con contraseña, contraseña, direcciones física y postal, titular de documentos) · Método de pago y depósitos (tarjetas de prueba, predeterminada, depósitos y solicitud de reembolso) · Gestión de títulos (direcciones por sede en 2 pasos, envío automático, recogida) · Documentos y formularios (subida de identidad + 3 formularios PDF rellenados) · Claves de acceso (sesiones activas, cerrar las demás) · Centro de preferencias (sedes favoritas e idioma, intereses, comunicaciones) · Notificaciones · Tarifas de membresía.

### Cobros reales (cuando usted quiera)

Hoy todo funciona en **modo demostración**: solo se aceptan tarjetas de prueba (4242 4242 4242 4242) y no se cobra dinero. En **Administración › Pasarelas de pago** (`/admin/payments`) verá qué proveedor está activo y qué claves faltan (Stripe, Mercado Pago, Wompi, PayPal), sin que la página muestre nunca sus valores. Para activar uno: claves en `.env` (ver `.env.example`), adaptador en `src/services/payments.js` (mismas funciones que el demo) y `PAYMENT_PROVIDER=<proveedor>`. Hasta que estén los tres pasos, el sistema sigue en demo solo. Las tarjetas guardadas solo conservan marca, últimos 4 y caducidad.

### Idioma y región

Cabecera › 🌐 **SPAIN | Español** → *Idioma del sitio web* (6 idiomas + **Sí**) y *Región del Sitio Web* (cuadrícula de 11 banderas). También en el pie. Se guardan en cookies (`ap_lang`, `ap_region`); `?lang=fr`, `?region=US` y `?country=all` funcionan en cualquier URL.

## 6. Documentación

- [`docs/AUDITORIA.md`](docs/AUDITORIA.md) — auditoría del proyecto anterior, matriz de cobertura de capturas, mapa de rutas.
- [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) — arquitectura, modelo de datos, máquinas de estado, motor de pujas, seguridad y decisiones.
- [`docs/ASSETS.md`](docs/ASSETS.md) — registro de imágenes de reemplazo.
- `/api/docs` y `/openapi.json` — referencia de la API v1.

## 7. Estructura

```
src/
  server.js            HTTP + Socket.IO + motor de subastas
  app.js               Express: seguridad, sesiones, CSRF, i18n, rutas, errores
  db.js                Pool PostgreSQL + transacciones
  lib/                 auth (argon2, sesiones, RBAC), security (CSRF, rate limit), validate (Zod), uploads, audit, notify, i18n
  services/            bidding (pujas/proxy), auctionEngine (reloj), orders (facturas, pagos, PIN, transporte), catalog, alerts, reports, pdf
  routes/              pages (público), dashboard (comprador), seller, staff (admin/finanzas/logística), api/* (REST v1; owner.js = control del propietario), files (descargas privadas)
  realtime/socket.js   salas lot:/event:/user:, pujas por WebSocket
  views/               EJS: pages/, panel/{buyer,seller,staff}/, partials/
public/                css/site.css, js/app.js, js/live.js, openapi.json
db/migrations/         001_init.sql (esquema completo) · 002_owner_member.sql (suplantación, roles propios, Buy It Now, contraofertas, vistos) · 003_regions.sql (país de cada sede) · 004_account_center.sql (tarjetas, depósitos, direcciones de títulos, preferencias)
scripts/               seed, migrate, reset-demo, db, crawl, screenshots, openapi, setup-windows.ps1
tests/ e2e/            node:test (unit + integración) y Playwright
```

## 8. Límites honestos

- **Pantallas privadas**: el portal del comprador se adaptó a las capturas proporcionadas. Los paneles de vendedor, administración, finanzas y logística conservan su diseño anterior. El portal no es una reproducción píxel por píxel; ver `docs/PORTAL_REFERENCIAS.md`.
- **Imágenes**: los vehículos usan ilustraciones SVG generadas (proporción 4:3) en lugar de fotos; los vendedores sí pueden subir fotos reales. Ver `docs/ASSETS.md`.
- **Idioma**: 6 idiomas (Español por defecto, English, Français canadien, العربية, Русский, Polski) en cabecera, menús, pie, panel de idioma/región, tablero del miembro, portada y tarjetas de lote. El contenido de las páginas secundarias, los paneles de staff y los mensajes del servidor siguen en español o inglés. El árabe se escribe de derecha a izquierda dentro de cada texto, pero la estructura de la página no se refleja.
- **Región**: 11 países. Filtra inventario, sedes, buscador y portada por el país de la sede. Los importes siguen en EUR (no hay conversión de divisas). Las sedes fuera de España son ficticias.
- **Marca**: se mantiene **copart** con logotipo propio. No se usa ni se imita el nombre o el logotipo de Copart (p. ej. “Copar” con el mismo diseño), por la regla del enunciado de no suplantar a la marca. El logotipo está en un solo archivo (`src/views/partials/logo.ejs` + favicon) por si la universidad o la empresa conceden permiso para usar otro.
- **Pagos, correos, tarifas, IVA, IBAN**: simulados. Los correos se guardan en *Demo mailbox*; nada sale del servidor.
- **Redis** no se usa: con un solo proceso, PostgreSQL (`SELECT … FOR UPDATE`) garantiza la consistencia de las pujas; ver ARQUITECTURA §7.
- **Docker Compose** está incluido pero no se probó aquí (este equipo no tiene Docker).
