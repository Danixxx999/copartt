'use strict';
/**
 * Inicio de sesión social (OAuth 2.0 / OpenID Connect) enchufable.
 *
 * Google y Microsoft están IMPLEMENTADOS (flujo "authorization code" estándar). Funcionan en cuanto
 * se ponen sus credenciales en .env; si faltan, el botón aparece desactivado con instrucciones (igual
 * que las pasarelas de pago). Apple queda listo para añadir (su "client secret" es un JWT firmado).
 *
 * El número de tarjeta... perdón, la contraseña del proveedor NUNCA llega aquí: el usuario se autentica
 * en la web del proveedor y nosotros solo recibimos un código de un solo uso que canjeamos por su correo.
 *
 * Config en .env:
 *   OAUTH_BASE_URL       (p. ej. http://localhost:3000; por defecto se deduce de la petición)
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 *   MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET
 */
const { AppError } = require('../lib/errors');

const PROVIDERS = {
  google: {
    name: 'Google', implemented: true, env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    idFromEnv: () => process.env.GOOGLE_CLIENT_ID, secretFromEnv: () => process.env.GOOGLE_CLIENT_SECRET,
    notes: 'Crea credenciales OAuth en console.cloud.google.com → APIs & Services → Credentials. URI de redirección: <base>/auth/oauth/google/callback',
  },
  microsoft: {
    name: 'Microsoft', implemented: true, env: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userInfoUrl: 'https://graph.microsoft.com/oidc/userinfo',
    scope: 'openid email profile',
    idFromEnv: () => process.env.MICROSOFT_CLIENT_ID, secretFromEnv: () => process.env.MICROSOFT_CLIENT_SECRET,
    notes: 'Registra una app en entra.microsoft.com (Azure AD). URI de redirección: <base>/auth/oauth/microsoft/callback',
  },
  apple: {
    name: 'Apple', implemented: false, env: ['APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY'],
    notes: 'Sign in with Apple: el "client secret" es un JWT ES256 firmado con la clave .p8. Adaptador pendiente.',
  },
};

function configured(code) {
  const p = PROVIDERS[code];
  return !!(p && p.implemented && p.env.every(k => process.env[k]));
}
const redirectUri = (base, code) => `${String(base).replace(/\/$/, '')}/auth/oauth/${code}/callback`;

/** URL a la que enviar al usuario para que inicie sesión en el proveedor. */
function authUrl(code, { base, state }) {
  const p = PROVIDERS[code];
  if (!configured(code)) throw new AppError(404, 'Este inicio de sesión no está disponible.', { code: 'OAUTH_UNAVAILABLE' });
  const q = new URLSearchParams({ client_id: p.idFromEnv(), redirect_uri: redirectUri(base, code), response_type: 'code', scope: p.scope, state, access_type: 'online', prompt: 'select_account' });
  return `${p.authUrl}?${q}`;
}

/** Canjea el código por los datos del usuario: {providerUserId, email, firstName, lastName, emailVerified}. */
async function exchange(code, { base, authCode }) {
  const p = PROVIDERS[code];
  if (!configured(code)) throw new AppError(404, 'Proveedor no disponible.', { code: 'OAUTH_UNAVAILABLE' });
  const body = new URLSearchParams({ code: authCode, client_id: p.idFromEnv(), client_secret: p.secretFromEnv(), redirect_uri: redirectUri(base, code), grant_type: 'authorization_code' });
  const tokenRes = await fetch(p.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
  if (!tokenRes.ok) throw new AppError(502, 'El proveedor rechazó el inicio de sesión. Inténtelo de nuevo.', { code: 'OAUTH_TOKEN' });
  const token = await tokenRes.json();
  const infoRes = await fetch(p.userInfoUrl, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' } });
  if (!infoRes.ok) throw new AppError(502, 'No se pudieron leer los datos de la cuenta.', { code: 'OAUTH_USERINFO' });
  const info = await infoRes.json();
  const email = (info.email || '').toLowerCase().trim();
  if (!email) throw new AppError(502, 'El proveedor no entregó un correo electrónico.', { code: 'OAUTH_NO_EMAIL' });
  return {
    providerUserId: String(info.sub || info.id),
    email,
    emailVerified: info.email_verified === true || info.email_verified === 'true' || code === 'microsoft',
    firstName: info.given_name || (info.name || '').split(' ')[0] || 'Miembro',
    lastName: info.family_name || (info.name || '').split(' ').slice(1).join(' ') || '',
  };
}

/** Estado para el panel del dueño (sin mostrar nunca los valores de las claves). */
function status() {
  return Object.entries(PROVIDERS).map(([code, p]) => {
    const missing = (p.env || []).filter(k => !process.env[k]);
    return { code, name: p.name, implemented: p.implemented, env: p.env || [], missing, configured: configured(code), notes: p.notes };
  });
}
/** Proveedores listos para mostrar su botón en login/registro. */
const enabled = () => Object.keys(PROVIDERS).filter(configured).map(c => ({ code: c, name: PROVIDERS[c].name }));

module.exports = { PROVIDERS, configured, authUrl, exchange, status, enabled, redirectUri };
