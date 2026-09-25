# Récapitulatif ordonné du MCP

## 1. Objectif

Construire un MCP permettant à **deux comptes Claude différents** de :

- se découvrir ;
- s’envoyer des messages ;
- se répartir des tâches ;
- suivre l’état des tâches ;
- recevoir des notifications ;
- savoir si l’autre compte est actif, bloqué ou hors ligne ;
- détecter lorsqu’un compte atteint sa limite de 5 heures ou hebdomadaire ;
- reprendre ou redistribuer le travail lorsqu’un compte est bloqué.

Le système ne dépendra pas de `ListAgents`, `SendMessage` ou des Agent Teams natifs, car ces fonctions sont surtout prévues pour les sessions d’un même compte ou d’un même environnement Claude Code.

---

## 2. Architecture générale

```text
Compte Claude A
        │
        │ MCP sécurisé
        ▼
Serveur MCP Coordinator
        │
        │ Supabase
        ▼
Base de données partagée
        │
        │ Supabase Realtime
        ▲
        │
        │ MCP sécurisé
Compte Claude B
```

Supabase servira de **mémoire et de bureau de coordination partagé**.

Le MCP sera l’interface visible par Claude. Supabase conservera les données importantes même si une session ou un conteneur s’arrête.

---

## 3. Les trois parties principales

### A. Le MCP Coordinator

C’est le serveur que chaque compte Claude ajoutera comme serveur MCP.

Il fournira notamment ces outils :

```text
register_session()
heartbeat()
list_agents()
get_agent_status()

create_task()
list_tasks()
claim_task()
update_task()
complete_task()
release_task()

send_message()
read_messages()
ack_message()

get_quota_status()
get_coordination_status()
```

### B. Supabase

Supabase hébergera :

- PostgreSQL ;
- Supabase Auth ;
- les règles de sécurité RLS ;
- les Edge Functions ;
- éventuellement Supabase Realtime.

Le serveur MCP sera déployé dans une Edge Function :

```text
https://<project>.supabase.co/functions/v1/claude-coordinator/mcp
```

### C. Le plugin Claude Code

Le plugin servira à installer facilement :

- le MCP Coordinator ;
- les instructions de coordination ;
- les hooks ;
- les scripts de surveillance du quota ;
- éventuellement un Channel MCP pour les notifications temps réel.

Le plugin n’est pas le système de communication lui-même. Il sert à empaqueter et distribuer les composants.

---

## 4. Identité des deux comptes

Chaque compte Claude aura une identité indépendante :

```text
Compte Claude A
  account_id: account-a
  session_id: session-a

Compte Claude B
  account_id: account-b
  session_id: session-b
```

Les deux comptes utiliseront des identifiants ou tokens différents.

Ils pourront cependant appartenir au même espace de collaboration :

```text
workspace: mon-projet
```

Ainsi, le serveur saura :

- qui envoie un message ;
- qui reçoit le message ;
- qui possède une tâche ;
- quelles actions chaque compte a le droit d’effectuer.

---

## 5. Tables Supabase

La base contiendra principalement les tables suivantes.

### `agents`

Représente les comptes et sessions Claude.

```text
id
account_id
session_id
name
status
capabilities
last_heartbeat_at
created_at
```

États possibles :

```text
available
working
blocked_by_quota
waiting_for_reset
needs_attention
offline
```

### `tasks`

Contient les tâches distribuées entre les comptes.

```text
id
title
description
status
priority
created_by
assigned_to
lease_until
result
created_at
completed_at
```

États :

```text
pending
claimed
in_progress
completed
failed
cancelled
```

### `messages`

Contient les messages entre agents.

```text
id
sender_agent_id
recipient_agent_id
task_id
message_type
body
status
correlation_id
created_at
delivered_at
acknowledged_at
```

États :

```text
pending
delivered
acknowledged
failed
```

### `quota_events`

Contient les événements liés aux limites Claude Code.

```text
id
agent_id
event_type
quota_window
used_percentage
resets_at
error_type
error_details
created_at
```

Types d’événements :

```text
quota_warning
quota_blocked
quota_reset
quota_auto_resumed
quota_resume_disabled
```

### `events`

Journal global permettant de conserver l’historique :

