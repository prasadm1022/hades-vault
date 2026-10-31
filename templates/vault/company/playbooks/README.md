# Learned technology playbooks

One file per technology the engine has no playbook for: `tech/<tech>.md` (kebab-case), written by
the learning loop following `{{ENGINE}}/playbooks/learn-technology.md`; its detection fingerprint
goes into `stacks.json` here (same schema as `{{ENGINE}}/playbooks/stacks.json`, merged over it by
`hades detect`). Roles read them by path when the engine's `playbooks/tech/` has nothing for a stack.

Sections: detection, install, build/lint/types/test/run commands, deploy, pitfalls, sources
(URLs, versions, date checked). No client names or secrets, so a playbook can be contributed upstream.
