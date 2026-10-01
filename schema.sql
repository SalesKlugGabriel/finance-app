-- Missão Finanças — schema no banco compartilhado "dashboard" (mesma convenção de
-- visitas-app e viabil-app: um banco só, tabelas prefixadas por projeto).
--
-- Este arquivo roda INTEIRO a cada vez que o app sobe, então tudo aqui precisa ser
-- repetível sem estragar nada (IF NOT EXISTS, ON CONFLICT, etc).

-- ============ Casas ============
-- Uma "casa" é um conjunto de contas compartilhado — na prática, um casal. Cada pessoa
-- pertence a uma casa, e só enxerga os lançamentos da casa dela. É o que permite o amigo
-- do Gabriel e a esposa usarem o mesmo app sem ver (nem mexer) nas contas dele.
CREATE TABLE IF NOT EXISTS missao_casas (
    id        serial PRIMARY KEY,
    nome      text NOT NULL,
    criada_em timestamptz NOT NULL DEFAULT now()
);

-- ============ Usuários ============
CREATE TABLE IF NOT EXISTS missao_usuarios (
    id       serial PRIMARY KEY,
    nome     text UNIQUE NOT NULL,
    pin_hash text,
    pin_salt text
);
ALTER TABLE missao_usuarios ADD COLUMN IF NOT EXISTS erros_seguidos integer NOT NULL DEFAULT 0;
ALTER TABLE missao_usuarios ADD COLUMN IF NOT EXISTS bloqueado_ate timestamptz;
ALTER TABLE missao_usuarios ADD COLUMN IF NOT EXISTS casa_id integer REFERENCES missao_casas(id);
ALTER TABLE missao_usuarios ADD COLUMN IF NOT EXISTS criado_em timestamptz NOT NULL DEFAULT now();

-- A senha deixou de ser um PIN de 4 números e virou senha de verdade (25/09/2026, pedido do
-- Gabriel: o app passou a ser aberto a outros casais). As colunas mudam de nome, mas o VALOR
-- é o mesmo hash scrypt de antes — quem já entrava com o PIN de 4 números continua entrando
-- com ele, agora como senha.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'missao_usuarios' AND column_name = 'pin_hash') THEN
        ALTER TABLE missao_usuarios RENAME COLUMN pin_hash TO senha_hash;
        ALTER TABLE missao_usuarios RENAME COLUMN pin_salt TO senha_salt;
    END IF;
END $$;

-- 🔴 Nunca semear usuário de teste aqui. A 1ª versão (24/09/2026) semeava "_teste_missao"
-- com senha em branco — e, como o primeiro acesso DEFINE a senha, qualquer pessoa que
-- soubesse o nome entrava e via as finanças do casal. O teste cria e apaga na hora.
DELETE FROM missao_usuarios WHERE nome = '_teste_missao';

CREATE TABLE IF NOT EXISTS missao_sessoes (
    token      text PRIMARY KEY,
    usuario_id integer NOT NULL REFERENCES missao_usuarios(id) ON DELETE CASCADE,
    criada_em  timestamptz NOT NULL DEFAULT now(),
    expira_em  timestamptz NOT NULL DEFAULT now() + interval '180 days'
);
CREATE INDEX IF NOT EXISTS idx_missao_sessoes_usuario ON missao_sessoes (usuario_id);

-- ============ Convites ============
-- Link de uso único pra chamar alguém pra dentro da sua casa. Uso único de propósito: um
-- link desses dá acesso à vida financeira inteira de quem convidou, e link de WhatsApp é
-- repassado com facilidade.
CREATE TABLE IF NOT EXISTS missao_convites (
    token      text PRIMARY KEY,
    casa_id    integer NOT NULL REFERENCES missao_casas(id) ON DELETE CASCADE,
    criado_por integer REFERENCES missao_usuarios(id) ON DELETE SET NULL,
    criado_em  timestamptz NOT NULL DEFAULT now(),
    expira_em  timestamptz NOT NULL DEFAULT now() + interval '7 days',
    usado_em   timestamptz,
    usado_por  integer REFERENCES missao_usuarios(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_missao_convites_casa ON missao_convites (casa_id);

-- ============ Lançamentos ============
-- Guarda de documentos genérica: espelha a forma de "coleção de documentos" que o app já
-- usava (contas, dividas, metas, pagamentos, lazer, gastos, receitas).
CREATE TABLE IF NOT EXISTS missao_docs (
    colecao       text NOT NULL,
    id            text NOT NULL,
    dados         jsonb NOT NULL,
    criado_em     timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (colecao, id)
);
CREATE INDEX IF NOT EXISTS idx_missao_docs_colecao ON missao_docs (colecao);
ALTER TABLE missao_docs ADD COLUMN IF NOT EXISTS casa_id integer REFERENCES missao_casas(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_missao_docs_casa ON missao_docs (casa_id, colecao);

CREATE TABLE IF NOT EXISTS missao_config (
    id            text PRIMARY KEY DEFAULT 'geral',
    dados         jsonb NOT NULL DEFAULT '{}'::jsonb,
    atualizado_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE missao_config ADD COLUMN IF NOT EXISTS casa_id integer REFERENCES missao_casas(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_missao_config_casa ON missao_config (casa_id);

-- ============ Migração: o que existia antes das casas ============
-- Antes de 25/09/2026 havia UMA casa só, implícita (Gabriel + Luana), e nenhum lançamento
-- tinha dono. Aqui isso vira uma casa de verdade, sem perder nada. Roda uma vez só: depois
-- disso não existe mais usuário nem lançamento com casa_id nulo.
DO $$
DECLARE
    casa_inicial integer;
BEGIN
    IF EXISTS (SELECT 1 FROM missao_usuarios WHERE casa_id IS NULL) THEN
        SELECT id INTO casa_inicial FROM missao_casas ORDER BY id LIMIT 1;
        IF casa_inicial IS NULL THEN
            INSERT INTO missao_casas (nome) VALUES ('Nossa casa') RETURNING id INTO casa_inicial;
        END IF;
        UPDATE missao_usuarios SET casa_id = casa_inicial WHERE casa_id IS NULL;
        UPDATE missao_docs     SET casa_id = casa_inicial WHERE casa_id IS NULL;
        UPDATE missao_config   SET casa_id = casa_inicial WHERE casa_id IS NULL;
    END IF;
END $$;