```text
session_registered
task_created
task_claimed
task_completed
message_sent
message_acknowledged
quota_blocked
quota_reset
```

---

## 6. Répartition des tâches

### Création

Le compte A crée une tâche :

```text
Compte A → create_task(
  title="Analyser le système d'authentification"
)
```

La tâche devient :

```text
status = pending
```

### Réservation

Le compte B consulte les tâches :

```text
Compte B → list_tasks()
```

Puis il en réserve une :

```text
Compte B → claim_task(task_id)
```

La réservation est temporaire. Elle utilise un **lease**.

Exemple :

```text
lease_until = dans 60 secondes
```

Le compte B envoie régulièrement :

```text
heartbeat(task_id)
```

Si B disparaît, le lease expire et la tâche peut être reprise par A.

Cela évite que deux agents travaillent simultanément sur la même tâche.

### Fin

Le compte B termine :

```text
Compte B → complete_task(
  task_id,
  result,
  artifacts
)
```

Le serveur :

1. marque la tâche comme terminée ;
2. conserve le résultat ;
3. écrit un événement ;
4. débloque les tâches dépendantes ;
5. informe le compte A.

---

## 7. Communication entre les comptes

### Envoi

```text
Compte A → send_message(
  to="account-b",
  task_id="...",
  text="La migration est prête à être testée."
)
```

Le message est enregistré dans Supabase avant toute notification.

### Réception

Le compte B peut appeler :

```text
read_messages()
```

Puis confirmer :

```text
ack_message(message_id)
```

La base reste la source de vérité. Même si B est momentanément hors ligne, le message ne disparaît pas.

### Notifications temps réel

Dans une première version :

```text
Compte B appelle read_messages()
```

Dans une version plus avancée :

```text
Supabase Realtime
        │
        ▼
Channel MCP
        │
        ▼
Compte Claude B
```

Supabase Realtime pourra signaler instantanément un nouveau message, mais le message sera toujours conservé dans PostgreSQL.

---

## 8. Détection des limites Claude Code

La détection sera faite avec trois mécanismes complémentaires.

### A. Détection préventive avec `statusLine`

Claude Code peut fournir :

```json
{
  "rate_limits": {
    "five_hour": {
      "used_percentage": 95,
      "resets_at": 1790362800
    },
    "seven_day": {
      "used_percentage": 82,
      "resets_at": 1790611200
    }
  }
}
```

Cela permet de prévenir l’autre compte :

```text
« Le compte A a utilisé 95 % de sa limite de 5 heures. »
```

### B. Détection du blocage avec `StopFailure`

Lorsque Claude Code ne peut plus répondre à cause d’une limite API, le hook `StopFailure` est exécuté.

Il reçoit notamment :

```json
{
  "error": "...",
  "error_details": "...",
  "last_assistant_message": "..."
}
```

Le hook enregistre :

```text
agent A
status = blocked_by_quota
quota_window = five_hour ou seven_day
resets_at = date connue si disponible
```

Puis il envoie un message au compte B :

```text
« Le compte A est bloqué par sa limite.
Tu peux reprendre ses tâches urgentes. »
```

### C. Détection du retour avec les notifications de quota

Le hook `Notification` peut recevoir :

```text
quota_auto_resume_fired
quota_auto_resume_stale
quota_auto_resume_disabled
```

Cela permet de détecter :

- la reprise automatique après reset ;
- un reset qui a eu lieu pendant le sommeil du processus ;
- l’absence de reprise automatique.

Message envoyé à l’autre compte :

```text
« Le compte A est de nouveau disponible. »
```

---

## 9. Gestion de la limite de 5 heures et de la limite hebdomadaire

### Limite de 5 heures

Le compte peut parfois attendre automatiquement le reset si la session est interactive.

Le système pourra donc :

```text
1. détecter le blocage ;
2. enregistrer l’heure du reset ;
3. informer l’autre compte ;
4. attendre la notification de reset ;
5. marquer l’agent comme disponible ;
6. reprendre les tâches.
```

### Limite hebdomadaire

La limite hebdomadaire peut être éloignée de plusieurs jours. Claude Code ne restera pas nécessairement en attente automatiquement dans tous les modes.

Il faudra donc conserver dans Supabase :

```text
blocked_by_quota = true
quota_window = seven_day
resets_at = date future
```

