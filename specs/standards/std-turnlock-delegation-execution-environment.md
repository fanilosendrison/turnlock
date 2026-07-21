---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "standard"
domain: "turnlock-delegation-execution-environment"
severity: "strict"
name: "Turnlock Delegation Execution Environment Standard"
id: "STD-TURNLOCK-DELEGATION-EXECUTION-ENVIRONMENT"
version: "0.1.0"
---

# Turnlock Delegation Execution Environment Standard

## 1. Scope

Apply this standard to the Turnlock core, Runner processes, resident controller,
delivery bridge, host submission command, Pi adapter, and pi-subagents process
used by delegation attempt execution version 1.

This standard defines the only certified version 1 deployment profile. Treat any
unlisted operating system, architecture, runtime, filesystem, or process
topology as unsupported until a later version adds and tests it.

## 2. Certified platform profile

The initial certified profile is:

| Capability | Required value |
| ---------- | -------------- |
| Operating system | macOS 12.7.6 |
| Kernel family | Darwin 21.6.0 |
| Architecture | x86_64 |
| Writable filesystem | Local APFS |
| Bun | 1.3.12 |
| Node.js | 22.22.2 |
| Git | Apple Git 137.1, reporting 2.37.1 |
| Pi coding agent | 0.80.10 |
| Process topology | Native processes on one host |
| Container requirement | None; containers are unsupported |

Pin exact external integration versions through Dependency Contracts. A newer
patch, minor, or major version is not accepted merely because its package
manager range appears compatible. CI must certify and update the owning
Dependency Contract or this environment profile first.

## 3. Filesystem capabilities

Place the Turnlock run root, Runner root, strategy root, delivery journal, and
each artifact's temporary publication file on local writable APFS storage.

Require startup conformance probes to prove:

- exclusive regular-file creation;
- atomic rename within one filesystem;
- no-follow opening and post-open object identity checks;
- durable file flush and directory-entry flush behavior;
- stable file identity while an opened descriptor is held;
- rejection of devices, sockets, directories, and symbolic links;
- case-sensitivity behavior known to the allocator;
- private file permissions for control artifacts.

Do not span one atomic publication across filesystems. Do not use NFS, SMB,
cloud-synchronized folders, FUSE mounts, removable volumes, or APFS locations
whose durability probes fail.

Treat a case-insensitive APFS volume as supported only when allocation rejects
case-colliding portable paths before publication.

## 4. Process and identity capabilities

Run the core, Runner invocation, resident controller, bridge, submission command,
and Pi endpoint as native processes under one operating-system user.

Require platform probes to return boot identity, a boot-scoped monotonic clock,
PID, and process start identity sufficient to distinguish PID reuse. On the
certified profile:

- obtain boot identity by directly executing `/usr/sbin/sysctl` with argv
  `-n kern.bootsessionuuid`;
- obtain boot-monotonic milliseconds from `node:os.uptime() * 1000`;
- derive process-start identity by directly executing `/bin/ps` with argv
  `-p <pid> -o lstart=` under `LC_ALL=C` and validating its complete output;
- require Node and Bun samples to share one nondecreasing boot epoch within the
  committed `bootMonotonicResolutionMs`;
- reject the environment when any runtime, sysctl, or process probe disagrees.

A permission or API failure that prevents this proof makes automatic lease or
mutex recovery unavailable.

Require each authority-bearing process to bind a private Unix-domain liveness
endpoint under the Runner root and sign fresh probe challenges with an ephemeral
in-memory Ed25519 key. Do not infer process identity from command text, parent
PID, endpoint-file existence, file modification time, or PID alone.

The cooperative security model covers crashes, retries, stale processes,
accidental path misuse, and ordinary races. It does not protect ordinary control
files from a malicious process running as the same user with arbitrary shell
access. Stronger runtime isolation requires a separate future environment
profile.

Configure at least one trusted Ed25519 operator public key for quarantine
abandonment. Commit key IDs and public-key digests in core deployment
configuration. Keep private keys outside Turnlock run roots, Runner roots,
process environments, and provider credential stores; an interactive operator
supplies the detached signature. Runner processes receive no signing capability.

## 5. Runtime and executable identity

Resolve executables from trusted Runner deployment configuration, not from a
core-provided shell string, worker output, ambient current directory, or mutable
`PATH` search after admission.

Commit these identities before starting an attempt:

