# Migração completa — rede restrita → rede limpa (automação total)

> Objetivo: levar segredos + vínculos + cestas para outra máquina em
> **1 pacote criptografado**, sem nada disso passar pelo repositório.
> Testado ida-e-volta em 2026-10-13 (export → import restaurando
> `.env` + 1 conta + cestas).

## 0. Regra de segurança (não negociável)

- `.env`, `data/contas.json`, `data/cestas.json`, `cookie*.txt`, `qr*.png`,
  `*.pem`, `*.key` e `migracao-*.tar.gz*` estão no `.gitignore` e
  **NUNCA entram no git**. Auditoria: `git ls-files | grep -iE "env|cookie|data/"`
  deve voltar vazio.
- O pacote de migração trafega **sempre criptografado** (AES-256-CBC) e é
  apagado da origem após a transferência.

## 1. Na máquina ATUAL (origem) — exportar

```bash
cd /home/oficina/PROJETOS/autoMensagemWhats
git pull origin develop          # garanta o código mais novo
./scripts/migrar-export.sh       # gera em /tmp: migracao-AAAAMMDD-HHMM.tar.gz.enc
```

O script empacota **somente**: `.env` + `data/contas.json` + `data/cestas.json`,
lista o conteúdo (só nomes), pede uma **senha forte** e apaga o `.tar.gz`
aberto. Leve **apenas o `.enc`** (pendrive, transferência segura).

## 2. Na máquina NOVA (destino, rede limpa) — importar

Pré-requisitos: Ubuntu/Debian com Docker + Node 20+.

```bash
git clone https://github.com/Regimarcilio/autoMensagemWhats
cd autoMensagemWhats
git checkout main                # ou a release mais nova
./scripts/migrar-import.sh /caminho/migracao-AAAAMMDD-HHMM.tar.gz.enc
# digite a senha → restaura .env (600) + contas + cestas
```

Confira os endereços mostrados (`EVO_URL`, `EVO_HOST_PORT`): se a 8080
estiver livre aí, pode voltar ao padrão (`EVO_HOST_PORT=8080`).

## 3. Subir tudo no destino

```bash
docker compose up -d            # Evolution v2 + Postgres
npm install && npm run build
npm run manager &               # gerenciador em http://IP:8091
npm start -- evo:qr --save qr.png   # escaneie em <60s
npm start -- evo:status              # state: open = ok
```

## 4. Ligar o automático (último clique)

1. `http://IP:8091` → **Contas** → confira etiqueta + vínculos categoria → conta + grupo
2. **LIGA TUDO** — 1 oferta a cada 2 min por categoria, link com sua comissão

## 5. Validação pós-migração (checklist)

- [ ] `curl localhost:8091/api/contas` mostra as contas (só máscaras)
- [ ] `curl localhost:8091/api/piloto` responde
- [ ] Selo `LIVE` aparece na busca (rede limpa) em vez de `DEMO`
- [ ] 1ª mensagem de teste chega no grupo com foto + link `meli.la` da sua etiqueta
- [ ] `.enc` apagado da origem; `git status` limpo nas duas máquinas

## 6. Renovar o cookie (quando o ML invalidar)

Sintoma no log: `createLink 401/500` repetido ou `COOKIE... expirado`.
No PC: portal afiliado → gerador de links → F12 → Network → `createLink`
→ copiar header `Cookie` → colar no `.env` (`COOKIE_ML=...`) e nas contas
(tela Contas → salvar de novo). Sem commitar, sempre.

## Referência das credenciais

| Var | Onde (re)obter |
|---|---|
| `EVO_KEY` / `EVO_GO_KEY` | você inventa (`openssl rand -hex 32`) |
| `TAG_ML` | ML → Administrador de etiquetas (+ reservas) |
| `COOKIE_ML` | ML → gerador de links → F12 → `createLink` → `Cookie` |
| `GRUPO_TESTE` | após o QR: `GET /group/fetchAllGroups/{instância}` |
