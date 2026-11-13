-- 003: regiones del sitio. Cada sede pertenece a un país; el selector "Región del sitio web"
--      filtra el inventario, las sedes y los vehículos populares por ese país.
ALTER TABLE locations ADD COLUMN country CHAR(2) NOT NULL DEFAULT 'ES' CHECK (country ~ '^[A-Z]{2}$');
CREATE INDEX locations_country_idx ON locations (country);
