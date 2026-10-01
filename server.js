const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { pool, garantirSchema } = require('./db');

const PORT = process.env.PORT || 3000;
const PASTA_FOTOS = process.env.PASTA_FOTOS || path.join(__dirname, 'fotos');
fs.mkdirSync(PASTA_FOTOS, { recursive: true });

// As mesmas 7 coleções que o app já usa. Nunca aceitar um nome de coleção que não esteja
// aqui — é o que impede alguém de escrever numa tabela/rota que não existe.
const COLECOES = ['contas', 'dividas', 'metas', 'pagamentos', 'lazer', 'gastos', 'receitas'];

const app = express();
app.use(express.json({ limit: '2mb' }));

/* Toda rota é embrulhada por aqui. Sem isto, um erro dentro de uma rota "async" vira uma
   promessa sem dono e o Node MATA o processo inteiro — medido em 24/09/2026: um único
   pedido malformado derrubava o app pra todo mundo (o Swarm reerguia em ~10s). */
const rota = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ============ Senha ============
   Nunca guardada em texto puro — só o resultado do scrypt com sal próprio de cada pessoa.
   Mínimo de 4 caracteres de propósito: quem já entrava com PIN de 4 números (Gabriel e
   Luana, antes de 25/09/2026) continua entrando com o mesmo segredo, agora como senha. */
const MINIMO_SENHA = 4;
function calcularHash(senha, salt) {
  return crypto.scryptSync(String(senha), salt, 64).toString('hex');
}
function senhaValida(s) {
  return typeof s === 'string' && s.length >= MINIMO_SENHA && s.length <= 200;
}
function nomeValido(n) {
  return typeof n === 'string' && n.trim().length >= 2 && n.trim().length <= 40;
}
function conferir(senha, hashGuardado, salt) {
  const esperado = Buffer.from(hashGuardado, 'hex');
  const recebido = Buffer.from(calcularHash(senha, salt), 'hex');
  return esperado.length === recebido.length && crypto.timingSafeEqual(esperado, recebido);
}
async function abrirSessao(usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('INSERT INTO missao_sessoes (token, usuario_id) VALUES ($1, $2)', [token, usuarioId]);
  return token;
}

// Quantos erros de senha seguidos até parar de aceitar tentativa, e por quanto tempo.
// Medido em 24/09/2026: sem isto, dá pra testar ~17 senhas por segundo.
const ERROS_ATE_BLOQUEAR = 8;
const MINUTOS_BLOQUEADO = 10;

async function buscarUsuario(nome) {
  const r = await pool.query(
    `SELECT id, nome, senha_hash, senha_salt, casa_id, erros_seguidos,
            GREATEST(0, CEIL(EXTRACT(EPOCH FROM (bloqueado_ate - now())) / 60)) AS minutos_restantes
     FROM missao_usuarios WHERE lower(nome) = lower($1)`, [String(nome || '').trim()]);
  return r.rows[0] || null;
}

/* ============ Entrar ============ */
app.post('/api/login', rota(async (req, res) => {
  const { usuario, senha } = req.body || {};
  if (!nomeValido(usuario) || typeof senha !== 'string' || !senha) {
    return res.status(400).json({ erro: 'Digite seu usuário e a senha.' });
  }
  const u = await buscarUsuario(usuario);
  // Usuário não existe: não é erro, é o caminho de criar conta (a tela pede senha + confirmação).
  if (!u) return res.status(404).json({ novo: true, erro: 'Esse usuário ainda não existe.' });

  if (Number(u.minutos_restantes) > 0) {
    return res.status(429).json({ erro: `Muitas senhas erradas. Tente de novo em ${u.minutos_restantes} minuto(s).` });
  }
  if (!u.senha_hash || !conferir(senha, u.senha_hash, u.senha_salt)) {
    const erros = Number(u.erros_seguidos || 0) + 1;
    if (erros >= ERROS_ATE_BLOQUEAR) {
      await pool.query(
        `UPDATE missao_usuarios SET erros_seguidos = 0, bloqueado_ate = now() + ($2 || ' minutes')::interval WHERE id = $1`,
        [u.id, MINUTOS_BLOQUEADO]);
      return res.status(429).json({ erro: `Muitas senhas erradas. Tente de novo em ${MINUTOS_BLOQUEADO} minutos.` });
    }
    await pool.query('UPDATE missao_usuarios SET erros_seguidos = $2 WHERE id = $1', [u.id, erros]);
    return res.status(401).json({ erro: 'Senha incorreta.' });
  }
  await pool.query('UPDATE missao_usuarios SET erros_seguidos = 0, bloqueado_ate = NULL WHERE id = $1', [u.id]);
  res.json({ token: await abrirSessao(u.id), usuario: u.nome });
}));

