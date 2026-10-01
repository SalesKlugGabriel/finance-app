// Prova, em navegador de verdade, a regra que sustenta o cartão de crédito:
// uma parcela que cai na fatura NÃO pode ser cobrada também como conta separada.
// Se este teste quebrar, o app está contando o mesmo dinheiro duas vezes.
//
// Roda do host: node teste-cartao.js [endereço]
// Cria um usuário "_teste_cartao" com casa própria e apaga tudo no fim.

const { chromium } = require('/root/pw/node_modules/playwright');
const { execSync, execFileSync } = require('child_process');

// O navegador (Playwright) vive no host e o Postgres só é alcançável de dentro do
// container — então a limpeza vai por `docker exec`, em vez de abrir o banco pra fora.
// execFileSync (e não execSync) de propósito: sem shell no meio, o código com quebras de
// linha chega inteiro em vez de virar "\n" literal e quebrar a sintaxe.
function noBanco(js) {
  const cid = execSync('docker ps -qf name=missao_missao_financas_app').toString().trim();
  return execFileSync('docker', ['exec', cid, 'node', '-e', js]).toString().trim();
}

const BASE = process.argv[2] || 'https://financas.workprog.pro';
const U = '_teste_cartao', S = 'senha_de_teste';
let falhas = 0, conferencias = 0;
function ok(nome, condicao, detalhe = '') {
  conferencias++;
  if (condicao) console.log(`  OK    ${nome}`);
  else { falhas++; console.log(`  FALHA ${nome} ${detalhe}`); }
}
const api = (t, c, o = {}) => fetch(BASE + '/api' + c,
  { ...o, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t, ...(o.headers || {}) } }).then(r => r.json());

function limpar() {
  return noBanco(`
    const {pool}=require('/app/db');
    (async()=>{
      const r=await pool.query("SELECT casa_id FROM missao_usuarios WHERE nome='${U}'");
      const casas=r.rows.map(x=>x.casa_id).filter(Boolean);
      await pool.query("DELETE FROM missao_usuarios WHERE nome='${U}'");
      for(const t of ['missao_docs','missao_config','missao_convites'])
        if(casas.length) await pool.query('DELETE FROM '+t+' WHERE casa_id = ANY($1)',[casas]);
      if(casas.length) await pool.query('DELETE FROM missao_casas WHERE id = ANY($1)',[casas]);
      const s=await pool.query("SELECT count(*) c FROM missao_docs WHERE dados->>'nome' LIKE 'ZZ TESTE%'");
      console.log(s.rows[0].c);
      await pool.end();
    })();`);
}

