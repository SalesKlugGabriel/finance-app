// Trava o pedido do Gabriel de 01/10/2026: "os gastos registrados no app deveriam aparecer
// como pagos no mês em que foram registrados também".
//
// Antes, um gasto do dia a dia (mercado, combustível, lanche) só existia na aba Gastos e numa
// linha de total no balanço. Quem abria a aba Mês para ver o que já tinha saído via só as
// contas — o resto do dinheiro gasto não aparecia em lugar nenhum daquela tela.
//
// 🔴 O perigo do conserto é maior que o do defeito: gasto NÃO é obrigação. Se ele entrasse em
// `obrigacoes()`, o mesmo dinheiro seria contado duas vezes (o balanço já soma `gastos` numa
// linha própria) e o placar "N de M contas pagas" passaria a contar ida ao supermercado como
// conta. Por isso a maior parte das conferências aqui é sobre o que NÃO pode mudar.
//
// Roda do host: node teste-gastos-no-mes.js [endereço]

const { chromium } = require('/root/pw/node_modules/playwright');
const { execSync, execFileSync } = require('child_process');

function noBanco(js) {
  const cid = execSync('docker ps -qf name=missao_missao_financas_app').toString().trim();
  return execFileSync('docker', ['exec', cid, 'node', '-e', js]).toString().trim();
}
const BASE = process.argv[2] || 'https://financas.workprog.pro';
const U = '_teste_gastos_mes', S = 'senha_de_teste';