/* ============ Criar conta ============
   Primeiro acesso de alguém que ainda não existe: senha + confirmação. Se veio por um link
   de convite, entra direto na casa de quem convidou; se não, ganha uma casa própria. */
app.post('/api/cadastrar', rota(async (req, res) => {
  const { usuario, senha, senha2, convite } = req.body || {};
  const nome = String(usuario || '').trim();
  if (!nomeValido(nome)) return res.status(400).json({ erro: 'O usuário precisa ter de 2 a 40 letras.' });
  if (!senhaValida(senha)) return res.status(400).json({ erro: `A senha precisa ter pelo menos ${MINIMO_SENHA} caracteres.` });
  if (senha !== senha2) return res.status(400).json({ erro: 'As duas senhas não são iguais.' });
  if (await buscarUsuario(nome)) return res.status(409).json({ erro: 'Esse usuário já existe. Entre com a senha dele.' });

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    let casaId = null;
    if (convite) {
      const c = await cliente.query(
        `SELECT casa_id FROM missao_convites
         WHERE token = $1 AND usado_em IS NULL AND expira_em > now() FOR UPDATE`, [convite]);
      if (!c.rows[0]) {
        await cliente.query('ROLLBACK');
        return res.status(400).json({ erro: 'Esse convite não vale mais. Peça um link novo.' });
      }
      casaId = c.rows[0].casa_id;
    } else {
      const nova = await cliente.query('INSERT INTO missao_casas (nome) VALUES ($1) RETURNING id', [`Casa de ${nome}`]);
      casaId = nova.rows[0].id;
      await cliente.query(
        `INSERT INTO missao_config (id, casa_id, dados) VALUES ($1, $2, $3::jsonb)`,
        ['casa' + casaId, casaId, JSON.stringify({ tetoLazer: 0, rendaFixa: 0 })]);
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const novo = await cliente.query(
      `INSERT INTO missao_usuarios (nome, senha_hash, senha_salt, casa_id) VALUES ($1, $2, $3, $4) RETURNING id, nome`,
      [nome, calcularHash(senha, salt), salt, casaId]);
    if (convite) {
      await cliente.query('UPDATE missao_convites SET usado_em = now(), usado_por = $2 WHERE token = $1',
        [convite, novo.rows[0].id]);
    }
    await cliente.query('COMMIT');
    res.json({ token: await abrirSessao(novo.rows[0].id), usuario: novo.rows[0].nome });
  } catch (e) {
    await cliente.query('ROLLBACK');
    throw e;
  } finally {
    cliente.release();
  }
}));

function tokenDoCabecalho(req) {
  const cab = req.headers.authorization || '';
  return cab.startsWith('Bearer ') ? cab.slice(7) : null;
}
// Continua sendo "function" (e não const) de propósito: as rotas abaixo usam este nome, e
// const não vale antes da linha onde é declarado — derrubou o deploy uma vez (24/09/2026).
async function exigirLogin(req, res, next) {
  try {
    const token = tokenDoCabecalho(req);
    if (!token) return res.status(401).json({ erro: 'Entre novamente no app.' });
    const r = await pool.query(
      `SELECT u.id, u.nome, u.casa_id FROM missao_sessoes s JOIN missao_usuarios u ON u.id = s.usuario_id
       WHERE s.token = $1 AND s.expira_em > now()`, [token]);
    if (!r.rows[0]) return res.status(401).json({ erro: 'Sessão expirada. Entre de novo.' });
    req.usuario = r.rows[0];
    next();
  } catch (e) { next(e); }
}

app.get('/api/me', exigirLogin, rota(async (req, res) => {
  const casa = await pool.query('SELECT id, nome FROM missao_casas WHERE id = $1', [req.usuario.casa_id]);
  const membros = await pool.query(
    'SELECT nome FROM missao_usuarios WHERE casa_id = $1 ORDER BY criado_em, id', [req.usuario.casa_id]);
  res.json({
    usuario: req.usuario.nome,
    casa: casa.rows[0] || null,
    membros: membros.rows.map(m => m.nome),
  });
}));

app.post('/api/logout', rota(async (req, res) => {
  const token = tokenDoCabecalho(req);
  if (token) await pool.query('DELETE FROM missao_sessoes WHERE token = $1', [token]);
  res.json({ ok: true });
}));

