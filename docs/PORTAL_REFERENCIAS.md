# Portal copart — ajuste a las capturas

**Corrección vigente:** la portada pública y el portal del comprador son estados diferentes. La unificación descrita en revisiones anteriores se reemplazó por la separación documentada en [Estados de sesión](ESTADOS_SESION.md), basada en los dos PDF y las nuevas capturas del usuario. Las membresías se muestran en la portada pública y se omiten en la portada del cliente.

## Tercera revisión: portada y ficha pública

La portada usa `home-reference.ejs`: dos banners navegables, inventario popular de cuatro tarjetas por fila, pestañas con filtros reales, bloque de información/categorías, promociones y membresías. El conteo de vehículos y subastas procede de la base de datos; no se muestran cifras de Copart como cifras propias.

El diseño compacto también se aplica a `/` y `/lot/:lot_number` sin sesión. Se corrigió la diferencia mostrada en la captura de Chrome: las fichas públicas ya no vuelven al diseño anterior grande. Se conserva la autenticación: una persona sin sesión puede consultar la ficha, pero no puede ofertar ni guardar notas.

Hay imágenes propias generadas para banner y placeholders de automóvil/SUV, identificadas como ilustrativas. No son las fotos exactas de las capturas, ni representan el estado del lote. Las fotos originales cargadas por los vendedores se conservan y tienen prioridad. Detalle y prompts: `docs/GENERATED_ASSETS.md`.

Validación: **17 pruebas unitarias/de integración y 8 pruebas de navegador aprobadas**. Capturas de portada, segundo banner y ficha pública, en escritorio y móvil: `docs/screenshots/home-reference/`. Se verificó la carga en `http://localhost:3000`.

## Segunda revisión: densidad y servidor local

Se corrigió el 404 de `/dashboard/lots` reiniciando la instancia antigua del puerto **3000** con las rutas actuales. Las comprobaciones se ejecutaron sobre esa misma instancia, no sobre un puerto alternativo.

`public/css/member-density.css` ajusta la escala a las nuevas capturas. En 1900 × 1000: cabecera de 100 px, navegación de 50 px, barra lateral de Mis Lotes de 215 px y comienzo del pie en 656 px tanto en Mis Lotes como en Mis ofertas. Se verificó también el escritorio de 1520 px con escala de pantalla del 125 %, además del móvil de 390 px. Las capturas están en `docs/screenshots/member-density/`.

Mis Lotes incorpora las trece columnas de la referencia, selector de columnas, ordenación, ocultar imágenes, tamaño de texto, barra lateral plegable y exportación de columnas visibles. Las tarjetas de vistos recientemente incorporan oferta máxima con incrementos calculados por el servidor para los lotes abiertos y cuentas elegibles. No se realizaron pujas en la base de demostración durante la revisión visual.

Validación de esta revisión: **17 pruebas unitarias/de integración y 4 pruebas de navegador aprobadas**. La galería, los datos y el cuadro de oferta tienen ahora el ancho y la densidad de las capturas; las secciones adicionales de información de venta, costos e historial se pueden desplegar.

Se adaptó el portal del comprador a las capturas aportadas: cabecera azul degradada, navegación superior con desplegables, fondo negro, enlaces azules, tarjetas del tablero y tablas oscuras. Se conserva la marca copart, el inventario y los permisos existentes.

## Páginas

| Referencia | Ruta del proyecto |
| --- | --- |
| Tablero, finanzas, títulos, tareas y vistos recientemente | `/dashboard` |
| Encuesta de bienvenida | `/dashboard?welcome=1` |
| Asiento del conductor / Mis Lotes | `/dashboard/lots` |
| Buscador de vehículos | `/vehicle-finder` |
| Subastas de hoy | `/auctions` |
| Mis ofertas / ganados / perdidos / contraofertas | `/dashboard/bids`, parámetros `tab=won`, `lost`, `counter` |
| Facturas no pagadas | `/dashboard/payments` |
| Historial de facturas | `/dashboard/payments?tab=history` |
| Historial de transacciones | `/dashboard/payments?tab=history&view=transactions` |
| Galería, especificaciones y oferta | `/lot/:lot_number` |

Las tablas de lotes, ofertas, pagos y subastas permiten buscar y paginar los datos cargados. Las exportaciones descargan las filas visibles en CSV, con protección frente a fórmulas de hoja de cálculo. La oferta y sus controles de incremento mantienen la API y las validaciones del servidor. Las notas y las preferencias de bienvenida se guardan por usuario en este navegador, no se sincronizan entre dispositivos.

## Verificación

- 17 pruebas unitarias y de integración: permisos, registro, documentos, concurrencia, WebSocket, adjudicación, facturación, pagos, transporte, PIN, administración, compra inmediata y contraofertas.
- Pruebas Playwright en `e2e/member-reference.spec.js`: rutas, ausencia de errores JavaScript, filtros, exportación, navegación, galería, persistencia local, bienvenida y ancho móvil.
- Prueba de suplantación del propietario actualizada a los textos del tablero.
- Capturas de escritorio y móvil en `docs/screenshots/member-update/`.

## Diferencias que se conservan

Este ajuste no es una reproducción píxel por píxel. La marca, las fotografías disponibles, los datos de la cuenta, el calendario, la moneda EUR y las ubicaciones pertenecen al proyecto existente. No se incorporaron las fotos de los vehículos de las capturas, porque no están disponibles como archivos del inventario. Los lotes demo conservan sus ilustraciones y los vendedores pueden subir fotografías.

Los pagos siguen siendo simulados. No se agregaron integraciones externas para reportes, cobros ni mensajes. Varias pantallas secundarias conservan textos en inglés. En móvil las tarjetas se apilan y las tablas desplazan su contenido horizontalmente.

Para cargar cambios de rutas en una instancia ya iniciada, reiniciar el servidor con `INICIAR.bat`; para estilos puede ser necesario recargar con Ctrl+F5.
