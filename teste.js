// Checklist de testes do Missão Finanças. Roda de dentro do container, contra a API real
// (http://localhost:3000). Cria usuários e casas obviamente de teste ("_teste_*"), e apaga
// tudo no final — nunca toca em usuário, casa ou lançamento de gente de verdade.
//
// O teste mais importante daqui é o de ISOLAMENTO: uma casa não pode ver, editar nem apagar
// nada de outra. É a fronteira que sustenta o app ser aberto a vários casais.

const { pool } = require('./db');

const BASE = 'http://localhost:3000/api';
let falhas = 0, conferencias = 0;

async function req(caminho, opcoes = {}, token = null) {
  const headers = { 'Content-Type': 'application/json', ...(opcoes.headers || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + caminho, { ...opcoes, headers });
  const t = await r.text();
  let corpo = null;
  try { corpo = t ? JSON.parse(t) : null; } catch (e) { corpo = { textoCru: t.slice(0, 120) }; }
  return { status: r.status, corpo };
}
function ok(nome, condicao, detalhe = '') {
  conferencias++;
  if (condicao) console.log(`  OK    ${nome}`);
  else { falhas++; console.log(`  FALHA ${nome} ${detalhe}`); }
}
const USUARIOS = ['_teste_ana', '_teste_bruno', '_teste_carla'];
async function limpar() {
  const r = await pool.query(`SELECT id, casa_id FROM missao_usuarios WHERE nome = ANY($1)`, [USUARIOS]);
  const casas = [...new Set(r.rows.map(x => x.casa_id).filter(Boolean))];
  await pool.query(`DELETE FROM missao_usuarios WHERE nome = ANY($1)`, [USUARIOS]);
  if (casas.length) {
    await pool.query(`DELETE FROM missao_docs WHERE casa_id = ANY($1)`, [casas]);
    await pool.query(`DELETE FROM missao_config WHERE casa_id = ANY($1)`, [casas]);
    await pool.query(`DELETE FROM missao_convites WHERE casa_id = ANY($1)`, [casas]);
    await pool.query(`DELETE FROM missao_casas WHERE id = ANY($1)`, [casas]);
  }
}

(async () => {
  await limpar();

  /* ============ Entrar e criar conta ============ */
  let r = await req('/login', { method: 'POST', body: JSON.stringify({ usuario: '_teste_ana', senha: 'senha123' }) });
  ok('usuário que não existe -> 404 com "novo"', r.status === 404 && r.corpo.novo === true, JSON.stringify(r.corpo));

  r = await req('/cadastrar', { method: 'POST', body: JSON.stringify({ usuario: '_teste_ana', senha: 'senha123', senha2: 'outra' }) });
  ok('senha e confirmação diferentes -> 400', r.status === 400, r.status);

  r = await req('/cadastrar', { method: 'POST', body: JSON.stringify({ usuario: '_teste_ana', senha: 'abc', senha2: 'abc' }) });
  ok('senha curta demais -> 400', r.status === 400, r.status);

  r = await req('/cadastrar', { method: 'POST', body: JSON.stringify({ usuario: '_teste_ana', senha: 'senha123', senha2: 'senha123' }) });
  ok('criar conta -> 200 com token', r.status === 200 && !!r.corpo.token, JSON.stringify(r.corpo));
  const ANA = r.corpo.token;

  r = await req('/cadastrar', { method: 'POST', body: JSON.stringify({ usuario: '_TESTE_ANA', senha: 'senha123', senha2: 'senha123' }) });
  ok('mesmo usuário com outra caixa (maiúsculas) -> 409', r.status === 409, r.status);

  r = await req('/login', { method: 'POST', body: JSON.stringify({ usuario: '_teste_ana', senha: 'errada' }) });
  ok('senha errada -> 401', r.status === 401, r.status);

  r = await req('/login', { method: 'POST', body: JSON.stringify({ usuario: '_teste_ana', senha: 'senha123' }) });
  ok('login com a senha certa -> 200', r.status === 200 && !!r.corpo.token, r.status);

  r = await req('/me', {}, ANA);
  ok('GET /me traz usuário, casa e quem participa',
    r.status === 200 && r.corpo.usuario === '_teste_ana' && !!r.corpo.casa && r.corpo.membros.includes('_teste_ana'),
    JSON.stringify(r.corpo));
  const casaAna = r.corpo.casa.id;

  r = await req('/estado', {}, ANA);
  ok('casa nova começa vazia', r.status === 200 && r.corpo.contas.length === 0, JSON.stringify(r.corpo.contas));

  /* ============ Lançamentos dentro da casa ============ */
  r = await req('/col/contas', { method: 'POST', body: JSON.stringify({ nome: 'ZZ TESTE conta da Ana', valor: 100 }) }, ANA);
  ok('criar conta', r.status === 200 && !!r.corpo.id, JSON.stringify(r.corpo));
  const contaAna = r.corpo.id;

  r = await req('/estado', {}, ANA);
  ok('a conta aparece no estado da Ana', r.corpo.contas.some(c => c.id === contaAna));

  /* ============ ISOLAMENTO: a fronteira entre casas ============ */
  r = await req('/cadastrar', { method: 'POST', body: JSON.stringify({ usuario: '_teste_bruno', senha: 'senha456', senha2: 'senha456' }) });
  ok('segundo casal cria conta -> 200', r.status === 200 && !!r.corpo.token, r.status);
  const BRUNO = r.corpo.token;

  r = await req('/me', {}, BRUNO);
  ok('Bruno caiu numa casa DIFERENTE da Ana', r.corpo.casa.id !== casaAna, `${r.corpo.casa.id} vs ${casaAna}`);

  r = await req('/estado', {}, BRUNO);
  ok('🔒 Bruno NÃO vê a conta da Ana', r.status === 200 && !r.corpo.contas.some(c => c.id === contaAna),
    JSON.stringify(r.corpo.contas));

  r = await req('/col/contas/' + contaAna, { method: 'PUT', body: JSON.stringify({ nome: 'INVADIDA', valor: 1 }) }, BRUNO);
  const depoisDoPut = await req('/estado', {}, ANA);
  const intacta = depoisDoPut.corpo.contas.find(c => c.id === contaAna);
  ok('🔒 Bruno NÃO consegue editar a conta da Ana', intacta && intacta.nome === 'ZZ TESTE conta da Ana',
    JSON.stringify(intacta));

  await req('/col/contas/' + contaAna, { method: 'DELETE' }, BRUNO);
  const depoisDoDelete = await req('/estado', {}, ANA);
  ok('🔒 Bruno NÃO consegue apagar a conta da Ana', depoisDoDelete.corpo.contas.some(c => c.id === contaAna));

  r = await req('/config', { method: 'PUT', body: JSON.stringify({ tetoLazer: 777, rendaFixa: 1 }) }, BRUNO);
  const cfgAna = await req('/estado', {}, ANA);
  ok('🔒 config de uma casa não vaza para a outra', cfgAna.corpo.config.tetoLazer !== 777, JSON.stringify(cfgAna.corpo.config));

  /* ============ Convite: compartilhar a casa ============ */
  r = await req('/convites', { method: 'POST' }, ANA);
  ok('Ana cria um convite', r.status === 200 && !!r.corpo.token, JSON.stringify(r.corpo));
  const convite = r.corpo.token;

  r = await req('/convites/' + convite);
  ok('o link do convite diz de qual casa é, sem login', r.status === 200 && r.corpo.valido === true && !!r.corpo.casa,
    JSON.stringify(r.corpo));

  r = await req('/convites/naoexiste123');
  ok('convite inventado -> 404', r.status === 404, r.status);

  r = await req('/convites/' + convite + '/aceitar', { method: 'POST' }, BRUNO);
  ok('Bruno aceita o convite', r.status === 200, JSON.stringify(r.corpo));

  r = await req('/estado', {}, BRUNO);
  ok('agora Bruno VÊ a conta da Ana', r.corpo.contas.some(c => c.id === contaAna), JSON.stringify(r.corpo.contas));

  r = await req('/me', {}, BRUNO);
  ok('Bruno está na casa da Ana e os dois aparecem como participantes',
    r.corpo.casa.id === casaAna && r.corpo.membros.includes('_teste_ana') && r.corpo.membros.includes('_teste_bruno'),
    JSON.stringify(r.corpo));

  r = await req('/col/contas/' + contaAna, { method: 'PUT', body: JSON.stringify({ nome: 'ZZ TESTE editada pelo Bruno', valor: 200 }) }, BRUNO);
  const viuEdicao = await req('/estado', {}, ANA);
  ok('agora os dois editam as MESMAS contas',
    viuEdicao.corpo.contas.find(c => c.id === contaAna).nome === 'ZZ TESTE editada pelo Bruno');

  r = await req('/convites/' + convite + '/aceitar', { method: 'POST' }, BRUNO);
  ok('convite é de uso único (a segunda vez falha)', r.status === 400, r.status);

  r = await req('/cadastrar', { method: 'POST', body: JSON.stringify({ usuario: '_teste_carla', senha: 'senha789', senha2: 'senha789', convite }) });
  ok('cadastrar com convite já usado -> 400', r.status === 400, r.status);

  r = await req('/convites', { method: 'POST' }, ANA);
  const convite2 = r.corpo.token;
  r = await req('/cadastrar', { method: 'POST', body: JSON.stringify({ usuario: '_teste_carla', senha: 'senha789', senha2: 'senha789', convite: convite2 }) });
  ok('quem se cadastra POR um convite já nasce dentro da casa', r.status === 200 && !!r.corpo.token, JSON.stringify(r.corpo));
  const CARLA = r.corpo.token;
  r = await req('/estado', {}, CARLA);
  ok('Carla vê as contas da casa desde o primeiro acesso', r.corpo.contas.some(c => c.id === contaAna));

  /* ============ Nome da casa ============ */
  r = await req('/casa', { method: 'PUT', body: JSON.stringify({ nome: 'ZZ TESTE Casa da Ana' }) }, ANA);
  ok('renomear a casa', r.status === 200, r.status);
  r = await req('/me', {}, CARLA);
  ok('o nome novo aparece para todo mundo da casa', r.corpo.casa.nome === 'ZZ TESTE Casa da Ana', r.corpo.casa.nome);

  /* ============ Coisas que já existiam ============ */
  r = await req('/col/naoexiste', { method: 'POST', body: JSON.stringify({ x: 1 }) }, ANA);
  ok('coleção fora da lista -> 404', r.status === 404, r.status);

  const semToken = await fetch(BASE + '/estado');
  ok('sem token -> 401', semToken.status === 401, semToken.status);

  r = await req('/config', { method: 'PUT', body: JSON.stringify({ tetoLazer: 1500, rendaFixa: 9000 }) }, ANA);
  ok('salvar config da casa', r.status === 200, r.status);
  r = await req('/estado', {}, CARLA);
  ok('config vale para a casa inteira', r.corpo.config.tetoLazer === 1500, JSON.stringify(r.corpo.config));

  const fd = new FormData();
  fd.append('foto', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'teste.jpg');
  const up = await fetch(BASE + '/fotos', { method: 'POST', headers: { Authorization: 'Bearer ' + ANA }, body: fd });
  const upJson = await up.json();
  ok('upload de foto', up.status === 200 && !!upJson.id, JSON.stringify(upJson));
  const blob = await fetch(BASE.replace('/api', '') + '/_blob/' + upJson.id);
  ok('foto acessível em /_blob/', blob.status === 200);
  require('fs').unlinkSync(require('path').join(process.env.PASTA_FOTOS || __dirname + '/fotos', upJson.id + '.jpg'));

  const fdGrande = new FormData();
  fdGrande.append('foto', new Blob([Buffer.alloc(9 * 1024 * 1024)], { type: 'image/jpeg' }), 'grande.jpg');
  const respGrande = await fetch(BASE + '/fotos', { method: 'POST', headers: { Authorization: 'Bearer ' + ANA }, body: fdGrande });
  const jsonGrande = await respGrande.json().catch(() => ({}));
  ok('foto acima de 8 MB -> 413 com recado claro', respGrande.status === 413 && /8 MB/.test(jsonGrande.erro || ''), respGrande.status);

  r = await req('/col/contas', { method: 'POST', body: JSON.stringify({ nome: 'ZZ TESTE ' + String.fromCharCode(0) }) }, ANA);
  ok('pedido que o Postgres recusa -> 500 com resposta', r.status === 500, r.status);
  r = await req('/me', {}, ANA);
  ok('servidor continua de pé depois do erro', r.status === 200, r.status);

  r = await req('/logout', { method: 'POST' }, ANA);
  ok('logout', r.status === 200, r.status);
  r = await req('/estado', {}, ANA);
  ok('token não vale mais depois do logout', r.status === 401, r.status);

  /* ============ Trava de senha errada ============ */
  let ultimo = null;
  for (let i = 0; i < 8; i++) {
    ultimo = await req('/login', { method: 'POST', body: JSON.stringify({ usuario: '_teste_bruno', senha: 'chute' + i }) });
  }
  ok('8 senhas erradas seguidas -> bloqueia (429)', ultimo.status === 429, ultimo.status);
  r = await req('/login', { method: 'POST', body: JSON.stringify({ usuario: '_teste_bruno', senha: 'senha456' }) });
  ok('bloqueado recusa até a senha CERTA', r.status === 429, r.status);
  await pool.query("UPDATE missao_usuarios SET bloqueado_ate = NULL, erros_seguidos = 0 WHERE nome = '_teste_bruno'");
  r = await req('/login', { method: 'POST', body: JSON.stringify({ usuario: '_teste_bruno', senha: 'senha456' }) });
  ok('passado o bloqueio, a senha certa entra de novo', r.status === 200, r.status);

  /* ============ Limpeza ============ */
  await limpar();
  const sobrouU = await pool.query('SELECT count(*) FROM missao_usuarios WHERE nome LIKE $1', ['_teste%']);
  ok('nenhum usuário de teste sobrou', sobrouU.rows[0].count === '0', sobrouU.rows[0].count);
  const sobrouD = await pool.query("SELECT count(*) FROM missao_docs WHERE dados->>'nome' LIKE 'ZZ TESTE%'");
  ok('nenhum lançamento de teste sobrou', sobrouD.rows[0].count === '0', sobrouD.rows[0].count);
  const orfaos = await pool.query('SELECT count(*) FROM missao_docs WHERE casa_id IS NULL');
  ok('nenhum lançamento ficou sem casa', orfaos.rows[0].count === '0', orfaos.rows[0].count);

  console.log(`\n=== ${conferencias} conferências, ${falhas} falha(s) ===`);
  await pool.end();
  process.exit(falhas === 0 ? 0 : 1);
})().catch(async e => {
  console.error('Erro no teste:', e);
  try { await limpar(); await pool.end(); } catch (_) {}
  process.exit(1);
});
