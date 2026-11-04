---
name: woodpecker
description: "The owner's security rules for Woodpecker CI pipelines: untrusted repositories, image builds without secrets, the registry login, pinned images, variable escaping. Load before you write or change a Woodpecker pipeline (`.woodpecker/*.yml`, `.woodpecker.yml`) or a CI step that builds or publishes an image."
---

# Woodpecker pipelines

Part of the global rules (`AGENTS.md`, "Git Flow"); they bind as if written there.

A repository stays untrusted. Never add `volumes`, `privileged` or a Docker socket mount to a step,
and never mark a repository trusted to make one work: that gives every pull request that edits the
pipeline root on the agent host, which holds other projects and their keys. An image is built by
kaniko with `--no-push` and no secret, because the Dockerfile's `RUN` lines run in that container; a
separate crane step, which runs no repository code, is the only one holding the registry login, and
only on the events that publish. Pin every pipeline image by version and digest. A step that checks
a tag is on `main` catches mistakes; it is not a security boundary. Woodpecker substitutes `${VAR}`
in the whole file before it parses the YAML, so write a variable the shell should expand as
`$${VAR}`.
