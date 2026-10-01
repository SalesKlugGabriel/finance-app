// Trava o conserto de 01/10/2026: dívida com acordo À VISTA (sem parcela mensal) aparece
// na lista de contas do mês, e todo pagamento registrado num chefão dá baixa visível.
//
// O defeito original, reportado pelo Gabriel com a dívida real "Havan" (original R$ 5.000,
// acordo R$ 430,85, pago de uma vez): `obrigacoes(m)` só deixava a dívida entrar no mês se
// ela tivesse PARCELA MENSAL preenchida. Acordo à vista — o caso mais comum de dívida
// antiga renegociada — nunca entrava, então o pagamento registrado no chefão não aparecia
// em "Pagas" nenhuma. O dinheiro até saía do saldo (balanco soma todo pagamento que não é
// meta), mas na tela do mês não havia sinal nenhum dele.
//
// Cenário montado para cobrir as quatro formas de dívida ao mesmo tempo:
//   A — à vista, paga por inteiro        (o caso do Gabriel)
//   B — parcelada                        (regressão: não pode mudar nada)
//   C — à vista, paga só em parte        (status parcial, e o que falta é o resto do acordo)
//   D — sem acordo nenhum (sem mês)      (não vence; só aparece se tiver pagamento no mês)
//
// Roda do host: node teste-divida-avista.js [endereço]

const { chromium } = require('/root/pw/node_modules/playwright');
const { execSync, execFileSync } = require('child_process');

function noBanco(js) {
  const cid = execSync('docker ps -qf name=missao_missao_financas_app').toString().trim();
  return execFileSync('docker', ['exec', cid, 'node', '-e', js]).toString().trim();
}
const BASE = process.argv[2] || 'https://financas.workprog.pro';
const U = '_teste_avista', S = 'senha_de_teste';

// Contador declarado: um erro de execução no meio do arquivo pode abortar a lista e o
// processo sair com sucesso parecendo que tudo passou. Lição já paga no PokéMobile.
const ESPERADAS = 18;
let falhas = 0, conferencias = 0;
function ok(nome, condicao, detalhe = '') {
  conferencias++;
  if (condicao) console.log(`  OK    ${nome}`);
  else { falhas++; console.log(`  FALHA ${nome} ${detalhe}`); }
}

