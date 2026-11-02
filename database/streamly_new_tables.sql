-- =====================================================================
--  Streamly – new tables (MySQL 8 / Aiven)             all start EMPTY
--
--  HOW TO RUN IN DBEAVER
--    1. Connect to your Aiven database and make it the active schema.
--    2. Open a SQL editor (Ctrl+]), paste this whole file.
--    3. Run it as a SCRIPT:  Alt+X  (Execute SQL Script) – not Ctrl+Enter.
--
--  The app checks for each table every minute, so you can create them
--  one at a time. Anything missing just shows "no data yet".
--
--  Your existing tables (titles, genres, countries, actors, directors,
--  title_genres, title_countries, title_actors, title_directors and the
--  view v_titles_full) are NOT touched.
--
--  show_id is declared INT here. If your titles.show_id is a different
--  type, run this and change it below to match:
--    SELECT COLUMN_TYPE FROM information_schema.COLUMNS
--     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'titles' AND COLUMN_NAME = 'show_id';
-- =====================================================================

SET NAMES utf8mb4;

-- 1. users  ---------------------------------------------------------
--    Login is still hardcoded in server.js. This table is ready for when
--    you move accounts into the database (store a password HASH, never plain text).
CREATE TABLE IF NOT EXISTS users (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  username       VARCHAR(50)  NOT NULL UNIQUE,
  display_name   VARCHAR(100) NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  role           ENUM('admin','member') NOT NULL DEFAULT 'member',
  is_active      TINYINT(1)   NOT NULL DEFAULT 1,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. title_media  ---------------------------------------------------
--    Poster / backdrop / trailer links per title. Poster shows on cards,
--    backdrop on the hero banner and wide cards.
CREATE TABLE IF NOT EXISTS title_media (
  show_id       INT NOT NULL PRIMARY KEY,
  poster_url    VARCHAR(500) NULL,
  backdrop_url  VARCHAR(500) NULL,
  trailer_url   VARCHAR(500) NULL,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. title_stats  ---------------------------------------------------
--    Star rating (1-5), "98% match", and the score that powers the
--    "Trending movies" row. avg_rating / rating_count are refreshed
--    automatically when members rate a title (needs user_ratings too).
CREATE TABLE IF NOT EXISTS title_stats (
  show_id         INT NOT NULL PRIMARY KEY,
  avg_rating      DECIMAL(2,1) NULL,
  rating_count    INT NOT NULL DEFAULT 0,
  match_percent   TINYINT UNSIGNED NULL,
  trending_score  DECIMAL(10,2) NOT NULL DEFAULT 0,
  view_count      BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_trending (trending_score)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. user_ratings  --------------------------------------------------
--    One row per member per title (they can change it later).
CREATE TABLE IF NOT EXISTS user_ratings (
  username  VARCHAR(50) NOT NULL,
  show_id   INT NOT NULL,
  stars     TINYINT UNSIGNED NOT NULL,
  rated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (username, show_id),
  KEY idx_ratings_show (show_id),
  CONSTRAINT chk_stars CHECK (stars BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5. awards  --------------------------------------------------------
CREATE TABLE IF NOT EXISTS awards (
  id    INT AUTO_INCREMENT PRIMARY KEY,
  name  VARCHAR(150) NOT NULL UNIQUE       -- e.g. Academy Awards, Filmfare, Emmy
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 6. title_awards  --------------------------------------------------
--    Powers the "Award-winning films" row (result = 'won') and the
--    Awards section in the title popup.
CREATE TABLE IF NOT EXISTS title_awards (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  show_id     INT NOT NULL,
  award_id    INT NOT NULL,
  category    VARCHAR(150) NOT NULL DEFAULT '',   -- e.g. Best Picture
  award_year  SMALLINT NULL,
  result      ENUM('won','nominated') NOT NULL DEFAULT 'won',
  UNIQUE KEY uq_title_award (show_id, award_id, category, award_year),
  KEY idx_ta_award (award_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 7. episodes  ------------------------------------------------------
--    Episode list for TV shows (shown in the title popup).
CREATE TABLE IF NOT EXISTS episodes (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  show_id       INT NOT NULL,
  season_no     SMALLINT NOT NULL DEFAULT 1,
  episode_no    SMALLINT NOT NULL,
  title         VARCHAR(255) NOT NULL,
  description   TEXT NULL,
  duration_min  SMALLINT NULL,
  UNIQUE KEY uq_episode (show_id, season_no, episode_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 8. watch_progress  ------------------------------------------------
--    Powers "Continue watching" with the progress bar. Your future
--    player posts to /api/me/progress; the app does the rest.
CREATE TABLE IF NOT EXISTS watch_progress (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  username          VARCHAR(50) NOT NULL,
  show_id           INT NOT NULL,
  progress_seconds  INT NOT NULL DEFAULT 0,
  duration_seconds  INT NOT NULL DEFAULT 0,
  season_no         SMALLINT NULL,
  episode_no        SMALLINT NULL,
  completed         TINYINT(1) NOT NULL DEFAULT 0,
  last_watched_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_progress (username, show_id),
  KEY idx_progress_recent (username, last_watched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 9. my_list  -------------------------------------------------------
--    Saves each member's list in the database instead of the browser.
CREATE TABLE IF NOT EXISTS my_list (
  username  VARCHAR(50) NOT NULL,
  show_id   INT NOT NULL,
  added_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (username, show_id),
  KEY idx_list_recent (username, added_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 10. title_views  --------------------------------------------------
--    "Recently viewed" row (one row each time a title popup opens).
CREATE TABLE IF NOT EXISTS title_views (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  username   VARCHAR(50) NOT NULL,
  show_id    INT NOT NULL,
  viewed_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_views_user (username, viewed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 11. notifications  ------------------------------------------------
--    The bell in the top bar. username NULL = shown to everyone.
CREATE TABLE IF NOT EXISTS notifications (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  username    VARCHAR(50) NULL,
  show_id     INT NULL,
  message     VARCHAR(300) NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_notif (username, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 12. collections  --------------------------------------------------
--    Hand-picked rows for the home page. The row with slug 'hero'
--    controls the big banner carousel; every other active collection
--    becomes its own row.
CREATE TABLE IF NOT EXISTS collections (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  slug        VARCHAR(80)  NOT NULL UNIQUE,
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 13. collection_titles  -------------------------------------------
CREATE TABLE IF NOT EXISTS collection_titles (
  collection_id  INT NOT NULL,
  show_id        INT NOT NULL,
  position       INT NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, show_id),
  KEY idx_ct_pos (collection_id, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 14. genre_art  ----------------------------------------------------
--    Image for each tile in "Popular genres".
CREATE TABLE IF NOT EXISTS genre_art (
  genre_id   INT NOT NULL PRIMARY KEY,
  image_url  VARCHAR(500) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- =====================================================================
--  OPTIONAL: foreign keys (keeps data clean when a title is deleted)
--  Run this block only AFTER the tables above exist, and only if
--  titles.show_id is INT (same type as above). If you get error 3780
--  ("incompatible columns"), the types differ – skip this block, the
--  app works fine without it.
--  If genres.id isn't INT, skip the genre_art line.
-- =====================================================================
-- ALTER TABLE title_media       ADD CONSTRAINT fk_media_title   FOREIGN KEY (show_id) REFERENCES titles(show_id) ON DELETE CASCADE;
-- ALTER TABLE title_stats       ADD CONSTRAINT fk_stats_title   FOREIGN KEY (show_id) REFERENCES titles(show_id) ON DELETE CASCADE;
-- ALTER TABLE user_ratings      ADD CONSTRAINT fk_ratings_title FOREIGN KEY (show_id) REFERENCES titles(show_id) ON DELETE CASCADE;
-- ALTER TABLE title_awards      ADD CONSTRAINT fk_ta_title      FOREIGN KEY (show_id) REFERENCES titles(show_id) ON DELETE CASCADE;
-- ALTER TABLE title_awards      ADD CONSTRAINT fk_ta_award      FOREIGN KEY (award_id) REFERENCES awards(id) ON DELETE CASCADE;
-- ALTER TABLE episodes          ADD CONSTRAINT fk_ep_title      FOREIGN KEY (show_id) REFERENCES titles(show_id) ON DELETE CASCADE;
-- ALTER TABLE watch_progress    ADD CONSTRAINT fk_wp_title      FOREIGN KEY (show_id) REFERENCES titles(show_id) ON DELETE CASCADE;
-- ALTER TABLE my_list           ADD CONSTRAINT fk_list_title    FOREIGN KEY (show_id) REFERENCES titles(show_id) ON DELETE CASCADE;
-- ALTER TABLE title_views       ADD CONSTRAINT fk_views_title   FOREIGN KEY (show_id) REFERENCES titles(show_id) ON DELETE CASCADE;
-- ALTER TABLE collection_titles ADD CONSTRAINT fk_ct_title      FOREIGN KEY (show_id) REFERENCES titles(show_id) ON DELETE CASCADE;
-- ALTER TABLE collection_titles ADD CONSTRAINT fk_ct_coll       FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE;
-- ALTER TABLE genre_art         ADD CONSTRAINT fk_ga_genre      FOREIGN KEY (genre_id) REFERENCES genres(id) ON DELETE CASCADE;


-- =====================================================================
--  OPTIONAL: example rows to test each feature (uncomment, replace the
--  show_id numbers with real ones from your titles table)
--      SELECT show_id, title FROM titles LIMIT 20;
-- =====================================================================
-- INSERT INTO title_media (show_id, poster_url, backdrop_url) VALUES (1, 'https://example.com/poster.jpg', 'https://example.com/backdrop.jpg');
-- INSERT INTO title_stats (show_id, avg_rating, rating_count, match_percent, trending_score) VALUES (1, 4.3, 120, 98, 95.5);
-- INSERT INTO collections (name, slug, sort_order) VALUES ('Banner spotlight', 'hero', 0), ('Editor''s picks', 'editors-picks', 1);
-- INSERT INTO collection_titles (collection_id, show_id, position) VALUES (1, 1, 1), (1, 2, 2), (2, 3, 1);
-- INSERT INTO awards (name) VALUES ('Academy Awards');
-- INSERT INTO title_awards (show_id, award_id, category, award_year, result) VALUES (1, 1, 'Best Picture', 2022, 'won');
-- INSERT INTO notifications (message) VALUES ('Welcome to Streamly – new titles added this week!');
-- INSERT INTO genre_art (genre_id, image_url) VALUES (1, 'https://example.com/genre.jpg');
