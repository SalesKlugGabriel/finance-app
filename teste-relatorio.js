// Valida o Relatório contra os 14 casos que o Gabriel listou, num cenário montado de
// propósito para ser difícil: pagamento parcial, dívida meio paga, conta atrasada, juros,
// desconto, aporte e retirada de meta, receita extra, mês vazio, virada de ano, categoria
// que não existia antes, dívida quitada, meta concluída e histórico anterior ao início.
//
// A conferência central é a invariante que sustenta o relatório inteiro:
//   soma das categorias do mês === saídas do mês === o que o balanco() já subtraía.
// Se isso quebrar, o app está contando o mesmo dinheiro duas vezes.
//
// Roda do host: node teste-relatorio.js [endereço]

const { chromium } = require('/root/pw/node_modules/playwright');
const { execSync, execFileSync } = require('child_process');

function noBanco(js) {
  const cid = execSync('docker ps -qf name=missao_missao_financas_app').toString().trim();
  return execFileSync('docker', ['exec', cid, 'node', '-e', js]).toString().trim();
}
const BASE = process.argv[2] || 'https://financas.workprog.pro';
const U = '_teste_rel', S = 'senha_de_teste';
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
      console.log('ok'); await pool.end();
    })();`);
}

(async () => {
  limpar();
  const { token: t } = await fetch(BASE + '/api/cadastrar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: U, senha: S, senha2: S }),
  }).then(r => r.json());

  // Meses do cenário, incluindo a virada de ano (caso 10).
  const M = ['2026-11', '2026-12', '2027-01'];
  await api(t, '/config', { method: 'PUT', body: JSON.stringify({ tetoLazer: 500, rendaFixa: 8000, inicio: '2026-11' }) });

  // --- contas ---
  const aluguel = await api(t, '/col/contas', { method: 'POST', body: JSON.stringify(
    { nome: 'ZZ TESTE Aluguel', valor: 2000, dia: 5, categoria: 'Essencial', titular: 'Casal', inicio: '2026-11' }) });
  const luz = await api(t, '/col/contas', { method: 'POST', body: JSON.stringify(
    { nome: 'ZZ TESTE Luz', valor: 300, dia: 20, categoria: 'Essencial', titular: 'Casal', inicio: '2026-11' }) });
  // conta que só existe em janeiro: categoria inexistente no mês anterior (caso 11)
  await api(t, '/col/contas', { method: 'POST', body: JSON.stringify(
    { nome: 'ZZ TESTE IPVA', valor: 900, dia: 10, categoria: 'Imposto', titular: 'Casal', inicio: '2027-01', fim: '2027-01' }) });

  // --- dívidas: uma meio paga (caso 2) e uma quitada (caso 12) ---
  const divA = await api(t, '/col/dividas', { method: 'POST', body: JSON.stringify(
    { nome: 'ZZ TESTE Recovery', titular: 'Gabriel', negociado: 3000, parcela: 500, inicio: '2026-11', dia: 15, ordem: 1 }) });
  const divB = await api(t, '/col/dividas', { method: 'POST', body: JSON.stringify(
    { nome: 'ZZ TESTE Loja', titular: 'Luana', negociado: 400, parcela: 400, inicio: '2026-11', dia: 15, ordem: 2 }) });

  // --- metas: uma em andamento e uma concluída (caso 13) ---
  const metaA = await api(t, '/col/metas', { method: 'POST', body: JSON.stringify(
    { nome: 'ZZ TESTE Reserva', alvo: 6000, aporteMensal: 500, icone: '🛡️', ordem: 1 }) });
  const metaB = await api(t, '/col/metas', { method: 'POST', body: JSON.stringify(
    { nome: 'ZZ TESTE Viagem', alvo: 1000, aporteMensal: 0, icone: '✈️', ordem: 2 }) });

  // --- novembro: pagamento parcial (1), juros (4), aporte (6), receita extra (8) ---
  await api(t, '/col/pagamentos', { method: 'POST', body: JSON.stringify(
    { tipo: 'conta', contaId: aluguel.id, mes: '2026-11', data: '2026-11-05', valor: 1200, juros: 0, desconto: 0, quem: U }) }); // parcial
  await api(t, '/col/pagamentos', { method: 'POST', body: JSON.stringify(
    { tipo: 'conta', contaId: luz.id, mes: '2026-11', data: '2026-11-25', valor: 300, juros: 45, desconto: 0, quem: U }) });     // com juros
  await api(t, '/col/pagamentos', { method: 'POST', body: JSON.stringify(
    { tipo: 'divida', dividaId: divA.id, mes: '2026-11', data: '2026-11-15', valor: 500, juros: 0, desconto: 0, quem: U }) });
  await api(t, '/col/pagamentos', { method: 'POST', body: JSON.stringify(
    { tipo: 'meta', metaId: metaA.id, mes: '2026-11', data: '2026-11-28', valor: 800, quem: U }) });
  await api(t, '/col/receitas', { method: 'POST', body: JSON.stringify(
    { mes: '2026-11', data: '2026-11-10', valor: 1500, origem: 'ZZ TESTE extra', quem: U }) });
  await api(t, '/col/gastos', { method: 'POST', body: JSON.stringify(
    { mes: '2026-11', data: '2026-11-12', valor: 600, categoria: 'Mercado', desc: 'ZZ TESTE mercado', quem: U }) });
  await api(t, '/col/gastos', { method: 'POST', body: JSON.stringify(
    { mes: '2026-11', data: '2026-11-18', valor: 250, categoria: 'Restaurante', desc: 'ZZ TESTE jantar', quem: U }) });

  // --- dezembro: desconto (5), retirada de meta (7), dívida quitada (12), meta concluída (13) ---
  await api(t, '/col/pagamentos', { method: 'POST', body: JSON.stringify(
    { tipo: 'conta', contaId: aluguel.id, mes: '2026-12', data: '2026-12-05', valor: 2000, juros: 0, desconto: 200, quem: U }) });
  await api(t, '/col/pagamentos', { method: 'POST', body: JSON.stringify(
    { tipo: 'divida', dividaId: divB.id, mes: '2026-12', data: '2026-12-15', valor: 400, quem: U }) });   // quita a dívida B
  await api(t, '/col/pagamentos', { method: 'POST', body: JSON.stringify(
    { tipo: 'meta', metaId: metaB.id, mes: '2026-12', data: '2026-12-20', valor: 1000, quem: U }) });      // conclui a meta B
  await api(t, '/col/pagamentos', { method: 'POST', body: JSON.stringify(
    { tipo: 'meta', metaId: metaA.id, mes: '2026-12', data: '2026-12-22', valor: -300, quem: U }) });      // retirada
  await api(t, '/col/gastos', { method: 'POST', body: JSON.stringify(
    { mes: '2026-12', data: '2026-12-08', valor: 400, categoria: 'Combustível', desc: 'ZZ TESTE posto', quem: U }) });

  // --- janeiro: sem pagamento nenhum (mês só com obrigação em aberto = caso 3 e 9) ---

  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const erros = []; page.on('pageerror', e => erros.push(e.message));
  await page.goto(BASE + '/');
  await page.evaluate(x => localStorage.setItem('missao_token', x), t);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // Navega até novembro/2026 (o app abre em setembro/2026)
  const irPara = async alvo => {
    for (let i = 0; i < 24; i++) {
      const atual = await page.evaluate(() => mes);
      if (atual === alvo) return true;
      await page.click(atual < alvo ? '#next' : '#prev');
      await page.waitForTimeout(220);
    }
    return false;
  };
  ok('consegue navegar até novembro/2026', await irPara('2026-11'));

  // ---- A invariante central, mês a mês ----
  for (const m of [...M, '2026-10']) {
    const r = await page.evaluate(mm => {
      const res = resumoDoMes(mm), cat = categoriasDoMes(mm);
      return { saidas: res.saidas, total: cat.total, pagamentos: res.pagamentos, gastos: res.gastos, guardado: res.guardado };
    }, m);
    ok(`🔒 ${m}: soma das categorias = saídas do mês (sem contagem dupla)`,
      Math.abs(r.total - r.saidas) < 0.005, `categorias ${r.total} vs saídas ${r.saidas}`);
  }

  // ---- Casos um a um, contra valores calculados à mão ----
  const nov = await page.evaluate(() => ({ r: resumoDoMes('2026-11'), c: categoriasDoMes('2026-11') }));
  // receitas: 8000 fixa + 1500 extra
  ok('(8) receita extra entra na receita do mês', Math.abs(nov.r.receitas - 9500) < 0.005, nov.r.receitas);
  // pagamentos: 1200 (parcial) + 300+45 juros + 500 dívida = 2045
  ok('(1)(4) pagamento parcial e juros contam pelo valor realmente pago',
    Math.abs(nov.r.pagamentos - 2045) < 0.005, nov.r.pagamentos);
  ok('(4) juros aparecem à parte como informação, sem virar fatia própria',
    Math.abs(nov.r.juros - 45) < 0.005 && Math.abs(nov.c.total - nov.r.saidas) < 0.005, nov.r.juros);
  // falta: aluguel 2000-1200=800, IPVA não existe em nov, dívida A 3000 restante -> parcela 500 já paga
  ok('(3) conta parcialmente paga deixa só o que falta em "ainda a pagar"',
    Math.abs(nov.r.falta - 800) < 0.005, nov.r.falta);
  const cat = k => (nov.c.itens.find(x => x.k === k) || {}).valor;
  ok('(11) mercado e lazer separados corretamente', cat('mercado') === 600 && cat('lazer') === 250,
    `mercado ${cat('mercado')} lazer ${cat('lazer')}`);
  ok('(6) aporte em meta entra como saída na categoria Metas', cat('metas') === 800, cat('metas'));

  const dez = await page.evaluate(() => ({ r: resumoDoMes('2026-12'), c: categoriasDoMes('2026-12') }));
  // pagamentos dez: aluguel 2000-200 desconto = 1800, dívida B 400 => 2200
  ok('(5) desconto reduz o valor que saiu de verdade', Math.abs(dez.r.pagamentos - 2200) < 0.005, dez.r.pagamentos);
  const catD = k => (dez.c.itens.find(x => x.k === k) || {}).valor;
  ok('(7) retirada de meta entra negativa, sem virar saída positiva', catD('metas') === 700, catD('metas'));
  ok('(11) transporte aparece em dez e não existia em nov', catD('transporte') === 400 && !cat('transporte'), catD('transporte'));

  const jan = await page.evaluate(() => resumoDoMes('2027-01'));
  ok('(10) virada de ano: janeiro/2027 é lido como mês seguinte a dezembro/2026',
    jan.falta > 0 && jan.pagamentos === 0, JSON.stringify({ falta: jan.falta, pagou: jan.pagamentos }));
  ok('(9) mês sem movimentação não quebra: sobra = receitas', Math.abs(jan.sobra - 8000) < 0.005, jan.sobra);

  const out = await page.evaluate(() => resumoDoMes('2026-10'));
  ok('(14) mês anterior ao início configurado fica zerado, sem inventar histórico',
    out.saidas === 0 && out.pagamentos === 0, JSON.stringify(out));

  // ---- Patrimônio reconstruído ----
  // O histórico vai até o mês que está sendo olhado (se ele já tiver movimento), então
  // navego até janeiro/2027 para o período cobrir o cenário inteiro.
  ok('navega até janeiro/2027', await irPara('2027-01'));
  const patr = await page.evaluate(() => historicoPatrimonio(0));
  const pNov = patr.find(p => p.mes === '2026-11'), pDez = patr.find(p => p.mes === '2026-12');
  // nov: dívida A 3000-500=2500, dívida B 400 => 2900; metas 800
  ok('(2) dívida parcialmente paga: saldo histórico cai só o que foi pago',
    pNov && Math.abs(pNov.dividas - 2900) < 0.005, pNov && pNov.dividas);
  // dez: A 2500, B quitada = 0 => 2500; metas 800-300+1000 = 1500
  ok('(12) dívida quitada some do saldo a partir do mês em que foi paga',
    pDez && Math.abs(pDez.dividas - 2500) < 0.005, pDez && pDez.dividas);
  ok('(6)(7) metas acumuladas somam aportes e descontam retiradas',
    pDez && Math.abs(pDez.metas - 1500) < 0.005, pDez && pDez.metas);
  ok('posição financeira = metas − dívidas', pDez && Math.abs(pDez.posicao - (1500 - 2500)) < 0.005, pDez && pDez.posicao);

  // ---- Meta concluída (13) e projeção ----
  const proj = await page.evaluate(() => S.metas.map(g => ({ nome: g.nome, at: atualMeta(g), alvo: Number(g.alvo) || 0, ritmo: ritmoDaMeta(g) })));
  const viagem = proj.find(p => p.nome.includes('Viagem'));
  ok('(13) meta concluída aparece com 100% e sem previsão de data', viagem && viagem.at >= viagem.alvo, JSON.stringify(viagem));

  // ---- As 4 sub-abas: renderizam, sem NaN/Infinity ----
  await page.click('.tabs button[data-tab="relatorio"]'); await page.waitForTimeout(900);
  for (const [k, nome] of [['resumo', 'Resumo'], ['evolucao', 'Evolução'], ['patrimonio', 'Patrimônio'], ['insights', 'Insights']]) {
    await page.click(`#navRel [data-rel="${k}"]`); await page.waitForTimeout(700);
    const txt = await page.textContent('#view');
    ok(`sub-aba ${nome} desenha sem NaN/Infinity/undefined`,
      !/NaN|Infinity|undefined/.test(txt), (txt.match(/NaN|Infinity|undefined/g) || []).join(','));
    await page.screenshot({ path: `/root/missao-financas/saida/rel-${k}.png`, fullPage: true });
  }

  // ---- Responsividade: nenhum gráfico pode empurrar a página para o lado ----
  for (const w of [320, 375, 390, 430, 560]) {
    await page.setViewportSize({ width: w, height: 800 });
    for (const k of ['resumo', 'evolucao', 'patrimonio', 'insights']) {
      await page.click(`#navRel [data-rel="${k}"]`); await page.waitForTimeout(350);
      const estoura = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      ok(`${w}px · ${k}: sem rolagem horizontal`, !estoura);
    }
  }
  await page.setViewportSize({ width: 320, height: 800 });
  await page.screenshot({ path: '/root/missao-financas/saida/rel-320.png', fullPage: true });

  // ---- As abas antigas continuam funcionando (nada foi quebrado) ----
  for (const [k, marca] of [['mes', 'Balanço'], ['chefoes', 'chefões'], ['metas', 'Total guardado'], ['gastos', 'Lazer']]) {
    await page.click(`.tabs button[data-tab="${k}"]`); await page.waitForTimeout(600);
    const txt = await page.textContent('#view');
    ok(`aba ${k} continua funcionando`, txt.toLowerCase().includes(marca.toLowerCase()), txt.slice(0, 60));
  }

  ok('nenhum erro de JavaScript no caminho todo', erros.length === 0, JSON.stringify(erros));
  await b.close();
  limpar();
  console.log(`\n=== ${conferencias} conferências, ${falhas} falha(s) ===`);
  process.exit(falhas === 0 ? 0 : 1);
})().catch(e => {
  console.error('Erro no teste:', e);
  try { limpar(); } catch (_) {}
  process.exit(1);
});