app.put('/api/casa', exigirLogin, rota(async (req, res) => {
  const nome = String((req.body || {}).nome || '').trim();
  if (nome.length < 2 || nome.length > 60) return res.status(400).json({ erro: 'O nome da casa precisa ter de 2 a 60 letras.' });
  await pool.query('UPDATE missao_casas SET nome = $2 WHERE id = $1', [req.usuario.casa_id, nome]);
  res.json({ ok: true, nome });
}));

/* ============ Convite: compartilhar a casa com alguém ============ */
app.post('/api/convites', exigirLogin, rota(async (req, res) => {
  const token = crypto.randomBytes(24).toString('hex');
  const r = await pool.query(
    `INSERT INTO missao_convites (token, casa_id, criado_por) VALUES ($1, $2, $3) RETURNING expira_em`,
    [token, req.usuario.casa_id, req.usuario.id]);
  res.json({ token, expira_em: r.rows[0].expira_em });
}));

// Público de propósito: a tela de login precisa saber pra QUAL casa o convite leva, antes
// de a pessoa ter conta. Devolve só o nome da casa — nenhum lançamento.
app.get('/api/convites/:token', rota(async (req, res) => {
  const r = await pool.query(
    `SELECT c.nome FROM missao_convites v JOIN missao_casas c ON c.id = v.casa_id
     WHERE v.token = $1 AND v.usado_em IS NULL AND v.expira_em > now()`, [req.params.token]);
  if (!r.rows[0]) return res.status(404).json({ valido: false, erro: 'Convite vencido ou já usado.' });
  res.json({ valido: true, casa: r.rows[0].nome });
}));

// Quem JÁ tem conta e recebeu um convite: passa a enxergar a casa de quem convidou.
app.post('/api/convites/:token/aceitar', exigirLogin, rota(async (req, res) => {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const c = await cliente.query(
      `SELECT casa_id FROM missao_convites WHERE token = $1 AND usado_em IS NULL AND expira_em > now() FOR UPDATE`,
      [req.params.token]);
    if (!c.rows[0]) {
      await cliente.query('ROLLBACK');
      return res.status(400).json({ erro: 'Esse convite não vale mais. Peça um link novo.' });
    }
    const novaCasa = c.rows[0].casa_id;
    if (novaCasa === req.usuario.casa_id) {
      await cliente.query('ROLLBACK');
      return res.json({ ok: true, jaEra: true });
    }
    const casaAntiga = req.usuario.casa_id;
    await cliente.query('UPDATE missao_usuarios SET casa_id = $2 WHERE id = $1', [req.usuario.id, novaCasa]);
    await cliente.query('UPDATE missao_convites SET usado_em = now(), usado_por = $2 WHERE token = $1',
      [req.params.token, req.usuario.id]);
    // Casa que ficou sem ninguém E sem lançamento não serve pra nada — sai do caminho.
    // Se tiver lançamento, fica guardada (não apago trabalho de ninguém em silêncio).
    const sobrou = await cliente.query(
      `SELECT (SELECT count(*) FROM missao_usuarios WHERE casa_id = $1) AS gente,
              (SELECT count(*) FROM missao_docs WHERE casa_id = $1) AS docs`, [casaAntiga]);
    if (sobrou.rows[0].gente === '0' && sobrou.rows[0].docs === '0') {
      await cliente.query('DELETE FROM missao_config WHERE casa_id = $1', [casaAntiga]);
      await cliente.query('DELETE FROM missao_casas WHERE id = $1', [casaAntiga]);
    }
    await cliente.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await cliente.query('ROLLBACK');
    throw e;
  } finally {
    cliente.release();
  }
}));

/* ============ Estado (as 7 coleções + config, tudo de uma vez) ============
   SEMPRE filtrado pela casa de quem está logado — é a fronteira que impede um casal de ver
   as contas do outro. Toda rota daqui pra baixo repete esse filtro. */
app.get('/api/estado', exigirLogin, rota(async (req, res) => {
  const doc = await pool.query(
    `SELECT colecao, id, dados, to_char(criado_em, 'YYYY-MM') AS mes_cadastro
     FROM missao_docs WHERE casa_id = $1`, [req.usuario.casa_id]);
  const estado = {};
  for (const c of COLECOES) estado[c] = [];
  for (const row of doc.rows) {
    if (!estado[row.colecao]) continue;
    // mes_cadastro: quando o lançamento entrou no app. O relatório usa isso para não
    // desenhar uma dívida como se ela já existisse em meses anteriores ao cadastro —
    // o que seria inventar histórico. Nunca sobrescreve um campo que o dado já tenha.
    estado[row.colecao].push({ id: row.id, mes_cadastro: row.mes_cadastro, ...row.dados });
  }
  const cfg = await pool.query('SELECT dados FROM missao_config WHERE casa_id = $1', [req.usuario.casa_id]);
  estado.config = (cfg.rows[0] && cfg.rows[0].dados) || {};
  res.json(estado);
}));

