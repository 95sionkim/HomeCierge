// 배포와 로컬 화면 모두 설치한 버전의 공식 브라우저 SDK를 같은 출처에서 읽는다.
import { copyFile, mkdir } from 'node:fs/promises';

const sdk = new URL('../node_modules/@supabase/supabase-js/', import.meta.url);
const assets = new URL('../public/vendor/', import.meta.url);
await mkdir(assets, { recursive: true });
await Promise.all([
  copyFile(new URL('dist/umd/supabase.js', sdk), new URL('supabase.js', assets)),
  copyFile(new URL('LICENSE', sdk), new URL('supabase-LICENSE.txt', assets)),
]);
