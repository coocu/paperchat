import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {privacyEffectiveDate,privacyOperator,privacyContactEmail,privacyIntro,privacySections} from './public/privacy.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderPrivacyPage(){
  const sections=privacySections.map(section=>`<section class="paper"><h2>${esc(section.title)}</h2>${(section.paragraphs||[]).map(p=>`<p>${esc(p)}</p>`).join('')}${section.bullets?.length?`<ul>${section.bullets.map(p=>`<li>${esc(p)}</li>`).join('')}</ul>`:''}</section>`).join('\n');
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>종이편지 · 개인정보 처리방침</title><link rel="stylesheet" href="/theme.css"></head>
<body><main><header class="bar"><span class="brand">종이편지</span><a class="textBtn" href="/app">채팅으로 돌아가기</a></header><section class="hero"><h1>개인정보 처리방침</h1><p>${esc(privacyOperator)} · 시행일 ${esc(privacyEffectiveDate)}</p><p>${esc(privacyIntro)}</p></section><div class="screen-stack">
${sections}
<section class="letter"><h2>문의</h2><a href="mailto:${esc(privacyContactEmail)}">${esc(privacyContactEmail)}</a><p><a href="/support">고객지원 안내</a></p></section>
</div></main></body></html>\n`;
}
// Export the same content for standalone static hosting when needed.
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)
  writeFileSync(new URL('./public/privacy.html',import.meta.url),renderPrivacyPage());