- Turnlock package and executable identity;
- Runner package and executable identity;
- Pi coding-agent package identity;
- selected pi-subagents Dependency Contract identity;
- canonical JSON dependency contract identity;
- trusted operator public-key registry digest;
- Node.js and Bun versions;
- Git version.

A recovered process must reproduce the same identity commitment. A mismatch
selects a trustworthy configuration rejection when attempt attribution remains
valid; otherwise it requests quarantine.

## 6. Pi and pi-subagents admission

Use only a pi-subagents release and commit for which
`DC-PI-SUBAGENTS` reports a compatible Turnlock integration API. The current
fork baseline `pi-subagents` 0.35.1 at commit
`2842823d421ed01619f6cc58c15dab850cef7eaa` is explicitly not compatible because
it lacks caller-committed launch correlation and non-destructive durable result
retention.

Until a compatible fork release and active Dependency Contract exist, the Pi
strategy capability verdict must be `dependency-unavailable` and no host
continuation or Pi launch may start for an attempt requiring that strategy.

Do not use private module imports, terminal scraping, TUI state, result-file
watcher timing, or random generated run IDs as substitute integration contracts.

## 7. Network and provider profile

Permit no TCP or UDP inbound network listener for Turnlock delegation
coordination. Permit private filesystem-scoped Unix-domain liveness endpoints
and process-local Pi RPC or equivalent local IPC covered by the pi-subagents
Dependency Contract.

An external worker profile may require outbound DNS and TLS connections to its
configured model provider. Require deployment configuration to commit a closed
provider profile containing:

- provider identifier;
- Pi model identifier or selector;
- credential source identity without secret bytes;
- whether an HTTPS proxy is required;
- permitted endpoint identities or the provider's official endpoint policy;
- request timeout bounded by the delegation resource policy.

Reject a worker profile before dispatch when its provider, model, credentials,
DNS, TLS trust, proxy requirement, or endpoint policy cannot be validated.
Offline execution is unsupported for profiles that require a remote provider.
Do not fall back to an uncommitted provider or model.

Provider credentials remain process-local secret inputs. Exclude them from
prompts, commitments, artifacts, logs, diagnostics, and protocol results.

## 8. Working directory and workspace

Bind one logical Git workspace and relative working directory through
[STD-TURNLOCK-WORKSPACE-INPUT-COMMITMENT](std-turnlock-workspace-input-commitment.md).
Treat the absolute workspace location as a runtime binding.

Require all overlapping host and worker jobs to be cooperatively read-only for
committed workspace inputs. Place Runner, Pi, raw output, and temporary roots
outside included workspace roots or inside one committed exclusion.

Use official Git commands for workspace capture. Do not parse Git index or
object formats with project-local code.

## 9. Time sources

Use:

- epoch milliseconds for persisted deadlines and wall-clock diagnostics;
- ISO 8601 UTC for audit presentation;
- `node:os.uptime()` as the certified Darwin boot-monotonic source for
  cross-process lease, mutex, and claim expiry during one boot;
- a process monotonic clock for in-process durations;
- the coordination standard for boot changes and clock anomaly handling.

Compare boot-monotonic values across processes only when `platformBootId`
matches. Never compare them across host reboots. Do not use provider, worker,
Pi lifecycle, or filesystem modification timestamps to override intake,
ownership, or deadline authority.

## 10. Startup preflight

Before core execution or external dispatch, verify the complete environment
profile and persist its semantic digest under
`turnlock:delegation-environment-profile`.

Fail preflight when:

- any exact version differs;
- the platform or architecture differs;
- a required filesystem probe fails;
- a process-identity probe is unavailable;
- executable identity cannot be committed;
- no valid trusted operator public-key registry exists;
- required local IPC cannot be established within policy;
- the selected dependency contract is absent or incompatible;
- a required network/provider profile is invalid.

Do not partially enable an environment. Do not defer failed checks until after
host delivery or external spawn.

## 11. Conformance

Require CI and deployment tests for:

- exact platform and runtime version admission;
- rejection of every unlisted platform;
- APFS atomicity, durability, no-follow, and case-collision behavior;
- PID reuse and reboot identity;
- trusted executable resolution without shell evaluation;
- unavailable and mismatched dependency contracts;
- provider profile closure and secret exclusion;
- local-only RPC topology;
- Runner staging isolation from committed workspace inputs.

## 12. Consumers

The complete delegation-attempt conception corpus consumes this standard. No
CDD or NIB may broaden the supported environment without a versioned standard
change and conformance evidence.
