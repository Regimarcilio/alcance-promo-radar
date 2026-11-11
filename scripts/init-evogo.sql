-- Executado apenas na primeira inicialização do volume do Postgres.
-- Cria o segundo banco exigido pela Evolution GO (auth + users).
-- Idempotente: só cria se ainda não existir.
SELECT 'CREATE DATABASE evogo_users'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'evogo_users')\gexec
