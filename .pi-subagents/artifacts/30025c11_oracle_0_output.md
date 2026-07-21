Inherited decisions:
- D-01: protocole versionné d’abord.
- D-02: option A.
- D-03: option A.
- D-04: option A.

Diagnosis:
- L’orientation est bonne, mais D-02 et D-04 restent insuffisamment fermés.

Drift / contradiction check:
- 🔴 **D-02 self-attestation:** l’absence de `launcher-identity.json` ne prouve pas qu’aucun enfant n’existe : il peut être spawné mais ne pas encore avoir écrit le fichier. Un retry immédiat peut donc créer deux launchers.
- 🔴 **D-02 stale lock:** `stat(inode) → unlink` reste TOCTOU ; le fichier peut être remplacé après `stat` et avant `unlink`. L’inode ne rend pas `unlink` conditionnel.
- 🔴 **D-02 stop:** `kill(pid, 0)` ne prouve ni l’identité du process ni l’arrêt de ses descendants ; un zombie peut aussi exister. Le stop doit couvrir un groupe supervisé et une réconciliation durable.
- 🔴 **D-03 envelope:** l’envelope proposée manque `callerLaunchKey`, `jobId`, `requestDigest`/generation, `executorSpecDigest` et version. Sans eux, un JSON valide au mauvais target peut être accepté.
- 🔴 **D-03 retention:** l’intent aide la reprise, mais la suppression doit attendre `earliestCleanupAtEpochMs`; sinon elle viole la retention floor. Il faut aussi un état par artifact pour les suppressions partielles.
- 🔴 **D-04 snapshots:** `agentConfigDigest` + `resolvedAgentConfigs` en mémoire ne permettent pas une reprise. Le snapshot sérialisé, validé et engagé doit être durablement référencé par le plan.
- 🔴 **D-04 policy:** la liste proposée ne correspond pas à `DelegationResourcePolicyV1`. Les champs lock/stale/retention floor/max concurrent launches n’y existent pas. Il faut soit étendre le STD, soit définir une dérivation exacte depuis ses champs ; ne pas créer un sous-contrat implicite.
- 🟡 **D-04:** `cwd: string` persistant est un chemin absolu interdit comme identité portable ; persister une référence/binding de workspace, pas le chemin hôte.
- 🟡 **D-04:** `resolvedModel` peut contredire le CDD-S, qui exclut les fallback models effectivement observés des commitments. Engager le sélecteur et la politique de fallback, pas le résultat runtime.

Recommendation:
- Conserver D-01=B, D-03=A et D-04=A.
- Conserver D-02=A, mais remplacer l’identité-file seule par un protocole de **claim fencing** :
  1. parent persiste un `spawn-intent` avec génération et nonce ;
  2. enfant réclame atomiquement cette génération sous coordination durable avant toute exécution ;
  3. toute reprise fence les générations précédentes ; un enfant tardif ne peut pas exécuter.
- Ne pas accepter le stale-lock break par inode. Utiliser une primitive de verrouillage qui ne requiert pas un `unlink` stale non conditionnel, ou faire échouer fermé et escalader.
- Déplacer la suppression physique dans un collecteur explicite après la retention floor.

Risks:
- Les standards imposent identité de process, endpoint de liveness signé et no-follow/post-open verification : `specs/standards/std-turnlock-delegation-execution-environment.md:74–92`, `std-turnlock-artifact-reference-and-integrity.md:200–220`.
- Les envelopes doivent respecter les digests/commitments des standards et les exigences de corrélation du CDD-S : `cdd-s-pi-subagents-execution.md:350–359, 539–544`.
- La policy doit rester le contrat complet du STD : `std-turnlock-delegation-resource-policy.md:20–32, 136–172`.

Need from main agent:
- Aucune décision supplémentaire avant d’intégrer les corrections ci-dessus.

Suggested execution prompt:
- Aucun handoff d’implémentation recommandé tant que le protocole de claim fencing et le mapping de resource policy ne sont pas figés.