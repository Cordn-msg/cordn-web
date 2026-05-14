# Why Cordn

## The problem

Messaging Layer Security (MLS) gives strong group security properties, but deploying an MLS system in practice usually requires more than the cryptography itself. Real deployments often need a Delivery Service or coordinator that can provide message ordering, fetch semantics, and delivery for proposals, commits, welcomes, and application messages. In many systems, that coordinator ends up looking like a conventional Internet service: publicly exposed, operationally heavier, and often tied to additional authentication infrastructure.

That creates a tension.

On one side, MLS benefits from a coordinator with clear delivery semantics. On the other side, traditional coordinator deployment is cumbersome and often pushes systems toward centralized infrastructure, static public exposure, and extra trust assumptions.

Cordn exists to resolve that tension with a different set of tradeoffs.

## What Cordn is

[`Cordn`](../README.md) is a coordinator-assisted MLS protocol profile that uses [`ContextVM`](../../docs/cvm/quick-overview.md) as its deployment and transport layer.

It keeps the part MLS actually needs:

- an ordered coordinator model for group delivery,
- client-side MLS validation and state management,
- and a clear interface for KeyPackages, Welcomes, and group messages.

But it changes the deployment model:

- coordinators do not need conventional public HTTP exposure,
- they can run behind NATs and firewalls,
- they can be self-hosted from ordinary devices,
- and they can remain reachable through ContextVM's relay-based transport.

Cordn is therefore not an attempt to remove coordination from MLS. It is an attempt to make MLS coordination easier to deploy, harder to suppress, and less dependent on traditional infrastructure.

## Why not just use a conventional MLS Delivery Service?

Conventional MLS deployments are valid and often simpler to reason about operationally, but they come with costs:

- public service exposure,
- domains, TLS termination, or equivalent infrastructure,
- harder self-hosting for ordinary users,
- and, in many deployments, separate authentication or identity services.

Cordn keeps the coordinator role but relocates it into a more sovereign deployment model through [`ContextVM`](../../docs/cvm/quick-overview.md). This makes it practical for users to run their own coordinator from home, behind a firewall, or even from more temporary environments without giving up MLS-style coordination.

## Why not just run MLS directly over public relays?

That path is attractive because it seems more decentralized, but it comes with a serious cost: MLS is not coordination-free. Group state progression depends on members converging on one ordered history of commits and epochs.

Weakly ordered public dissemination makes that much harder. Competing commits, stale views, partial visibility, and recovery ambiguity can all become more common when the transport layer does not provide a strong enough coordination point.

Cordn deliberately avoids that mistake.

It keeps a single active coordinator per group and preserves strong per-group message ordering through monotonic group-scoped cursors, as defined in [`cordn/spec/00.md`](../spec/00.md). This is one of the central Cordn tradeoffs: preserve the coordination discipline MLS needs, but make the coordinator easier to deploy and move.

## Why ContextVM matters

[`ContextVM`](../../docs/cvm/quick-overview.md) is a general-purpose protocol for exposing services through Nostr relays without requiring direct public server exposure. That matters for Cordn in several ways.

### Easier deployment

Cordn coordinators can be run from ordinary environments:

- home networks,
- laptops,
- small servers,
- or temporary/ephemeral deployments.

This lowers the operational barrier to running private communication infrastructure.

### Censorship resistance and portability

Because the coordinator is reached through ContextVM rather than classic public service exposure, it is easier to move, rehost, or operate from constrained networks. This gives Cordn a stronger sovereign-hosting story than a traditional publicly exposed DS.

### Better privacy posture than protocol-specific public traffic

Cordn traffic is carried inside a broader encrypted ContextVM transport environment rather than being directly exposed as a highly legible protocol-specific public message stream. This does not make Cordn magically metadata-invisible, but it does make protocol activity less isolated and less directly distinguishable than designs that publish their messaging artifacts more openly.

## The identity model

Cordn takes inspiration from Marmot's simpler identity approach while remaining more conservative about transport coordination.

In [`cordn/spec/00.md`](../spec/00.md), Cordn uses MLS `BasicCredential` tied to a stable Nostr public key identity for KeyPackage publication and retrieval. The identity binding is strengthened through signed publication payloads that clients verify independently.

This has several advantages:

- it avoids requiring a separate authentication service,
- it keeps identity ownership verifiable,
- and it reduces the coordinator's role as a trust anchor.

Just as importantly, Cordn does **not** require the same kind of stable transport identity for every operation.

The coordinator needs authenticated stable identity mainly for operations where impersonation would be dangerous, such as:

- publishing KeyPackages,
- and deleting owned KeyPackages.

Once a user is already in a group, MLS authentication becomes the primary security mechanism for group messages and group state transitions. In practice, this means ordinary group message posting can use ephemeral transport keys, limiting unnecessary identity exposure to the coordinator.

