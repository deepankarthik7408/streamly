-- =====================================================================
--  Streamly – real accounts (email + password sign-up and Google sign-in)
--
--  Run in DBeaver:  open this file, then Alt+X (Execute SQL Script).
--
--  This REPLACES the `users` table from streamly_new_tables.sql with the
--  full version. Only run it while the users table is empty / unused
--  (it was never used before, so that's normal). If you ever have real
--  members and need to change columns, use ALTER TABLE instead.
-- =====================================================================

SET NAMES utf8mb4;

DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  username       VARCHAR(50)  NOT NULL UNIQUE,   -- internal id, e.g. u_ab12cd34… or g_<google id>
  display_name   VARCHAR(100) NOT NULL,
  email          VARCHAR(255) NULL UNIQUE,       -- sign-in name for email accounts
  password_hash  VARCHAR(255) NOT NULL DEFAULT '',  -- salted scrypt hash; empty for Google-only accounts
  google_sub     VARCHAR(64)  NULL UNIQUE,       -- Google's permanent id for the person
  avatar_url     VARCHAR(500) NULL,
  role           ENUM('admin','member') NOT NULL DEFAULT 'member',
  is_active      TINYINT(1)   NOT NULL DEFAULT 1,   -- set to 0 to block someone
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at  TIMESTAMP    NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Handy admin queries (run any time):
--   SELECT id, display_name, email, role, is_active, created_at, last_login_at FROM users ORDER BY created_at DESC;
--   UPDATE users SET is_active = 0 WHERE email = 'someone@example.com';   -- block
--   UPDATE users SET role = 'admin' WHERE email = 'you@gmail.com';        -- make admin