const ESPERADAS = 17;
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

  await api(t, '/config', { method: 'PUT', body: JSON.stringify({ tetoLazer: 500, rendaFixa: 8000, inicio: '2026-10' }) });

  // Duas contas: uma paga, uma não. O placar do mês tem de continuar falando só delas.
  const luz = await api(t, '/col/contas', { method: 'POST', body: JSON.stringify(
    { nome: 'ZZ TESTE Luz', valor: 300, dia: 10, categoria: 'Essencial', titular: 'Casal', inicio: '2026-10' }) });
  await api(t, '/col/contas', { method: 'POST', body: JSON.stringify(
    { nome: 'ZZ TESTE Internet', valor: 120, dia: 20, categoria: 'Essencial', titular: 'Casal', inicio: '2026-10' }) });
  await api(t, '/col/pagamentos', { method: 'POST', body: JSON.stringify(
    { tipo: 'conta', contaId: luz.id, mes: '2026-10', data: '2026-10-10', quem: 'Gabriel', valor: 300, juros: 0, desconto: 0 }) });

  // Três gastos em outubro (um deles de lazer) e um em novembro, para provar que cada um fica
  // no SEU mês — o mês do gasto vem da data dele, não do mês que está aberto na tela.
  await api(t, '/col/gastos', { method: 'POST', body: JSON.stringify(
    { mes: '2026-10', data: '2026-10-03', valor: 450, categoria: 'Mercado', desc: 'ZZ Supermercado', quem: 'Luana' }) });
  await api(t, '/col/gastos', { method: 'POST', body: JSON.stringify(
    { mes: '2026-10', data: '2026-10-07', valor: 180, categoria: 'Transporte', desc: 'ZZ Combustível', quem: 'Gabriel' }) });
  await api(t, '/col/gastos', { method: 'POST', body: JSON.stringify(
    { mes: '2026-10', data: '2026-10-09', valor: 90, categoria: 'Restaurante', desc: 'ZZ Jantar', quem: 'Gabriel' }) });
  await api(t, '/col/gastos', { method: 'POST', body: JSON.stringify(
    { mes: '2026-11', data: '2026-11-02', valor: 999, categoria: 'Mercado', desc: 'ZZ Mercado de novembro', quem: 'Luana' }) });

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const erros = []; page.on('pageerror', e => erros.push(e.message));
  await page.goto(BASE + '/');
  await page.evaluate(x => localStorage.setItem('missao_token', x), t);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const irPara = async alvo => {
    for (let i = 0; i < 24; i++) {
      const atual = await page.evaluate(() => mes);
      if (atual === alvo) return true;
      await page.click(atual < alvo ? '#next' : '#prev');
      await page.waitForTimeout(220);
    }
    return false;
  };
  ok('consegue abrir outubro/2026', await irPara('2026-10'));
  await page.click('.tabs button[data-tab="mes"]'); await page.waitForTimeout(600);

  const txt = () => page.textContent('#view');
  const outubro = await txt();

  // ---- O pedido ----
  ok('🔒 os três gastos de outubro aparecem na aba Mês',
    ['ZZ Supermercado', 'ZZ Combustível', 'ZZ Jantar'].every(n => outubro.includes(n)));
  ok('🔒 aparecem numa seção própria de já pagos', outubro.includes('Pagos no dia a dia'));
  ok('🔒 cada um diz que já foi pago e quando', outubro.includes('pago dia 03/10'));
  // Conferir só "720,00" não provaria nada: esse total já aparecia no balanço, na linha
  // "Gastos do dia a dia". Tem de ser a contagem E o total DO CABEÇALHO da seção nova.
  ok('🔒 o cabeçalho da seção traz quantos e quanto (3 · R$ 720,00)',
    /Pagos no dia a dia\s*\(?\s*3\s*·\s*R\$\s*720,00/.test(outubro.replace(/\s+/g, ' ')),
    outubro.replace(/\s+/g, ' ').slice(0, 0) || '');
  ok('gasto de outro mês não vaza para outubro', !outubro.includes('ZZ Mercado de novembro'));

  // ---- O que NÃO pode mudar ----
  const n = await page.evaluate(() => {
    const ob = obrigacoes('2026-10'), b = balanco('2026-10');
    return { quantas: ob.length, pagas: ob.filter(o => o.status === 'pago').length,
             temGasto: ob.some(o => (o.nome || '').includes('ZZ Supermercado')),
             contas: b.contas, gastos: b.gastos, falta: b.falta, sobra: b.sobra, lz: b.lz };
  });
  ok('🔒 gasto NÃO entra na lista de obrigações do mês', !n.temGasto);
  ok('🔒 o placar continua contando só contas (2, uma paga)', n.quantas === 2 && n.pagas === 1,
    `${n.pagas}/${n.quantas}`);
  ok('placar aparece na tela como "1 de 2 contas pagas"', outubro.includes('1 de 2 contas pagas'));
  ok('🔒 "contas e parcelas pagas" não engorda com gasto', Math.abs(n.contas - 300) < 0.005, n.contas);
  ok('🔒 "gastos do dia a dia" continua com o total certo', Math.abs(n.gastos - 720) < 0.005, n.gastos);
  ok('🔒 "ainda falta pagar" não muda (só a internet)', Math.abs(n.falta - 120) < 0.005, n.falta);
  // 8000 − 300 (conta) − 720 (gastos) = 6980. Se houvesse contagem dupla, cairia para 6260.
  ok('🔒 sem contagem dupla: sobra = 8000 − 300 − 720', Math.abs(n.sobra - 6980) < 0.005, n.sobra);
  ok('lazer continua separado e só com o jantar', Math.abs(n.lz - 90) < 0.005, n.lz);

  // ---- Mês seguinte ----
  ok('consegue abrir novembro/2026', await irPara('2026-11'));
  await page.waitForTimeout(500);
  const novembro = await txt();
  ok('o gasto de novembro aparece em novembro, e os de outubro não',
    novembro.includes('ZZ Mercado de novembro') && !novembro.includes('ZZ Supermercado'));

  ok('nenhum erro de JavaScript no caminho todo', erros.length === 0, erros.join(' | '));

  await irPara('2026-10'); await page.waitForTimeout(500);
  await page.screenshot({ path: '/root/missao-financas/saida/gastos-no-mes.png', fullPage: true });

  await browser.close();
  limpar();

  console.log(`\n${conferencias} conferências, ${falhas} falha(s)`);
  if (conferencias !== ESPERADAS) {
    console.log(`FALHA de execução: esperava ${ESPERADAS} conferências e rodou ${conferencias} — o arquivo abortou no meio.`);
    process.exit(1);
  }
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error('ERRO', e); process.exit(1); });
