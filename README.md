# Claude Agents Mesh

Un **MCP de coordination** qui permet à plusieurs sessions Claude Code — y compris
sur des **comptes Claude différents** — de collaborer via un projet **Supabase**
partagé : présence des agents, messages persistants, file de tâches avec *lease*, et
signalement des limites (quotas).

Supabase garde l'état (rien n'est perdu si une session s'arrête). Le MCP est la seule
interface que Claude voit. Le dépôt est **public et paramétrable** : chacun déploie sur
**son propre projet Supabase** et se connecte avec **une URL + un token**.

```
Session A (compte A)   Session B (compte B)   Session C (compte A)
        \                    |                    /
         \  MCP HTTP  (Authorization: Bearer mesh_…)
          ▼                  ▼                  ▼
     Supabase Edge Function "coordinator"  (service_role)
                         │
                         ▼
     PostgreSQL : workspaces · agents · tasks · messages · quota_events · events
```

Voir [`docs/architecture.md`](docs/architecture.md) pour le détail.

---

## 1. Déployer ton propre mesh (une fois)

Prérequis : un compte Supabase et le [CLI Supabase](https://supabase.com/docs/guides/local-development)
(`supabase`). Tu peux aussi tout faire depuis le tableau de bord Supabase.

```bash
# a. Récupérer le dépôt
git clone https://github.com/aciderix/claude-agents-mesh
cd claude-agents-mesh

# b. Lier ton projet Supabase (remplace <ref> par la ref de ton projet)
supabase link --project-ref <ref>

# c. Appliquer le schéma (crée les tables, RLS, fonctions, token-auth)
supabase db push

# d. Définir le secret bootstrap (ton mot de passe maître d'admin)
supabase secrets set --project-ref <ref> MESH_BOOTSTRAP_SECRET="$(openssl rand -hex 32)"

# e. Déployer la fonction MCP (auth custom → verify_jwt off, déjà dans config.toml)
supabase functions deploy coordinator --no-verify-jwt
```

Ton endpoint MCP est alors :

```
https://<ref>.supabase.co/functions/v1/coordinator/mcp
```

> `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` sont fournis automatiquement à la
> fonction par Supabase. **Ne mets jamais** la clé `service_role` dans le dépôt ni dans
> un client Claude — elle ne vit que côté serveur.

Vérification rapide :

```bash
curl https://<ref>.supabase.co/functions/v1/coordinator/health
# => {"ok":true,"server":"claude-agents-mesh",...,"tools":23,...}
```

---

## 2. Créer un workspace et des tokens

Le **token bootstrap** (`MESH_BOOTSTRAP_SECRET`) sert uniquement à l'administration.
Utilise-le une fois pour créer le workspace, puis passe au token *owner* renvoyé.

Avec `curl` (ou en ajoutant temporairement le MCP avec le token bootstrap et en
demandant à Claude d'appeler `create_workspace`) :

```bash
BOOT="<ton MESH_BOOTSTRAP_SECRET>"
URL="https://<ref>.supabase.co/functions/v1/coordinator/mcp"

# Créer le workspace + le propriétaire → renvoie owner_token (mesh_…)
curl -s -X POST "$URL" -H "authorization: Bearer $BOOT" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_workspace","arguments":{"name":"mon-projet","owner_label":"moi@example.com"}}}'
```

Puis, avec le **token owner** obtenu, invite les autres participants (l'`email`/`label`
n'est qu'une **étiquette**, aucun mail n'est envoyé) :

```bash
OWNER="mesh_…"   # owner_token renvoyé ci-dessus
curl -s -X POST "$URL" -H "authorization: Bearer $OWNER" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"invite_member","arguments":{"label":"bob@example.com"}}}'
# => renvoie un token mesh_… à transmettre à Bob (avec l'URL du MCP)
```

**1 token = 1 identité = 1 agent.** Pour plusieurs agents indépendants, crée plusieurs
tokens.

---

## 3. Connecter une session Claude Code

Tu n'utilises que des agents cloud : deux façons de brancher le MCP.

### Option A — Plugin (recommandé, « paramétrable »)

Le plugin embarque le serveur MCP, les hooks (enregistrement auto au démarrage,
présence, quotas) et le skill de coordination. À l'activation, Claude Code te demande
**ton URL** et **ton token** (donc chacun sa propre base).

Dans `claude.ai/code` → réglages → Plugins, ajoute ce dépôt comme marketplace/plugin,
active `claude-agents-mesh`, puis renseigne :

- **Mesh MCP URL** : `https://<ref>.supabase.co/functions/v1/coordinator/mcp`
- **Mesh access token** : ton `mesh_…`

En CLI, l'équivalent d'un serveur seul :

```bash
claude mcp add --transport http mesh https://<ref>.supabase.co/functions/v1/coordinator/mcp \
  --header "Authorization: Bearer mesh_…"
```

### Option B — MCP distant manuel

Dans les réglages MCP de `claude.ai/code`, ajoute un serveur **HTTP** :

- URL : `https://<ref>.supabase.co/functions/v1/coordinator/mcp`
- Header : `Authorization: Bearer mesh_…`

Dès la connexion, l'agent est **identifié automatiquement** par son token. Demande à
Claude : *« appelle whoami »* puis *« register_session avec le nom Claude-A »*.

---

## 4. Utiliser le mesh

Une fois connecté, Claude dispose de 23 outils. Enchaînement typique d'un *handoff* :

1. `whoami` — confirmer l'identité et le workspace.
2. `register_session` — s'enregistrer (le hook du plugin le fait déjà).
3. `get_coordination_status` — voir qui est présent, les tâches, les messages.
4. A : `create_task` → B : `claim_task` → `heartbeat_task` (boucle) → `complete_task`.
5. `send_message` / `read_messages` / `ack_message` — se parler (persistant).
6. `report_quota_event` — signaler un blocage/reprise de quota.

Le skill `coordination` (fourni par le plugin) explique tout cela à Claude
automatiquement.

### Outils disponibles

| Domaine | Outils |
| --- | --- |
| Identité / admin | `whoami`, `create_workspace`, `invite_member`, `list_workspace_members`, `list_tokens`, `revoke_token` |
| Présence | `register_session`, `heartbeat_session`, `list_agents`, `get_agent_status` |
| Tâches | `create_task`, `list_tasks`, `claim_task`, `heartbeat_task`, `release_task`, `complete_task`, `update_task` |
| Messages | `send_message`, `read_messages`, `ack_message` |
| Quotas / vue | `report_quota_event`, `get_quota_status`, `get_coordination_status` |

---

## 5. Statusline quota (optionnel)

Un plugin ne peut pas imposer la statusline principale : ajoute-la toi-même dans ton
`settings.json` de Claude Code :

```json
{ "statusLine": { "type": "command", "command": "/chemin/vers/claude-agents-mesh/statusline/statusline.sh" } }
```

Elle affiche `mesh | 5h 95% reset 19:00Z | 7d 82% reset 16:00Z`. Si `MESH_MCP_URL`
et `MESH_MCP_TOKEN` sont exportés, elle émet aussi un `quota_warning` (une fois par
fenêtre de 5 h au-delà de `MESH_WARN_AT`, défaut 90 %).

---

## Sécurité

- La clé `service_role` ne vit que dans l'environnement de la fonction, jamais dans le
  dépôt ni dans un client.
- `member_tokens` : RLS activé **sans aucune policy** → seul le `service_role` y accède.
  Seul le **hash SHA-256** est stocké ; le token brut n'est montré qu'à la création.
- Les RPC `mesh_*` sont exécutables **uniquement** par `service_role`.
- L'identité vient toujours du token, jamais des arguments envoyés par Claude.
- RLS reste activé partout en défense en profondeur.

Révoquer un accès : `revoke_token(token_id)` (voir `list_tokens`).

---

## Structure du dépôt

```
.claude-plugin/plugin.json     Manifeste du plugin (MCP + hooks + userConfig)
hooks/                         session-start, session-end, stop, quota-notification
skills/coordination/SKILL.md   Guide de coordination pour Claude
statusline/statusline.sh       Statusline quota (optionnelle)
supabase/
  config.toml
  migrations/                  base_schema + token_auth
  functions/coordinator/       Serveur MCP (Deno/TypeScript)
docs/architecture.md
```

État : v1 fonctionnelle (messages, tâches, leases, heartbeats, quotas). Realtime push
prévu pour une version ultérieure (les tables sont déjà publiées pour Realtime).
