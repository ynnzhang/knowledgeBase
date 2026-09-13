// Node/local runtime. Cloud bindings are supplied only by the Cloudflare build.
// Keeping this boundary explicit avoids importing worker-only modules in Node.
export function cloudBindings(): { DB?: D1Database; ASSETS?: R2Bucket } {
  return {};
}
