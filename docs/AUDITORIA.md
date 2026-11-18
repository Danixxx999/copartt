# Auditoría y matriz de cobertura

## 1. Auditoría del proyecto anterior (`Documents/Copart` = `copart_Pro_Colombia`)

| Aspecto | Estado encontrado |
|---|---|
| Stack | Node 22 sin dependencias, `node:sqlite`, SPA en JS plano. 1 archivo de servidor (261 líneas densas), 1 de cliente (124 líneas). |
| Base de datos | **SQLite**, 12 tablas sin migraciones (esquema en un string), sin `updated_at`. La especificación exige PostgreSQL. |
| Funciona | Registro/login con scrypt y cookie HttpOnly; catálogo con filtros; puja proxy con `BEGIN IMMEDIATE`; favoritos; búsquedas guardadas; panel admin básico; SSE. |
| Parcial | Roles solo ADMIN/BUYER/SELLER (sin finanzas ni logística); membresías asignadas a mano; órdenes sin factura ni pago; sin documentos de verificación. |
| Faltante | Subastas en vivo por eventos, WebSocket, facturas/PDF, pagos demo, revisión de Finanzas, PIN de retiro, transporte, alertas de vehículos, sedes, calendario, CMS, informes, auditoría completa, i18n. |
| Defectos | El test oficial fallaba en Windows (`EPERM` al borrar el SQLite abierto; todas las aserciones pasaban). Adjudicación por precio visible sin cierre por evento. Mercado Colombia/COP, distinto de la referencia (España/EUR). |
| Visual | Diseño propio “inspirado”; la versión de las capturas ya acercaba colores, pero lejos de la estructura de la referencia. |
| Entorno | Node.js no estaba instalado en el PATH; no había PostgreSQL ni Docker. |

**Decisión:** construir desde cero en `Copart IA` (a petición del usuario), conservando del anterior el nombre **copart**, la idea de puja proxy, cookies HttpOnly y el aviso de entorno de pruebas. El proyecto antiguo queda intacto como respaldo.

## 2. Matriz de cobertura de las capturas de referencia

| Captura / PDF | Ruta | Estado | Notas de fidelidad |
|---|---|---|---|
| Home (PDF completo) | `/` | ✅ | Cabecera degradada con puntos, búsqueda negra, botón marrón, idioma, Register/Sign In; menú gris con dropdowns y *Help Center*; banda del calendario; hero 3 pasos; membresías Guest/Basic/Premium; carrusel; *What is*; categorías; marcas con pestañas y anuncio; 4 promos; *Follow Us*; CTA azul; pie de 6 columnas. Logotipo propio. |
| How It Works (PDF) | `/how-it-works` | ✅ | Bloque superior con fotos, *After You've Registered* (4 iconos), *Why Buy*, pasos, *Delivery and Transportation*, FAQ. Fotos sustituidas por ilustraciones. |
| Vehicle Finder | `/vehicle-finder` | ✅ | Tarjeta con cabecera azul, condición All/Used/Salvage, tipos, odómetro, años, marca→modelo dependiente, ubicación, OR, Lot #, botón verde; 3 cajas de condición; pestañas Make/Types/Damage/Featured/Specialty con contadores reales. |
| Resultados | `/vehicles` (`/lotSearchResults`) | ✅ | Filtros en URL, orden, paginación, vista cuadrícula/lista, vacío, guardar búsqueda. |
| Vehicle Alerts (2 capturas) | `/vehicle-alerts` | ✅ | Banner azul con teléfono/sobre, textos, formulario Type/Year/Make/Model/Frequency/Nombre/Email/consentimiento; gestión y cancelación por token. |
| Auctions Calendar | `/auctions/calendar` | ✅ | Tabla semanal Lunes–Domingo con hora (Madrid), anuncio, Print, vista lista, panel lateral. |
| Join Auctions | `/auctions`, `/auctions/:id/live` | ✅ propuesta | No había captura de la sala; diseño propio *On The Block* con dial de tiempo, lista de lotes y estado de conexión. |
| Locations (2 capturas) | `/locations`, `/locations/:code` | ✅ | Título grande azul, buscador, *About Yards* con 4 tarjetas; listado y ficha de sede. |
| Services & Support dropdown | cabecera | ✅ | Transport, Sell a Vehicle, separador, How to Buy, Common Questions, Videos, Contact Us. |
| Transport | `/transport` | ✅ | Hero azul con 3 pasos y flechas, ventajas, Express; + calculadora y seguimiento (añadido funcional). |
| Login | `/login` | ✅ | Tarjeta *Account Type* Buyer/Seller, Email ID, Password con ojo, Remember, Forgot, banner *This week in auction*. |
| Register | `/register` → `/membership` → `/documents` | ✅ | Pestañas Create Account / Choose Membership / Document Submission, Individual/Business, teléfono con prefijo, consentimientos. |
| Ficha de lote | `/lot/:n` | ✅ propuesta | Sin captura; estructura galería + detalles + caja de puja. |
| Paneles privados | `/dashboard`, `/seller`, `/admin`, `/finance`, `/ops` | ✅ propuesta | Marcados como propuesta académica en la barra lateral. |
| Área del miembro (iteración 2) | `/dashboard/*` | ✅ propuesta | Sin capturas propias; estructura tomada de la descripción pública del *Member Dashboard* de la referencia: cabecera pública + menú *My Account*, widget *My Buying Power*, *Bid Status* (Current / Won / Lost / Counter Bids), *Payments Due / History*, *Recently Viewed*, Buy It Now. Pendiente de ajustar con las capturas que aporte el usuario. |
| Portal del miembro (capturas 30–57) | `/vehicle-finder`, `/sales-list`, `/watchList`, `/savedsearch`, `/vehicle-alerts`, `/auctions`, `/auctions/calendar`, `/dashboard` | ✅ | Misma estructura que las capturas, con textos propios. Buscador: franja promocional, deslizador de kilometraje, Locales/Provincia/Código postal, VIN/Lote, 7 pestañas con contadores reales y consejos. Tablero: Vistos recientemente con *Oferta inicial + Oferta máxima*, Ofertas, Lista de favoritos, Pagos y logística. No se reproducen los logotipos de empresas del grupo de la referencia, las insignias de las tiendas de apps ni los vídeos tutoriales. |
| Control del propietario | `/admin/users`, `/admin/roles`, `/admin/vehicles/new`, `/admin/content` | ✅ propuesta | Suplantación auditada, roles personalizados, alta de cualquier cuenta, publicación de vehículos y CMS. |