function validarColecao(req, res, next) {
  if (!COLECOES.includes(req.params.col)) return res.status(404).json({ erro: 'Coleção inexistente.' });
  next();
}

app.post('/api/col/:col', exigirLogin, validarColecao, rota(async (req, res) => {
  const id = crypto.randomBytes(7).toString('hex');
  const dados = req.body || {};
  await pool.query('INSERT INTO missao_docs (colecao, id, dados, casa_id) VALUES ($1, $2, $3, $4)',
    [req.params.col, id, dados, req.usuario.casa_id]);
  res.json({ id, ...dados });
}));

app.put('/api/col/:col/:id', exigirLogin, validarColecao, rota(async (req, res) => {
  const dados = req.body || {};
  // O UPDATE exige casa_id: sem isso, alguém com o id de um lançamento de outra casa
  // escreveria por cima dele.
  const r = await pool.query(
    `UPDATE missao_docs SET dados = $3, atualizado_em = now()
     WHERE colecao = $1 AND id = $2 AND casa_id = $4`,
    [req.params.col, req.params.id, dados, req.usuario.casa_id]);
  if (r.rowCount === 0) {
    await pool.query('INSERT INTO missao_docs (colecao, id, dados, casa_id) VALUES ($1, $2, $3, $4)',
      [req.params.col, req.params.id, dados, req.usuario.casa_id]);
  }
  res.json({ id: req.params.id, ...dados });
}));

app.delete('/api/col/:col/:id', exigirLogin, validarColecao, rota(async (req, res) => {
  await pool.query('DELETE FROM missao_docs WHERE colecao = $1 AND id = $2 AND casa_id = $3',
    [req.params.col, req.params.id, req.usuario.casa_id]);
  res.json({ ok: true });
}));

app.put('/api/config', exigirLogin, rota(async (req, res) => {
  const dados = req.body || {};
  const r = await pool.query(
    `UPDATE missao_config SET dados = $2, atualizado_em = now() WHERE casa_id = $1`,
    [req.usuario.casa_id, dados]);
  if (r.rowCount === 0) {
    await pool.query('INSERT INTO missao_config (id, casa_id, dados) VALUES ($1, $2, $3)',
      ['casa' + req.usuario.casa_id, req.usuario.casa_id, dados]);
  }
  res.json(dados);
}));

/* ============ Fotos de comprovante/cupom ============
   Sem leitura automática por IA aqui (dependeria de uma chave de API paga, e isso é
   decisão do Gabriel) — mas a foto em si fica guardada, no endereço /_blob/<id>. */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
app.post('/api/fotos', exigirLogin, upload.single('foto'), rota(async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Nenhuma foto enviada.' });
  const id = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(path.join(PASTA_FOTOS, id + '.jpg'), req.file.buffer);
  res.json({ id });
}));
app.get('/_blob/:id', (req, res) => {
  const arquivo = path.join(PASTA_FOTOS, path.basename(req.params.id) + '.jpg');
  if (!fs.existsSync(arquivo)) return res.status(404).end();
  res.type('image/jpeg').sendFile(arquivo);
});

/* ============ Páginas ============ */
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views', 'app.html')));

/* ============ Rede de segurança ============
   Qualquer erro que escape de uma rota vira uma RESPOSTA, não a queda do app. */
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ erro: 'Foto grande demais (máximo 8 MB). Tire outra menor.' });
  }
  console.error('Erro na rota', req.method, req.originalUrl, '-', err && err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ erro: 'Deu problema no servidor. Tente de novo.' });
});

// Última linha de defesa: registra e segue de pé, em vez de morrer (o padrão do Node 20
// é derrubar o processo numa promessa sem dono).
process.on('unhandledRejection', e => console.error('Promessa sem dono:', e));
process.on('uncaughtException', e => console.error('Erro não capturado:', e));

garantirSchema()
  .then(() => app.listen(PORT, () => console.log('Missão Finanças ouvindo na porta ' + PORT)))
  .catch(e => { console.error('Falha ao preparar o banco:', e); process.exit(1); });