const api = (t, c, o = {}) => fetch(BASE + '/api' + c,
  { ...o, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t, ...(o.headers || {}) } })
  .then(r => r.json());

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
      console.log('ok'); await pool.end();
    })();`);
}

(async () => {
  limpar();
  const { token: t } = await fetch(BASE + '/api/cadastrar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: U, senha: S, senha2: S }),
  }).then(r => r.json());
  if (!t) { console.log('FALHA não conseguiu criar o usuário de teste'); process.exit(1); }

  await api(t, '/config', { method: 'PUT', body: JSON.stringify({ rendaFixa: 8000, inicio: '2026-10' }) });

  const divida = d => api(t, '/col/dividas', { method: 'POST', body: JSON.stringify(d) });
  const pagar = p => api(t, '/col/pagamentos', { method: 'POST', body: JSON.stringify(p) });

  // A — exatamente a forma da dívida real do Gabriel: acordo fechado, sem parcelar.
  const A = await divida({ nome: 'ZZ TESTE Havan', titular: 'Gabriel', original: 5000,
    negociado: 430.85, inicio: '2026-10', dia: 1, ordem: 1 });
  const B = await divida({ nome: 'ZZ TESTE Parcelada', titular: 'Gabriel', original: 4000,
    negociado: 3000, parcela: 500, inicio: '2026-10', dia: 10, ordem: 2 });
  const C = await divida({ nome: 'ZZ TESTE Meia', titular: 'Luana', original: 1200,
    negociado: 1000, inicio: '2026-10', dia: 15, ordem: 3 });
  const D = await divida({ nome: 'ZZ TESTE Sem acordo', titular: 'Luana', negociado: 700, ordem: 4 });

  await pagar({ tipo: 'divida', dividaId: A.id, mes: '2026-10', data: '2026-10-01',
    quem: 'Gabriel', valor: 430.85, juros: 0, desconto: 0 });
  await pagar({ tipo: 'divida', dividaId: C.id, mes: '2026-10', data: '2026-10-15',
    quem: 'Luana', valor: 400, juros: 0, desconto: 0 });

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const erros = []; page.on('pageerror', e => erros.push(e.message));
  await page.goto(BASE + '/');
  await page.evaluate(x => localStorage.setItem('missao_token', x), t);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const mes = m => page.evaluate(mm => {
    const ob = obrigacoes(mm), b = balanco(mm);
    return { ob: ob.map(o => ({ nome: o.nome, tipo: o.tipo, valor: o.valor, pago: o.pago, status: o.status })),
             contas: b.contas, falta: b.falta };
  }, m);

  const out = await mes('2026-10');
  const acha = n => out.ob.find(o => o.nome.includes(n));

  // ---- O defeito reportado ----
  const a = acha('Havan');
  ok('🔒 acordo à vista aparece na lista do mês (era o defeito)', !!a,
    JSON.stringify(out.ob.map(o => o.nome)));
  ok('🔒 o valor que vence à vista é o acordo inteiro, não um pedaço inventado',
    !!a && Math.abs(a.valor - 430.85) < 0.005, a && a.valor);
  ok('🔒 pago por inteiro no mês ⇒ entra como PAGA', !!a && a.status === 'pago', a && a.status);
  ok('🔒 a baixa é do valor realmente registrado', !!a && Math.abs(a.pago - 430.85) < 0.005, a && a.pago);

  // ---- Regressão: parcelada continua igual ----
  const b = acha('Parcelada');
  ok('parcelada continua aparecendo', !!b);
  ok('parcelada vence a PARCELA, não o acordo todo', !!b && b.valor === 500, b && b.valor);
  ok('parcelada sem pagamento fica pendente', !!b && b.status === 'pendente', b && b.status);

  // ---- À vista paga pela metade ----
  const c = acha('Meia');
  ok('à vista paga em parte fica PARCIAL', !!c && c.status === 'parcial', c && c.status);
  ok('à vista paga em parte mostra o acordo inteiro como valor', !!c && c.valor === 1000, c && c.valor);
  ok('à vista paga em parte registra o que foi pago', !!c && c.pago === 400, c && c.pago);

  // ---- Sem acordo não vence ----
  ok('dívida sem mês de vencimento NÃO entra na lista do mês', !acha('Sem acordo'));

  // ---- "Ainda falta pagar" ----
  // B inteira (500) + o que falta de C (1000-400=600) = 1100. A está quitada.
  ok('"ainda falta pagar" soma só o que realmente falta', Math.abs(out.falta - 1100) < 0.005, out.falta);

  // ---- O dinheiro já era contado antes; precisa continuar sendo ----
  ok('pagamento de dívida continua saindo do saldo do mês',
    Math.abs(out.contas - 830.85) < 0.005, out.contas);

  // ---- Mês seguinte ----
  const nov = await mes('2026-11');
  const achaN = n => nov.ob.find(o => o.nome.includes(n));
  ok('dívida quitada não vira fantasma no mês seguinte', !achaN('Havan'),
    JSON.stringify(nov.ob.map(o => o.nome)));
  ok('parcelada segue vencendo no mês seguinte', !!achaN('Parcelada') && achaN('Parcelada').valor === 500);
  ok('à vista com saldo restante segue cobrando o que falta',
    !!achaN('Meia') && Math.abs(achaN('Meia').valor - 600) < 0.005, achaN('Meia') && achaN('Meia').valor);

  // ---- Porta 2: pagamento registrado num mês SEM vencimento também aparece ----
  await pagar({ tipo: 'divida', dividaId: D.id, mes: '2026-11', data: '2026-11-20',
    quem: 'Luana', valor: 100, juros: 0, desconto: 0 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const nov2 = await mes('2026-11');
  ok('🔒 pagamento registrado em dívida sem vencimento aparece no mês em que foi feito',
    !!nov2.ob.find(o => o.nome.includes('Sem acordo')),
    JSON.stringify(nov2.ob.map(o => o.nome)));

  ok('nenhum erro de JavaScript no caminho todo', erros.length === 0, erros.join(' | '));

  // Captura de tela: teste funcional não vê layout. A linha do chefão entra numa lista
  // desenhada para contas, com dia de vencimento e botão de pagar — vale olhar.
  while (await page.evaluate(() => mes) > '2026-10') { await page.click('#prev'); await page.waitForTimeout(250); }
  await page.click('.tabs button[data-tab="mes"]'); await page.waitForTimeout(600);
  await page.screenshot({ path: '/root/missao-financas/saida/divida-avista-mes.png', fullPage: true });
  await page.click('.tabs button[data-tab="chefoes"]'); await page.waitForTimeout(600);
  await page.screenshot({ path: '/root/missao-financas/saida/divida-avista-chefoes.png', fullPage: true });

  await browser.close();
  limpar();

  console.log(`\n${conferencias} conferências, ${falhas} falha(s)`);
  if (conferencias !== ESPERADAS) {
    console.log(`FALHA de execução: esperava ${ESPERADAS} conferências e rodou ${conferencias} — o arquivo abortou no meio.`);
    process.exit(1);
  }
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error('ERRO', e); process.exit(1); });
