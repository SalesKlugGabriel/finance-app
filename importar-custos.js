// Importa a planilha "Custos_Mensais.xlsx" do Gabriel para dentro de uma casa do app.
//
// Regras que segui, e o motivo de cada uma:
//   • Só importo os meses que a planilha NOMEIA no cabeçalho. As 3 últimas colunas do
//     arquivo têm valor mas não têm mês escrito — chutar 02/27, 03/27 e 04/27 seria
//     inventar data de vencimento, então ficam de fora e viram aviso no fim.
//   • Só do mês em diante (`--desde`). Importar mês passado criaria um monte de conta
//     "atrasada" que na verdade já foi paga — e marcar como paga seria inventar pagamento
//     que nunca aconteceu no app.
//   • Linha que já existe com o mesmo nome NÃO é recriada. Se a planilha tiver valor
//     diferente do cadastrado em algum mês, isso entra como exceção daquele mês.
//   • Valor diferente mês a mês vira `excecoes` (o app já sabia disso). Mês sem valor, no
//     meio de meses com valor, vira `pulos` (o "não tem neste mês").
//   • Dia de vencimento só quando a própria descrição diz ("vence dia 23", "vcto 20").
//     Sem isso, fica em branco — o app avisa que não sabe quando vence.
//   • "Despesas" e "Saldo" são contas da própria planilha (soma), não lançamento: fora.
//   • "Renda" vira uma entrada de dinheiro por mês, com o valor exato daquele mês.
//
// Uso:  node importar-custos.js <arquivo.xlsx> --casa=<id> [--desde=2026-10] [--gravar]
//       Sem --gravar, só mostra o que faria (ensaio).

const XLSX = require('/root/viabil-engine/node_modules/xlsx');
const { pool } = require('./db');
const crypto = require('crypto');

const args = process.argv.slice(2);
const arquivo = args.find(a => !a.startsWith('--'));
const opt = k => { const a = args.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : null; };
const CASA = Number(opt('casa'));
const DESDE = opt('desde') || null;
const GRAVAR = args.includes('--gravar');

if (!arquivo || !CASA) {
  console.error('uso: node importar-custos.js <arquivo.xlsx> --casa=<id> [--desde=AAAA-MM] [--gravar]');
  process.exit(1);
}

// "04/26" -> "2026-04"
function mesDoCabecalho(txt) {
  const m = String(txt || '').trim().match(/^(\d{2})\/(\d{2})$/);
  return m ? `20${m[2]}-${m[1]}` : null;
}
function diaDaDescricao(txt) {
  const m = String(txt).match(/(?:vence\s*dia|vcto|venc\.?)\s*(\d{1,2})/i);
  if (!m) return null;
  const d = Number(m[1]);
  return d >= 1 && d <= 31 ? d : null;
}
function fimDaDescricao(txt) {
  const m = String(txt).match(/finaliza\s*(\d{2})\/(\d{4})/i);
  return m ? `${m[2]}-${m[1]}` : null;
}
function titularDaDescricao(txt) {
  const t = String(txt).toLowerCase();
  const temL = /\bluana\b/.test(t), temG = /\bgabriel\b/.test(t);
  if (temL && !temG) return 'Luana';
  if (temG && !temL) return 'Gabriel';
  return 'Casal';
}
// Categoria: palpite declarado, editável na tela. Só uso palavra que aparece na própria
// descrição — nada de adivinhar por valor.
function categoriaDaDescricao(txt) {
  const t = String(txt).toLowerCase();
  if (/das mei|imposto|iptu|ipva/.test(t)) return 'Imposto';
  if (/netflix|chat gpt|chatgpt|spotify|unhas/.test(t)) return 'Pessoal';
  if (/nubank|sicredi|sicoob|renner|havan|riachuelo|pan|empr[eé]stimo|cheque especial|m[oó]veis|cart[aã]o/.test(t)) return 'Parcela';
  if (/aluguel|luz|condom[ií]nio|[aá]gua|internet|seguro|oficina/.test(t)) return 'Essencial';
  return 'Essencial';
}
const IGNORAR = ['despesas', 'saldo'];  // linhas de soma da própria planilha

