// Confere a tela de verdade (Chrome via Playwright), sem nunca logar como Gabriel/Luana
// pela interface — entra como o usuário de teste direto pela API e só então injeta o token,
// pra nunca gravar um PIN de teste em cima da senha real de alguém.
const { chromium } = require('/root/pw/node_modules/playwright');

const BASE = 'https://poke.workprog.pro';

(async () => {
  const login = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome: '_teste_missao', pin: '1357' }),
  }).then(r => r.json());
  if (!login.token) { console.error('login de teste falhou', login); process.exit(1); }

  const browser = await chromium.launch();
  for (const [nome, viewport] of [['desktop', { width: 1280, height: 900 }], ['celular', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    // Ainda deslogado: confere a TELA de login antes de injetar o token.
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.screenshot({ path: `/root/missao-financas/saida/${nome}-0-login.png` });
    const loginVisivel = await page.isVisible('#login');
    const appEscondido = await page.isHidden('#app');
    console.log(nome, 'tela de login visível antes de logar:', loginVisivel, '| app escondido:', appEscondido);

    // Agora injeta o token do usuário de TESTE (nunca digitado na tela) e recarrega.
    await page.evaluate(t => localStorage.setItem('missao_token', t), login.token);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    await page.screenshot({ path: `/root/missao-financas/saida/${nome}-1-mes.png`, fullPage: true });
    console.log(nome, 'app visível depois de logar:', await page.isVisible('#app'), '| login escondido:', await page.isHidden('#login'));

    for (const aba of ['chefoes', 'metas', 'gastos']) {
      await page.click(`.tabs button[data-tab="${aba}"]`);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `/root/missao-financas/saida/${nome}-2-${aba}.png`, fullPage: true });
    }

    await page.click('.tabs button[data-act="lancar"]');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `/root/missao-financas/saida/${nome}-3-lancar.png` });

    await ctx.close();
  }
  await browser.close();

  // Limpeza: sessão e PIN de teste não ficam pendurados.
  await fetch(BASE + '/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + login.token } });
  console.log('OK — screenshots em /root/missao-financas/saida/');
})();
