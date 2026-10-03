# mesh-live — le mesh en direct dans Claude Code

`mesh-live` est un **mod** Claude Code (un plugin de *function hooks* en TypeScript)
qui branche le Claude Agents Mesh directement dans le moteur de Claude Code. Il
complète le plugin `claude-agents-mesh` (serveur MCP + hooks bash) et utilise sa
connexion MCP : il n'a besoin d'aucun token à lui.

Un seul sondeur (`get_coordination_status` + `read_messages`, toutes les
`poll_seconds`) alimente un instantané partagé ; chaque fonction le lit :

| # | Fonction | Ce que ça fait |
|---|---|---|
| 1 | **Boîte de réception + réveil** | Bandeau au-dessus de l'invite (`✉ 2 messages de Claude-B · 1 tâche libre [Lire] [Panneau] [Masquer]`). Un nouveau message — ou une nouvelle tâche si l'agent n'en tient aucune — **démarre un tour** dès que la session est inactive : le mesh devient *push*. |
| 2 | **Quotas réels** | Lit les fenêtres de limite (5 h / 7 j) que le moteur reçoit de l'API (`session.measure`), et non plus le texte des notifications : `quota_warning` à chaque seuil (80/90/95 % par défaut, une fois par fenêtre), `quota_blocked` à 100 % ou sur un arrêt `rate_limit`, `quota_reset` quand la fenêtre repart. |
| 3 | **Bail des tâches** | `heartbeat_task` automatique pour chaque tâche tenue (bail = 4 sondages), `release_task` + statut `offline` à la fin de session. |
| 4 | **Passation automatique** | Au seuil `handoff_threshold` (95 %) : note de passation rédigée en forkant la session (servie par le cache), ajoutée à la description de chaque tâche tenue avant de la libérer (ou nouvelle tâche « Reprise du travail de … »), puis message `handoff` aux agents en ligne. |
| 5 | **Panneau `/mesh`** | Agents (présence, statut, dernier événement de quota), tâches actives avec **Réclamer / Libérer / Terminée**, messages non lus avec **Lu**. |
| 6 | **Commandes** | `/mesh`, `/inbox`, `/claim [id]`, `/handoff [note]`, `/tell <agent> <message>`. |
| 7 | **Ligne de statut** | `mesh · 2/3 en ligne · 1 à moi · 2 libres · ✉ 1 · 5h 87 %`. |
| 8 | **Contexte vivant** | Une section fixe dans le prompt système (règles du mesh, identique d'un tour à l'autre pour garder le cache) + un bloc `<mesh-status>` à côté de l'invite **seulement quand l'état a changé**. |
| 9 | **Verrou de fichiers** | Avant `Edit`/`Write`/`NotebookEdit`, le fichier est comparé aux `files` des tâches tenues par d'autres agents : `warn` (toast + note au modèle) ou `deny`. |
| 10 | **Masquage des tokens** | Les `mesh_…` sont affichés `mesh_1a2b3c4d…[masqué]` dans les réponses, les invites et les appels d'outils (affichage seulement). |

## Installation

Le mod est un plugin à part dans la même marketplace que `claude-agents-mesh` :
active **`mesh-live`** à côté de `claude-agents-mesh` (le second fournit le
serveur MCP `mesh` dont le mod se sert).

Pour l'essayer depuis un clone :

```bash
claude --plugin-dir ./mods/mesh-live
```

Si ton serveur MCP mesh porte un autre nom que `mesh` dans `/mcp`, règle l'option
`mesh_server` (les noms `mesh`, `Claude mesh` et `plugin:claude-agents-mesh:mesh`
sont essayés automatiquement).

### Verrou de fichiers : mise à jour du serveur

La fonction 9 a besoin du champ `files` des tâches, ajouté par la migration
`supabase/migrations/20261003100000_task_files.sql` et par la fonction
`coordinator` à jour (`create_task` / `update_task` acceptent `files`,
`get_coordination_status` le renvoie) :

