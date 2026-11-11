import { createHandler } from '../src/server/handler.js';
import { createBackend } from '../src/server/supabase.js';

// UI 프레임워크와 독립적인 Vercel Functions 진입점.
export default {
  fetch: createHandler({ env: process.env, createBackend }),
};
