Le MCP actuel est un coordinateur entre plusieurs sessions Claude Code, relié à Supabase. Il permet à deux agents Claude, potentiellement liés à deux comptes Claude différents, de partager un workspace et de collaborer.

Fonctionnalités disponibles actuellement

1. Gestion des workspaces

Le MCP peut :

créer un workspace partagé ;

ajouter un utilisateur comme membre ;

lister les membres d’un workspace.


Fonctions :

create_workspace()  
add_workspace_member()  
list_workspace_members()

Actuellement, l’ajout d’un membre demande encore son UUID Supabase.

2. Enregistrement des sessions Claude

Chaque session Claude Code peut s’enregistrer comme un agent.

Fonctions :

register_session()  
list_agents()  
get_agent_status()  
heartbeat_session()

Cela permet de :

créer automatiquement un agent ;

associer l’agent à un workspace ;

enregistrer son nom de session ;

déclarer ses capacités ;

suivre son statut ;

actualiser sa présence ;

détecter les agents disponibles ou hors ligne.


Les statuts prévus sont :

available  
working  
blocked_by_quota  
waiting_for_reset  
needs_attention  
offline

L’UUID de l’agent est généré automatiquement par la base.

3. Communication entre agents

Les agents peuvent s’envoyer des messages persistants.

Fonctions :

send_message()  
read_messages()  
ack_message()

Le système permet :

d’envoyer un message à un agent précis ;

d’associer le message à une tâche ;

de définir un type de message ;

de stocker un contenu JSON ;

de suivre son statut ;

d’accuser réception du message.


Les statuts de message sont :

pending  
delivered  
acknowledged  
failed

Les messages sont stockés dans Supabase et ne sont donc pas perdus si une session Claude est interrompue.

4. Gestion de tâches partagées

Le MCP contient une file de tâches collaborative.

Fonctions :

create_task()  
list_tasks()  
update_task()  
claim_task()  
heartbeat_task()  
release_task()  
complete_task()

Les agents peuvent :

créer une tâche ;

lui donner un titre et une description ;

définir une priorité ;

consulter les tâches ;

réserver une tâche ;

obtenir un lease temporaire ;

prolonger ce lease ;

libérer une tâche ;

terminer une tâche ;

enregistrer un résultat JSON.


Les statuts de tâche sont :

pending  
claimed  
in_progress  
completed  
failed  
cancelled

Le mécanisme de lease doit permettre à un autre agent de reprendre une tâche lorsqu’un agent disparaît ou ne renouvelle plus son lease.

5. Suivi des quotas Claude

Le système prévoit l’enregistrement des événements de quota Claude Code.

Fonctions :

report_quota_event()  
get_quota_state()

Les événements pris en charge sont :

quota_warning  
quota_blocked  
quota_reset  
quota_auto_resumed  
quota_resume_disabled

Le système peut mémoriser :

la fenêtre concernée ;

le pourcentage utilisé ;

la date de réinitialisation ;

le type d’erreur ;

les détails de l’événement.


Les fenêtres de quota prévues sont :

five_hour  
seven_day  
spend_limit

Lorsqu’un agent atteint une limite, son statut peut passer automatiquement à :

blocked_by_quota

Puis revenir à :

available

après une réinitialisation ou une reprise automatique.

6. Vue globale de coordination

Le MCP expose également une vue synthétique d’un workspace :

get_coordination_status()

Cette fonction regroupe :

les agents présents ;

leurs statuts ;

les tâches actives ;

les leases ;

les événements de quota ;

les derniers messages.


Elle est destinée à permettre à un agent de comprendre rapidement l’état général de la collaboration.

Fonctionnalités du plugin autour du MCP

Le plugin Claude Code ajoute plusieurs mécanismes automatiques.

Hooks de session

Les hooks sont prévus pour écouter :

SessionStart  
StopFailure  
Notification  
SessionEnd

Ils peuvent :

enregistrer automatiquement une session ;

signaler un blocage de quota ;

signaler une reprise après quota ;

signaler la fin d’une session ;

mettre à jour le statut de l’agent.


StatusLine

Le plugin peut afficher une ligne comme :

quota 5h 95% reset 19:00Z | 7d 82% reset 16:00Z

À partir d’un certain seuil, il peut envoyer automatiquement un événement quota_warning.

Notifications Realtime

Le plugin contient un canal Realtime qui doit notifier la session lorsqu’il y a :

un nouveau message ;

une modification de statut d’un agent ;

un événement de quota ;

une modification de tâche.


Cette fonctionnalité dépend toutefois du démarrage correct du channel dans Claude Code Cloud et doit être considérée comme optionnelle pour le moment.

Sécurité actuelle

Le système utilise :

Supabase Auth  
JWT Bearer  
PostgreSQL RLS

Le serveur ne devrait pas faire confiance à un user_id fourni librement par Claude. Il déduit l’utilisateur depuis le JWT.

Les opérations sensibles vérifient notamment :

que l’agent appartient bien à l’utilisateur authentifié ;

que l’agent appartient au workspace concerné ;

que l’utilisateur est membre du workspace ;

que l’agent possède la tâche avant de la terminer ou de renouveler son lease.


La clé service_role ne doit pas être utilisée dans le plugin.

Ce qui fonctionne déjà

Le backend possède actuellement :

les tables Supabase ;

les migrations principales ;

l’Edge Function MCP ;

les opérations de messages ;

les opérations de tâches ;

le suivi des agents ;

le suivi des quotas ;

le Realtime ;

les hooks ;

le status line ;

le canal de notifications ;

le contrôle JWT/RLS.


Ce qui n’est pas encore suffisamment simple ou finalisé

Le MCP ne fournit pas encore automatiquement :

la création des utilisateurs Supabase ;

l’invitation par simple adresse e-mail ;

la découverte automatique du workspace ;

la récupération automatique du contexte après une nouvelle session Cloud ;

le renouvellement robuste des tokens ;

l’enregistrement fiable après disparition du conteneur cloud ;

la configuration automatique du MCP HTTP distant dans Claude Web.


Aujourd’hui, il faut encore fournir ou gérer manuellement :

JWT Supabase  
clé publique Supabase  
workspace UUID  
identité du second utilisateur

L’objectif de la prochaine version est de réduire tout cela à :

Connexion de l’utilisateur  
        +  
Invitation par e-mail  
        +  
Création automatique de la session et de l’agent

Le MCP est donc déjà fonctionnel comme infrastructure de coordination, mais son onboarding et son intégration Claude Code Cloud doivent encore être simplifiés.
