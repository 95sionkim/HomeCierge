// 배포와 로컬 화면 모두 설치한 버전의 공식 브라우저 SDK를 같은 출처에서 읽는다.
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const sdk = new URL('../node_modules/@supabase/supabase-js/', import.meta.url);
const assets = new URL('../public/vendor/', import.meta.url);
await mkdir(assets, { recursive: true });
await Promise.all([
  copyFile(new URL('dist/umd/supabase.js', sdk), new URL('supabase.js', assets)),
  copyFile(new URL('LICENSE', sdk), new URL('supabase-LICENSE.txt', assets)),
  // 게스트 예시는 실제 검색·계산 함수를 공유하며 계정 또는 외부 API에 접근하지 않는다.
  build({ entryPoints: [fileURLToPath(new URL('../src/demo/planning.ts', import.meta.url))],
    outfile: fileURLToPath(new URL('planning-example.js', assets)), bundle: true, format: 'esm',
    platform: 'browser', target: 'es2022' }),
]);