## The privacy tradeoff

Cordn does not claim perfect metadata privacy. Instead, it tries to choose a better balance between privacy, deployability, and strong MLS guarantees.

### What the coordinator can see

A coordinator can observe the traffic it handles for a given group. It can see that a group is active and can learn timing and volume patterns for that group's traffic.

However:

- group identifiers are not public network-wide artifacts in the same way they would be in a more openly disseminated protocol,
- the coordinator does not get plaintext message content,
- and ordinary group message posting does not have to reveal stable participant identities because ephemeral transport keys can be used.

This means a public coordinator gives up some privacy, but not the core encryption guarantees.

### Public coordinators are still useful

Public coordinators make the system easier to use:

- users can join without running their own infrastructure,
- operators can offer reliable hosted coordinators,
- and sustainable business models become possible through monetized coordinator operation.

Using a public coordinator is therefore a reasonable tradeoff for many users: good privacy, strong content protection, easy deployment, and no need to self-host.

### Self-hosting strengthens the privacy story

If a group has higher privacy requirements, Cordn's self-hosting model becomes especially compelling.

Because coordinators are easy to deploy through [`ContextVM`](../../docs/cvm/quick-overview.md), users can:

- run a personal coordinator from home,
- operate a private coordinator for a small social circle,
- or even spin up a temporary coordinator for one session and discard it afterwards.

That flexibility is one of Cordn's strongest properties. It allows the privacy/sovereignty profile to be adjusted to the group's needs instead of forcing one operating model on everyone.

## The ordering tradeoff

Cordn is intentionally **not** designed around simultaneous multi-coordinator operation for one group.

That is a feature, not a missing ambition.

MLS benefits from clear ordering and a strong coordination point. Introducing multiple active coordinators would weaken those guarantees and make same-epoch ambiguity more likely. Cordn therefore chooses a simpler rule:

- one active coordinator per group,
- monotonic per-group cursors for ordered fetch progression,
- and migration as an explicit handoff rather than concurrent multi-writer coordination.

This keeps the design compatible with MLS's stronger ordering needs while still preserving portability. Because ordering is group-scoped rather than global, group history is easier to migrate cleanly to another coordinator when needed.

## What Cordn optimizes for

Cordn optimizes for a very specific combination of goals:

- **Strong group security** through MLS.
- **Simple, sovereign identity** through Nostr-style key-based authentication rather than external account systems.
- **Firewall-tolerant coordinator deployment** through [`ContextVM`](../../docs/cvm/quick-overview.md).
- **Clear ordering semantics** through a single active coordinator and per-group cursors.
- **Flexible privacy tradeoffs** ranging from public hosted coordinators to fully self-hosted or even ephemeral coordinators.
- **Censorship resistance and portability** without discarding the coordinator model MLS needs.

## Strengths

- **MLS without public infrastructure pain**: Cordn makes coordinator deployment much easier than a traditional public DS model.
- **Strong ordering where it matters**: the protocol keeps a real coordination point instead of hoping weak public transport will be good enough.
- **Cleaner auth model**: no separate identity provider is required for the baseline design.
- **Better privacy than fully public protocol dissemination**: coordinator-visible traffic exists, but traffic is not exposed as openly legible public protocol artifacts.
- **Flexible operating model**: users can choose between public coordinators, private self-hosted coordinators, and temporary session-specific coordinators.
- **Realistic path to sustainability**: public coordinators can exist as paid or hosted services without compromising end-to-end encryption.

## Limitations

- **Coordinators still observe activity**: they can learn that a group is active and see traffic patterns.
- **Availability trust remains**: a coordinator can still delay, drop, or censor delivery.
- **Cordn does not eliminate coordination**: it preserves it and improves its deployment profile.
- **ContextVM introduces its own ecosystem assumptions**: Cordn gains a lot from ContextVM, but also depends on its transport environment and operational model.
- **This is a tradeoff, not magic**: stronger self-hosting and sovereignty are bought by accepting a coordinator-centered design rather than trying to fully dissolve coordination into public relay transport.

## Bottom line

Cordn makes sense because it accepts MLS's real requirements instead of fighting them.

MLS needs coordination. Traditional coordinators are often too exposed, too heavy, and too dependent on extra infrastructure. Pure weakly ordered relay transport makes convergence harder than it first appears. Cordn takes a different path:

- keep the coordinator,
- keep strong ordering,
- simplify identity,
- use [`ContextVM`](../../docs/cvm/quick-overview.md) to make deployment sovereign and firewall-tolerant,
- and let users choose the privacy/convenience point that fits their needs.

For users who want easy hosted operation, Cordn can work with public coordinators while preserving strong encryption guarantees. For users who need stronger sovereignty or privacy, Cordn makes self-hosting and even ephemeral coordinator deployment realistic. That is the core reason Cordn exists.
