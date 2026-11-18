'use strict';
/** Anuncios del dueño: avisos, promociones y publicidad propia mostrados a los miembros. */
const db = require('../db');

/** Condición SQL de audiencia para un usuario (roles + plan). */
function audienceParams(user) {
  const roles = user ? user.roles : [];
  const plan = user && user.plan ? user.plan.code : (user && user.pendingPlan ? user.pendingPlan.code : 'guest');
  const isStaff = user ? user.isStaff : false;
  // Devuelve la lista de valores de "audience" que le corresponden a este usuario.
  const aud = ['all'];
  if (roles.includes('buyer')) aud.push('buyers', plan);
  if (roles.includes('seller')) aud.push('sellers');
  if (isStaff) aud.push('staff');
  return aud;
}

/** Anuncios vigentes para un usuario, separados en banner (no cerrados) y feed. */
async function activeFor(user, { bannerOnly = false } = {}) {
  if (!user) return { banners: [], feed: [] };
  const aud = audienceParams(user);
  const rows = await db.many(`
    SELECT a.*, (d.user_id IS NOT NULL) AS dismissed
      FROM announcements a
      LEFT JOIN announcement_dismissals d ON d.announcement_id = a.id AND d.user_id = $1
     WHERE a.active AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now()) AND a.audience = ANY($2)
     ORDER BY a.id DESC`, [user.id, aud]);
  return {
    banners: rows.filter(a => ['banner', 'both'].includes(a.placement) && !(a.dismissible && a.dismissed)),
    feed: bannerOnly ? [] : rows.filter(a => ['feed', 'both'].includes(a.placement)),
  };
}

/** Envía el anuncio al buzón de notificaciones de cada usuario de su audiencia (una sola vez). */
async function push(client, announcement) {
  const q = client || db;
  const roleFilter = { buyers: "r.code='buyer'", sellers: "r.code='seller'", staff: "r.code IN ('admin','finance','ops')" }[announcement.audience];
  const isPlan = ['guest', 'basic', 'premium'].includes(announcement.audience);
  let sql, params = [];
  if (roleFilter) sql = `SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE u.status='active' AND ${roleFilter}`;
  else if (isPlan) { sql = "SELECT u.id FROM users u WHERE u.status='active' AND u.id IN (SELECT s.user_id FROM subscriptions s JOIN membership_plans mp ON mp.id=s.plan_id WHERE s.status='active' AND mp.code=$1)"; params = [announcement.audience]; }
  else sql = "SELECT u.id FROM users u WHERE u.status='active'";
  const targets = await q.many(sql, params);
  const link = announcement.cta_url || '/dashboard/notifications';
  for (const t of targets) await q.query('INSERT INTO notifications(user_id, title, body, link) VALUES ($1,$2,$3,$4)', [t.id, announcement.title, announcement.body, link]);
  await q.query('UPDATE announcements SET pushed_at=now() WHERE id=$1', [announcement.id]);
  return targets.length;
}

module.exports = { activeFor, push, audienceParams };