(async () => {
  const wb = XLSX.readFile(arquivo);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const linhas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const cab = linhas[0];

  // Quais colunas têm mês declarado no cabeçalho
  const colunas = [];
  for (let c = 1; c < cab.length; c++) {
    const mes = mesDoCabecalho(cab[c]);
    if (mes) colunas.push({ c, mes });
  }
  const semCabecalho = [];
  for (let c = 1; c < cab.length; c++) if (!mesDoCabecalho(cab[c])) semCabecalho.push(c);

  const mesesImportados = colunas.filter(x => !DESDE || x.mes >= DESDE);
  console.log(`Planilha: ${arquivo}`);
  console.log(`Meses com nome no cabeçalho: ${colunas.map(x => x.mes).join(', ')}`);
  console.log(`Vou importar: ${mesesImportados.map(x => x.mes).join(', ')}${DESDE ? ` (a partir de ${DESDE})` : ''}`);
  console.log(`Casa destino: ${CASA} | modo: ${GRAVAR ? 'GRAVANDO' : 'ensaio (nada é salvo)'}\n`);

  const jaExistem = await pool.query(
    `SELECT id, dados->>'nome' AS nome, dados FROM missao_docs WHERE casa_id = $1 AND colecao = 'contas'`, [CASA]);
  const porNome = new Map(jaExistem.rows.map(r => [String(r.nome || '').trim().toLowerCase(), r]));

  const criar = [], ajustar = [], receitas = [], avisos = [];

  for (let r = 1; r < linhas.length; r++) {
    const desc = linhas[r][0];
    if (!desc || !String(desc).trim()) continue;
    const nome = String(desc).trim();
    const chave = nome.toLowerCase();

    const valores = new Map();          // mes -> valor, só dos meses importados
    for (const { c, mes } of mesesImportados) {
      const v = linhas[r][c];
      if (typeof v === 'number' && isFinite(v) && v !== 0) valores.set(mes, Math.round(v * 100) / 100);
    }
    if (!valores.size) continue;        // nada nos meses que interessam

    if (IGNORAR.includes(chave)) continue;

    if (chave === 'renda') {            // entrada de dinheiro, não conta a pagar
      for (const [mes, valor] of valores) receitas.push({ mes, valor });
      continue;
    }

    // Valor base = o que MAIS se repete (empate: o do mês mais recente). Pegar o do
    // primeiro mês daria errado em linha tipo "Pan", onde outubro é a exceção de R$ 4.089
    // e o normal é R$ 1.363 — e aí todo mês novo nasceria com o valor errado.
    const meses = mesesImportados.map(x => x.mes);
    const primeiro = meses.find(m => valores.has(m));
    const contagem = new Map();
    for (const [mes, v] of valores) contagem.set(v, (contagem.get(v) || 0) + 1);
    let base = valores.get(primeiro), melhor = -1;
    for (const [mes, v] of [...valores].reverse()) {
      if (contagem.get(v) > melhor) { melhor = contagem.get(v); base = v; }
    }
    const excecoes = {};
    for (const [mes, v] of valores) if (v !== base) excecoes[mes] = v;

    // meses SEM valor entre o primeiro e o último com valor => "não tem neste mês"
    const ultimo = meses.filter(m => valores.has(m)).pop();
    const pulos = meses.filter(m => m > primeiro && m < ultimo && !valores.has(m));

    // termina antes do fim da planilha? então tem data para acabar
    const fimPlanilha = meses[meses.length - 1];
    const fimTexto = fimDaDescricao(nome);
    const fim = fimTexto || (ultimo < fimPlanilha ? ultimo : null);

    const existente = porNome.get(chave);
    if (existente) {
      // Não recrio: só levo as diferenças de valor da planilha para o que já está lá.
      const atual = existente.dados;
      const baseAtual = Number(atual.valor) || 0;
      const exc = { ...(atual.excecoes || {}) };
      let mudou = false;
      for (const [mes, v] of valores) {
        const valorHoje = exc[mes] != null ? Number(exc[mes]) : baseAtual;
        if (Math.abs(valorHoje - v) > 0.004) { exc[mes] = v; mudou = true; }
      }
      if (mudou) ajustar.push({ id: existente.id, nome, excecoes: exc, dados: atual });
      else avisos.push(`"${nome}" já existe no app e bate com a planilha — não mexi.`);
      continue;
    }

    criar.push({
      nome, valor: base, dia: diaDaDescricao(nome), categoria: categoriaDaDescricao(nome),
      titular: titularDaDescricao(nome), inicio: primeiro,
      fim: fim || null,
      excecoes: Object.keys(excecoes).length ? excecoes : undefined,
      pulos: pulos.length ? pulos : undefined,
    });
  }

  // --- relatório ---
  console.log(`CONTAS NOVAS (${criar.length}):`);
  for (const c of criar) {
    const extras = [
      c.dia ? `vence dia ${c.dia}` : 'sem dia de vencimento',
      c.fim ? `até ${c.fim}` : 'sem data para acabar',
      c.excecoes ? `${Object.keys(c.excecoes).length} mês(es) com valor diferente` : null,
      c.pulos ? `não tem em ${c.pulos.join(', ')}` : null,
    ].filter(Boolean).join(' · ');
    console.log(`  ${c.nome.padEnd(36)} R$ ${String(c.valor).padStart(9)} [${c.categoria}/${c.titular}] ${extras}`);
  }
  console.log(`\nCONTAS QUE JÁ EXISTIAM E GANHAM VALOR DE ALGUM MÊS (${ajustar.length}):`);
  for (const a of ajustar) console.log(`  ${a.nome}: ${JSON.stringify(a.excecoes)}`);
  console.log(`\nENTRADAS DE DINHEIRO (${receitas.length}):`);
  for (const rc of receitas) console.log(`  ${rc.mes}: R$ ${rc.valor}`);
  if (avisos.length) { console.log('\nOBSERVAÇÕES:'); avisos.forEach(a => console.log('  ' + a)); }
  if (semCabecalho.length) {
    console.log(`\n⚠️  ${semCabecalho.length} coluna(s) da planilha têm valor mas NÃO têm mês escrito no cabeçalho — ficaram de fora de propósito (chutar o mês seria inventar vencimento).`);
  }

  if (!GRAVAR) { console.log('\n(ensaio — nada foi salvo. Rode de novo com --gravar)'); await pool.end(); return; }

  const uid = () => crypto.randomBytes(7).toString('hex');
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    for (const c of criar) {
      const dados = { nome: c.nome, valor: c.valor, dia: c.dia, categoria: c.categoria, titular: c.titular, inicio: c.inicio };
      if (c.fim) dados.fim = c.fim;
      if (c.excecoes) dados.excecoes = c.excecoes;
      if (c.pulos) dados.pulos = c.pulos;
      await cliente.query('INSERT INTO missao_docs (colecao, id, dados, casa_id) VALUES ($1,$2,$3,$4)',
        ['contas', uid(), dados, CASA]);
    }
    for (const a of ajustar) {
      await cliente.query(`UPDATE missao_docs SET dados = $2, atualizado_em = now() WHERE colecao='contas' AND id=$1 AND casa_id=$3`,
        [a.id, { ...a.dados, excecoes: a.excecoes }, CASA]);
    }
    for (const rc of receitas) {
      await cliente.query('INSERT INTO missao_docs (colecao, id, dados, casa_id) VALUES ($1,$2,$3,$4)',
        ['receitas', uid(), { mes: rc.mes, data: rc.mes + '-01', valor: rc.valor, origem: 'Renda do mês', nota: 'Importado da planilha Custos_Mensais' }, CASA]);
    }
    // A renda da planilha muda mês a mês (15.000 em out/nov, 15.500 em dez/jan), e entrou
    // como uma entrada POR MÊS. Se a "renda fixa" do app continuasse valendo junto, cada
    // mês contaria a renda duas vezes. Então ela vai a zero — e o número que aparece na
    // tela passa a vir de uma célula só da planilha, que é a regra da fonte única.
    if (receitas.length) {
      const cfg = await cliente.query('SELECT dados FROM missao_config WHERE casa_id = $1', [CASA]);
      const dados = { ...((cfg.rows[0] && cfg.rows[0].dados) || {}), rendaFixa: 0 };
      // Primeiro mês da importação vira o "começo" da casa: sem isso o app abriria no mês
      // atual, vazio, com as contas escondidas um mês à frente. É também o campo de onde
      // saem a sequência de meses no azul e o XP de "mês fechado".
      if (!dados.inicio) dados.inicio = mesesImportados[0].mes;
      const upd = await cliente.query('UPDATE missao_config SET dados = $2, atualizado_em = now() WHERE casa_id = $1', [CASA, dados]);
      if (upd.rowCount === 0) {
        await cliente.query('INSERT INTO missao_config (id, casa_id, dados) VALUES ($1,$2,$3)', ['casa' + CASA, CASA, dados]);
      }
      console.log('   (renda fixa zerada: a renda passou a vir mês a mês da planilha, para não contar duas vezes)');
    }
    await cliente.query('COMMIT');
    console.log(`\n✅ Gravado: ${criar.length} contas novas, ${ajustar.length} ajustadas, ${receitas.length} entradas.`);
  } catch (e) {
    await cliente.query('ROLLBACK');
    console.error('\n❌ Nada foi gravado (deu erro, desfiz tudo):', e.message);
    process.exitCode = 1;
  } finally {
    cliente.release();
    await pool.end();
  }
})();
