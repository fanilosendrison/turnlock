## Inherited decisions:
- Revue strictement en lecture seule ; aucun fichier modifié.
- Le CDD-S Turnlock et les STD Turnlock sont les référentiels amont.
- `pi-subagents` 0.35.1 reste incompatible tant qu’un nouveau contrat et une implémentation réelle ne le remplacent pas.

## Diagnosis:
Le document a de bons objectifs, mais ses contrats fondamentaux ne sont pas encore assez cohérents pour être implémentés sans invention.

## Drift / contradiction check:
1. 🔴 **Contrat public incompatible avec les standards Turnlock** — *décisionnel*  
   Le document redéfinit `ArtifactTargetRefV1`, `ArtifactCommitmentV2` et les digests comme des strings/JSON canoniques (`proto…md:99-106, 155-164, 378-379, 705-727`), alors que les standards imposent des références portables, `contentDigest: "sha256:…"`, et `PayloadDigestV1` RFC8785 domain-separated (`std-turnlock-artifact-reference-and-integrity.md:67-126`; `std-turnlock-canonical-json-and-digest.md:29-91`).  
   La table « Exact match » est donc fausse (`proto…md:1138-1146`) : le CDD-S exige notamment `PayloadDigestV1`, un état `paused`, et `capabilities(): Promise<…>` (`cdd-s-pi-subagents-execution.md:215-359`).

2. 🔴 **FSM durable incapable de prouver l’unicité ni l’arrêt** — *décisionnel*  
   Après `dispatch-intent`, le processus est spawn avant la persistance du PID (`proto…md:438-446`). Un crash dans cette fenêtre permet un replay qui peut créer un second groupe.  
   De même, `stopLaunch` marque inconditionnellement l’exécution arrêtée après les signaux (`:561-575`) sans preuve d’arrêt du process tree, ni état durable `stopping/orphaned`.  
   Le lock est aussi unsafe : lecture du lock stale puis `unlinkSync(lockPath)` sans opération atomique liée à l’identité observée (`:781-813`). `bootId + PID` ne résout pas une réutilisation de PID dans le même boot (`:1119-1122`), contrairement au STD qui exige identité de démarrage et endpoint de liveness signé (`std-turnlock-delegation-execution-environment.md:74-92`).

3. 🔴 **Résultats, réconciliation et rétention non fermés** — *décisionnel*  
   Le format de résultat ne définit ni enveloppe corrélée au job/launch, ni validation par `resultContractDigest`, ni règle complète d’agrégation de l’état terminal (`proto…md:517-531`). Un résultat oversized ou binaire devient `failed` sans fichier valide, alors que tout job terminal doit ensuite fournir un `resultCommitment`.  
   La réconciliation ambiguë « laisse le caller décider » sans réponse typée permettant la quarantaine (`:687-699`), en conflit avec le CDD-S qui impose la quarantaine (`cdd-s…md:611`).  
   La rétention supprime les fichiers avant le receipt/registre durable (`proto…md:603-616`) : un SIGKILL casse l’idempotence. Elle supprime aussi immédiatement les résultats alors que le CDD-S exige acknowledgement **et** retention floor (`cdd-s…md:350-359`).

4. 🔴 **Plan d’exécution non reproductible et frontière sessionless incomplète** — *décisionnel*  
   L’API ne reçoit ni `cwd`, ni scope, ni snapshot immuable de profil/outils/permissions/extensions. Pourtant elle doit résoudre les agents en interne (`proto…md:853-865`). La source actuelle lit des configurations vivantes selon `cwd` et scope (`src/agents/agents.ts:1437-1488`), donc une reprise peut exécuter un autre agent.  
   La réutilisation annoncée de `buildAsyncRunnerSteps` dépend actuellement d’un `ExtensionAPI` et d’une session (`src/runs/background/async-execution.ts:105-140`), incompatibles avec la promesse sessionless.

## Recommendation:
**Veto : retour en drafting, sans micro-corrections.**

Avant toute implémentation, factoriser et décider :
1. le propriétaire du protocole v2 cross-boundary (STD dédié ou évolution explicite du CDD-I/CDD-S ; pas un futur DC présenté comme actif) ;
2. un protocole de spawn/recovery qui traite toute fenêtre inconnue comme quarantaine ou l’empêche mécaniquement ;
3. une enveloppe terminale write-once pour tous les outcomes et une transaction de rétention crash-safe ;
4. un `ResolvedExecutionPlan` immuable, incluant bindings, profils, budgets et identité d’exécutable.

## Risks:
- La politique locale `TurnlockResourcePolicy` introduit des limites absentes du STD, hardcode `[1,4]`, n’applique pas `maxConcurrentLaunches`, et mentionne un `resourcePolicyDigest` non persisté (`proto…md:418, 975-987`; `std-turnlock-delegation-resource-policy.md:20-32, 136-138, 168-172`).
- `capabilities()` promet zéro I/O mais propose `git rev-parse HEAD` à l’exécution (`proto…md:355-361`).
- Faux positifs à éviter : l’absence actuelle de l’export `pi-subagents/turnlock` (`package.json:8-12`) et le caractère privé de `spawnRunner` ne sont pas, seuls, des défauts du **futur** design. Le défaut est l’absence de frontière de remplacement déterministe.

## Need from main agent:
Décider où vit le protocole v2 autoritaire et quel modèle de récupération est acceptable pour une fenêtre de spawn inconnue.

## Suggested execution prompt:
Aucun handoff d’implémentation n’est justifié avant ces décisions.