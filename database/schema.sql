-- Beam session logs. The server creates these tables automatically on start;
-- this file is here for reference and for setting up the database by hand.
-- Only metadata is stored: file names and contents never reach the server.

CREATE DATABASE IF NOT EXISTS beam;
USE beam;

CREATE TABLE IF NOT EXISTS sessions (
  id CHAR(36) PRIMARY KEY,               -- one row per paired screen + phone
  started_at DATETIME NOT NULL,
  ended_at DATETIME NULL,
  host_device VARCHAR(120) NOT NULL,     -- e.g. "Windows PC, Chrome"
  guest_device VARCHAR(120) NOT NULL,    -- e.g. "iPhone, Safari"
  end_reason VARCHAR(40) NULL            -- e.g. guest_left, host_disconnected
);

CREATE TABLE IF NOT EXISTS transfers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  direction ENUM('host_to_guest','guest_to_host') NOT NULL,
  file_count INT NOT NULL,
  total_bytes BIGINT NOT NULL,
  duration_ms INT NOT NULL,
  avg_speed_bps BIGINT NOT NULL,
  all_verified TINYINT(1) NOT NULL,      -- 1 if every file's SHA-256 matched
  INDEX idx_transfers_session (session_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Useful queries for the report
-- Total data moved:      SELECT SUM(total_bytes) FROM transfers;
-- Busiest hours:         SELECT HOUR(created_at) h, COUNT(*) FROM transfers GROUP BY h ORDER BY 2 DESC;
-- Average speed per day: SELECT DATE(created_at), AVG(avg_speed_bps) FROM transfers GROUP BY 1;