(async () => {
  limpar();
  const cad = await fetch(BASE + '/api/cadastrar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: U, senha: S, senha2: S }),
  }).then(r => r.json());
  const t = cad.token;

  // Cenário: fatura de cartão de R$ 1.000 + uma conta comum de R$ 300.
  const cartao = await api(t, '/col/contas', { method: 'POST', body: JSON.stringify(
    { nome: 'ZZ TESTE Nubank', valor: 1000, dia: 10, categoria: 'Parcela', titular: 'Casal', inicio: '2026-09', ehCartao: true }) });
  await api(t, '/col/contas', { method: 'POST', body: JSON.stringify(
    { nome: 'ZZ TESTE Aluguel', valor: 300, categoria: 'Essencial', titular: 'Casal', inicio: '2026-09' }) });

  const b = await chromium.launch();
  const page = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const erros = []; page.on('pageerror', e => erros.push(e.message));
  await page.goto(BASE + '/');
  await page.evaluate(x => localStorage.setItem('missao_token', x), t);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  // O dinheiro sai do Intl com espaço NÃO-SEPARÁVEL entre "R$" e o número (U+00A0). Sem
  // normalizar, a comparação falha mostrando dois textos que parecem idênticos na tela.
  const limpo = t => t.replace(/\s+/g, ' ').trim();
  const falta = async () => limpo(await page.textContent('.block .big'));

  ok('começa somando fatura + conta comum', await falta() === 'R$ 1.300,00', await falta());

  // --- Compra parcelada no cartão, respondendo "a fatura já inclui" ---
  await page.click('.tabs button[data-act="lancar"]'); await page.waitForTimeout(500);
  await page.click('#sheet [data-act="novoParcelado"]'); await page.waitForTimeout(600);
  await page.fill('#pNome', 'ZZ TESTE Geladeira');
  await page.click(`#pComo .chip[data-cartao="${cartao.id}"]`); await page.waitForTimeout(300);
  ok('escolhido o cartão, some o campo "dia do vencimento" (quem manda é a fatura)', await page.isHidden('#pDia'));
  await page.fill('#pTotal', '2000'); await page.fill('#pN', '10');
  await page.click('#fOk'); await page.waitForTimeout(1800);
  ok('pergunta se a fatura já inclui a compra (não decide sozinho)', await page.isVisible('#fjSomar'));
  await page.click('#fjNada'); await page.waitForTimeout(1800);

  ok('🔒 NÃO cobra duas vezes: o total do mês não muda', await falta() === 'R$ 1.300,00', await falta());
  const nomes = await page.$$eval('.row .name', n => n.map(x => x.textContent.trim()));
  ok('🔒 a parcela não aparece como conta separada', !nomes.some(l => l.includes('Geladeira')), JSON.stringify(nomes));
  ok('a linha do cartão mostra o que tem dentro',
    (await page.textContent('[data-act="verFatura"]')).includes('1 parcela aqui dentro'),
    await page.textContent('[data-act="verFatura"]'));

  // --- A fatura por dentro ---
  await page.click('[data-act="verFatura"]'); await page.waitForTimeout(900);
  ok('a fatura lista a compra com o número da parcela',
    (await page.textContent('#sheet .itens')).includes('ZZ TESTE Geladeira'));
  ok('avisa o quanto da fatura o app NÃO conhece (sem fingir que sabe)',
    limpo(await page.textContent('#sheet .banner')).includes('R$ 800,00'),
    limpo(await page.textContent('#sheet .banner')).slice(0, 60));
  await page.click('#fX'); await page.waitForTimeout(500);

  // --- Agora o caminho "somar na fatura" ---
  await page.click('.tabs button[data-act="lancar"]'); await page.waitForTimeout(500);
  await page.click('#sheet [data-act="novoParcelado"]'); await page.waitForTimeout(600);
  await page.fill('#pNome', 'ZZ TESTE Sofá');
  await page.click(`#pComo .chip[data-cartao="${cartao.id}"]`);
  await page.fill('#pTotal', '600'); await page.fill('#pN', '6');
  await page.click('#fOk'); await page.waitForTimeout(1500);
  await page.click('#fjSomar'); await page.waitForTimeout(2000);
  ok('"somar na fatura" sobe o total exatamente o valor da parcela', await falta() === 'R$ 1.400,00', await falta());

  // --- Soltar do cartão devolve a parcela para a lista ---
  await page.click('[data-act="verFatura"]'); await page.waitForTimeout(800);
  await page.click('#sheet .itens [data-act="opcoesConta"]'); await page.waitForTimeout(800);
  await page.click('#oNoCartao'); await page.waitForTimeout(800);
  await page.click('#sheet [data-cartao=""]'); await page.waitForTimeout(2000);
  const nomes2 = await page.$$eval('.row .name', n => n.map(x => x.textContent.trim()));
  ok('soltar do cartão devolve a parcela para a lista do mês', nomes2.some(l => l.includes('Sofá') || l.includes('Geladeira')), JSON.stringify(nomes2));

  ok('nenhum erro de JavaScript no caminho todo', erros.length === 0, JSON.stringify(erros));
  await b.close();

  const sobrou = limpar();
  ok('nada de teste sobrou no banco', sobrou === '0', sobrou);

  console.log(`\n=== ${conferencias} conferências, ${falhas} falha(s) ===`);
  process.exit(falhas === 0 ? 0 : 1);
})().catch(e => {
  console.error('Erro no teste:', e);
  try { limpar(); } catch (_) {}
  process.exit(1);
});
