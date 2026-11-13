# Registro de assets

Ninguna imagen, logotipo ni fotografía de Copart se incluye en el proyecto. La portada y los placeholders de automóviles/SUVs ahora utilizan imágenes ilustrativas generadas con el tool integrado image_gen. [Archivos y prompts](GENERATED_ASSETS.md).

| Asset | Origen | Dónde | Cómo reemplazar |
|---|---|---|---|
| Logotipo copart | SVG propio | `src/views/partials/logo.ejs`, `public/img/favicon.svg` | Actualizar el SVG horizontal de `src/views/partials/logo.ejs` para el encabezado, pie, paneles y registro; `public/img/favicon.svg` controla solo el icono del navegador |
| Imágenes de vehículos demo | Imagen generada ilustrativa para automóvil/SUV; SVG para otros tipos | `public/img/copart/demo-*.jpg`; `displayImage` en `src/lib/viewHelpers.js` | El vendedor sube fotos JPG/PNG/WEBP desde `/seller/vehicles/:id/edit`; no se sustituyen sus fotos |
| Imágenes del hero, categorías, banners | Mismo generador SVG | `home.ejs`, `login.ejs`, `how-it-works.ejs` | Colocar imágenes con licencia en `public/img/` y cambiar el `src` (mismas proporciones) |
| Iconos | Sprite SVG propio | `src/views/partials/icons.ejs` | Añadir `<symbol>` |
| Tipografías | Google Fonts: Lato, Red Hat Display (OFL) | `partials/head.ejs` | — |
| Bandera de España del pie | CSS (degradado) | `.flag-es` en `site.css` | — |
