# Visitante y cliente: comparación de las referencias

Se revisaron visualmente los dos PDF aportados. Cada archivo contiene una sola página larga, compuesta por una imagen; no contiene texto extraíble ni instrucciones operativas. Se utilizaron como referencias visuales de la interfaz.

## Evidencia

- PDF sin `(1)`: aparece el nombre del usuario, «Portal de Miembro», Tablero y Asiento del Conductor; el contenido es oscuro. Después de vehículos populares aparece la exploración por marcas y categorías.
- PDF con `(1)`: aparecen Registrarse e Iniciar sesión, sin Portal de Miembro y con menú público. Esta captura también usa fondo oscuro, por lo que el fondo por sí solo no identifica una sesión.
- Las capturas posteriores en ventana privada muestran la variante pública clara: cabecera azul oscura, acciones amarillas/azules, tarjetas blancas y membresías debajo de vehículos populares. La petición del usuario especifica que las membresías no deben aparecer en esa posición al iniciar sesión.

## Implementación

| Componente | Visitante | Comprador conectado |
| --- | --- | --- |
| Identidad visual | copart con variante para cabecera oscura; sin subtítulo de miembro | copart y Portal de Miembro |
| Acciones superiores | Registrarse / Iniciar sesión | Nombre de la cuenta y menú de usuario |
| Navegación | Cómo funciona, Inventario, Subastas, Ubicaciones, Servicios, Ayuda, Vender | Tablero, Asiento del Conductor, Inventario, Subastas, Ofertas, Pagos y servicios |
| Portada por defecto | Fondo claro, cabecera azul oscura, botones amarillo/azul | Fondo oscuro, cabecera clara, acciones marrones/azules |
| Primer paso y CTA | Regístrese / registro | Busque / inventario |
| Membresías en la portada | Debajo de vehículos populares | No se renderiza el bloque |
| Preferencias de cookies | Aviso inicial, aceptación/rechazo, selección y reapertura desde el pie | No se presenta el aviso en el portal |
| Ficha de lote | Menú público; acceso a iniciar sesión; servidor bloquea la puja | Menú de miembro; oferta habilitada solo si la cuenta es elegible |

La preferencia pública clara/oscura se guarda aparte del idioma. Una captura pública oscura sigue siendo visitante. El portal del cliente conserva su tema oscuro de referencia, incluso si antes se seleccionó la apariencia pública clara. No se usa el idioma ni una cookie de tema para conceder funciones de cliente.

Los precios, límites, lotes y contadores siguen siendo los de copart; no se copian como datos propios las cifras comerciales de Copart. Las ilustraciones demo existentes se mantienen identificadas como tales; no se incorporan las fotografías de los PDF como si documentaran el estado de los vehículos demo.

## Archivos relevantes

- `src/lib/viewHelpers.js`: calcula el estado de sesión y la apariencia pública.
- `src/views/partials/header.ejs`, `public-menu.ejs`, `member-menu.ejs`: cabeceras y menús separados.
- `src/views/pages/home-reference.ejs`: contenido y posición de las membresías según sesión.
- `public/css/session-states.css`: diferencias de presentación entre estados.
- `src/views/partials/cookie-preferences.ejs`, `public/js/cookie-preferences.js`: preferencias locales, sin rastreadores externos activos.
- `e2e/session-states.spec.js`: prueba de visitante → login → portada → logout, apariencia/idioma y cookies.

Las capturas se guardan en `docs/screenshots/session-states/`. Los renders de los PDF utilizados para la revisión están en `docs/reference-pdfs/`. El script `scripts/check-session-layout.js` verifica escritorio y móvil sobre el puerto 3000.

Última validación: **17 pruebas unitarias/de integración y 11 pruebas de navegador aprobadas**. El recorrido real de login y logout se comprobó con Playwright; las capturas de escritorio y móvil confirman que las membresías están presentes como visitante y ausentes como cliente. Las capturas específicas de precios son `desktop-visitor-memberships.png` y `mobile-visitor-memberships.png`.

## Fuentes proporcionadas por el usuario

- `C:/Users/usuario/Downloads/Subastas de autos 100 % en línea - Copart USA - Venta de autos usados __en subastas de autos en línea.pdf`
- `C:/Users/usuario/Downloads/Subastas de autos 100 % en línea - Copart USA - Venta de autos usados __en subastas de autos en línea (1).pdf`
