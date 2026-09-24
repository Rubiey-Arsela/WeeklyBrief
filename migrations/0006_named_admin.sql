-- Named-admin elevation over the reader-access gate.
--
-- The WhatsApp group all shares one view-only code (app_settings.reader_code,
-- currently 6170). Rubiey needs the same low-friction single sign-in box,
-- but typing her name together with a SEPARATE, private code should elevate
-- her session to admin: unlock Add/Edit Report and the Reader Access
-- dashboard, which stay hidden/blocked for every other reader even if they
-- happen to type "Rubiey" as their name while using the shared code.
--
-- reader_sessions.role distinguishes an elevated session ('admin') from an
-- ordinary one ('reader'); isStaffRequest()/isAdminRequest() in index.tsx
-- both accept role='admin' reader sessions in addition to Microsoft SSO and
-- the standalone admin-dashboard password.

ALTER TABLE reader_sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'reader';

-- Personal elevation credential — name is matched case-insensitively,
-- code must match exactly. Both are stored in app_settings so they can be
-- changed later from the admin dashboard without a redeploy.
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('admin_personal_name', 'Rubiey');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('admin_personal_code', '5058');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('admin_personal_code_version', '1');