```bash
supabase db push
supabase functions deploy coordinator --no-verify-jwt
```

Tant que le serveur n'est pas mis à jour, tout le reste fonctionne et le verrou
ne signale simplement rien.

## Options

Toutes dans `/config` (ou `pluginConfigs["mesh-live"].options` de `settings.json`) :

| Option | Défaut | Rôle |
|---|---|---|
| `mesh_server` | `mesh` | Nom du serveur MCP mesh tel que `/mcp` l'affiche |
| `agent_name` | *(vide)* | Nom passé à `register_session` ; vide = garder le nom existant |
| `poll_seconds` | `30` | Intervalle de sondage (min. 10) |
| `wake_on_message` | `true` | Démarrer un tour sur nouveau message |
| `wake_on_task` | `true` | Démarrer un tour sur nouvelle tâche si l'agent n'en tient aucune |
| `show_band` | `true` | Bandeau au-dessus de l'invite |
| `show_status` | `true` | Ligne de statut |
| `report_quota` | `true` | Signaler les quotas au mesh |
| `quota_thresholds` | `80,90,95` | Seuils de `quota_warning` |
| `auto_handoff` | `true` | Passation automatique près de la limite |
| `handoff_threshold` | `95` | Pourcentage qui déclenche la passation |
| `keep_leases` | `true` | Renouveler le bail des tâches tenues |
| `release_on_exit` | `true` | Libérer les tâches et passer `offline` en fin de session |
| `inject_context` | `true` | Guide mesh + bloc `<mesh-status>` pour le modèle |
| `file_lock` | `warn` | `warn`, `deny` ou `off` |
| `mask_tokens` | `true` | Masquer les tokens `mesh_` à l'affichage |

## Développement

```
mods/mesh-live/
├── .claude-plugin/plugin.json   manifeste + options (userConfig)
├── hooks/hooks.json             { "modules": ["./register.tsx"] }
├── hooks/register.tsx           tous les hooks et tout ce qui touche `$`
├── hooks/lib/model.ts           instantané, statut, digest, masquage (pur)
├── hooks/lib/glob.ts            correspondance des chemins de `files` (pur)
├── hooks/lib/options.ts         lecture des options (pur)
├── hooks/lib/text.ts            textes envoyés au modèle, commandes (pur)
├── types/index.d.ts             contrat de l'état ($.state)
└── tests/mesh-live.test.ts      tests (faux coordinateur sous le plugin)
```

Le validateur impose que `$` ne quitte jamais `register.tsx` : tout ce qui
l'utilise y est déclaré au niveau du module ; les autres fichiers sont purs.

```bash
claude plugin validate mods/mesh-live
claude plugin test mods/mesh-live
```

### Demandes d'autorisation (sessions cloud / mobile)

Chaque sondage appelle 3 outils mesh (`heartbeat_session`, `get_coordination_status`,
`read_messages`). Là où chaque appel MCP demande une autorisation sans proposer
« toujours autoriser » (claude.ai/code sur le web ou le mobile), cela fait une demande
toutes les quelques secondes. Constaté en vrai : la règle
`"permissions": { "allow": ["mcp__mesh", "mcp__Claude_mesh"] }` du `.claude/settings.json`
ne les a pas supprimées dans cette session. Le mod limite donc les dégâts :

- un appel = au plus une demande (le nom du serveur est lu dans la liste des outils,
  sans appel d'essai) ;
- refuser `heartbeat_session` ne déclenche plus de `register_session` ;
- après 2 sondages en échec (refus compris), le sondage s'arrête et la ligne de statut
  affiche `en pause (/mesh pour reprendre)`.

Tant que ces autorisations ne peuvent pas être données une fois pour toutes, active
plutôt `mesh-live` dans un terminal ou l'app desktop, où « toujours autoriser » existe.

Limites connues : le réveil (`$.prompt.submit`) attend que la session soit
inactive ; les mods sont une API en accès anticipé qui peut changer d'une version
de Claude Code à l'autre (écrit et testé avec la 2.1.288).
