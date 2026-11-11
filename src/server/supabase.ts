import { createClient } from '@supabase/supabase-js';
import type { Database } from '../db/database.types.js';
import type { Backend, BackendConfig } from './handler.js';

export function createBackend(config: BackendConfig): Backend {
  // 요청마다 클라이언트를 만들어 다른 사용자의 인증 상태를 공유하지 않는다.
  const client = createClient<Database>(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: { Authorization: `Bearer ${config.token}` },
      fetch: (input, init) => fetch(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(8000)])
          : AbortSignal.timeout(8000),
      }),
    },
  });
  return {
    async getUser() {
      const { data, error } = await client.auth.getUser(config.token);
      if (error) {
        if (error.status && error.status < 500 && error.status !== 429) return null;
        throw new Error('auth_unavailable');
      }
      return data.user ? { id: data.user.id, isAnonymous: data.user.is_anonymous === true } : null;
    },
    async getProfile(id) {
      const { data, error } = await client.from('user_profiles')
        .select('user_id,search_conditions,commute_destination,revision,updated_at')
        .eq('user_id', id).maybeSingle();
      if (error) throw new Error('database_unavailable');
      return data;
    },
  };
}