L’autre agent pourra alors reprendre le travail sans attendre.

Un mécanisme externe pourra vérifier le moment du reset et envoyer une notification, mais il faudra que la session Claude soit encore active pour reprendre automatiquement une tâche.

---

## 10. Sécurité

Chaque compte devra avoir :

- son propre token ;
- son propre identifiant ;
- des droits limités ;
- une authentification vérifiée par le MCP.

Supabase RLS empêchera un compte de lire ou modifier ce qu’il ne devrait pas voir.

Il faudra notamment empêcher :

- le compte A de se faire passer pour B ;
- un agent de terminer une tâche qu’il ne possède pas ;
- un message d’être envoyé à un espace interdit ;
- un webhook externe d’injecter directement des instructions ;
- l’utilisation d’une clé `service_role` dans le client Claude.

---

## 11. Structure du dépôt GitHub

Le futur dépôt pourrait être :

```text
claude-cross-account-mcp/
├── README.md
├── package.json
├── .env.example
├── .claude-plugin/
│   └── plugin.json
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   │   ├── 001_initial_schema.sql
│   │   ├── 002_rls_policies.sql
│   │   └── 003_quota_events.sql
│   └── functions/
│       └── claude-coordinator/
│           ├── index.ts
│           ├── auth.ts
│           ├── agents.ts
│           ├── tasks.ts
│           ├── messages.ts
│           └── quotas.ts
├── hooks/
│   ├── stop-failure.sh
│   ├── quota-notification.sh
│   └── session-start.sh
├── skills/
│   └── coordination/
│       └── SKILL.md
├── tests/
│   ├── agents.test.ts
│   ├── tasks.test.ts
│   ├── messages.test.ts
│   └── quotas.test.ts
└── docs/
    └── architecture.md
```

---

## 12. Ordre de construction recommandé

### Phase 1 — Base Supabase

Créer :

1. le projet Supabase ;
2. les tables ;
3. les migrations ;
4. les politiques RLS ;
5. les deux identités de test.

### Phase 2 — MCP minimal

Créer uniquement :

```text
register_session
list_agents
send_message
read_messages
ack_message
```

Objectif :

```text
Compte A → message → Compte B
Compte B → réponse → Compte A
```

### Phase 3 — Tâches

Ajouter :

```text
create_task
list_tasks
claim_task
heartbeat
complete_task
release_task
```

Objectif :

```text
Compte A crée une tâche
Compte B la récupère
Compte B la termine
Compte A reçoit le résultat
```

### Phase 4 — Quotas

Ajouter :

```text
statusLine
StopFailure
Notification quota_auto_resume_*
quota_events
```

Objectif :

```text
Compte A atteint sa limite
Compte B est prévenu
Compte B reprend le travail
Compte A redevient disponible après reset
```

### Phase 5 — Temps réel

Ajouter :

```text
Supabase Realtime
Channel MCP
```

Objectif :

```text
Un message arrive sans attendre le prochain appel manuel de read_messages()
```

### Phase 6 — Plugin et documentation

Empaqueter :

- le MCP ;
- les hooks ;
- les skills ;
- les instructions ;
- les fichiers de configuration ;
- la procédure d’installation pour chaque compte.

---

## 13. Ce que nous avons déjà vérifié

- **GitHub** est connecté et disponible.
- **Supabase** est connecté.
- L’organisation Supabase visible est `Claude`.
- Aucun projet Supabase n’existe actuellement dans cette organisation.
- Aucune table ou donnée n’a donc été créée.
- Aucun dépôt GitHub n’a encore été créé.

## Architecture finale retenue

```text
Deux comptes Claude indépendants
              │
              ▼
      MCP Coordinator HTTP
              │
              ▼
     Supabase Edge Function
              │
      ┌───────┼────────┐
      ▼       ▼        ▼
 PostgreSQL  Auth   Realtime
      │
      ├── agents
      ├── tasks
      ├── messages
      ├── quota_events
      └── events
```

En résumé :

> **Supabase conserve l’état, le MCP expose les commandes, les hooks détectent les événements Claude Code, et Realtime/Channels transmettent les notifications.**

La première version devra rester simple : **messages, tâches, leases, heartbeats et détection des quotas**.
