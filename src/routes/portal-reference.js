'use strict';
const express = require('express');
const db = require('../db');
const router = express.Router();
router.get(['/sales-list', '/salesListResult'], async (req, res) => {
  const events = await db.many(`SELECT e.*, loc.name AS location_name, loc.country,
    (SELECT COUNT(*)::int FROM auction_lots l WHERE l.event_id=e.id AND l.status<>'cancelled') AS lots
    FROM auction_events e LEFT JOIN locations loc ON loc.id=e.location_id
    WHERE e.status IN ('scheduled','live') AND (loc.country=$1 OR e.location_id IS NULL)
    ORDER BY e.status='live' DESC, e.starts_at, e.id`, [req.region]);
  res.render('pages/sales-list', { events, title: 'Listado de Ventas' });
});
router.get(['/watchList', '/watchlist-guide'], (req, res) => res.render('pages/inventory-guide', { guide: 'watch', title: 'Lista de favoritos' }));
router.get(['/savedsearch', '/saved-search-guide'], (req, res) => res.render('pages/inventory-guide', { guide: 'saved', title: 'Búsquedas guardadas' }));
for (const [alias, target] of Object.entries({ '/vehicleFinder': '/vehicle-finder', '/todaysAuction': '/auctions', '/auctionCalendar': '/auctions/calendar' })) {
  router.get(alias, (req, res) => res.redirect(302, target));
}
module.exports = router;
