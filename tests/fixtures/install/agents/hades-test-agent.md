---
name: hades-test-agent
description: Fixture agent used by the install tests.
tools: Read, Grep, Bash
model: sonnet
---
You are a fixture agent. CLI: node {{HADES_HOME}}/bin/hades.mjs
Vault: {{HADES_VAULT}}
Unknown placeholders stay: {{NOT_A_VAR}}
