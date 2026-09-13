import { env } from 'cloudflare:workers';
export function cloudBindings(): { DB?: D1Database; ASSETS?: R2Bucket } {
  return env as { DB?: D1Database; ASSETS?: R2Bucket };
}
