// Build a self-contained synthetic UI preview using only checked-in source assets.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const aurora = process.argv.includes('--aurora');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFile(path.join(repo, relative), 'utf8');
const dataUri = async (relative, mime) => `data:${mime};base64,${(await readFile(path.join(repo, relative))).toString('base64')}`;
const files = { welcome:'01-welcome', loading:'02-search-loading', thinking:'03-thinking', complete:'04-complete', empty:'05-empty-result', held:'06-needs-check', error:'07-retry' };
const assets = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, name]) => [key, await dataUri(`public/app/brand/mascot/${name}.png`, 'image/png')])));
let css = await read('public/app/conversation.css');
if (aurora) css += '\n' + await read('public/app/conversation-aurora.css');
css = css.replace('/app/fonts/PretendardVariable.woff2', await dataUri('public/app/fonts/PretendardVariable.woff2', 'font/woff2'));
let js = await read('public/app/conversation.js');
js = `const embeddedAssets=${JSON.stringify(assets)};\n${js}`;
js = js.replace("const entryPath=isAurora?'/conversation-aurora.html':'/conversation.html';", "const entryPath='?view=welcome';").replace('src="/app/brand/mascot/${poses[pose]}.png"', 'src="${embeddedAssets[pose]}"')
  .replace('href="/conversation.html"', 'href="?view=welcome"')
  .replace('<a class="secondary" href="/#home">실제 서비스 로그인 열기 ↗</a>', "${btn('existing-service','실제 연결 기능 안내','secondary')}")
  .replace('<a class="nav-link" href="/#home">${icon(\'home\')}기존 연결 기능 ↗</a>', "${btn('existing-service','기존 연결 기능 안내','nav-link','home')}")
  .replace("if(a==='source')return setView('evidence');", "if(a==='source')return setView('evidence');if(a==='existing-service')return openDialog('기존 연결 기능',note('이 HTML은 독립 디자인 시안입니다. 실제 로그인·공고·분석·자금표·법령·경로·뉴스 기능은 HomeCierge 앱 서버를 실행한 후 기본 페이지에서 사용합니다.')); ");
let html = await read(aurora ? 'public/conversation-aurora.html' : 'public/conversation.html');
html = html.replace('  <link rel="stylesheet" href="/app/conversation-aurora.css">', '');
html = html.replace('<link rel="stylesheet" href="/app/conversation.css">', `<style>${css}</style>`)
  .replace('<link rel="icon" href="/app/brand/mascot/01-welcome.png" type="image/png">', `<link rel="icon" href="${assets.welcome}" type="image/png">`)
  .replace('<script type="module" src="/app/conversation.js"></script>', '')
  .replace('</body>', `<script type="module">${js}</script></body>`);
if (html.includes('src="/app/') || html.includes('href="/app/')) throw new Error('단독 HTML에 외부 앱 자산 참조가 남아 있습니다.');
html = html.replace(/[ \t]+$/gm, '');
const output = path.join(repo, aurora ? 'design/homecierge-aurora.html' : 'design/homecierge-conversation.html');
await mkdir(path.dirname(output), { recursive:true });
await writeFile(output, html);
console.log(`생성 완료: ${path.relative(repo, output)} (${Buffer.byteLength(html).toLocaleString('en-US')} bytes)`);
