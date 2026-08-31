import { env } from 'cloudflare:workers';
import { NOTE_OVERRIDES_SCHEMA } from '../../../db/schema';

type NoteOverrideRow = {
  path: string;
  raw: string;
  updated_at: string;
};

function database() {
  return (env as unknown as { DB: D1Database }).DB;
}

async function ensureSchema(db: D1Database) {
  await db.prepare(NOTE_OVERRIDES_SCHEMA).run();
}

export async function GET() {
  try {
    const db = database();
    await ensureSchema(db);
    const result = await db
      .prepare('SELECT path, raw, updated_at FROM note_overrides ORDER BY path')
      .all<NoteOverrideRow>();
    return Response.json({ overrides: result.results || [] });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '无法读取云端笔记修改。' },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as { path?: unknown; raw?: unknown };
    const path = typeof payload.path === 'string' ? payload.path.trim() : '';
    const raw = typeof payload.raw === 'string' ? payload.raw : '';
    if (!path || !raw) {
      return Response.json({ error: '缺少笔记路径或内容。' }, { status: 400 });
    }

    const db = database();
    await ensureSchema(db);
    const modified = new Date().toISOString();
    await db
      .prepare(`
        INSERT INTO note_overrides (path, raw, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          raw = excluded.raw,
          updated_at = excluded.updated_at
      `)
      .bind(path, raw, modified)
      .run();

    return Response.json({ raw, modified });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '无法保存云端笔记修改。' },
      { status: 500 },
    );
  }
}