## 3. Mapa de rutas

**Públicas:** `/`, `/how-it-works`, `/vehicle-finder`, `/vehicles`, `/lot/:lotNumber`, `/vehicle-alerts`, `/vehicle-alerts/manage/:token`, `/auctions/calendar`, `/auctions`, `/auctions/:id/live`, `/locations`, `/locations/:code`, `/transport`, `/membership`, `/register`, `/register/membership`, `/register/documents`, `/login`, `/forgot-password`, `/reset-password/:token`, `/help`, `/how-to-buy`, `/faq`, `/contact`, `/sell-a-vehicle`, `/videos`, `/fee-calculator`, `/sitemap`, `/page/:slug` (terms, privacy, cookie-policy, company-details, about-us), `/api/docs`.

**Comprador:** `/dashboard`, `/watchlist`, `/bids`, `/purchases`, `/purchases/:id`, `/invoices`, `/invoices/:id.pdf`, `/saved-searches`, `/alerts`, `/membership`, `/documents`, `/notifications`, `/profile`.

**Vendedor:** `/seller`, `/seller/vehicles`, `/seller/vehicles/new`, `/seller/vehicles/:id/edit`, `/seller/sales`, `/seller/calendar`, `/seller/statements`.

**Administración:** `/admin` (+ `users`, `users/:id`, `documents`, `sellers`, `vehicles`, `vehicles/:id`, `auctions`, `auctions/:id`, `bids`, `memberships`, `catalog`, `locations`, `content`, `support`, `settings`, `audit`, `mailbox`, `reports`).

**Finanzas:** `/finance`, `/finance/invoices`, `/finance/balances`. **Logística:** `/ops`, `/ops/pickups`, `/ops/transport`, `/ops/yards`.

**Comprador (nuevas):** `/dashboard/payments`, `/dashboard/buying-power`, `/dashboard/recently-viewed`, `/dashboard/bids?tab=counter`. **Admin (nuevas):** `/admin/roles`, `/admin/vehicles/new`, `/admin/vehicles/:id/edit`.

**API:** ver `/api/docs` y `/openapi.json` (98 operaciones).

## 4. Criterios de aceptación (estado verificado)

| # | Criterio | Verificado por |
|---|---|---|
| 1 | Home parecida a la referencia, desktop y móvil | `docs/screenshots/*` + E2E móvil |
| 2 | Menús sin 404 ni pantallas vacías | `scripts/crawl.js`: 150 páginas (incluye 6 idiomas, varias regiones y las páginas del portal), 0 errores |
| 3 | Registro → membresía → panel; persiste tras recargar | integración (test 3) |
| 4 | Guest no puja; elegible sí | integración (test 2) + E2E |
| 5 | Vendedor crea/edita → admin aprueba → aparece con filtros | integración (test 4) + E2E |
| 6 | 2 navegadores ven la puja en tiempo real; una sola adjudicación | integración (WebSocket) + E2E `live-auction` |
| 7 | Mis compras → factura → pago demo → Finanzas → PIN Logística | integración (test 6) |
| 8 | Alertas, búsquedas guardadas, fotos y documentos | integración (tests 4 y 8) |
| 9 | Admin gestiona usuarios, sedes, lotes, subastas, finanzas, informes | paneles + crawl |
| 10 | Corre en máquina nueva con README | `scripts/setup-windows.ps1` ejecutado en este equipo (las descargas e `initdb` se verificaron con los mismos comandos al instalar; en este equipo el script las omite porque ya existen). Docker Compose: no probado (no hay Docker) |
