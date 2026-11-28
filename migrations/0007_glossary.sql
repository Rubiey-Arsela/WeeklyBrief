-- Glossary — short definitions for the acronyms/jargon the weekly brief
-- uses repeatedly (OPR, SST, IPP, FiT, etc.), so a reader who doesn't
-- recognise a term doesn't have to leave the app to look it up. A single
-- shared table (not per-edition) since these definitions rarely change
-- week to week; editable later from the admin dashboard without a
-- redeploy.

CREATE TABLE IF NOT EXISTS glossary (
  term TEXT PRIMARY KEY,          -- stored lowercase for case-insensitive lookup
  display_term TEXT NOT NULL,     -- original casing shown in the UI, e.g. "OPR"
  definition TEXT NOT NULL,
  created TEXT NOT NULL DEFAULT (datetime('now')),
  updated TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed with the terms that recur across the brief's own sector vocabulary
-- (macro, ports/logistics, energy, digital economy, property, aviation,
-- banking) — a reasonable starting set the director can extend later.
INSERT OR IGNORE INTO glossary (term, display_term, definition) VALUES
  ('opr', 'OPR', 'Overnight Policy Rate — Bank Negara Malaysia''s benchmark interest rate, the main lever it uses to influence borrowing costs and inflation.'),
  ('bnm', 'BNM', 'Bank Negara Malaysia — the country''s central bank, responsible for monetary policy, financial stability and currency issuance.'),
  ('dosm', 'DOSM', 'Department of Statistics Malaysia — the government agency that publishes official economic data (GDP, trade, inflation, employment).'),
  ('sst', 'SST', 'Sales and Service Tax — Malaysia''s consumption tax regime, charged on taxable goods (sales tax) and services (service tax).'),
  ('gdp', 'GDP', 'Gross Domestic Product — the total value of goods and services produced in the economy over a period, the standard measure of economic growth.'),
  ('fdi', 'FDI', 'Foreign Direct Investment — capital invested by overseas entities into productive assets (factories, equipment, operations) in Malaysia.'),
  ('ipp', 'IPP', 'Independent Power Producer — a private company that generates electricity for sale to the grid or to Tenaga Nasional, rather than a utility-owned plant.'),
  ('fit', 'FiT', 'Feed-in Tariff — a guaranteed above-market price paid to renewable-energy generators (solar, biomass, etc.) for the power they feed into the grid.'),
  ('nem', 'NEM', 'Net Energy Metering — a scheme letting solar panel owners offset their electricity bill with excess power exported back to the grid.'),
  ('ptp', 'PTP', 'Port of Tanjung Pelepas — Malaysia''s largest transshipment container port, located in Johor near Singapore.'),
  ('myr', 'MYR', 'Malaysian Ringgit — Malaysia''s currency, ISO code MYR, commonly quoted against USD as USD/MYR.'),
  ('bursa', 'Bursa Malaysia', 'The Malaysian stock exchange operator, home to the FBM KLCI benchmark index and all locally listed companies.'),
  ('klci', 'FBM KLCI', 'FTSE Bursa Malaysia Kuala Lumpur Composite Index — the benchmark index tracking the 30 largest companies listed on Bursa Malaysia.'),
  ('ron95', 'RON95', 'RON95 petrol — the subsidised, lower-octane petrol grade sold in Malaysia, subject to government price controls/subsidy targeting.'),
  ('ron97', 'RON97', 'RON97 petrol — the unsubsidised, higher-octane petrol grade sold at market price in Malaysia.'),
  ('mof', 'MOF', 'Ministry of Finance — the Malaysian government ministry responsible for fiscal policy, budget, and public spending.'),
  ('epf', 'EPF', 'Employees Provident Fund — Malaysia''s mandatory retirement savings scheme for private-sector employees.'),
  ('khazanah', 'Khazanah', 'Khazanah Nasional — Malaysia''s sovereign wealth fund, holding strategic stakes across key national companies.'),
  ('petronas', 'Petronas', 'Petroliam Nasional Berhad — Malaysia''s state-owned oil and gas company.'),
  ('brent', 'Brent Crude', 'Brent Crude — the global benchmark price for crude oil, used to price roughly two-thirds of the world''s traded oil.'),
  ('cpo', 'CPO', 'Crude Palm Oil — the raw, unrefined palm oil commodity, Malaysia''s major agricultural export, priced on Bursa Malaysia derivatives.'),
  ('mco', 'MCO', 'Movement Control Order — Malaysia''s COVID-era lockdown measure; occasionally referenced in historical/comparative context.'),
  ('dc', 'Data Centre', 'A facility housing computing/storage infrastructure for cloud, AI and enterprise workloads — a fast-growing investment theme in Johor and the Klang Valley.')
ON CONFLICT(term) DO NOTHING;
