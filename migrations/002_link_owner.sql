-- Expand: coluna nova e opcional. A versão anterior da api continua funcionando (ela só ignora a coluna).
-- NULL = link criado por um serviço (API key), sem dono.
ALTER TABLE links ADD COLUMN owner_id text;

-- Serve o "meus links": filtra pelo dono e já entrega na ordem da paginação (mais novos primeiro).
CREATE INDEX links_owner_created_idx ON links (owner_id, created_at DESC, code DESC);
