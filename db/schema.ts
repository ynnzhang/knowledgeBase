export const NOTE_OVERRIDES_SCHEMA = `
CREATE TABLE IF NOT EXISTS note_overrides (
  path TEXT PRIMARY KEY NOT NULL,
  raw TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
`;
