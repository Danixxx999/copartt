'use strict';
const db = require('../db');
const { eur } = require('./money');
const config = require('../config');

const TZ = config.timezone;
const fmt = (d, opts) => (d ? new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...opts }).format(new Date(d)) : '—');
const date = d => fmt(d, { day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTime = d => fmt(d, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const time = d => fmt(d, { hour: '2-digit', minute: '2-digit' });
const weekday = d => fmt(d, { weekday: 'long' });

const LABELS = {
  prebidding: ['Pre-bidding open', 'blue'], scheduled: ['Scheduled', 'gray'], live: ['Live now', 'green'], ended: ['Ended', 'gray'], awarded: ['Sold', 'brown'],
  pending_seller_approval: ['On approval', 'amber'], no_sale: ['No sale', 'gray'], cancelled: ['Cancelled', 'red'],
  draft: ['Draft', 'gray'], pending_approval: ['Pending approval', 'amber'], approved: ['Approved', 'green'], rejected: ['Rejected', 'red'], withdrawn: ['Withdrawn', 'gray'], sold: ['Sold', 'brown'],
  pending_payment: ['Pending payment', 'amber'], payment_review: ['Payment under review', 'blue'], paid: ['Paid', 'green'], ready_for_pickup: ['Ready for pickup', 'green'], in_transport: ['In transport', 'blue'], completed: ['Completed', 'gray'],
  issued: ['Issued', 'amber'], partially_paid: ['Partially paid', 'blue'], void: ['Void', 'gray'], pending_review: ['Pending review', 'amber'],
  requested: ['Requested', 'amber'], assigned: ['Carrier assigned', 'blue'], picked_up: ['Picked up', 'blue'], in_transit: ['In transit', 'blue'], delivered: ['Delivered', 'green'],
  active: ['Active', 'green'], used: ['Used', 'gray'], revoked: ['Revoked', 'red'], pending: ['Pending', 'amber'], unverified: ['Not verified', 'gray'], suspended: ['Suspended', 'red'],
  open: ['Open', 'amber'], in_progress: ['In progress', 'blue'], closed: ['Closed', 'gray'], quoted: ['Quoted', 'blue'], accepted: ['Accepted', 'green'], expired: ['Expired', 'gray'],
};
const label = s => (LABELS[s] || [String(s || '').replace(/_/g, ' ')])[0];
const badge = s => `<span class="badge badge-${(LABELS[s] || [0, 'gray'])[1]}">${label(s)}</span>`;
const lotTitle = l => `${l.year} ${l.make} ${l.model}${l.trim ? ' ' + l.trim : ''}`;
const km = n => `${Number(n || 0).toLocaleString('es-ES')} km`;
const cap = s => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const isDemoImage = p => typeof p === 'string' && p.startsWith('/media/car/');
const displayImage = p => {
  if (!isDemoImage(p)) return p || '/img/copart/demo-sedan.jpg';
  if (/\/suv\.svg/.test(p)) return '/img/copart/demo-suv.jpg';
  if (/\/automobile\.svg/.test(p)) return '/img/copart/demo-sedan.jpg';
  return p;
};

let bannerCache = { at: 0, value: null };
async function topBanner() {
  if (Date.now() - bannerCache.at < 10_000) return bannerCache.value;
  bannerCache = { at: Date.now(), value: await db.one("SELECT text, link_text, link_url FROM banners WHERE placement='top' AND active ORDER BY id LIMIT 1") };
  return bannerCache.value;
}
const resetBannerCache = () => { bannerCache.at = 0; };

async function locals(req, res, next) {
  try {
    const isMemberPortal = !!(req.user && req.user.is('buyer'));
    const staffSurface = /^\/(admin|seller|finance|ops|api)(\/|$)/.test(req.path);
    const referenceLayout = isMemberPortal || !staffSurface;
    const selectedTheme = ['light','dark'].includes(req.query.theme) ? req.query.theme : null;
    if (selectedTheme) res.cookie('ap_theme', selectedTheme, { sameSite:'lax', path:'/', maxAge:365*86400_000 });
    // Por defecto, el mismo aspecto que la referencia (cabecera celeste, menú gris, fondo negro). El tema claro es opcional.
    const colorTheme = isMemberPortal ? 'dark' : selectedTheme || (['light','dark'].includes(req.cookies?.ap_theme) ? req.cookies.ap_theme : 'dark');
    Object.assign(res.locals, { eur, date, dateTime, time, weekday, label, badge, lotTitle, km, cap, displayImage, isDemoImage, isMemberPortal, referenceLayout, colorTheme, cookieChoice: !!req.cookies?.ap_cookie_preferences, path: req.path, query: req.query, title: null, description: null });
    res.locals.qsWith = (patch) => { const p = new URLSearchParams(req.query); for (const [k, v] of Object.entries(patch)) { if (v === null || v === undefined || v === '') p.delete(k); else p.set(k, v); } return p.toString(); };
    res.locals.banner = await topBanner();
    res.locals.unread = req.user ? (await db.one('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [req.user.id])).n : 0;
    // Anuncios del dueño: banners vigentes (no cerrados) para mostrar bajo la cabecera.
    res.locals.annBanners = (req.user && !req.path.startsWith('/api/')) ? (await require('../services/announcements').activeFor(req.user, { bannerOnly: true })).banners : [];
    res.locals.homeFor = require('./auth').homeFor;
    res.locals.socialEnabled = require('../services/social-auth').enabled(); // proveedores de login social configurados
    next();
  } catch (e) { next(e); }
}
module.exports = { locals, eur, date, dateTime, time, label, badge, lotTitle, resetBannerCache };
