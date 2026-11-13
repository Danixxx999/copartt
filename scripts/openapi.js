'use strict';
// Genera public/openapi.json (OpenAPI 3.1) a partir de la lista de endpoints. Uso: node scripts/openapi.js
const fs = require('node:fs');
const path = require('node:path');
const E = [
  ['post', '/auth/register', 'Auth', 'Crear cuenta (paso 1)', false, { account_type: 'individual|business', first_name: 'string', last_name: 'string', email: 'email', phone: 'digits', password: 'string(min 10)', terms: 'boolean' }],
  ['post', '/auth/login', 'Auth', 'Iniciar sesión (modo buyer/seller). Fija cookie HttpOnly ap_sid', false, { email: 'email', password: 'string', account_type: 'buyer|seller' }],
  ['post', '/auth/logout', 'Auth', 'Cerrar sesión', true],
  ['get', '/auth/me', 'Auth', 'Usuario actual con roles, permisos y plan', false],
  ['post', '/auth/forgot-password', 'Auth', 'Solicitar enlace de restablecimiento', false, { email: 'email' }],
  ['post', '/auth/reset-password', 'Auth', 'Restablecer contraseña con token', false, { token: 'string', password: 'string' }],
  ['post', '/auth/change-password', 'Auth', 'Cambiar contraseña', true, { current_password: 'string', new_password: 'string' }],
  ['post', '/memberships/choose', 'Memberships', 'Elegir plan (crea factura si es de pago)', true, { plan: 'guest|basic|premium' }],
  ['post', '/documents', 'Documents', 'Subir documento de verificación (multipart: doc_type, file)', true],
  ['patch', '/profile', 'Users', 'Actualizar perfil', true],
  ['get', '/makes', 'Catalog', 'Marcas con modelos', false], ['get', '/makes/{id}/models', 'Catalog', 'Modelos de una marca', false],
  ['get', '/vehicle-types', 'Catalog', 'Tipos de vehículo', false], ['get', '/damage-types', 'Catalog', 'Tipos de daño', false], ['get', '/locations', 'Locations', 'Sedes', false],
  ['get', '/lots', 'Lots', 'Búsqueda paginada. Query: q, make, model, type, condition, year_from, year_to, odo_min, odo_max, location, damage, featured, status(open|closed|all), sort, page, per_page', false],
  ['get', '/lots/{lotNumber}', 'Lots', 'Ficha del lote + historial de pujas (VIN mascarado)', false],
  ['get', '/auctions', 'Auctions', 'Eventos de subasta', false], ['get', '/fees/estimate', 'Invoices', 'Calculadora de costes (?amount=)', false],
  ['post', '/lots/{id}/bids', 'Bids', 'Prepuja o puja en vivo (máximo/proxy). Cabecera opcional Idempotency-Key', true, { amount: 'number (EUR)', idempotency_key: 'string', kind: 'prebid|live' }],
  ['post', '/watchlist/{lotId}', 'Watchlist', 'Alternar favorito', true], ['get', '/watchlist', 'Watchlist', 'Favoritos', true],
  ['post', '/saved-searches', 'SavedSearches', 'Guardar búsqueda', true, { name: 'string', query: 'querystring' }], ['delete', '/saved-searches/{id}', 'SavedSearches', 'Eliminar', true],
  ['post', '/alerts', 'Alerts', 'Crear alerta de vehículo', false], ['patch', '/alerts/{token}', 'Alerts', 'Editar alerta', false], ['post', '/alerts/{token}/cancel', 'Alerts', 'Cancelar alerta', false],
  ['post', '/support/tickets', 'Support', 'Formulario de contacto', false],
  ['get', '/notifications', 'Notifications', 'Notificaciones', true], ['post', '/notifications/read-all', 'Notifications', 'Marcar leídas', true],
  ['post', '/invoices/{id}/payments/demo', 'Payments', 'Pago demo: bank_transfer (multipart con proof) o card_demo (tarjeta 4242…)', true, { method: 'bank_transfer|card_demo', scope: 'vehicle|fees|full', reference: 'string' }],
  ['post', '/payments/{id}/review', 'Payments', 'Finanzas aprueba/rechaza (permiso finance.review)', true, { approve: 'boolean', note: 'string' }],
  ['post', '/orders/{id}/cancel', 'Orders', 'Cancelar orden impagada (finance.review)', true, { reason: 'string' }],
  ['post', '/transport/estimate', 'Transport', 'Presupuesto público', false], ['post', '/orders/{id}/transport-quotes', 'Transport', 'Presupuesto para una compra', true],
  ['post', '/transport/quotes/{id}/accept', 'Transport', 'Aceptar → orden de transporte + factura', true], ['post', '/transport-orders/{id}', 'Transport', 'Cambiar estado (logistics.manage)', true],
  ['post', '/pickup-passes/validate', 'Pickup', 'Validar PIN de retiro (pickup.validate)', true, { order_number: 'string', pin: '6 digits' }],
  ['post', '/seller/apply', 'Seller', 'Solicitar cuenta de vendedor', true], ['post', '/seller/vehicles', 'Seller', 'Crear borrador', true], ['patch', '/seller/vehicles/{id}', 'Seller', 'Editar borrador', true],
  ['delete', '/seller/vehicles/{id}', 'Seller', 'Eliminar borrador', true], ['post', '/seller/vehicles/{id}/submit', 'Seller', 'Enviar a aprobación', true],
  ['post', '/seller/vehicles/{id}/images', 'Seller', 'Subir fotos (multipart images[])', true], ['delete', '/seller/vehicles/{id}/images/{imageId}', 'Seller', 'Borrar foto', true],
  ['post', '/seller/vehicles/{id}/documents', 'Seller', 'Subir documento', true], ['post', '/seller/lots/{id}/decision', 'Seller', 'Aceptar/rechazar puja bajo reserva', true, { accept: 'boolean' }],
  ['patch', '/admin/users/{id}', 'Admin', 'Estado, roles, plan, verificación (users.manage)', true], ['post', '/admin/users', 'Admin', 'Crear usuario', true],
  ['post', '/admin/documents/{id}/review', 'Admin', 'Revisar documento', true], ['post', '/admin/sellers/{id}/approve', 'Admin', 'Aprobar vendedor', true],
  ['post', '/admin/vehicles/{id}/review', 'Admin', 'Aprobar (crea lote en subasta) o rechazar', true], ['post', '/admin/vehicles/{id}/withdraw', 'Admin', 'Retirar vehículo', true],
  ['post', '/admin/catalog/{kind}', 'Admin', 'Crear marca/modelo/tipo/daño', true], ['delete', '/admin/catalog/{kind}/{id}', 'Admin', 'Eliminar elemento del catálogo', true],
  ['post', '/admin/locations', 'Admin', 'Crear sede', true], ['patch', '/admin/locations/{id}', 'Admin', 'Editar sede', true],
  ['post', '/admin/events', 'Auctions', 'Programar subasta', true], ['patch', '/admin/events/{id}', 'Auctions', 'Editar subasta', true],
  ['post', '/admin/events/{id}/start', 'Auctions', 'Iniciar ahora', true], ['post', '/admin/events/{id}/cancel', 'Auctions', 'Cancelar', true],
  ['patch', '/admin/lots/{id}', 'Auctions', 'Precio de salida/reserva', true], ['post', '/admin/lots/{id}/cancel', 'Auctions', 'Cancelar lote', true],
  ['patch', '/admin/plans/{id}', 'Memberships', 'Reglas y límites del plan', true], ['patch', '/admin/settings/{key}', 'Settings', 'Editar ajuste (JSON)', true],
  ['patch', '/admin/pages/{slug}', 'Content', 'Editar página', true], ['patch', '/admin/banners/{id}', 'Content', 'Editar banner', true],
  ['patch', '/admin/tickets/{id}', 'Support', 'Responder ticket', true], ['post', '/admin/alerts/digest', 'Alerts', 'Enviar resumen de alertas', true],
  ['get', '/reports/{name}.csv', 'Reports', 'Exportar CSV: sales, invoices, payments, bids, users, inventory, transport', true],
  // Área del miembro y propietario (migración 002)
  ['post', '/lots/{id}/buy-now', 'Bids', 'Buy It Now: compra inmediata a precio fijo antes de la subasta (bloqueo de fila, un único comprador)', true],
  ['post', '/lots/{id}/counter-response', 'Bids', 'El mejor postor acepta o rechaza la contraoferta del vendedor', true, { accept: 'boolean' }],
  ['post', '/seller/lots/{id}/counter', 'Seller', 'Contraoferta al mejor postor (entre la puja y la reserva)', true, { amount: 'number (EUR)' }],
  ['post', '/admin/users/{id}/impersonate', 'Owner', 'Entrar como otro usuario (users.impersonate, auditado, 2 h máx.)', true],
  ['post', '/auth/impersonation/stop', 'Owner', 'Volver a la cuenta del administrador', true],
  ['patch', '/admin/users/{id}/profile', 'Owner', 'Editar email y datos personales/empresa', true], ['post', '/admin/users/{id}/password', 'Owner', 'Fijar contraseña y cerrar sesiones', true, { password: 'string(min 10)', revoke_sessions: 'boolean' }],
  ['post', '/admin/users/{id}/sessions/revoke', 'Owner', 'Cerrar todas las sesiones del usuario', true], ['post', '/admin/users/{id}/message', 'Owner', 'Mensaje (notificación + email demo)', true],
  ['delete', '/admin/users/{id}', 'Owner', 'Borrar usuario sin historial (si tiene pujas/compras → 409, suspender)', true],
  ['post', '/admin/roles', 'Owner', 'Crear rol personalizado con permisos (roles.manage)', true, { code: 'string', name: 'string', permissions: 'string[]' }],
  ['patch', '/admin/roles/{id}', 'Owner', 'Editar nombre y permisos de un rol', true], ['delete', '/admin/roles/{id}', 'Owner', 'Borrar rol personalizado sin usuarios', true],
  ['post', '/admin/vehicles', 'Owner', 'Crear vehículo en nombre de un vendedor (seller_id + datos)', true], ['patch', '/admin/vehicles/{id}', 'Owner', 'Editar cualquier vehículo no vendido', true],
  ['post', '/admin/vehicles/{id}/images', 'Owner', 'Subir fotos (multipart images[])', true], ['delete', '/admin/vehicles/{id}/images/{imageId}', 'Owner', 'Borrar foto', true],
  ['post', '/admin/vehicles/{id}/documents', 'Owner', 'Subir documento del vehículo', true], ['post', '/admin/vehicles/{id}/featured', 'Owner', 'Destacar en la home', true, { featured: 'boolean' }],
  ['post', '/admin/pages', 'Content', 'Crear página CMS (/page/slug)', true], ['delete', '/admin/pages/{slug}', 'Content', 'Borrar página (no legales)', true],
  ['post', '/admin/banners', 'Content', 'Crear banner (top / home)', true], ['delete', '/admin/banners/{id}', 'Content', 'Borrar banner', true],
];
const spec = {
  openapi: '3.1.0',
  info: { title: 'copart API (réplica académica)', version: '1.0.0', description: 'API REST de la plataforma de subastas. Las mutaciones requieren la cabecera X-CSRF-Token con el valor de la cookie ap_csrf. Errores: {error, code, fields}. Tiempo real por Socket.IO en /socket.io (join, sync, bid → lot:update, lot:closed, event:update, notification).' },
  servers: [{ url: '/api/v1' }],
  components: {
    securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'ap_sid' }, csrf: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' } },
    schemas: { Error: { type: 'object', properties: { error: { type: 'string' }, code: { type: 'string' }, fields: { type: 'object', additionalProperties: { type: 'string' } } } } },
  },
  paths: {},
};
for (const [method, p, tag, summary, auth, body] of E) {
  const params = [...p.matchAll(/\{(\w+)\}/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
  const op = { tags: [tag], summary, parameters: params.length ? params : undefined,
    responses: { 200: { description: 'OK' }, 400: { description: 'Validación', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }, ...(auth ? { 401: { description: 'No autenticado' }, 403: { description: 'Sin permiso (RBAC) o CSRF' } } : {}), 404: { description: 'No encontrado' }, 409: { description: 'Regla de negocio' } } };
  if (auth) op.security = [{ session: [], csrf: [] }];
  if (body) op.requestBody = { content: { 'application/json': { schema: { type: 'object', properties: Object.fromEntries(Object.entries(body).map(([k, v]) => [k, { type: 'string', description: v }])) } } } };
  (spec.paths[p] ||= {})[method] = op;
}
fs.writeFileSync(path.join(__dirname, '..', 'public', 'openapi.json'), JSON.stringify(spec, null, 2));
console.log(`✔ public/openapi.json (${E.length} operaciones)`);
