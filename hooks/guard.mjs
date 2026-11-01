#!/usr/bin/env node
// HADES guard: Claude Code PreToolUse hook enforcing the HADES hard rules in every permission mode.
// Input: hook JSON on stdin. Block: exit 2 + one stderr line. Allow: exit 0, no output.
// Internal errors fail CLOSED (exit 2) when the command or path contains a high-risk keyword (push,
// rm, config, settings, guard, .env, ...) and OPEN (warning, exit 0) otherwise, so a guard bug cannot
// brick ordinary work. Work beyond the complexity/time budget blocks (guard.limit).
// Policy data: hooks/guard-policy.json merged over DEFAULT_POLICY. Docs: hooks/README.md.
// "--format <platform>" (codex, cursor, gemini, copilot, windsurf, cline, opencode) reads and answers
// in that coding agent's documented hook contract instead (adaptInput/adapterOutput; "hades export").
// Zero dependencies. Also importable: evaluate(input) and checkShell(command, opts) for the CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_FILE = fileURLToPath(import.meta.url);
const ENGINE_RAW = path.resolve(path.dirname(SELF_FILE), '..'); // may hold 8.3 short names: use ENGINE_DIR
const WIN = process.platform === 'win32';
const MARK = '\u0001'; // internal: marks a substitution inside a word; never legitimate in input
const SEP = '\u0002'; // internal: separates message parts
const MAX_DEPTH = 8;
const MAX_PARSES = 2000;
const MAX_SCRIPT_BYTES = 262144;
// Work limits. Exceeding one blocks the call (guard.limit) instead of risking a crash or the hook
// timeout, both of which would let the call through.
const MAX_INPUT_CHARS = 4 * 1024 * 1024;
const MAX_TOKENS = 200000;
const MAX_CMDS = 20000;
const MAX_WORK = 60000; // simple-command expansions per check (exponential cmd "if" chains)
const BUDGET_MS = 5000; // wall-clock budget per check; the hook timeout is 10 s
const MAX_GLOB_MATCHES = 20000; // filesystem glob expansion of write/delete/read targets
const MAX_GLOB_DIRS = 400;
const MAX_BRACE = 256;
// Internal errors fail closed for commands or paths containing one of these.
const HIGH_RISK = /push|config|\brm\b|\brd\b|\bdel\b|\berase\b|remove-item|\bri\b|rmdir|unlink|rmtree|rmsync|\bmv\b|move|settings|guard|hooks|claude|\.env|secret|credential|token|passw|\.ssh|\.aws|reset|clean|filter|rebase|\.git/i;
const DEVOPS = ['hades-devops-engineer'];
const LOGIN_PIPE = '^(docker|podman|helm|oras|crane|skopeo|finch|nerdctl|buildah|regctl) (.* )?login( |$)';

// ---------------------------------------------------------------------------------------------
// Built-in policy. hooks/guard-policy.json is merged over it: objects merge, arrays and scalars
// replace. Placeholders: {home} {engine} {vault} {workspace} {config} {projects} {orgs} {ostmp} {temp}
// {claude} (CLAUDE_CONFIG_DIR, else ~/.claude) {policy} (the policy file the guard loaded).
// Self-protection of the guard itself (engine hooks, the loaded policy file, the HADES config, the
// Claude settings/agents/skills/hooks under {claude}, managed settings) is also built in
// (MANDATORY_SELF below): a tuned policy cannot remove it.
// ---------------------------------------------------------------------------------------------
export const DEFAULT_POLICY = {
  version: 1,
  tempDirs: ['{ostmp}', '/tmp', '/var/tmp', '/private/tmp', '/private/var/folders'],
  protectedPaths: [
    '{home}', '{home}/.ssh', '{home}/.aws', '{home}/.gnupg', '{home}/.kube', '{home}/.config', '{home}/.claude', '{claude}',
    '{workspace}', '{vault}', '{vault}/organizations', '{vault}/company', '{engine}', '{engine}/hooks', '{projects}', '{orgs}',
    '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/opt', '/proc', '/root', '/sbin', '/srv',
    '/sys', '/usr', '/var', '/Applications', '/Library', '/System', '/Users', '/Volumes',
    'C:/Windows', 'C:/Program Files', 'C:/Program Files (x86)', 'C:/ProgramData', 'C:/Users',
  ],
  selfProtected: [
    '{engine}/hooks', '{engine}/hooks/**', '{engine}/hades.config.json', '{config}', '{policy}', '{home}/.claude.json',
    // the engine's .gitignore keeps the vault (<engine>/.vault) out of the public engine repository
    '{engine}/.gitignore',
    '{claude}/settings*.json', '{claude}/hooks/**', '{claude}/agents/hades', '{claude}/agents/hades/**', '{claude}/agents/hades-*',
    '{claude}/skills/hades*', '{claude}/skills/hades*/**', '{claude}/plugins/**', '{claude}/.claude.json',
    '{workspace}/.claude', '{workspace}/.claude/**', '{workspace}/CLAUDE.md', '{workspace}/AGENTS.md',
    '**/.claude/settings*.json', '**/.claude/hooks/**', '**/.claude/agents/hades', '**/.claude/agents/hades/**',
    '**/.claude/agents/hades-*', '**/.claude/skills/hades*', '**/.claude/skills/hades*/**', '**/.mcp.json', '**/.claude.json',
    '**/managed-settings*.json', '**/managed-mcp.json',
  ],
  selfProtectedNames: [
    'hooks/guard.mjs', 'guard-policy.json', 'hades.config.json', '.claude/settings', '.claude.json', '.mcp.json',
    'managed-settings', 'managed-mcp.json', '.claude/hooks/', '.claude/agents/hades', '.claude/skills/hades',
  ],
  // Git configuration files outside repositories: an alias, include or command-valued key written
  // there runs in every repository (git.config).
  gitConfigFiles: ['{home}/.gitconfig', '{home}/.config/git/config', '{home}/.config/git/attributes', '/etc/gitconfig'],
  neverWritable: ['{engine}/tools', '{engine}/tools/**', '{engine}/.tools-bin/**'],
  // Written by the HADES CLI only. team.json changes only through "hades team set" / "hades detect --write";
  // work-plan.json only through "hades task plan --from <task folder>/work-plan.draft.json" and "task item".
  stateFiles: {
    tools: '(^|/)tasks/[^/]+/(state|defects|work-plan|gates)\\.json$|(^|/)teams/[^/]+/team\\.json$',
    shell: '(^|/)tasks/[^/]+/(state|defects|work-plan|gates)\\.json$|(^|/)teams/[^/]+/team\\.json$',
  },
  // Copies of a project's Claude files kept by /hades-new-team: <vault>/**/legacy/** is exempt from the
  // generic "**/.claude/..." patterns (never from the built-in self-protection).
  legacyDirs: ['{vault}/**/legacy/**'],
  roles: {
    default: ['{vault}', '{temp}'],
    'hades-business-analyst': ['{vault}', '{temp}'],
    'hades-software-architect': ['{vault}', '{temp}'],
    // greenfield scaffold (planning) and integration glue (review) are written by the tech lead
    'hades-tech-lead': ['{projects}', '{vault}', '{workspace}', '{temp}'],
    'hades-cybersecurity-engineer': ['{vault}', '{temp}'],
    'hades-knowledge-curator': ['{vault}', '{temp}'],
    'hades-scout': [],
    'hades-backend-engineer': ['{projects}', '{vault}', '{workspace}', '{temp}'],
    'hades-frontend-engineer': ['{projects}', '{vault}', '{workspace}', '{temp}'],
    'hades-aiml-data-engineer': ['{projects}', '{vault}', '{workspace}', '{temp}'],
    'hades-qa-engineer': ['{projects}', '{vault}', '{workspace}', '{temp}'],
    'hades-devops-engineer': ['{projects}', '{vault}', '{workspace}', '{temp}'],
  },
  secrets: {
    paths: [
      '(^|/)\\.env(\\.[^/]+)?$',
      '(^|/)[^/]+\\.env$',
      '(^|/)\\.envrc$',
      '\\.(pem|key|p12|pfx|p8|ppk|jks|keystore|kdbx|ovpn)$',
      '(^|/)id_(rsa|dsa|ecdsa|ed25519)(_sk)?([._-][^/]*)?$',
      '(^|/)\\.ssh/',
      '(^|/)\\.gnupg/',
      '(^|/)\\.aws/(credentials|sso/cache/|cli/cache/)',
      '(^|/)\\.azure/(accesstokens\\.json|msal_token_cache|service_principal_entries)',
      '(^|/)\\.config/gcloud/(credentials\\.db|access_tokens\\.db|application_default_credentials\\.json|legacy_credentials/)',
      '(^|/)\\.docker/config\\.json$',
      '(^|/)\\.kube/config$',
      '(^|/)(kubeconfig|[^/]+\\.kubeconfig)(\\.ya?ml)?$',
      '(^|/)\\.git-credentials$',
      '(^|/)(\\.npmrc|\\.pypirc|\\.netrc|_netrc|\\.pgpass|\\.vault-token|\\.terraformrc|terraform\\.rc|credentials\\.tfrc\\.json)$',
      '(^|/)\\.config/gh/hosts\\.yml$',
      '^/proc/[^/]+/environ$',
    ],
    exceptions: [
      '\\.pub$',
      '(^|/)\\.ssh/(config|known_hosts(\\.old)?)$',
      '(^|/)\\.env\\.(example|sample|template|dist)$',
      '(^|/)(example|sample|template)\\.env$',
    ],
    notesStem: '(^|[._-])(credentials?|secrets?|passwords?|passwd)([._-](local|dev|development|prod|production|staging|test|backup|bak|old|[0-9]+))?$',
    notesExt: '^(txt|md|json|ya?ml|csv|ini|toml|cfg|conf|xml|properties)$',
    globProbes: [
      '.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519', 'server.key', 'cert.pem', 'cert.p12',
      'cert.pfx', 'release.jks', '.npmrc', '.netrc', '.git-credentials', 'credentials.json', 'secrets.yaml',
    ],
    varName: '(secret|token|passw|passphrase|api_?key|private_?key|access_?key|credential|session_?key|cookie|auth(?!or)|(^|_)pat$|^pat_|dsn$|connection_?string|database_url|webhook_url)',
    useCommands: [
      'rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'unlink', 'shred', 'ls', 'dir', 'get-childitem',
      'test-path', 'test', '[', 'stat', 'touch', 'chmod', 'chown', 'icacls', 'attrib', 'ssh-add', 'ssh-keygen',
      'source', '.', 'cd', 'set-location', 'mkdir',
    ],
    gitUse: ['check-ignore', 'status', 'ls-files', 'rm'],
    useFlags: {
      docker: ['--env-file'], 'docker-compose': ['--env-file'], podman: ['--env-file'], 'podman-compose': ['--env-file'],
      nerdctl: ['--env-file'], finch: ['--env-file'], node: ['--env-file', '--env-file-if-exists'], bun: ['--env-file'],
      deno: ['--env-file'], ssh: ['-i'], scp: ['-i'], sftp: ['-i'], rsync: ['-e', '--rsh'],
      kubectl: ['--kubeconfig', '--from-env-file', '--from-file', '--client-key', '--client-certificate', '--certificate-authority'],
      helm: ['--kubeconfig', '--key-file', '--cert-file', '--ca-file'],
      curl: ['--cert', '-E', '--key', '--cacert', '--capath', '--proxy-cert', '--proxy-key', '--proxy-cacert'],
      wget: ['--certificate', '--private-key', '--ca-certificate'], gcloud: ['--key-file'],
      'ansible-playbook': ['--private-key', '--key-file', '--vault-password-file'], ansible: ['--private-key', '--key-file', '--vault-password-file'],
      'invoke-webrequest': ['-certificate'], 'invoke-restmethod': ['-certificate'],
    },
  },
  pasteHosts: [
    'pastebin.com', 'paste.ee', 'pastie.org', 'hastebin.com', 'termbin.com', 'ix.io', 'sprunge.us', 'dpaste.org',
    'dpaste.com', 'paste.rs', 'paste.mozilla.org', 'rentry.co', 'rentry.org', 'ghostbin.com', 'controlc.com',
    'justpaste.it', 'transfer.sh', '0x0.st', 'file.io', 'tmpfiles.org', 'catbox.moe', 'bashupload.com', 'temp.sh',
    'oshi.at', 'gofile.io', 'filebin.net', 'pixeldrain.com', 'webhook.site', 'requestbin.com', 'pipedream.net',
    'beeceptor.com', 'gist.github.com', 'api.github.com/gists', 'gist.githubusercontent.com',
  ],
  commandRules: [
    // a) git: no pushes, no history rewrite, no mass discard, no forced ref changes
    { id: 'git.push', re: '^(git|hub) (push|send-pack|http-push)( |$)' },
    { id: 'git.push', re: '^(git|hub) (subtree push|lfs push|svn dcommit|p4 submit)( |$)' },
    { id: 'git.push', re: '^gh-pages( |$)' },
    { id: 'git.rewrite', re: '^(git|hub) (rebase|filter-branch|filter-repo|update-ref|replace|fast-import)( |$)', unless: '^(git|hub) rebase --abort$' },
    { id: 'git.rewrite', re: '^(git-filter-repo|bfg)( |$)' },
    { id: 'git.rewrite', re: '^(git|hub) commit( .*)? --amend( |=|$)' },
    { id: 'git.rewrite', re: '^(git|hub) pull( .*)? (--rebase(=(true|merges|interactive|i|m))?|-r)( |$)' },
    // reset to a commit: HEAD~1, main~2, x^, HEAD@{1}, @{u}, ORIG_HEAD, abbreviated hashes, remote branches
    { id: 'git.rewrite', re: '^(git|hub) reset( .*)? (--soft|--keep|[^ -][^ ]*[~^][0-9]*|[^ ]*@\\{[^ }]*\\}|orig_head|fetch_head|[0-9a-f]{4,40})( |$)', flags: 'i' },
    { id: 'git.rewrite', re: '^(git|hub) reset( .*)? (origin|upstream)/\\S+( |$)' },
    { id: 'git.discard', re: '^(git|hub) reset( .*)? --(hard|merge)( |$)' },
    { id: 'git.discard', re: '^(git|hub) clean(?!( .*)? (-[a-zA-Z]*n[a-zA-Z]*|--dry-run)( |$))( |$)' },
    { id: 'git.discard', re: '^(git|hub) checkout( .*)? (-f|--force|\\.|\\./|\\*|:/|:/\\.|:/\\*)( |$)' },
    { id: 'git.discard', re: '^(git|hub) restore(?!( .*)? (--staged|-S)( |$))( .*)? (\\.|\\./|\\*|:/|:/\\.)( |$)' },
    { id: 'git.discard', re: '^(git|hub) restore( .*)? (--worktree|-W|-[a-zA-Z]*W[a-zA-Z]*)( .*)? (\\.|\\./|\\*|:/|:/\\.)( |$)' },
    { id: 'git.discard', re: '^(git|hub) (read-tree( .*)? (-u|--reset)|checkout-index( .*)? (-f|--force|-a|--all|-[a-zA-Z]*[fa][a-zA-Z]*))( |$)' },
    { id: 'git.discard', re: '^(git|hub) switch( .*)? (-f|--force|--discard-changes)( |$)' },
    { id: 'git.discard', re: '^(git|hub) stash (drop|clear)( |$)' },
    // "stash --all" moves ignored files (the vault, hades.config.json, .tools-bin) out of the working tree
    { id: 'git.discard', re: '^(git|hub) stash( (push|save)( .*)?| -.*)? (-a|--all|-[a-zA-Z]*a[a-zA-Z]*)( |$)' },
    { id: 'git.discard', re: '^(git|hub) rm(?!( .*)? --cached( |$))( .*)? (\\.|\\./|\\*|:/)( |$)' },
    { id: 'git.discard', re: '^(git|hub) worktree remove( .*)? (-f|--force)( |$)' },
    { id: 'git.discard', re: '^(git|hub) (reflog (expire|delete)|prune|gc( .*)? --prune(=\\S+)?)( |$)' },
    { id: 'git.force', re: '^(git|hub) branch( .*)? (-[a-zA-Z]*[DMCf][a-zA-Z]*|--force)( |$)' },
    { id: 'git.force', re: '^(git|hub) (switch( .*)? -C|checkout( .*)? -B)( |$)' },
    { id: 'git.force', re: '^(git|hub) (add|stage|tag)( .*)? (-[a-zA-Z]*f[a-zA-Z]*|--force)( |$)' },
    // low-level staging ignores .gitignore (a git-ignored vault inside the engine would be staged)
    { id: 'git.force', re: '^(git|hub) update-index( .*)? (--add|--cacheinfo|--index-info)( |=|$)' },
    { id: 'git.config', re: '^(git|hub) config( .*)? (--global|--system)( |$)', unless: '( --get[a-z-]*| --list| -l| --show-origin| --show-scope)( |$)|^(git|hub) config (--global|--system)( --[a-z-]+)* [^ -]\\S*$' },
    // aliases, includes and hook paths (section names are case-insensitive); interactive config edits
    { id: 'git.config', re: '^(git|hub) config( .*)? (alias|include|includeif)\\.|^(git|hub) config( .*)? core\\.hookspath( |=|$)|^(git|hub) config( .*)? (-e|--edit)( |$)', flags: 'i', unless: '( --get[a-z-]*| --list| -l)( |$)' },
    // a) code hosting: PRs, releases, repos, gists, API writes are owner actions
    { id: 'git.hosting', re: '^gh (pr|issue) (create|new|merge|close|reopen|edit|comment|review|ready|lock|unlock|pin|unpin|transfer|delete|develop|revert|update-branch)( |$)' },
    { id: 'git.hosting', re: '^gh release (?!(list|view|download|ls)( |$))\\S' },
    { id: 'git.hosting', re: '^gh repo (create|new|delete|sync|rename|archive|unarchive|edit|fork|deploy-key)( |$)' },
    { id: 'git.hosting', re: '^gh gist (create|new|edit|delete|rename)( |$)' },
    { id: 'git.hosting', re: '^gh workflow run( |$)', allowRoles: DEVOPS },
    { id: 'git.hosting', re: '^gh (secret|variable|label|ruleset|cache|ssh-key|gpg-key|workflow|run|codespace|project|extension|ext|org|alias|auth) (set|delete|remove|create|edit|add|enable|disable|rerun|cancel|clone|install|upgrade|import|close|copy|link|unlink|login|logout|refresh|setup-git|switch)( |$)' },
    { id: 'git.hosting', re: '^(gh|glab) api( .*)? (-X[ =]?|--method[ =]?)(POST|PUT|PATCH|DELETE)( |$)', flags: 'i' },
    { id: 'git.hosting', re: '^(gh|glab) api( .*)? (-f|-F|--field|--raw-field|--input)( |=|$|\\S)' },
    { id: 'git.hosting', re: '^glab (mr|issue|release|repo|snippet|label|variable|schedule|ci|deploy-key|ssh-key|gpg-key|incident|changelog|stack|token|alias|auth|cluster) (create|new|merge|delete|edit|close|reopen|comment|note|approve|revoke|rebase|update|upload|run|retry|cancel|set|add|fork|archive|transfer|unarchive|login|logout|play|trigger|rotate)( |$)' },
    { id: 'git.hosting', re: '^hub (pull-request|create|delete|fork|gist|sync)( |$)' },
    { id: 'git.hosting', re: '^hub (release|issue) (create|edit|delete|update|transfer)( |$)' },
    // e) publishing
    { id: 'publish.package', re: '^(npm|pnpm|bun) publish( |$)' },
    { id: 'publish.package', re: '^yarn (npm )?publish( |$)' },
    { id: 'publish.package', re: '^(lerna|changeset|changesets) publish( |$)' },
    { id: 'publish.package', re: '^(np|semantic-release|release-it|publish-please)( |$)' },
    { id: 'publish.package', re: '^twine upload( |$)' },
    { id: 'publish.package', re: '^(poetry|flit|hatch|uv|pdm|maturin|rye|cargo|deno|jsr|vsce|ovsx) publish( |$)' },
    { id: 'publish.package', re: '^(gem|pod trunk|dotnet nuget|nuget) push( |$)' },
    { id: 'publish.package', re: '^(dart|flutter) pub publish( |$)' },
    { id: 'publish.package', re: '^(mix hex\\.publish|conda upload|anaconda upload)( |$)' },
    { id: 'publish.artifact', re: '^mvn( .*)? deploy(:\\S+)?( |$)', allowRoles: DEVOPS },
    { id: 'publish.artifact', re: '^(gradle|gradlew)( .*)? publish(?!ToMavenLocal)[A-Za-z]*( |$)', allowRoles: DEVOPS },
    { id: 'publish.image', re: '^(docker|podman|buildah|nerdctl|finch) (image |manifest )?push( |$)', allowRoles: DEVOPS },
    { id: 'publish.image', re: '^(docker|podman|nerdctl|finch) (buildx )?(build|bake)( .*)? --push( |=|$)', allowRoles: DEVOPS },
    { id: 'publish.image', re: '^(crane|oras|regctl) (push|copy|cp|image copy)( |$)', allowRoles: DEVOPS },
    { id: 'publish.image', re: '^(skopeo copy|helm push|helm cm-push)( |$)', allowRoles: DEVOPS },
    // d) commands that print secret values (AWS rule: never call get-secret-value; resolve at runtime)
    { id: 'secrets.print', re: '^aws secretsmanager (get-secret-value|batch-get-secret-value)( |$)' },
    { id: 'secrets.print', re: '^aws configure export-credentials( |$)' },
    { id: 'secrets.print', re: '^aws configure get \\S*(secret|session_token|access_key)', flags: 'i' },
    { id: 'secrets.print', re: '^aws ssm get-parameters?(-by-path)?( .*)? --with-decryption( |=|$)' },
    { id: 'secrets.print', re: '^aws iam create-access-key( |$)' },
    { id: 'secrets.print', re: '^aws sts (get-session-token|assume-role\\S*|get-federation-token)( |$)', okCaptured: true },
    { id: 'secrets.print', re: '^aws (ecr|ecr-public) get-login-password( |$)', okCaptured: true, okPipedTo: LOGIN_PIPE },
    { id: 'secrets.print', re: '^aws codeartifact get-authorization-token( |$)', okCaptured: true },
    { id: 'secrets.print', re: '^gh auth token( |$)', okCaptured: true, okPipedTo: LOGIN_PIPE },
    { id: 'secrets.print', re: '^gcloud auth (application-default )?print-(access|identity)-token( |$)', okCaptured: true, okPipedTo: LOGIN_PIPE },
    { id: 'secrets.print', re: '^az (account get-access-token|acr login( .*)? --expose-token)( |$)', okCaptured: true },
    { id: 'secrets.print', re: '^kubectl get secrets?([/ ].*)? (-o|--output)( |=)?\\S*(json|yaml|template)' },
    { id: 'secrets.print', re: '^(vault (kv get|read)|op read|op item get( .*)? --reveal)( |$)' },
    { id: 'secrets.print', re: '^(curl|wget|invoke-webrequest|invoke-restmethod)( .*)? \\S*(localhost|127\\.0\\.0\\.1):2773', flags: 'i' },
    { id: 'secrets.env-print', re: '^(get-item|get-childitem|get-content|gi|gci|gc|dir|ls|cat|type)( .*)? env:[\\\\/]?\\S*(secret|token|passw|key|credential)', flags: 'i' },
    // d) whole-environment dumps
    { id: 'secrets.env-dump', re: '^(env|printenv)( -0| --null)?$' },
    { id: 'secrets.env-dump', re: '^set$' },
    { id: 'secrets.env-dump', re: '^(export|declare|typeset)( -[a-zA-Z]+)*$' },
    { id: 'secrets.env-dump', re: '^(get-childitem|get-item|dir|ls|gci|gi)( -path| -literalpath)? env:(\\\\|/)?(\\S*\\*\\S*)?$', flags: 'i' },
    // b) irreversible cloud resource and data deletion (deploys and rollbacks never need these)
    { id: 'cloud.destroy', re: '^(terraform|tofu|terragrunt|pulumi|cdk|cdktf|sst) (.* )?destroy( |$)' },
    { id: 'cloud.destroy', re: '^terraform (.* )?apply( .*)? -destroy( |$)' },
    { id: 'cloud.destroy', re: '^aws s3 rb( |$)|^aws s3 rm( .*)? --recursive( |$)|^aws s3api delete-bucket( |$)' },
    { id: 'cloud.destroy', re: '^aws (cloudformation delete-stack|rds delete-db-(instance|cluster)|dynamodb delete-table|ec2 terminate-instances|ec2 delete-(vpc|volume|snapshot)|eks delete-cluster|ecr delete-repository|ecs delete-cluster|efs delete-file-system|kms schedule-key-deletion|route53 delete-hosted-zone|backup delete-backup-vault|logs delete-log-group|organizations \\S+|iam delete-\\S+|secretsmanager delete-secret)( |$)' },
    { id: 'cloud.destroy', re: '^(az group delete|az (sql|cosmosdb|storage account|aks|vm) delete|gcloud projects delete|gcloud (sql instances|container clusters|compute instances|storage buckets) delete|gsutil (.* )?rm -r|gsutil rb)( |$)' },
    { id: 'cloud.destroy', re: '^kubectl (.* )?delete (namespace|namespaces|ns|pv|pvc|persistentvolume|persistentvolumeclaim|crd|customresourcedefinition|node|nodes)( |/|$)' },
    // b) power, disks, system settings, persistence
    { id: 'sys.power', re: '^(shutdown|reboot|halt|poweroff|stop-computer|restart-computer|logoff|suspend)( |$)', flags: 'i' },
    { id: 'sys.power', re: '^(init|telinit) [06]( |$)' },
    { id: 'sys.power', re: '^(systemctl|loginctl) (reboot|poweroff|halt|suspend|hibernate|hybrid-sleep|kexec|rescue|emergency|kill-session|terminate-session|kill-user|terminate-user)( |$)' },
    { id: 'sys.power', re: '^wsl( .*)? (--shutdown|--terminate|-t|--unregister)( |$)' },
    { id: 'sys.disk', re: '^(format|diskpart|fdisk|sfdisk|gdisk|cfdisk|sgdisk|parted|wipefs|mkfs(\\.\\S+)?|mke2fs|mkswap|mkntfs|newfs\\S*|format-volume|clear-disk|initialize-disk|remove-partition|new-partition|resize-partition|set-partition|set-disk|reset-physicaldisk|blkdiscard|hdparm)( |$)', flags: 'i' },
    { id: 'sys.disk', re: '^(zpool (destroy|labelclear)|zfs destroy|lvremove|vgremove|pvremove|cryptsetup (luksformat|erase))( |$)', flags: 'i' },
    { id: 'sys.disk', re: '^diskutil (erase\\S*|partition\\S*|zerodisk|randomdisk|secureerase|reformat|apfs (delete\\S*|erase\\S*))( |$)', flags: 'i' },
    { id: 'sys.disk', re: '^dd( .*)? of=(/dev/(sd|hd|nvme|disk|rdisk|mmcblk|vd|xvd|dm-|md)|//\\./|\\\\\\\\\\.\\\\)', flags: 'i' },
    { id: 'sys.disk', re: '^(cipher( .*)? /w|vssadmin( .*)? delete|wbadmin( .*)? delete|bcdedit)( |:|$)', flags: 'i' },
    { id: 'sys.settings', re: '^(set-mppreference|add-mppreference|remove-mppreference|set-netfirewallprofile|disable-netfirewallrule)( |$)', flags: 'i' },
    { id: 'sys.settings', re: '^netsh (advfirewall|firewall)( .*)? (set|delete|add)( |$)', flags: 'i' },
    { id: 'sys.settings', re: '^reg (add|delete|import|restore|load|unload) "?(hklm|hkey_local_machine|hkcr|hkey_classes_root|hku|hkey_users)', flags: 'i' },
    { id: 'sys.settings', re: '^(csrutil( .*)? disable|spctl( .*)? --(master|global)-disable|setenforce 0|ufw disable)( |$)', flags: 'i' },
    { id: 'sys.settings', re: '^schtasks( .*)? /(create|change|delete)( |$)', flags: 'i' },
    { id: 'sys.settings', re: '^(register-scheduledtask|unregister-scheduledtask|set-scheduledtask|new-service|remove-service|setx)( |$)', flags: 'i' },
    { id: 'sys.settings', re: '^crontab(?!( -u \\S+)? -l( |$))( |$)' },
    { id: 'sys.settings', re: '^(useradd|userdel|usermod|adduser|deluser|passwd|chpasswd|visudo|new-localuser|remove-localuser|set-localuser|add-localgroupmember)( |$)', flags: 'i' },
    { id: 'sys.settings', re: '^net (user|localgroup)( .*)? /(add|delete)( |$)', flags: 'i' },
    // f) nested autonomous sessions, Claude configuration, HADES installation
    { id: 'self.session', re: '^claude( .*)? (--dangerously-skip-permissions|--allow-dangerously-skip-permissions|--permission-mode[ =]bypasspermissions|--settings|--setting-sources|--plugin-dir|--bare|--mcp-config)( |=|$)', flags: 'i' },
    { id: 'self.session', re: '^claude (config (set|add|remove)|mcp (add|add-json|add-from-claude-desktop|remove|reset-project-choices)|plugins? (install|uninstall|enable|disable|update|marketplace|add))( |$)', flags: 'i' },
    // the owner's launcher: allowed only as "node <engine>/bin/hades.mjs run ..." in the main session
    { id: 'self.session', re: '^hades run( |$)', when: 'agent' },
    { id: 'self.protect', re: '^hades (install|uninstall)( |$)' },
  ],
  rawRules: [
    { id: 'self.env', re: 'HADES_(GUARD[A-Z_]*|CONFIG_FILE)[\'"]?\\s*[=,]', flags: 'i' },
    { id: 'self.env', re: '(setx|set-item|si|new-item|ni)\\s+(-path\\s+)?[\'"]?(env:[\\\\/]?)?HADES_(GUARD|CONFIG_FILE)', flags: 'i' },
    // a redirected Claude config dir loads settings without the guard hook (any env-setting syntax)
    { id: 'self.session', re: 'CLAUDE_CONFIG_DIR[\'"]?\\s*[=,]', flags: 'i' },
    { id: 'self.session', re: '(setx|set-item|si|new-item|ni|set)\\s+(-path\\s+)?[\'"]?(env:[\\\\/]?)?CLAUDE_CONFIG_DIR', flags: 'i' },
    // git configuration through the environment (aliases, includes, command-valued keys)
    { id: 'git.config', re: 'GIT_CONFIG_(PARAMETERS|COUNT|KEY_\\d+|VALUE_\\d+|GLOBAL|SYSTEM)[\'"]?\\s*[=,]', flags: 'i' },
    { id: 'git.config', re: '(setx|set-item|si|new-item|ni|set)\\s+(-path\\s+)?[\'"]?(env:[\\\\/]?)?GIT_CONFIG_', flags: 'i' },
    { id: 'sys.forkbomb', re: ':\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;\\s*:' },
    // scope "code": only executed code (PowerShell commands, -c/-e code, scripts), not text written to files
    { id: 'secrets.env-dump', re: '\\[(system\\.)?environment\\]::getenvironmentvariables\\(', flags: 'i', scope: 'code' },
    { id: 'secrets.env-print', re: 'getenvironmentvariable\\(\\s*[\'"]?[A-Za-z0-9_]*(secret|token|passw|api_?key|private_?key|access_?key|credential)', flags: 'i', scope: 'code' },
    { id: 'secrets.env-dump', re: '(console\\.(log|dir|table|error)|json\\.stringify|util\\.inspect|pprint|print|puts|var_dump|print_r)\\s*\\(?\\s*(process\\.env|os\\.environ|dict\\(os\\.environ\\)|\\$_env|getenv\\(\\))\\s*[),]', flags: 'i', scope: 'code' },
  ],
};

// Messages: [reason, what to do instead]. "%s" is replaced by the detail.
const MESSAGES = {
  'git.push': ['pushing is reserved for the owner', 'Commit locally; the owner reviews and pushes.'],
  'git.rewrite': ['history rewriting (rebase, amend, filter, reset to a commit, ref edits) is not allowed', 'Create a new commit instead.'],
  'git.discard': ['mass discard of work or recovery data is not allowed', 'Restore or remove specific paths, or keep the changes and commit them.'],
  'git.force': ['forced git operation (or low-level staging that bypasses .gitignore)', 'Use the non-forced form (e.g. git branch -d, git add without -f).'],
  'git.vault': ['staging vault files (%s) into a repository other than the vault\'s own would put private data there', 'Commit vault changes with git -C <vault> only.'],
  'git.config': ['changing git aliases or global/system git config', 'Use repository-local settings; record global needs as a decision.'],
  'git.dynamic': ['git subcommand that is computed at run time, fed by xargs, or not a git builtin (aliases are not allowed) cannot be verified', 'Write the git builtin command literally.'],
  'git.hosting': ['remote repository changes (PRs, issues, releases, repos, gists, API writes) are owner actions', 'Record what is needed in the task README for the owner.'],
  'git.internals': ['writing inside .git (%s)', 'Use git commands instead.'],
  'fs.delete': ['refusing to delete, move or re-permission a protected path (%s)', 'Delete only inside a project (e.g. dist, node_modules) with a literal path.'],
  'fs.git': ['deleting or moving .git data (%s)', 'Leave repository internals alone.'],
  'fs.device': ['writing to a raw disk device (%s)', 'Never write to devices.'],
  'cloud.destroy': ['irreversible cloud resource or data deletion is an owner action', 'Record the exact command in 08-deployment.md for the owner.'],
  'sys.power': ['shutdown, reboot or session termination', 'Never stop the machine.'],
  'sys.disk': ['disk, partition or backup destruction tool', 'Never run disk tools.'],
  'sys.settings': ['system, security, account or persistent scheduling settings change', 'Record the needed change as a decision for the owner.'],
  'sys.forkbomb': ['fork bomb', 'Do not run it.'],
  'rce.pipe': ['piping downloaded or generated content into a shell or interpreter', 'Download to a file, inspect it, and use a pinned tool or package manager.'],
  'rce.subst': ['executing downloaded content via substitution', 'Download to a file, inspect it, and use a pinned tool or package manager.'],
  'rce.download-exec': ['executing a file downloaded in the same command (%s)', 'Download, inspect, then run it in a separate, reviewed step.'],
  'secrets.file': ['access to a secret file (%s)', 'Refer to secrets by environment-variable name; read .env.example for structure.'],
  'secrets.print': ['command prints secret values into the session', 'Resolve secrets at run time (env vars, --password-stdin, {{resolve:secretsmanager:...}}).'],
  'secrets.env-dump': ['dumping the environment exposes secrets', 'Print only the specific non-secret variable you need.'],
  'secrets.env-print': ['printing a secret-looking variable (%s)', 'Pass it to the command that needs it without printing it.'],
  'publish.package': ['publishing packages is an owner action', 'Build and test locally; record the release step for the owner.'],
  'publish.artifact': ['publishing artifacts is reserved for hades-devops-engineer deploys', 'Hand deploy work to the devops engineer.'],
  'publish.image': ['pushing images is reserved for hades-devops-engineer deploys', 'Hand deploy work to the devops engineer.'],
  'publish.paste': ['upload to or fetch from a paste/file-sharing host (%s)', 'Keep artefacts in the task folder.'],
  'self.protect': ['%s is protected (guard, Claude settings/agents/skills/hooks, MCP config, HADES config)', 'Only the owner changes these, by hand or with hades install.'],
  'self.session': ['nested Claude session with altered permissions/settings/config dir/home, or Claude/HADES config change', 'Work in this session; the PM spawns role agents.'],
  'self.env': ['changing HADES guard environment variables', 'Owner-only; set outside Claude Code.'],
  'scope.readonly': ['%s is read-only', 'Return findings in your final message.'],
  'scope.write': ['%s', 'Write only inside: %s.'],
  'scope.vendored': ['vendored tool sources are read-only (%s)', 'Use hades tools commands; record needed upstream changes as a decision.'],
  'scope.engine': ['HADES engine files are not a registered project (%s)', 'Write inside a registered project or the vault.'],
  'state.direct-edit': ['%s is written by the HADES CLI only', 'Use hades task|defect|gate|team|org commands.'],
  'guard.limit': ['command too large or complex to verify', 'Split it into smaller commands, or write a script file and run it.'],
};

// Git builtins (git --list-cmds=main, 2.4x) and approved extensions. Any other subcommand is an alias
// or an external git-<name> program, which the guard cannot verify (git.dynamic). Git ignores aliases
// that shadow a builtin, so every alias route (config, -c, --config-env, GIT_CONFIG_*, include.path)
// ends in a subcommand outside this set.
const GIT_SUBCOMMANDS = new Set(`add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr
check-ignore check-mailmap check-ref-format checkout checkout--worker checkout-index cherry cherry-pick citool clean clone
column commit commit-graph commit-tree config count-objects credential credential-cache credential-cache--daemon
credential-store credential-wincred credential-osxkeychain credential-libsecret credential-manager daemon describe diagnose
diff diff-files diff-index diff-pairs diff-tree difftool difftool--helper fast-export fast-import fetch fetch-pack filter-branch
fmt-merge-msg for-each-ref for-each-repo format-patch fsck fsck-objects fsmonitor--daemon gc get-tar-commit-id grep gui
gui--askpass gui--askyesno hash-object help hook http-backend http-fetch http-push imap-send index-pack init init-db instaweb
interpret-trailers last-modified log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file
merge-index merge-octopus merge-one-file merge-ours merge-recursive merge-recursive-ours merge-recursive-theirs merge-resolve
merge-subtree merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes p4 pack-objects pack-redundant pack-refs
patch-id pickaxe prune prune-packed pull push quiltimport range-diff read-tree rebase receive-pack reflog refs remote remote-ext
remote-fd remote-ftp remote-ftps remote-http remote-https repack replace replay repo request-pull rerere reset restore revert
rev-list rev-parse rm send-email send-pack sh-i18n--envsubst shortlog show show-branch show-index show-ref sparse-checkout
stage stash status stripspace submodule submodule--helper subtree svn switch symbolic-ref tag unpack-file unpack-objects
update update-index update-ref update-server-info upload-archive upload-archive--writer upload-pack var verify-commit
verify-pack verify-tag version web--browse whatchanged worktree write-tree lfs flow filter-repo`.split(/\s+/));
// Long options the git rules match on, so abbreviations (git accepts any unique prefix) are expanded.
const GIT_LONG = ['--hard', '--merge', '--soft', '--keep', '--mixed', '--amend', '--rebase', '--force', '--dry-run', '--discard-changes', '--staged', '--worktree', '--cached', '--prune', '--global', '--system', '--edit', '--reset', '--all', '--add', '--cacheinfo', '--index-info'];
function gitLong(a) {
  const m = /^(--[a-z][a-z-]*)(=[\s\S]*)?$/.exec(a);
  if (!m || GIT_LONG.includes(m[1])) return a;
  const full = GIT_LONG.find((o) => o.startsWith(m[1]));
  return full ? full + (m[2] || '') : a;
}
const HUB_SUBCOMMANDS = new Set('alias api browse ci-status compare create delete fork gist issue pr pull-request release sync'.split(' '));
// Config keys whose value git runs as a command (scanned like a nested command line).
const GIT_EXEC_KEY = /^(core\.(fsmonitor|pager|editor|sshcommand|askpass)|sequence\.editor|diff\.external|pager\..+|gpg(\..+)?\.program|uploadpack\.packobjectshook|interactive\.difffilter|web\.browser|(credential|filter|diff|merge|mergetool|difftool|browser|man|remote|url)\..*\.(cmd|command|path|helper|driver|clean|smudge|process|textconv|program|receivepack|uploadpack)|credential\.helper|remote\..*\.(receivepack|uploadpack|vcs)|core\.gitproxy)$/i;
// Environment variables whose value git or the shell runs as a command.
const EXEC_ENV = /^(GIT_(EXTERNAL_DIFF|PAGER|EDITOR|SEQUENCE_EDITOR|SSH_COMMAND|SSH|ASKPASS|PROXY_COMMAND)|PAGER|EDITOR|VISUAL|SSH_ASKPASS|PROMPT_COMMAND|BASH_ENV|ENV)$/i;
// Variables that redirect where a nested claude loads its configuration from.
const SESSION_ENV = /^(CLAUDE_CONFIG_DIR|CLAUDE_CODE_[A-Z0-9_]+|HADES_[A-Z0-9_]+|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH)$/i;

// ---------------------------------------------------------------------------------------------
// Command vocabularies
// ---------------------------------------------------------------------------------------------
const set = (s) => new Set(s.split(' '));
const PS_ALIAS = {
  rm: 'remove-item', del: 'remove-item', erase: 'remove-item', rd: 'remove-item', rmdir: 'remove-item', ri: 'remove-item',
  ls: 'get-childitem', dir: 'get-childitem', gci: 'get-childitem', cat: 'get-content', type: 'get-content', gc: 'get-content',
  cp: 'copy-item', copy: 'copy-item', cpi: 'copy-item', mv: 'move-item', move: 'move-item', mi: 'move-item',
  ren: 'rename-item', rni: 'rename-item', sc: 'set-content', ac: 'add-content', iwr: 'invoke-webrequest',
  curl: 'invoke-webrequest', wget: 'invoke-webrequest', irm: 'invoke-restmethod', iex: 'invoke-expression',
  echo: 'write-output', write: 'write-output', sl: 'set-location', cd: 'set-location', chdir: 'set-location',
  ni: 'new-item', gi: 'get-item', sls: 'select-string', tee: 'tee-object', start: 'start-process', saps: 'start-process',
  icm: 'invoke-command', clc: 'clear-content', pushd: 'push-location', popd: 'pop-location', gv: 'get-variable',
  sal: 'set-alias', nal: 'new-alias',
};
const DELETE = set('rm rmdir rd del erase remove-item unlink shred rimraf del-cli trash trash-put rmtrash srm wipe');
const MOVE = set('mv move move-item ren rename rename-item');
const PERM = set('chmod chown chgrp icacls takeown attrib');
const CMD_STYLE = set('del erase rd rmdir move ren copy xcopy attrib icacls takeown robocopy start');
const SHELLS = set('bash sh zsh dash ksh fish ash mksh csh tcsh yash');
const PWSH = set('powershell pwsh powershell_ise');
const INTERP = set('python node nodejs bun deno perl ruby php lua luajit osascript tclsh rscript');
const CODE_FLAGS = {
  python: ['-c'], node: ['-e', '--eval', '-p', '--print', '-pe'], nodejs: ['-e', '--eval', '-p', '--print'], bun: ['-e', '--eval', '-p', '--print'],
  perl: ['-e', '-E'], ruby: ['-e'], php: ['-r'], lua: ['-e'], luajit: ['-e'], osascript: ['-e'], rscript: ['-e'],
};
const DOWNLOADERS = set('curl wget invoke-webrequest invoke-restmethod http https xh fetch aria2c start-bitstransfer lwp-download lwp-request');
const PRINTERS = set('echo printf printenv write-output write-host write-information out-host');
const READERS = set('test [ [[ cat type get-content gc less more head tail bat batcat grep egrep fgrep rg ag ack findstr select-string ls dir get-childitem get-item get-itemproperty test-path stat file wc diff cmp fc comm jq yq md5sum sha1sum sha256sum shasum get-filehash cd pushd popd set-location push-location echo printf write-output write-host realpath readlink dirname basename resolve-path tree du measure-object format-hex hexdump od strings nl view sort uniq');
const GIT_READ = set('diff log show status blame ls-files grep add commit check-ignore rev-parse cat-file describe shortlog');
const PASTE_SAFE = set('git hades echo printf write-output write-host grep egrep rg findstr select-string');
const BASH_KEYWORDS = set('if elif while until then else do ! function');
const ASSIGN_BUILTINS = set('export declare typeset local readonly');
const SIMPLE_PREFIX = {
  parallel: ['-j', '--jobs', '-S', '--sshlogin', '--delay', '--timeout', '-a', '--arg-file', '--colsep', '-d', '--delimiter'],
  nohup: [], time: ['-f', '-o', '--format', '--output'], exec: ['-a'], command: [], builtin: [], setsid: [], unbuffer: [],
  caffeinate: ['-t', '-w'], chronic: [], stdbuf: ['-i', '-o', '-e'], nice: ['-n', '--adjustment'], ionice: ['-c', '-n', '-p'],
  torsocks: [], proxychains: ['-f'], proxychains4: ['-f'], call: [], busybox: [], doas: ['-u', '-C'], run0: ['-u', '--user'],
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt', '--chdir'],
  strace: ['-o', '-e', '-p', '-s', '-u', '-E'], ltrace: ['-o', '-e', '-p', '-s', '-u'],
  xargs: ['-I', '-n', '-L', '-l', '-P', '-s', '-d', '-E', '-e', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-lines', '--replace', '--eof'],
  timeout: ['-s', '-k', '--signal', '--kill-after'], chroot: ['--userspec', '--groups'], flock: ['-w', '-E', '--timeout', '--conflict-exit-code'],
};
const SKIP_POSITIONAL = { timeout: 1, chroot: 1, flock: 1 };
const RUNNERS = {
  uv: ['run'], pipx: ['run'], poetry: ['run'], pipenv: ['run'], pdm: ['run'], hatch: ['run'], rye: ['run'], bundle: ['exec'],
  conda: ['run'], mamba: ['run'], micromamba: ['run'], mise: ['exec', 'x'], asdf: ['exec'], rtx: ['exec', 'x'], devbox: ['run'],
  doppler: ['run'], op: ['run'], 'aws-vault': ['exec'], direnv: ['exec'],
};
const DIRECT_RUNNERS = set('uvx dotenv dotenvx env-cmd cross-env');
const RUNNER_VALUES = ['--with', '-w', '--python', '-p', '--project', '--directory', '--env-file', '--package', '--extra', '--group', '--index', '-n', '--name', '--prefix', '-e', '-f', '--file', '--environment', '--config', '-c', '--profile', '-v', '-r', '--rc-file'];
const PKG_BUILTINS = set('add install i remove rm uninstall update up upgrade publish pack link unlink init create dlx exec x why list ls outdated audit config cache store env import rebuild patch prune fetch deploy setup licenses server bin root doctor info view workspaces workspace set plugin version global node constraints dedupe explain search login logout npm owner tag team unplug help run run-script test t start stop restart ci');
const PS_EXE_VALUE_PARAMS = ['psconsolefile', 'version', 'inputformat', 'outputformat', 'windowstyle', 'configurationname', 'configurationfile', 'custompipename', 'workingdirectory', 'settingsfile', 'encodedarguments'];
const PS_VALUE_PARAMS = set('path literalpath lp pspath destination filter include exclude credential stream erroraction ea warningaction wa informationaction infa errorvariable ev outvariable ov outbuffer ob pipelinevariable pv newname value encoding itemtype type name argumentlist args filepath workingdirectory wd verb uri outfile method body infile headers contenttype');

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------
const K = (p) => (p == null ? p : String(p).toLowerCase());
const slash = (p) => String(p).replace(/\\/g, '/');
// Loop instead of push(...items): huge argument lists must not overflow the stack (a crash fails open).
function pushAll(arr, items) {
  for (const x of items) arr.push(x);
  return arr;
}

function isInside(p, root) {
  if (p == null || root == null) return false;
  const a = K(p);
  const b = K(root);
  if (a === b) return true;
  return a.startsWith(b.endsWith('/') ? b : `${b}/`);
}

function isRoot(p) {
  const s = K(p);
  return s === '/' || /^[a-z]:\/$/.test(s) || /^\/\/[^/]+(\/[^/]+)?\/?$/.test(s);
}

// $x ${x} $(..) %x% (cmd), !x! (cmd delayed expansion), %a / %%a (cmd for variables), @x (PowerShell splat)
function isDynamic(s) {
  return s.includes(MARK) || /\$[{(A-Za-z_]/.test(s) || /%[A-Za-z_][\w]*%/.test(s) || /![A-Za-z_][\w]*!/.test(s) || /(^|[^%\w])%%?[A-Za-z](?![\w%])/.test(s) || /^@[A-Za-z_]/.test(s);
}

function stripDynamic(s) {
  return s
    .replace(new RegExp(`${MARK}\\d+${MARK}`, 'g'), '')
    .replace(/\$\{[^}]*\}/g, '')
    .replace(/\$env:[A-Za-z_]\w*/gi, '')
    .replace(/\$[A-Za-z_]\w*/g, '')
    .replace(/%[A-Za-z_]\w*%/g, '')
    .replace(/![A-Za-z_]\w*!/g, '')
    .replace(/%%?[A-Za-z](?![\w%])/g, '');
}

// Bash brace expansion of one word: "a{b,c}d" -> abd acd, "{1..3}" -> 1 2 3; nested; bounded.
// "${x}", "@{u}" and "{}" are not expansions.
function findBrace(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] !== '{' || (i > 0 && (s[i - 1] === '$' || s[i - 1] === '@'))) continue;
    let depth = 0;
    const commas = [];
    let end = -1;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '\\') {
        j++;
        continue;
      }
      if (s[j] === '{') depth++;
      else if (s[j] === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      } else if (s[j] === ',' && depth === 1) commas.push(j);
    }
    if (end < 0) return null;
    const body = s.slice(i + 1, end);
    if (commas.length) {
      const alts = [];
      let from = i + 1;
      for (const c of [...commas, end]) {
        alts.push(s.slice(from, c));
        from = c + 1;
      }
      return { start: i, end, alts };
    }
    const r = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.-?(\d+))?$/.exec(body);
    if (r) {
      const num = /^-?\d+$/.test(r[1]) && /^-?\d+$/.test(r[2]);
      const a = num ? Number(r[1]) : r[1].charCodeAt(0);
      const b = num ? Number(r[2]) : r[2].charCodeAt(0);
      const step = Math.max(1, Math.abs(Number(r[3] || 1)));
      const alts = [];
      for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? step : -step) {
        alts.push(num ? String(v) : String.fromCharCode(v));
        if (alts.length >= MAX_BRACE) break;
      }
      return { start: i, end, alts };
    }
  }
  return null;
}

function braceExpand(s, limit = MAX_BRACE) {
  const out = [];
  const rec = (str, depth) => {
    if (out.length >= limit) return;
    const m = depth < 32 ? findBrace(str) : null;
    if (!m) {
      out.push(str);
      return;
    }
    for (const alt of m.alts) {
      rec(str.slice(0, m.start) + alt + str.slice(m.end + 1), depth + 1);
      if (out.length >= limit) return;
    }
  };
  rec(String(s), 0);
  return out;
}

const hasBrace = (s) => /\{[^{}]*(,|\.\.)[^{}]*\}/.test(s);

// Expands the variables whose value the guard knows: home, temp and the working directory.
function expandKnown(s, cwd) {
  let out = String(s).replace(/^(~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|\$\{env:USERPROFILE\}|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%)(?=$|[\\/])/i, slash(os.homedir()));
  out = out.replace(/^(\$TMPDIR|\$\{TMPDIR\}|\$env:TEMP|\$env:TMP|%TEMP%|%TMP%)(?=$|[\\/])/i, slash(os.tmpdir()));
  if (cwd) out = out.replace(/^(\$PWD|\$\{PWD\})(?=$|[\\/])/i, cwd);
  return out;
}

// Normalises a path to forward slashes, resolved against cwd; keeps case (compare with K()).
// Returns null for URLs, and for relative paths when cwd is unknown.
function np(input, cwd) {
  if (input == null) return null;
  let s = String(input).trim().replace(/^["']+|["']+$/g, '');
  if (!s || (/^[a-z][a-z0-9+.-]+:\/\//i.test(s) && !/^file:/i.test(s))) return null;
  s = slash(expandKnown(s, cwd));
  s = s.replace(/^(?:microsoft\.powershell\.core\/)?filesystem::/i, '');
  if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\//i, '');
    if (/^\/[a-z]:/i.test(s)) s = s.slice(1);
    else if (!s.startsWith('/')) s = `//${s}`;
  }
  if (/^\/\/[?.]\//.test(s)) {
    s = s.slice(4);
    if (/^unc\//i.test(s)) s = `//${s.slice(4)}`;
  }
  if (WIN) {
    const m = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?=\/|$)/i.exec(s);
    if (m) s = `${m[1]}:${s.slice(m[0].length)}`;
  }
  let prefix;
  let rest;
  let m = /^([a-z]):\/*(.*)$/i.exec(s);
  if (m) {
    prefix = `${m[1]}:/`;
    rest = m[2];
  } else if (s.startsWith('//')) {
    const parts = s.slice(2).split('/');
    prefix = `//${parts.slice(0, 2).join('/')}/`;
    rest = parts.slice(2).join('/');
  } else if (s.startsWith('/')) {
    prefix = '/';
    rest = s.slice(1);
  } else {
    if (!cwd) return null;
    return np(`${String(cwd).replace(/\/+$/, '')}/${s}`, null);
  }
  const out = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return prefix + out.join('/');
}

// Network (UNC) paths are never touched: a lookup can hang for many seconds, and in command lines
// they are mostly URL fragments ("https://host/x" yields "//host/x").
const isUnc = (p) => /^\/\/[^/]/.test(String(p || ''));

// Real path of the deepest existing ancestor + the rest (defeats symlink tricks for file tools).
function realOf(p) {
  if (!p || isUnc(p)) return null;
  let cur = p;
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try {
      const r = slash(fs.realpathSync.native(cur));
      return tail.length ? `${r.replace(/\/+$/, '')}/${tail.reverse().join('/')}` : r;
    } catch {
      const parent = path.posix.dirname(cur);
      if (parent === cur || !parent) return null;
      tail.push(path.posix.basename(cur));
      cur = parent;
    }
  }
  return null;
}

// Windows 8.3 short names (VAULT~1 for .vault, HADES-~1 for hades-vault) name the same folders as
// the long names: such a path is expanded through the filesystem before it is judged.
const SHORT_SEG = /(^|\/)[^/]*~\d[^/]*(\/|$)/;
function longName(p) {
  if (!WIN || !p || isUnc(p) || !SHORT_SEG.test(p)) return p;
  return realOf(p) || p;
}
// A wildcard in a segment that looks like a short name (VAULT~?, HADES-~*) cannot be expanded safely.
const shortGlob = (p) => WIN && String(p).split('/').some((seg) => /~[\d*?[]/.test(seg) && hasGlob(seg));
// Targets are judged in long form, so every root they are compared with must be long too: a hook
// started through a short path (C:/Users/RUNNER~1/...) would otherwise own nothing it protects.
const ENGINE_DIR = longName(slash(ENGINE_RAW));

// Glob -> RegExp over lower-cased normalised paths. Backslash escapes a character.
function globRe(glob, anchored = true) {
  let re = '';
  const g = K(glob);
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '\\' && i + 1 < g.length) {
      re += g[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (ch === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '[') {
      const j = g.indexOf(']', i + 1);
      if (j > i + 1) {
        let cls = g.slice(i + 1, j);
        if (cls[0] === '!') cls = `^${cls.slice(1)}`;
        re += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = j;
      } else re += '\\[';
    } else re += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(anchored ? `^${re}$` : re);
}

const escGlob = (s) => s.replace(/[\\*?[\]]/g, '\\$&');
const hasGlob = (s) => /[*?[]/.test(s);

function safeGlobRe(glob, anchored = true) {
  try {
    return globRe(glob, anchored);
  } catch {
    return null; // e.g. an invalid range "[z-a]": the shell may still expand it to anything
  }
}

// Expands a glob in a normalised absolute path against the filesystem, segment by segment.
// dot=false: a wildcard does not match a leading "." (bash); dot=true: it does (PowerShell, cmd).
// Returns { paths, overflow, invalid }; paths are the concrete candidates (existing matches, plus
// literal tail segments after a matched directory). Bounded by MAX_GLOB_DIRS readdirs,
// MAX_GLOB_MATCHES candidates and the check's deadline.
function fsGlob(p, { dot = false, deadline = Infinity } = {}) {
  const res = { paths: [], overflow: false, invalid: false };
  const m = /^([a-z]:\/|\/\/[^/]+\/[^/]+\/|\/)(.*)$/i.exec(p || '');
  if (!m) return res;
  if (isUnc(p)) {
    res.paths = [p]; // network paths are not expanded; the pattern itself is still checked
    return res;
  }
  const segs = m[2].split('/').filter(Boolean);
  let cur = [m[1]];
  let dirs = 0;
  const join = (a, b) => (a.endsWith('/') ? `${a}${b}` : `${a}/${b}`);
  for (const seg0 of segs) {
    const seg = seg0 === '**' ? '*' : seg0;
    const next = [];
    if (!hasGlob(seg)) {
      for (const c of cur) next.push(join(c, seg));
    } else {
      const rx = safeGlobRe(seg);
      if (!rx) {
        res.invalid = true;
        return res;
      }
      const explicitDot = seg.startsWith('.');
      for (const c of cur) {
        if (++dirs > MAX_GLOB_DIRS || Date.now() > deadline) {
          res.overflow = true;
          return res;
        }
        let names;
        try {
          names = fs.readdirSync(c);
        } catch {
          continue;
        }
        for (const nm of names) {
          if (!dot && nm.startsWith('.') && !explicitDot) continue;
          if (rx.test(K(nm))) next.push(join(c, nm));
        }
        if (next.length > MAX_GLOB_MATCHES) {
          res.overflow = true;
          return res;
        }
      }
    }
    cur = next;
    if (!cur.length) break;
  }
  res.paths = cur;
  return res;
}

// ---------------------------------------------------------------------------------------------
// Context: policy + paths, loaded lazily
// ---------------------------------------------------------------------------------------------
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('$')) continue;
    const b = base ? base[k] : undefined;
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(b, v) : v;
  }
  return out;
}

function memo(fn) {
  let done = false;
  let v;
  return () => {
    if (!done) {
      v = fn();
      done = true;
    }
    return v;
  };
}

// Built-in self-protection, outside the mergeable policy data (a tuned policy replaces arrays).
// CORE: never exempt. GENERIC: exempt for copies in <vault>/**/legacy/** and for deleting a registered
// project's own .claude folder.
const MANDATORY_CORE = [
  '{engine}/hooks', '{engine}/hooks/**', '{engine}/hades.config.json', '{config}', '{policy}', '{home}/.claude.json',
  '{claude}/settings*.json', '{claude}/hooks', '{claude}/hooks/**', '{claude}/agents/hades', '{claude}/agents/hades/**',
  '{claude}/agents/hades-*', '{claude}/skills/hades*', '{claude}/skills/hades*/**', '{claude}/.claude.json',
  '{workspace}/.claude', '{workspace}/.claude/**', '**/managed-settings*.json', '**/managed-mcp.json',
];
// What "hades export" writes for other coding agents (docs/other-agents.md): instruction files, guard
// hooks, MCP and permission configuration, HADES agents, skills and commands. An agent that could edit
// these could switch its own guard off, so they are protected like the Claude settings.
const EXPORTED_CONFIG = [
  '{workspace}/AGENTS.md', '{workspace}/GEMINI.md',
  '{home}/.codex/**', '{home}/.gemini/**', '{home}/.cursor/**', '{home}/.copilot/**', '{home}/.cline/**',
  '{home}/.config/devin/**', '{home}/.config/opencode/**', '{home}/.agents/skills/hades*', '{home}/.agents/skills/hades*/**',
  '**/.codex/hooks.json', '**/.codex/config.toml', '**/.codex/agents/hades-*', '**/.agents/skills/hades*', '**/.agents/skills/hades*/**',
  '**/.cursor/hooks.json', '**/.cursor/mcp.json', '**/.cursor/cli.json', '**/.cursor/agents/hades-*', '**/.cursor/skills/hades*', '**/.cursor/skills/hades*/**',
  '**/.gemini/settings.json', '**/.gemini/agents/hades-*', '**/.gemini/commands/hades*',
  '**/.github/hooks/hades-*', '**/.github/agents/hades-*', '**/.github/skills/hades*', '**/.github/skills/hades*/**',
  '**/.devin/hooks*.json', '**/.devin/config*.json', '**/.devin/mcp_config*.json', '**/.devin/agents/hades-*', '**/.devin/skills/hades*', '**/.devin/skills/hades*/**',
  '**/devin/config.json', '**/devin/mcp_config.json', '**/devin/agents/hades-*', '**/devin/skills/hades*', '**/devin/skills/hades*/**',
  '**/.clinerules/hooks/**', '**/.cline/hooks/**', '**/cline/hooks/**', '**/.cline/skills/hades*', '**/.cline/skills/hades*/**', '**/cline_mcp_settings.json',
  '**/opencode.json', '**/opencode.jsonc', '**/.opencode/plugins/hades-*', '**/.opencode/agents/hades-*', '**/.opencode/commands/hades*',
  '**/opencode/plugins/hades-*', '**/opencode/agents/hades-*', '**/opencode/commands/hades*',
];
const MANDATORY_GENERIC = [
  '**/.claude/settings*.json', '**/.claude/hooks/**', '**/.claude/agents/hades', '**/.claude/agents/hades/**', '**/.claude/agents/hades-*',
  '**/.claude/skills/hades*', '**/.claude/skills/hades*/**', '**/.mcp.json', '**/.claude.json',
  ...EXPORTED_CONFIG,
];
// Protected file names, for relative paths whose directory is unknown (after "cd" into a glob or a
// variable) and for MCP tools whose root the guard cannot see.
const PROTECTED_BASENAME = /^(settings(\.[^/]*)?\.json|\.mcp\.json|\.claude\.json|managed-settings(\.[^/]*)?\.json|managed-mcp\.json|guard\.mjs|guard-policy\.json|hades\.config\.json)$/i;

function defaultVault(env) {
  if (env.HADES_DEFAULT_VAULT) return path.resolve(env.HADES_DEFAULT_VAULT);
  const current = path.join(ENGINE_DIR, '.vault');
  const legacy = path.join(ENGINE_DIR, 'vault');
  if (!fs.existsSync(current) && fs.existsSync(path.join(legacy, 'registry.json'))) return legacy;
  return current;
}

function makeContext(input, env) {
  const policyFile = longName(slash(path.resolve(env.HADES_GUARD_POLICY || path.join(ENGINE_DIR, 'hooks', 'guard-policy.json'))));
  const loaded = readJson(policyFile);
  const policy = deepMerge(DEFAULT_POLICY, loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {});
  for (const k of ['protectedPaths', 'selfProtected', 'selfProtectedNames', 'neverWritable', 'commandRules', 'rawRules', 'tempDirs', 'pasteHosts', 'gitConfigFiles', 'legacyDirs']) {
    if (!Array.isArray(policy[k])) policy[k] = [];
  }
  const configFile = longName(slash(path.resolve(env.HADES_CONFIG_FILE || path.join(ENGINE_DIR, 'hades.config.json'))));
  const engine = slash(ENGINE_DIR);
  const home = longName(slash(os.homedir()));
  const claudeDir = longName(slash(path.resolve(String(env.CLAUDE_CONFIG_DIR || '').trim() || path.join(os.homedir(), '.claude'))));
  const cwd = longName(np(input.cwd || process.cwd(), null) || slash(process.cwd()));
  const X = { policy, env, agent: String(input.agent_type || ''), cwd, engine, home, configFile, policyFile, claudeDir };
  X.deadline = Date.now() + BUDGET_MS;
  X.config = memo(() => readJson(configFile) || {});
  // Same resolution as lib/core/config.mjs: env, then hades.config.json (relative to the engine),
  // then <engine>/.vault (a legacy <engine>/vault with a registry.json while .vault does not exist).
  // A relative HADES_VAULT / HADES_WORKSPACE is relative to the engine as well (the hook's cwd varies).
  const fromConfig = (v) => (typeof v === 'string' && v ? path.resolve(ENGINE_DIR, v) : null);
  X.vaultConfigured = memo(() => longName(slash(path.resolve(fromConfig(env.HADES_VAULT) || fromConfig(X.config().vault) || defaultVault(env)))));
  // Where a vault sits by default: <engine>/.vault and the legacy <engine>/vault (or HADES_DEFAULT_VAULT).
  X.vaultCandidates = memo(() => (env.HADES_DEFAULT_VAULT ? [longName(slash(path.resolve(env.HADES_DEFAULT_VAULT)))] : [`${engine}/.vault`, `${engine}/vault`]));
  // A configured vault without registry.json (a stale absolute path after the engine folder was
  // renamed, a moved vault) falls back to a default location that holds one, so the real vault keeps
  // its protection and the roles keep their scope. An explicit HADES_VAULT is used as given.
  X.vault = memo(() => {
    const v = X.vaultConfigured();
    if (env.HADES_VAULT || fs.existsSync(`${v}/registry.json`)) return v;
    return X.vaultCandidates().find((d) => fs.existsSync(`${d}/registry.json`)) || v;
  });
  // Every folder protected as a vault whatever the config says: the vault, the configured one, the defaults.
  X.vaultRoots = memo(() => {
    const out = [];
    for (const v of [X.vault(), X.vaultConfigured(), ...X.vaultCandidates()]) if (v && !out.some((o) => K(o) === K(v))) out.push(v);
    return out;
  });
  X.inVault = (p) => X.vaultRoots().some((v) => isInside(p, v));
  X.isRegistry = (p) => X.vaultRoots().some((v) => K(p) === K(`${v}/registry.json`));
  X.workspace = memo(() => longName(slash(path.resolve(fromConfig(env.HADES_WORKSPACE) || fromConfig(X.config().workspace) || path.dirname(ENGINE_DIR)))));
  X.registry = memo(() => readJson(`${X.vault()}/registry.json`) || {});
  X.projects = memo(() => Object.values(X.registry().teams || {}).map((t) => t && t.project_path).filter(Boolean).map((p) => longName(np(p, null))).filter(Boolean));
  X.orgs = memo(() => Object.values(X.registry().organizations || {}).map((o) => o && o.root_path).filter(Boolean).map((p) => longName(np(p, null))).filter(Boolean));
  X.ostmp = memo(() => {
    const out = new Set();
    for (const t of [os.tmpdir(), env.TEMP, env.TMP, env.TMPDIR]) {
      if (!t) continue;
      const n = np(t, null);
      if (n) out.add(n);
      const r = realOf(n);
      if (r) out.add(r);
    }
    return [...out];
  });
  X.expand = (pattern) => {
    const lists = {
      '{home}': () => [home], '{engine}': () => [engine], '{vault}': () => [X.vault()], '{workspace}': () => [X.workspace()],
      '{config}': () => [np(configFile, null)], '{projects}': X.projects, '{orgs}': X.orgs, '{ostmp}': X.ostmp,
      '{temp}': () => X.temp(), '{claude}': () => [claudeDir], '{policy}': () => [policyFile, realOf(policyFile)],
    };
    const m = /\{(home|engine|vault|workspace|config|projects|orgs|ostmp|temp|claude|policy)\}/.exec(pattern);
    if (!m) return [pattern];
    const out = [];
    for (const v of lists[m[0]]().filter(Boolean)) {
      for (const rest of X.expand(pattern.slice(m.index + m[0].length))) out.push(pattern.slice(0, m.index) + escGlob(v) + rest);
    }
    return out;
  };
  X.pathList = (patterns) => patterns.flatMap((p) => X.expand(String(p))).map((p) => np(p.replace(/\\(.)/g, '$1'), null)).filter(Boolean);
  X.globList = (patterns) => patterns.flatMap((p) => X.expand(String(p))).map((p) => safeGlobRe(p)).filter(Boolean);
  X.temp = memo(() => X.pathList(policy.tempDirs.filter((p) => p !== '{temp}')));
  X.protected = memo(() => {
    const out = X.pathList(policy.protectedPaths);
    for (const v of X.vaultRoots()) if (!out.some((q) => K(q) === K(v))) out.push(v);
    return out;
  });
  // Roots, system dirs and home only: used for remote (ssh) commands and filtered find -delete.
  X.protectedCore = memo(() => X.pathList(policy.protectedPaths.filter((p) => !/\{(workspace|vault|engine|projects|orgs)\}/.test(p))));
  X.selfCoreRes = memo(() => X.globList(MANDATORY_CORE));
  X.selfRes = memo(() => [...X.globList(MANDATORY_GENERIC), ...X.globList(policy.selfProtected)]);
  X.legacyRes = memo(() => X.globList(policy.legacyDirs));
  X.gitConfigRes = memo(() => X.globList(policy.gitConfigFiles));
  X.neverRes = memo(() => X.globList(policy.neverWritable));
  // Concrete protected files: a glob pattern that matches one of them is refused even when the file
  // does not exist yet (the filesystem expansion covers existing files).
  X.selfProbes = memo(() => {
    const out = [`${engine}/hooks/guard.mjs`, `${engine}/hooks/guard-policy.json`, `${engine}/hooks/README.md`, `${engine}/hades.config.json`, configFile, policyFile, `${home}/.claude.json`];
    for (const f of ['settings.json', 'settings.local.json', '.claude.json', 'agents/hades/hades-x.md', 'agents/hades-x.md', 'skills/hades/SKILL.md', 'hooks/x']) out.push(`${claudeDir}/${f}`);
    for (const dir of [cwd, X.workspace(), ...X.projects()]) {
      for (const f of ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', '.claude/hooks/x', '.claude/agents/hades/hades-x.md', '.claude/skills/hades/SKILL.md']) out.push(`${dir}/${f}`);
    }
    out.push(`${X.workspace()}/CLAUDE.md`, `${X.workspace()}/AGENTS.md`);
    return out.map((p) => K(np(p, null))).filter(Boolean);
  });
  X.rules = memo(() => policy.commandRules.map((r) => ({
    ...r,
    rx: new RegExp(r.re, r.flags || ''),
    unlessRx: r.unless ? new RegExp(r.unless, r.flags || '') : null,
    pipeRx: r.okPipedTo ? new RegExp(r.okPipedTo, 'i') : null,
  })));
  X.rawRules = memo(() => policy.rawRules.map((r) => ({ ...r, rx: new RegExp(r.re, r.flags || '') })));
  X.secret = memo(() => {
    const s = policy.secrets;
    return {
      paths: s.paths.map((r) => new RegExp(r, 'i')),
      exceptions: s.exceptions.map((r) => new RegExp(r, 'i')),
      notesStem: new RegExp(s.notesStem, 'i'),
      notesExt: new RegExp(s.notesExt, 'i'),
      probes: s.globProbes.map(K),
      varName: new RegExp(s.varName, 'i'),
      use: new Set(s.useCommands),
      gitUse: new Set(s.gitUse),
      flags: s.useFlags || {},
    };
  });
  X.pasteRx = memo(() => {
    const hosts = policy.pasteHosts.map((h) => K(h).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
    return hosts.length ? new RegExp(`(^|[^a-z0-9-])(${hosts.join('|')})($|[^a-z0-9-])`, 'i') : null;
  });
  X.stateTools = memo(() => new RegExp(policy.stateFiles.tools, 'i'));
  X.stateShell = memo(() => new RegExp(policy.stateFiles.shell, 'i'));
  X.selfNames = memo(() => policy.selfProtectedNames.map(K));
  return X;
}

class Block {
  constructor(id, detail = '') {
    this.id = id;
    this.detail = String(detail || '')
      .replace(new RegExp(`${MARK}\\d+${MARK}`, 'g'), '$(...)')
      .replace(/\s+/g, ' ')
      .slice(0, 160);
  }
}

// One line: "HADES guard: <rule id>: <reason>. <what to do instead>"
function message(b) {
  const [reason, instead] = MESSAGES[b.id] || ['blocked by policy', 'Choose a safer alternative.'];
  const parts = b.detail ? b.detail.split(SEP) : [];
  let k = 0;
  const fill = (s) => s.replace(/%s/g, () => parts[k++] ?? '');
  let r = fill(reason);
  const alt = fill(instead);
  if (!reason.includes('%s') && parts[0]) r += ` (${parts[0]})`;
  return `HADES guard: ${b.id}: ${r}. ${alt}`.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------------------------
// Secret paths
// ---------------------------------------------------------------------------------------------
function secretHit(p, X) {
  if (!p) return false;
  const S = X.secret();
  const k = K(p);
  if (S.exceptions.some((r) => r.test(k))) return false;
  if (S.paths.some((r) => r.test(k))) return true;
  const base = k.slice(k.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot > 0 && S.notesExt.test(base.slice(dot + 1)) && S.notesStem.test(base.slice(0, dot)) && !(isInside(k, X.engine) && !isInside(k, X.vault()))) return true;
  return false;
}

// A path that is a secret file, or a directory whose contents are secret (~/.ssh, ~/.aws, ~/.kube).
function secretOrDirHit(p, X) {
  if (!p) return false;
  if (secretHit(p, X)) return true;
  if (X.secret().exceptions.some((r) => r.test(K(p)))) return false;
  const d = String(p).replace(/\/+$/, '');
  if (!['x', 'credentials', 'credentials.db', 'config', 'config.json', 'hosts.yml'].some((f) => secretHit(`${d}/${f}`, X))) return false;
  if (isUnc(p)) return true;
  try {
    return !fs.statSync(p).isFile();
  } catch {
    return true; // missing: may be a directory name
  }
}

// A free-text argument (commit message, defect title) rather than a path: 3+ words in the last segment.
const isSentence = (s) => String(s).slice(String(s).lastIndexOf('/') + 1).trim().split(/\s+/).length >= 3;

// A glob (or {a,b} alternatives) that would match a typical secret file name. dot=true: wildcards
// match dotfiles (ripgrep globs, PowerShell); dot=false: bash semantics.
function secretGlobHit(p, X, { dot = false } = {}) {
  if (!p) return false;
  if (hasBrace(p)) {
    const alts = braceExpand(p);
    if (alts.length > 1 || alts[0] !== p) return alts.some((alt) => secretHit(alt, X) || secretGlobHit(alt, X, { dot }));
  }
  const k = K(p);
  const base = k.slice(k.lastIndexOf('/') + 1);
  if (!hasGlob(base) || (!dot && /^\*(\.\*)?$/.test(base))) return false;
  const dir = k.slice(0, k.lastIndexOf('/') + 1);
  if (/(^|\/)\.(ssh|gnupg)\/$/.test(dir) || /(^|\/)\.aws\/$/.test(dir)) return true;
  const rx = safeGlobRe(base);
  if (!rx) return true; // unverifiable pattern: may match anything
  return X.secret().probes.some((probe) => rx.test(probe) && (dot || !(probe.startsWith('.') && !base.startsWith('.'))));
}

// Secret files below a directory (bounded breadth-first walk; dependency and VCS folders skipped).
// Returns relative paths. Used for recursive readers (grep -r, rg --hidden, findstr /s, ...).
const WALK_SKIP = new Set(['node_modules', '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__', '.tox', '.next', '.nuxt', '.cache', '.gradle', '.terraform', 'target', 'vendor', 'bower_components', '.pnpm-store']);
function secretsBelow(root, X, st) {
  const cache = st ? (st.secretDirs || (st.secretDirs = new Map())) : null;
  const key = K(root);
  if (cache && cache.has(key)) return cache.get(key);
  const found = [];
  if (isUnc(root)) return found;
  let entries = 0;
  try {
    if (fs.statSync(root).isFile()) {
      if (secretHit(root, X)) found.push(root.slice(root.lastIndexOf('/') + 1));
      if (cache) cache.set(key, found);
      return found;
    }
  } catch {
    if (cache) cache.set(key, found);
    return found;
  }
  let level = [''];
  for (let depth = 0; depth < 8 && level.length && found.length < 20; depth++) {
    const next = [];
    for (const rel of level) {
      if (Date.now() > X.deadline || entries > 20000) break;
      let list;
      try {
        list = fs.readdirSync(rel ? `${root}/${rel}` : root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of list) {
        entries++;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!WALK_SKIP.has(e.name)) next.push(r);
          if (secretOrDirHit(`${root}/${r}`, X) && /^\.(ssh|aws|gnupg|kube)$/i.test(e.name)) found.push(`${r}/`);
        } else if (secretHit(`${root}/${r}`, X)) found.push(r);
      }
    }
    level = next;
  }
  if (cache) cache.set(key, found);
  return found;
}

// ---------------------------------------------------------------------------------------------
// Lexer: words, operators, redirections, heredocs; command/process substitutions become nested
// parses whose commands are recorded in st.subs and referenced by markers inside the word.
// Modes: bash (POSIX shells), ps (PowerShell), cmd (cmd.exe).
// ---------------------------------------------------------------------------------------------
function matchClose(src, i, open, close) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "'" || c === '"') {
      const e = src.indexOf(c, j + 1);
      if (e < 0) return src.length;
      j = e;
      continue;
    }
    if (c === '\\' || c === '`') {
      j++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return src.length;
}

function lex(src, mode, st, depth, meta) {
  const out = [];
  const n = src.length;
  const ESC = mode === 'ps' ? '`' : mode === 'cmd' ? '^' : '\\';
  let w = null;
  const heredocs = [];
  const begin = () => {
    if (!w) w = { v: '', raw: '', q: false, sq: false, subs: [], p: 0 };
  };
  const flush = () => {
    if (w) out.push({ t: 'w', ...w });
    w = null;
  };
  const op = (v) => {
    flush();
    out.push({ t: 'op', v });
  };
  const atCmdStart = () => !w && (out.length === 0 || out[out.length - 1].t === 'op');
  const addSub = (inner, kind) => {
    const id = st.subs.length;
    st.subs.push({ text: inner, kind, cmds: [] });
    const before = st.cmds.length;
    parseNested(inner, mode, st, depth + 1, { cwd: meta.cwd, remote: meta.remote, fromScript: meta.fromScript });
    st.subs[id].cmds = st.cmds.slice(before);
    begin();
    w.v += `${MARK}${id}${MARK}`;
    w.raw += `${MARK}${id}${MARK}`;
    w.subs.push(id);
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === ESC && (d === '\n' || (d === '\r' && src[i + 2] === '\n'))) {
      i += d === '\r' ? 3 : 2;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      op('\n');
      i++;
      if (heredocs.length) i = readHeredocs(src, i, heredocs);
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === '\u00a0') {
      flush();
      i++;
      continue;
    }
    if (c === '#' && !w && mode !== 'cmd') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (mode === 'ps' && c === '<' && d === '#') {
      const e = src.indexOf('#>', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === ESC && i + 1 < n) {
      begin();
      w.v += d;
      w.raw += c + d;
      i += 2;
      continue;
    }
    // bash ANSI-C quoting $'..' (escapes decoded: \x70ush is push) and locale strings $".."
    if (mode === 'bash' && c === '$' && d === "'") {
      begin();
      w.q = true;
      let j = i + 2;
      let s = '';
      while (j < n && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src[j + 1];
          const simple = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
          let m;
          if (simple[e] !== undefined) {
            s += simple[e];
            j += 2;
          } else if ((m = /^x([0-9a-fA-F]{1,2})/.exec(src.slice(j + 1, j + 4)))) {
            s += String.fromCharCode(parseInt(m[1], 16));
            j += 1 + m[0].length;
          } else if ((m = /^u([0-9a-fA-F]{1,4})/.exec(src.slice(j + 1, j + 6))) || (m = /^U([0-9a-fA-F]{1,8})/.exec(src.slice(j + 1, j + 10)))) {
            const cp = parseInt(m[1], 16);
            s += cp <= 0x10ffff ? String.fromCodePoint(cp) : '?';
            j += 1 + m[0].length;
          } else if ((m = /^[0-7]{1,3}/.exec(src.slice(j + 1, j + 4)))) {
            s += String.fromCharCode(parseInt(m[0], 8) & 0xff);
            j += 1 + m[0].length;
          } else if (e === 'c' && j + 2 < n) {
            s += String.fromCharCode(src.charCodeAt(j + 2) & 0x1f);
            j += 3;
          } else {
            s += `\\${e}`;
            j += 2;
          }
          continue;
        }
        s += src[j++];
      }
      s = s.replace(/[\u0001\u0002]/g, '\uFFFD');
      w.v += s;
      w.raw += s;
      i = j + 1;
      continue;
    }
    if (mode === 'bash' && c === '$' && d === '"') {
      i++;
      continue;
    }
    if (c === "'") {
      begin();
      w.q = true;
      let j = i + 1;
      let s = '';
      while (j < n) {
        if (src[j] === "'") {
          if (mode === 'ps' && src[j + 1] === "'") {
            s += "'";
            j += 2;
            continue;
          }
          break;
        }
        s += src[j++];
      }
      if (mode !== 'cmd' && /[$%]/.test(s)) w.sq = true; // literal: no variable expansion inside
      w.v += s;
      w.raw += s;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      begin();
      w.q = true;
      let j = i + 1;
      while (j < n) {
        const ch = src[j];
        if (ch === '"') {
          if (mode !== 'bash' && src[j + 1] === '"') {
            w.v += '"';
            w.raw += '"';
            j += 2;
            continue;
          }
          break;
        }
        if (mode === 'bash' && ch === '\\' && j + 1 < n && '"\\$`\n'.includes(src[j + 1])) {
          if (src[j + 1] !== '\n') w.v += src[j + 1];
          w.raw += src[j + 1];
          j += 2;
          continue;
        }
        if (mode === 'ps' && ch === '`' && j + 1 < n) {
          w.v += src[j + 1];
          w.raw += src[j + 1];
          j += 2;
          continue;
        }
        if (mode !== 'cmd' && ch === '$' && src[j + 1] === '(') {
          const e = matchClose(src, j + 1, '(', ')');
          addSub(src.slice(j + 2, e), 'cmd');
          j = e + 1;
          continue;
        }
        if (mode === 'bash' && ch === '`') {
          let e = j + 1;
          while (e < n && src[e] !== '`') e += src[e] === '\\' ? 2 : 1;
          addSub(src.slice(j + 1, e), 'cmd');
          j = e + 1;
          continue;
        }
        w.v += ch;
        w.raw += ch;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (mode === 'ps' && c === '@' && (d === "'" || d === '"') && /^[ \t]*\r?\n/.test(src.slice(i + 2, i + 8))) {
      const endRe = d === "'" ? /\n'@/ : /\n"@/;
      const rest = src.slice(i + 2);
      const m = endRe.exec(rest);
      const body = m ? rest.slice(0, m.index) : rest;
      begin();
      w.q = true;
      w.v += body.replace(/^[ \t]*\r?\n/, '');
      w.raw += body;
      i = m ? i + 2 + m.index + 3 : n;
      continue;
    }
    if (mode !== 'cmd' && c === '$' && d === '(') {
      const e = matchClose(src, i + 1, '(', ')');
      addSub(src.slice(i + 2, e), 'cmd');
      i = e + 1;
      continue;
    }
    if (mode === 'ps' && c === '@' && d === '(') {
      const e = matchClose(src, i + 1, '(', ')');
      addSub(src.slice(i + 2, e), 'cmd');
      i = e + 1;
      continue;
    }
    if (mode === 'bash' && (c === '<' || c === '>') && d === '(' && !w) {
      const e = matchClose(src, i + 1, '(', ')');
      addSub(src.slice(i + 2, e), 'proc');
      i = e + 1;
      continue;
    }
    if (mode === 'bash' && c === '$' && /^(\{IFS\}|IFS(?![A-Za-z0-9_]))/.test(src.slice(i + 1, i + 7))) {
      flush(); // $IFS word splitting
      i += src[i + 1] === '{' ? 6 : 4;
      continue;
    }
    if ((c === '$' || c === '@') && d === '{') {
      const e = matchClose(src, i + 1, '{', '}');
      begin();
      w.v += src.slice(i, e + 1);
      w.raw += src.slice(i, e + 1);
      i = e + 1;
      continue;
    }
    if (mode === 'bash' && c === '`') {
      let e = i + 1;
      while (e < n && src[e] !== '`') e += src[e] === '\\' ? 2 : 1;
      addSub(src.slice(i + 1, e), 'cmd');
      i = e + 1;
      continue;
    }
    if (c === '(') {
      if (!w) {
        const e = matchClose(src, i, '(', ')');
        addSub(src.slice(i + 1, e), 'group');
        i = e + 1;
        continue;
      }
      w.v += c;
      w.raw += c;
      w.p++;
      i++;
      continue;
    }
    if (c === ')') {
      if (w && w.p > 0) {
        w.v += c;
        w.raw += c;
        w.p--;
      } else op(';'); // unmatched: case pattern "a)" or stray; the command after it stands alone
      i++;
      continue;
    }
    if (c === '{' || c === '}') {
      if (mode === 'ps' || (!w && (i + 1 >= n || /[\s;]/.test(d)))) {
        op(';');
        i++;
        continue;
      }
      begin();
      if (c === '{') w.br = true; // unquoted brace: bash brace expansion candidate
      w.v += c;
      w.raw += c;
      i++;
      continue;
    }
    if (c === ';') {
      op(';');
      i++;
      continue;
    }
    if (c === '&') {
      if (d === '&') {
        op('&&');
        i += 2;
        continue;
      }
      if (d === '>' && mode === 'bash') {
        flush();
        const app = src[i + 2] === '>';
        out.push({ t: 'redir', op: app ? '>>' : '>' });
        i += app ? 3 : 2;
        continue;
      }
      if (mode === 'ps' && atCmdStart()) {
        i++;
        continue;
      }
      op('&');
      i++;
      continue;
    }
    if (c === '|') {
      if (d === '|') {
        op('||');
        i += 2;
        continue;
      }
      op('|');
      i += d === '&' ? 2 : 1;
      continue;
    }
    if (c === '>' || c === '<' || (mode === 'ps' && c === '*' && d === '>' && !w)) {
      if (w && /^\d+$/.test(w.v) && !w.q) w = null;
      else flush();
      let j = c === '*' ? i + 1 : i;
      let opv;
      if (src.startsWith('<<<', j)) {
        opv = '<<<';
        j += 3;
      } else if (mode === 'bash' && src.startsWith('<<', j)) {
        opv = src[j + 2] === '-' ? '<<-' : '<<';
        j += opv.length;
      } else if (src.startsWith('>>', j)) {
        opv = '>>';
        j += 2;
      } else {
        opv = src[j];
        j++;
        if (src[j] === '|' || src[j] === '!') j++;
      }
      if (src[j] === '&') {
        j++;
        while (j < n && /[0-9-]/.test(src[j])) j++;
        i = j;
        continue;
      }
      if (opv === '<<' || opv === '<<-') {
        while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
        let delim = '';
        while (j < n && !/[\s;|&<>()]/.test(src[j])) delim += src[j++];
        delim = delim.replace(/["'\\]/g, '');
        const tok = { t: 'heredoc', body: '' };
        out.push(tok);
        if (delim) heredocs.push({ delim, strip: opv === '<<-', tok });
        i = j;
        continue;
      }
      out.push({ t: 'redir', op: opv });
      i = j;
      continue;
    }
    // PowerShell string concatenation without spaces: '.e'+'nv' is .env
    if (mode === 'ps' && c === '+' && w && w.q && (src[i - 1] === "'" || src[i - 1] === '"') && (d === "'" || d === '"')) {
      i++;
      continue;
    }
    begin();
    w.v += c;
    w.raw += c;
    i++;
  }
  flush();
  if (mode === 'ps') {
    // 'a' + 'b' with spaces: one value
    for (let k = out.length - 3; k >= 0; k--) {
      const [a, p, b] = [out[k], out[k + 1], out[k + 2]];
      if (a && p && b && a.t === 'w' && p.t === 'w' && b.t === 'w' && a.q && b.q && !p.q && p.v === '+') {
        out.splice(k, 3, { ...a, v: a.v + b.v, raw: a.raw + b.raw, subs: [...a.subs, ...b.subs] });
      }
    }
  }
  return out;
}

function readHeredocs(src, i, queue) {
  while (queue.length) {
    const h = queue.shift();
    const lines = [];
    while (i < src.length) {
      let e = src.indexOf('\n', i);
      if (e < 0) e = src.length;
      let line = src.slice(i, e).replace(/\r$/, '');
      i = e + 1;
      if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
      if (h.strip) line = line.replace(/^\t+/, '');
      lines.push(line);
    }
    h.tok.body = lines.join('\n');
  }
  return i;
}

// ---------------------------------------------------------------------------------------------
// Parser: simple commands -> unwrapped Cmd records (st.cmds, flattened, in order)
// ---------------------------------------------------------------------------------------------
function newState(X) {
  return {
    X, subs: [], cmds: [], texts: [], parses: 0, pipeSeq: 0, written: new Map(), downloads: new Set(), visited: new Set(),
    vars: new Map(), aliases: new Map(), tainted: new Set(), chars: 0, tokens: 0, overflow: false, byPipe: null,
    work: 0, envSet: new Set(), secretDirs: null,
  };
}

// Charges one unit of work; true (and overflow) once the work or time budget is spent.
function spent(st) {
  if (st.overflow) return true;
  st.work++;
  if (st.work > MAX_WORK || ((st.work & 63) === 0 && Date.now() > st.X.deadline)) st.overflow = true;
  return st.overflow;
}

// Text from files, decoded payloads or other untrusted sources must not carry internal markers.
const clean = (s) => String(s).replace(/[\u0001\u0002]/g, '\uFFFD');

// Commands of one pipeline stage (index built once per check).
function stage(st, pipe, idx) {
  if (!st.byPipe) {
    st.byPipe = new Map();
    for (const c of st.cmds) {
      const k = `${c.pipe}:${c.idx}`;
      if (!st.byPipe.has(k)) st.byPipe.set(k, []);
      st.byPipe.get(k).push(c);
    }
  }
  return st.byPipe.get(`${pipe}:${idx}`) || [];
}

function parseNested(text, mode, st, depth, meta) {
  if (!text || st.overflow) return;
  if (depth > MAX_DEPTH || st.parses >= MAX_PARSES || Date.now() > st.X.deadline) {
    st.overflow = true; // never skip silently: unscanned text could hide anything
    return;
  }
  st.parses++;
  st.chars += text.length;
  if (st.chars > MAX_INPUT_CHARS * 2) {
    st.overflow = true;
    return;
  }
  if (depth > 0) st.texts.push(text);
  const cwdRef = { v: meta.cwd };
  const toks = lex(text, mode, st, depth, { cwd: meta.cwd, remote: meta.remote, fromScript: meta.fromScript });
  let cur = { words: [], redirs: [], heredocs: [] };
  let pipe = st.pipeSeq++;
  let idx = 0;
  let pending = null;
  const finish = () => {
    if (cur.words.length || cur.redirs.length) {
      expandSimple(cur, { mode, depth, cwdRef, pipe, idx, captured: !!meta.captured, remote: !!meta.remote, fromScript: meta.fromScript }, st);
    }
  };
  st.tokens += toks.length;
  if (st.tokens > MAX_TOKENS) {
    st.overflow = true;
    return;
  }
  for (const t of toks) {
    if (st.cmds.length > MAX_CMDS) {
      st.overflow = true;
      return;
    }
    if (t.t === 'w') {
      if (pending) {
        cur.redirs.push({ op: pending, target: t });
        pending = null;
      } else cur.words.push(t);
    } else if (t.t === 'redir') pending = t.op;
    else if (t.t === 'heredoc') cur.heredocs.push(t);
    else if (t.t === 'op') {
      pending = null;
      finish();
      if (t.v === '|') idx++;
      else {
        pipe = st.pipeSeq++;
        idx = 0;
      }
      cur = { words: [], redirs: [], heredocs: [] };
    }
  }
  finish();
}

const mkWord = (v) => ({ v, raw: v, q: false, subs: [], p: 0 });
const quoteWord = (w) => (/[\s;&|<>()$`'"]/.test(w.v) && !w.v.includes(MARK) ? `'${w.v.replace(/'/g, "'\\''")}'` : w.v);

function canonExe(word, mode) {
  const s = slash(word);
  const base = s.slice(s.lastIndexOf('/') + 1).toLowerCase();
  const m = /^(.*?)\.(exe|cmd|bat|com)$/.exec(base);
  let name = m ? m[1] : base;
  if (!m && mode === 'ps' && PS_ALIAS[name]) name = PS_ALIAS[name];
  if (/^python\d+(\.\d+)?w?$/.test(name) || name === 'pythonw') name = 'python';
  if (name === 'claude-code') name = 'claude';
  return name;
}

function pkgBase(spec) {
  let s = spec.replace(/^npm:/, '');
  s = s.replace(/(.)@[^/@]*$/, '$1');
  return s.slice(s.lastIndexOf('/') + 1);
}

function skipOpts(words, valueOpts, positionalSkip = 0) {
  let i = 0;
  let skip = positionalSkip;
  while (i < words.length) {
    const a = words[i].v;
    if (a === '--') return words.slice(i + 1);
    if (a.startsWith('-') && a.length > 1) {
      i += valueOpts.includes(a) ? 2 : 1;
      continue;
    }
    if (skip > 0) {
      skip--;
      i++;
      continue;
    }
    break;
  }
  return words.slice(i);
}

function markCaptured(subIds, st) {
  for (const id of subIds) for (const c of st.subs[id].cmds) c.captured = true;
}

function psParams(args) {
  const named = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = /^-([A-Za-z][\w]*)(?::(.*))?$/.exec(a);
    if (m) {
      const name = m[1].toLowerCase();
      if (m[2] !== undefined) named[name] = m[2];
      else if (PS_VALUE_PARAMS.has(name)) named[name] = args[++i];
      else named[name] = true;
    } else positional.push(a);
  }
  return { named, positional };
}

function posixPositional(args) {
  const out = [];
  let opts = true;
  for (const a of args) {
    if (opts && a === '--') {
      opts = false;
      continue;
    }
    if (opts && a.startsWith('-') && a.length > 1) continue;
    out.push(a);
  }
  return out;
}

const PS_CMDLET = /^(remove|move|rename|copy|set|add|clear|new|out|get|test|invoke|start|tee)-[a-z]+$/;

function positionalFor(c) {
  const cmdStyle = CMD_STYLE.has(c.exeBase);
  if (PS_CMDLET.test(c.exe) && !cmdStyle) {
    const { named, positional } = psParams(c.args);
    const paths = ['path', 'literalpath', 'lp', 'pspath'].map((k) => named[k]).filter((v) => typeof v === 'string');
    return [...paths, ...positional];
  }
  const out = [];
  let opts = true;
  for (const a of c.args) {
    if (opts && a === '--') {
      opts = false;
      continue;
    }
    if (opts && a.startsWith('-') && a.length > 1) continue;
    if (cmdStyle && /^\/[a-z?]([:].*)?$/i.test(a)) continue;
    if (c.exeBase === 'robocopy' && /^\/[a-z]+(:.*)?$/i.test(a)) continue;
    out.push(a);
  }
  return out;
}

function pushCmd(st, meta, exeWord, argWords, extra = {}) {
  const exe = extra.exe || canonExe(exeWord.v, meta.mode);
  const args = argWords.map((w) => w.v);
  const base = slash(exeWord.v);
  const c = {
    exe,
    exeWord: exeWord.v,
    exeBase: base.slice(base.lastIndexOf('/') + 1).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, ''),
    exeDynamic: isDynamic(exeWord.v),
    exeSubs: exeWord.subs || [],
    args,
    argWords,
    mode: meta.mode,
    cwd: meta.cwdRef.v,
    pipe: meta.pipe,
    idx: meta.idx,
    depth: meta.depth,
    captured: !!meta.captured,
    remote: !!meta.remote,
    fromScript: meta.fromScript || null,
    assigns: meta.assigns || [],
    redirs: meta.redirs || [],
    heredocs: meta.heredocs || [],
    stdinWords: meta.stdinWords || [],
    viaArgs: !!meta.viaArgs,
    codeStrings: [],
    code: '',
    ...extra,
  };
  c.line = [c.exe, ...args].join(' ').replace(/[\r\n]+/g, ' ');
  st.cmds.push(c);
  return c;
}

function expandSimple(sc, meta0, st) {
  if (spent(st)) return;
  let mode = meta0.mode;
  let words = sc.words.slice();
  // bash brace expansion of unquoted braces: {git,push} or .{git,x} become separate words
  if (mode === 'bash' && words.some((w) => w.br)) {
    const out = [];
    for (const w of words) {
      if (w.br && hasBrace(w.v)) for (const v of braceExpand(w.v)) out.push({ ...w, v, raw: v, br: false });
      else out.push(w);
      if (out.length > MAX_BRACE * 4) {
        st.overflow = true;
        return;
      }
    }
    words = out;
  }
  const assigns = [];
  let captured = meta0.captured;
  let viaArgs = !!meta0.viaArgs;
  const nested = (text, m, extra = {}) => parseNested(text, m, st, meta0.depth + 1, { cwd: meta0.cwdRef.v, captured, remote: meta0.remote, fromScript: meta0.fromScript, ...extra });
  // Assignments: remember literal values (for "$cmd" execution) and taint values computed by downloads;
  // record which variables were set (nested claude with a moved home/config dir) and scan the values
  // of variables that git or the shell runs as commands (GIT_PAGER, GIT_SSH_COMMAND, ...).
  const noteAssign = (name0, w) => {
    if (!w) return;
    const name = String(name0).replace(/^env:/i, '');
    st.envSet.add(name.toUpperCase());
    if (EXEC_ENV.test(name) && w.v && !w.subs.length) nested(w.v.replace(/^!/, ''), 'bash');
    if (w.subs.length) {
      markCaptured(w.subs, st);
      if (subsDownload(w.subs, st, new Set())) st.tainted.add(name.toLowerCase());
    } else st.vars.set(name, w.v);
  };
  for (const w of words) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\+?=([\s\S]*)$/.exec(w.v) || (mode === 'ps' ? /^\$(?:env:)?([A-Za-z_]\w*)\+?=([\s\S]*)$/i.exec(w.v) : null);
    if (m) noteAssign(m[1], { ...w, v: m[2] });
  }
  if (mode === 'ps') {
    for (const w of words) {
      const m = /(?:\]::(?:start|create)|\.invokescript|\.newscriptblock|\.addscript|\.addcommand)\((.*)\)?/i.exec(w.v);
      if (m) nested(m[1].replace(/[,()]/g, ' '), 'ps');
      const ev = /setenvironmentvariable\(\s*['"]?([A-Za-z_]\w*)/i.exec(w.v);
      if (ev) st.envSet.add(ev[1].toUpperCase());
    }
  }
  if (mode === 'ps' && words.length >= 2 && /^\$[\w:.]+$/.test(words[0].v) && /^[+\-*/]?=$/.test(words[1].v)) {
    captured = true;
    for (const w of words) markCaptured(w.subs, st);
    const name = words[0].v.slice(1).replace(/^(global|script|local):/i, '');
    if (words.length === 3) noteAssign(name, words[2]);
    if (words[2] && DOWNLOADERS.has(canonExe(words[2].v, mode))) st.tainted.add(name.toLowerCase());
    words = words.slice(2);
  }
  while (words.length && mode !== 'ps' && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(words[0].v)) assigns.push(words.shift().v);
  const herestrings = sc.redirs.filter((r) => r.op === '<<<').map((r) => r.target);
  const redirs = sc.redirs.filter((r) => r.op !== '<<<');
  const bodies = [...sc.heredocs.map((h) => h.body), ...herestrings.map((w) => w.v)];
  const meta = () => ({ ...meta0, mode, captured, assigns, redirs, heredocs: sc.heredocs, stdinWords: herestrings, viaArgs });
  // A shell/interpreter reading code from stdin: scan heredocs, here-strings and "< file".
  const stdinSources = () => {
    for (const r of redirs) if (r.op === '<') scanScript(r.target.v, mode === 'cmd' ? 'cmd' : mode === 'ps' ? 'ps' : 'bash', st, meta0);
  };
  const aliasUsed = new Set();

  if (!words.length) {
    if (redirs.length) {
      const c = pushCmd(st, meta(), mkWord(''), [], { exe: '' });
      recordWrites(c, st);
    }
    return;
  }

  for (let hop = 0; hop < 16 && words.length; hop++) {
    if (spent(st)) return;
    const ew = words[0];
    const nm = canonExe(ew.v, mode);
    const args = words.slice(1);
    const av = args.map((w) => w.v);

    // dashed builtins ("git-push", libexec/git-core/git-push.exe) are git <builtin>
    const gm = /^git-([a-z][a-z0-9-]*)$/.exec(nm);
    if (gm && GIT_SUBCOMMANDS.has(gm[1])) {
      words = [{ ...ew, v: 'git' }, mkWord(gm[1]), ...args];
      continue;
    }
    if (mode === 'cmd' && nm === 'set') {
      for (const w of args) {
        const m = /^"?([A-Za-z_]\w*)=([\s\S]*?)"?$/.exec(w.v);
        if (m) noteAssign(m[1], { ...w, v: m[2] });
      }
      break;
    }

    // "$cmd args" where cmd was assigned a literal earlier in this command line; aliases likewise
    const vm = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(ew.v);
    if (vm && st.vars.has(vm[1]) && !aliasUsed.has(`$${vm[1]}`)) {
      aliasUsed.add(`$${vm[1]}`);
      words = [...st.vars.get(vm[1]).split(/\s+/).filter(Boolean).map(mkWord), ...args];
      continue;
    }
    if (!ew.q && st.aliases.has(nm) && !aliasUsed.has(nm)) {
      aliasUsed.add(nm);
      words = [...st.aliases.get(nm).split(/\s+/).filter(Boolean).map(mkWord), ...args];
      continue;
    }
    if (nm === 'alias' && mode !== 'ps') {
      for (const a of av) {
        const m = /^([^=\s]+)=(.+)$/.exec(a);
        if (m) st.aliases.set(m[1].toLowerCase(), m[2]);
      }
      break;
    }
    if (nm === 'set-alias' || nm === 'new-alias') {
      const { named, positional } = psParams(av);
      const name = typeof named.name === 'string' ? named.name : positional[0];
      const value = typeof named.value === 'string' ? named.value : positional[typeof named.name === 'string' ? 0 : 1];
      if (name && value) st.aliases.set(name.toLowerCase(), value);
      break;
    }
    if (ASSIGN_BUILTINS.has(nm) && mode !== 'ps') {
      for (const w of args) {
        const m = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(w.v);
        if (m) noteAssign(m[1], { ...w, v: m[2] });
      }
      break;
    }
    if (mode === 'cmd' && nm === 'if') {
      // cmd "if [/i] [not] exist|defined|errorlevel X cmd" / "if a==b cmd": scan every suffix
      // (each suffix is charged to the work budget: nested "if if if ..." chains end in guard.limit)
      for (let k = 1; k < Math.min(args.length, 16); k++) {
        if (spent(st)) return;
        expandSimple({ words: args.slice(k), redirs: sc.redirs, heredocs: [] }, { ...meta0, captured }, st);
      }
      return;
    }
    if (mode === 'cmd' && nm === 'for') {
      const k = av.findIndex((a) => a.toLowerCase() === 'do');
      if (k >= 0 && k + 1 < args.length) {
        words = args.slice(k + 1);
        continue;
      }
      break;
    }
    if (mode !== 'ps' && !ew.q && BASH_KEYWORDS.has(ew.v) && args.length) {
      words = args;
      continue;
    }
    if (mode === 'ps' && nm === '.' && args.length && !/[\\/]|\.ps1$/i.test(av[0])) {
      words = args;
      continue;
    }

    if (nm === 'env' && !ew.q) {
      let i = 0;
      for (; i < args.length; i++) {
        const a = args[i].v;
        if (a === '--') {
          i++;
          break;
        }
        if (['-u', '-C', '--unset', '--chdir'].includes(a)) {
          i++;
          continue;
        }
        if (a === '-S' || a === '--split-string' || a.startsWith('--split-string=')) {
          const first = a.includes('=') ? a.slice(a.indexOf('=') + 1) : (args[i + 1] || {}).v || '';
          const restWords = args.slice(a.includes('=') ? i + 1 : i + 2);
          nested([first, ...restWords.map(quoteWord)].join(' '), 'bash', { assigns });
          return;
        }
        if (a.startsWith('-')) continue;
        if (/^[A-Za-z_]\w*=/.test(a)) {
          assigns.push(a);
          continue;
        }
        break;
      }
      if (i >= args.length) {
        pushCmd(st, meta(), ew, args.filter((w) => !/^[A-Za-z_]\w*=/.test(w.v)));
        return;
      }
      words = args.slice(i);
      continue;
    }
    if (nm === 'command' && ['-v', '-V'].includes(av[0])) break;
    if (SIMPLE_PREFIX[nm]) {
      if (nm === 'flock' && av.some((a) => a === '-c' || a === '--command')) {
        const k = av.findIndex((a) => a === '-c' || a === '--command');
        if (av[k + 1]) nested(av[k + 1], 'bash');
        return;
      }
      let rest = skipOpts(args, SIMPLE_PREFIX[nm], SKIP_POSITIONAL[nm] || 0);
      if (!rest.length) break;
      if (nm === 'xargs' || nm === 'parallel') {
        viaArgs = true; // arguments arrive on stdin: the subcommand cannot be known
        if (/\s/.test(rest[0].v)) rest = [...rest[0].v.split(/\s+/).filter(Boolean).map(mkWord), ...rest.slice(1)];
      }
      words = rest;
      continue;
    }
    if (nm === 'start' && mode !== 'ps') {
      let i = 0;
      if (args[0] && args[0].q) i = 1;
      while (i < args.length && /^\//.test(args[i].v)) i += /^\/d$/i.test(args[i].v) ? 2 : 1;
      if (i >= args.length) break;
      words = args.slice(i);
      continue;
    }
    if (nm === 'watch') {
      const rest = skipOpts(args, ['-n', '--interval', '-q', '--equexit']);
      if (rest.length) nested(rest.map((w) => w.v).join(' '), 'bash');
      return;
    }
    if (nm === 'script' && av.some((a) => /^-[a-zA-Z]*c$/.test(a) || a === '--command')) {
      const k = av.findIndex((a) => /^-[a-zA-Z]*c$/.test(a) || a === '--command');
      if (av[k + 1]) nested(av[k + 1], 'bash');
      return;
    }
    if (nm === 'su' && av.some((a) => a === '-c' || a === '--command')) {
      const k = av.findIndex((a) => a === '-c' || a === '--command');
      if (av[k + 1]) nested(av[k + 1], 'bash');
      return;
    }
    if (nm === 'runas') {
      const last = av.filter((a) => !a.startsWith('/')).pop();
      if (last) nested(last, 'cmd');
      return;
    }
    if (['npx', 'bunx', 'pnpx'].includes(nm) || (nm === 'npm' && ['exec', 'x'].includes(av[0])) || (['pnpm', 'yarn'].includes(nm) && ['dlx', 'exec'].includes(av[0])) || (nm === 'bun' && av[0] === 'x')) {
      const rest0 = nm === 'npm' || nm === 'pnpm' || nm === 'yarn' || nm === 'bun' ? args.slice(1) : args;
      const ci = rest0.findIndex((w) => w.v === '-c' || w.v === '--call');
      if (ci >= 0 && rest0[ci + 1]) {
        nested(rest0[ci + 1].v, 'bash');
        return;
      }
      const rest = skipOpts(rest0, ['-p', '--package', '--workspace', '-w']);
      if (!rest.length) break;
      words = [{ ...rest[0], v: pkgBase(rest[0].v) }, ...rest.slice(1)];
      continue;
    }
    if (RUNNERS[nm] && RUNNERS[nm].includes(av[0])) {
      const r = args.slice(1);
      const dd = r.findIndex((w) => w.v === '--');
      let rest = dd >= 0 ? r.slice(dd + 1) : skipOpts(r, RUNNER_VALUES);
      if (dd < 0 && (nm === 'aws-vault' || nm === 'direnv') && rest.length) rest = rest.slice(1);
      if (!rest.length) break;
      words = rest;
      continue;
    }
    if (DIRECT_RUNNERS.has(nm)) {
      const dd = args.findIndex((w) => w.v === '--');
      let rest = dd >= 0 ? args.slice(dd + 1) : skipOpts(args, RUNNER_VALUES);
      while (rest.length && /^[A-Za-z_]\w*=/.test(rest[0].v)) rest = rest.slice(1);
      if (!rest.length) break;
      if (nm === 'uvx') rest = [{ ...rest[0], v: pkgBase(rest[0].v) }, ...rest.slice(1)];
      words = rest;
      continue;
    }
    if (nm === 'xargs') {
      const rest = skipOpts(args, SIMPLE_PREFIX.xargs);
      if (!rest.length) break;
      words = rest;
      continue;
    }
    if (nm === 'python') {
      let i = 0;
      let code = null;
      for (; i < args.length; i++) {
        const a = args[i].v;
        if (a === '-m' || /^-m\w/.test(a)) {
          const mod = a === '-m' ? (args[i + 1] || {}).v : a.slice(2);
          const restStart = a === '-m' ? i + 2 : i + 1;
          if (mod) {
            words = [mkWord(mod), ...args.slice(restStart)];
            code = 'module';
          }
          break;
        }
        if (a === '-c') {
          code = (args[i + 1] || {}).v || '';
          break;
        }
        if (['-X', '-W', '--check-hash-based-pycs'].includes(a)) {
          i++;
          continue;
        }
        if (a.startsWith('-') && a !== '-') continue;
        break;
      }
      if (code === 'module') continue;
      const c = pushCmd(st, meta(), ew, args, { exe: 'python', stdinExec: code === null && (i >= args.length || av[i] === '-') });
      if (code !== null) scanCode(code, c, st, meta0);
      else if (c.stdinExec) bodies.forEach((b) => scanCode(b, c, st, meta0));
      finishCmd(c, st, meta0);
      return;
    }
    if (INTERP.has(nm)) {
      const flags = CODE_FLAGS[nm] || [];
      let code = null;
      let i = 0;
      for (; i < args.length; i++) {
        const a = args[i].v;
        if (flags.includes(a)) {
          code = (args[i + 1] || {}).v || '';
          break;
        }
        const eq = flags.find((f) => f.startsWith('--') && a.startsWith(`${f}=`));
        if (eq) {
          code = a.slice(eq.length + 1);
          break;
        }
        if (['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--inspect-port', '-I', '-M'].includes(a)) {
          i++;
          continue;
        }
        if (a.startsWith('-') && a !== '-') continue;
        break;
      }
      if (nm === 'deno' && av[0] === 'eval') code = av[1] || '';
      const script = code === null && i < args.length ? args[i].v : null;
      // the engine's own CLI (only that file: another hades.mjs is an ordinary script)
      if (script && /(^|[\\/])hades\.(mjs|js)$/i.test(script) && !isDynamic(script)) {
        const sp = np(script, meta0.cwdRef.v);
        const cli = K(`${st.X.engine}/bin/hades.mjs`);
        if (sp && (K(sp) === cli || K(realOf(sp) || '') === K(realOf(`${st.X.engine}/bin/hades.mjs`) || cli))) {
          words = [mkWord('hades'), ...args.slice(i + 1)];
          continue;
        }
      }
      if ((nm === 'bun' || nm === 'deno') && ['run', 'task'].includes(av[0])) {
        const c = pushCmd(st, meta(), ew, args, { exe: nm });
        npmScripts(c, st, meta0);
        finishCmd(c, st, meta0);
        return;
      }
      const c = pushCmd(st, meta(), ew, args, { exe: nm, script, stdinExec: code === null && (!script || script === '-' || script === '/dev/stdin') });
      if (code !== null) scanCode(code, c, st, meta0);
      else if (c.stdinExec) bodies.forEach((b) => scanCode(b, c, st, meta0));
      finishCmd(c, st, meta0);
      return;
    }
    if (SHELLS.has(nm) || (nm === 'busybox' && av[0] === 'sh')) {
      const sargs = nm === 'busybox' ? args.slice(1) : args;
      let code = null;
      let i = 0;
      let sFlag = false;
      for (; i < sargs.length; i++) {
        const a = sargs[i].v;
        if (a === '--') {
          i++;
          break;
        }
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) {
          code = sargs[i + 1] || null;
          if (!code) sFlag = true; // "xargs bash -c": the code arrives on stdin/args
          i += 2;
          break;
        }
        if (['-o', '-O', '+O', '+o', '--rcfile', '--init-file'].includes(a)) {
          i++;
          continue;
        }
        if (/^-[a-zA-Z]*s[a-zA-Z]*$/.test(a)) sFlag = true;
        if (/^[-+]/.test(a) && a !== '-') continue;
        break;
      }
      const script = code === null && i < sargs.length && sargs[i].v !== '-' ? sargs[i].v : null;
      const stdinExec = code === null && (sFlag || !script);
      const c = pushCmd(st, meta(), ew, args, { exe: nm === 'busybox' ? 'sh' : nm, stdinExec, codeWord: code, script });
      if (code) nested(code.v, 'bash');
      else if (script) scanScript(script, 'bash', st, meta0);
      if (stdinExec) {
        bodies.forEach((b) => nested(b, 'bash'));
        stdinSources();
      }
      finishCmd(c, st, meta0);
      return;
    }
    if (nm === 'cmd') {
      let code = null;
      for (let i = 0; i < av.length; i++) {
        const a = av[i].replace(/^\/\/+/, '/'); // MSYS (Git Bash) form "cmd //c ..."
        if (/^\/[ckr]$/i.test(a)) {
          code = av.slice(i + 1).join(' ');
          break;
        }
        if (/^\/[ckr]/i.test(a) && !/^\/[ckr]:/i.test(a)) {
          code = [a.slice(2), ...av.slice(i + 1)].join(' ');
          break;
        }
        if (a.startsWith('/')) continue;
        break;
      }
      const c = pushCmd(st, meta(), ew, args, { exe: 'cmd', stdinExec: code === null });
      if (code !== null) nested(code, 'cmd');
      if (code === null) {
        bodies.forEach((b) => nested(b, 'cmd'));
        stdinSources();
      }
      finishCmd(c, st, meta0);
      return;
    }
    if (PWSH.has(nm)) {
      let i = 0;
      let code = null;
      let enc = null;
      let file = null;
      for (; i < av.length; i++) {
        const a = av[i];
        if (!/^[-/]/.test(a) || a === '-') break;
        const name = a.replace(/^[-/]+/, '').split(':')[0].toLowerCase();
        if (name === 'c' || name === 'cmd' || name === 'command' || (name.length >= 3 && 'command'.startsWith(name))) {
          code = av.slice(i + 1).join(' ');
          break;
        }
        if (name === 'e' || name === 'ec' || (name.length >= 2 && name.startsWith('en') && 'encodedcommand'.startsWith(name))) {
          enc = av[i + 1] || '';
          break;
        }
        if (name === 'f' || (name.length >= 2 && 'file'.startsWith(name))) {
          file = av[i + 1] || null;
          break;
        }
        if (name === 'ep' || (name.length >= 2 && name.startsWith('ex') && 'executionpolicy'.startsWith(name))) {
          i++;
          continue;
        }
        // parameters that take a value, matched by any prefix as PowerShell does (-win hidden)
        if (['wd', 'of', 'if'].includes(name) || (name && PS_EXE_VALUE_PARAMS.some((p) => p.startsWith(name)))) {
          i++;
          continue;
        }
      }
      if (code === null && enc === null && file === null && i < av.length) code = av.slice(i).join(' ');
      const stdinExec = (code === null && enc === null && file === null) || code === '-';
      const c = pushCmd(st, meta(), ew, args, { exe: 'powershell', stdinExec });
      if (enc) {
        try {
          nested(clean(Buffer.from(enc, 'base64').toString('utf16le')), 'ps');
        } catch {
          /* undecodable: nothing to scan */
        }
      }
      if (code && code !== '-') {
        nested(code, 'ps');
        if (/\.ps1$/i.test(av[i] || '')) scanScript(av[i], 'ps', st, meta0);
      }
      if (file) scanScript(file, 'ps', st, meta0);
      if (stdinExec) {
        bodies.forEach((b) => nested(b, 'ps'));
        stdinSources();
      }
      finishCmd(c, st, meta0);
      return;
    }
    if (nm === 'wsl') {
      let i = 0;
      let management = false;
      for (; i < av.length; i++) {
        const a = av[i];
        if (a === '--' || a === '-e' || a === '--exec') {
          i++;
          break;
        }
        if (['-d', '--distribution', '-u', '--user', '--cd', '--shell-type', '--distribution-id'].includes(a)) {
          i++;
          continue;
        }
        if (a.startsWith('-')) {
          management = true;
          continue;
        }
        break;
      }
      if (management && i >= av.length) {
        pushCmd(st, meta(), ew, args, { exe: 'wsl' });
        return;
      }
      const rest = args.slice(i);
      if (!rest.length) {
        pushCmd(st, meta(), ew, args, { exe: 'wsl', stdinExec: true });
        return;
      }
      if (rest.some((w) => /[;&|<>$`]/.test(w.v))) nested(rest.map(quoteWord).join(' '), 'bash');
      if (management) pushCmd(st, meta(), ew, args, { exe: 'wsl' });
      mode = 'bash';
      words = rest;
      continue;
    }
    if (nm === 'ssh') {
      const valueOpts = ['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w', '-B'];
      let i = 0;
      while (i < av.length && av[i].startsWith('-')) i += valueOpts.includes(av[i]) ? 2 : 1;
      const c = pushCmd(st, meta(), ew, args, { exe: 'ssh' });
      const remote = args.slice(i + 1);
      if (remote.length) nested(remote.map((w) => w.v).join(' '), 'bash', { remote: true, cwd: null });
      finishCmd(c, st, meta0);
      return;
    }
    if (nm === 'eval') {
      const c = pushCmd(st, meta(), ew, args, { exe: 'eval', stdinExec: false });
      nested(av.join(' '), 'bash');
      echoRescan(args, st, meta0);
      finishCmd(c, st, meta0);
      return;
    }
    if (nm === 'invoke-expression') {
      const { named, positional } = psParams(av);
      const text = typeof named.command === 'string' ? named.command : positional.join(' ');
      const c = pushCmd(st, meta(), ew, args, { exe: 'invoke-expression', stdinExec: true });
      if (text) nested(text, 'ps');
      echoRescan(args, st, meta0);
      finishCmd(c, st, meta0);
      return;
    }
    if (nm === 'source' || nm === '.') {
      const target = av[0];
      const fromProc = args[0] && args[0].subs.length > 0;
      const c = pushCmd(st, meta(), ew, args, { exe: nm, stdinExec: !target || target === '-' || target === '/dev/stdin' || fromProc });
      if (target && !fromProc) scanScript(target, /\.ps1$/i.test(target) || mode === 'ps' ? 'ps' : 'bash', st, meta0);
      if (fromProc) echoRescan(args, st, meta0);
      finishCmd(c, st, meta0);
      return;
    }
    if (nm === 'start-process') {
      const { named, positional } = psParams(av);
      const exe = typeof named.filepath === 'string' ? named.filepath : positional.shift();
      let argText = typeof named.argumentlist === 'string' ? named.argumentlist : typeof named.args === 'string' ? named.args : positional.join(' ');
      argText = argText.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (m, id) => (st.subs[Number(id)] ? st.subs[Number(id)].text : ''));
      if (!exe) break;
      const parts = argText.split(/[,\s]+/).map((s) => s.replace(/^["']|["']$/g, '')).filter(Boolean);
      words = [mkWord(exe), ...parts.map(mkWord)];
      continue;
    }
    if (nm === 'find') {
      const own = [];
      let execDelete = false;
      let k = 0;
      while (k < args.length) {
        const a = args[k].v;
        if (['-exec', '-execdir', '-ok', '-okdir'].includes(a)) {
          let j = k + 1;
          while (j < args.length && ![';', '+', '\\;'].includes(args[j].v)) j++;
          const inner = args.slice(k + 1, j);
          if (inner.length) {
            if (DELETE.has(canonExe(inner[0].v, 'bash'))) execDelete = true;
            expandSimple({ words: inner, redirs: [], heredocs: [] }, { ...meta0, captured }, st);
          }
          k = j + 1;
          continue;
        }
        own.push(args[k]);
        k++;
      }
      const c = pushCmd(st, meta(), ew, own, { exe: 'find', findDelete: execDelete || own.some((w) => w.v === '-delete') });
      finishCmd(c, st, meta0);
      return;
    }
    if (nm === 'git' || nm === 'hub') {
      const globals = [];
      let i = 0;
      let gitCwd = meta0.cwdRef.v;
      while (i < av.length) {
        const a = av[i];
        if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'].includes(a)) {
          globals.push([a, av[i + 1]]);
          if (a === '-C' && av[i + 1] !== undefined) gitCwd = isDynamic(av[i + 1]) ? null : np(av[i + 1], gitCwd);
          i += 2;
          continue;
        }
        const jm = /^(--config-env|--git-dir|--work-tree|--namespace|--super-prefix)=([\s\S]*)$/.exec(a);
        if (jm) {
          globals.push([jm[1], jm[2]]);
          i++;
          continue;
        }
        if (a.startsWith('-')) {
          globals.push([a]);
          i++;
          continue;
        }
        break;
      }
      // config values that git runs as commands: scanned like a nested command line
      const execValue = (key, value) => {
        if (GIT_EXEC_KEY.test(key || '') && value) nested(String(value).replace(/^!/, ''), 'bash');
      };
      for (const [k, v] of globals) {
        if (k === '-c' && v) execValue(v.slice(0, v.includes('=') ? v.indexOf('=') : v.length), v.includes('=') ? v.slice(v.indexOf('=') + 1) : '');
        if (k === '--config-env' && v && v.includes('=')) {
          const ref = v.slice(v.indexOf('=') + 1);
          execValue(v.slice(0, v.indexOf('=')), st.vars.get(ref));
        }
      }
      const sub = av[i] === undefined ? undefined : av[i].toLowerCase();
      if (sub === 'config') {
        const pos = [];
        for (let k = i + 1; k < av.length; k++) {
          if (['--file', '-f', '--blob', '--type', '--default', '--comment', '--value'].includes(av[k])) {
            k++;
            continue;
          }
          if (!av[k].startsWith('-')) pos.push(av[k]);
        }
        if (['set', 'add', 'replace-all'].includes(pos[0])) pos.shift();
        execValue(pos[0], pos[1]);
      }
      const rest = av.slice(i + 1);
      const dd = rest.indexOf('--');
      const c = pushCmd(st, { ...meta(), cwdRef: { v: gitCwd } }, ew, args.slice(i), { exe: nm, gitGlobals: globals, gitSub: sub });
      // git accepts unique prefixes of long options: --har is --hard
      if (sub !== undefined) c.line = [nm, sub, ...rest.map((a, j) => (dd < 0 || j < dd ? gitLong(a) : a))].join(' ').replace(/[\r\n]+/g, ' ');
      finishCmd(c, st, meta0);
      return;
    }
    break;
  }
  if (!words.length) return;
  const c = pushCmd(st, meta(), words[0], words.slice(1), { exe: canonExe(words[0].v, mode) });
  if (['cd', 'set-location', 'pushd', 'push-location', 'chdir'].includes(c.exe)) applyCd(c, meta0.cwdRef, st);
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(c.exe)) npmScripts(c, st, meta0);
  if (!c.exeDynamic && (/[\\/]/.test(c.exeWord) || /\.(sh|bash|zsh|ksh|ps1|bat|cmd)$/i.test(c.exeWord)) && c.exe !== 'hades') {
    const ext = (/\.(\w+)$/.exec(c.exeWord) || [])[1] || '';
    scanScript(c.exeWord, /^ps1$/i.test(ext) ? 'ps' : /^(bat|cmd)$/i.test(ext) ? 'cmd' : 'bash', st, meta0, !ext);
  }
  finishCmd(c, st, meta0);
}

function finishCmd(c, st) {
  recordWrites(c, st);
  recordDownloads(c, st);
}

function applyCd(c, cwdRef, st) {
  const pos = c.mode === 'ps' || c.exe === 'set-location' || c.exe === 'push-location'
    ? (() => {
        const { named, positional } = psParams(c.args);
        return [named.path, named.literalpath, ...positional].filter((v) => typeof v === 'string');
      })()
    : c.args.filter((a) => !/^(-[LPe@]+|\/d)$/i.test(a));
  const t = pos[0];
  if (!t) {
    cwdRef.v = slash(os.homedir());
    return;
  }
  if (t === '-' || isDynamic(t)) {
    cwdRef.v = null;
    return;
  }
  // "cd .clau*": the directory is the single match of the glob; unknown (null) otherwise, so relative
  // targets of protected names are then refused (checkWriteProtected)
  if (hasGlob(t) || (c.mode === 'bash' && hasBrace(t))) {
    const p = np(t, cwdRef.v);
    const g = p && !(c.mode === 'bash' && hasBrace(p)) ? fsGlob(p, { dot: c.mode !== 'bash', deadline: st ? st.X.deadline : Infinity }) : { paths: [] };
    const dirs = (g.paths || []).filter((d) => {
      try {
        return fs.statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
    cwdRef.v = dirs.length === 1 ? dirs[0] : null;
    return;
  }
  cwdRef.v = np(t, cwdRef.v);
}

// Remember content written in this command line (heredoc or echo into a file), so executing that
// file later in the same command is scanned too.
function recordWrites(c, st) {
  for (const r of c.redirs) {
    if (r.op !== '>' && r.op !== '>>') continue;
    const p = np(r.target.v, c.cwd);
    if (!p) continue;
    let content = c.heredocs.map((h) => h.body).join('\n');
    if (!content && PRINTERS.has(c.exe)) content = c.args.join(' ');
    if (content) st.written.set(K(p), content);
  }
  if (['set-content', 'add-content', 'out-file'].includes(c.exe)) {
    const { named, positional } = psParams(c.args);
    const target = named.path || named.literalpath || named.filepath || positional[0];
    const value = typeof named.value === 'string' ? named.value : positional[1];
    const p = typeof target === 'string' ? np(target, c.cwd) : null;
    if (p && value) st.written.set(K(p), value);
  }
}

function urlBase(u) {
  const m = /^[a-z]+:\/\/[^/]+\/(?:[^?#]*\/)?([^/?#]+)/i.exec(u || '');
  return m ? m[1] : null;
}

function recordDownloads(c, st) {
  const a = c.args;
  if (c.exe === 'bitsadmin' && a.some((x) => /^\/transfer$/i.test(x))) {
    const p = np(a[a.length - 1], c.cwd);
    if (p) st.downloads.add(K(p));
    return;
  }
  if (!DOWNLOADERS.has(c.exe) && !(c.exe === 'certutil' && a.some((x) => /^[-/]urlcache$/i.test(x)))) return;
  const outs = [];
  const url = a.find((x) => /^[a-z]+:\/\//i.test(x));
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (['-o', '--output', '-O', '--output-document', '-OutFile', '-outfile', '-Destination'].includes(x) && a[i + 1] && !(c.exe === 'curl' && x === '-O')) outs.push(a[i + 1]);
    else if (/^--(output|output-document)=/.test(x)) outs.push(x.slice(x.indexOf('=') + 1));
    else if (/^-[a-zA-Z]+o$/.test(x) && c.exe === 'curl' && a[i + 1]) outs.push(a[i + 1]);
    else if (/^-[a-zA-Z]+O$/.test(x) && c.exe === 'wget' && a[i + 1]) outs.push(a[i + 1]);
    else if (/^-o\S/.test(x) && c.exe === 'curl') outs.push(x.slice(2));
    else if (/^-O\S/.test(x) && c.exe === 'wget') outs.push(x.slice(2));
    else if (/^-outf/i.test(x) && a[i + 1]) outs.push(a[i + 1]);
  }
  if (c.exe === 'curl' && a.some((x) => x === '-O' || x === '--remote-name' || /^-[a-zA-Z]*O[a-zA-Z]*$/.test(x))) outs.push(urlBase(url));
  if (c.exe === 'wget' && !a.some((x) => /^-[a-zA-Z]*O/.test(x) || x.startsWith('--output-document'))) outs.push(urlBase(url));
  if (c.exe === 'certutil') outs.push(a.filter((x) => !x.startsWith('-') && !x.startsWith('/')).pop());
  for (const r of c.redirs) if (r.op === '>' || r.op === '>>') outs.push(r.target.v);
  for (const o of outs) {
    const p = o && o !== '-' ? np(o, c.cwd) : null;
    if (p) st.downloads.add(K(p));
  }
}

function echoRescan(args, st, meta0) {
  for (const w of args) {
    for (const id of w.subs || []) {
      for (const c of st.subs[id].cmds) {
        if (PRINTERS.has(c.exe) && c.args.length) parseNested(c.args.join(' '), c.mode, st, meta0.depth + 1, { cwd: meta0.cwdRef.v });
      }
    }
  }
}

function scanScript(p, mode, st, meta0, needShebang = false) {
  if (!p || isDynamic(p) || isUnc(slash(p))) return;
  const full = np(p, meta0.cwdRef.v);
  if (!full) return;
  const key = K(full);
  if (st.written.has(key)) {
    parseNested(st.written.get(key), mode, st, meta0.depth + 1, { cwd: meta0.cwdRef.v, fromScript: full });
    return;
  }
  if (st.visited.has(key)) return;
  st.visited.add(key);
  let text;
  try {
    const s = fs.statSync(full);
    if (!s.isFile() || s.size > MAX_SCRIPT_BYTES) return;
    text = fs.readFileSync(full, 'utf8');
  } catch {
    return;
  }
  const first = text.slice(0, 200).split('\n')[0];
  if (first.startsWith('#!') && !/\b(ba|z|k|da|a|mk)?sh\b|pwsh|powershell/.test(first)) return;
  if (needShebang && !first.startsWith('#!')) return;
  const m = /pwsh|powershell/.test(first) ? 'ps' : mode;
  parseNested(clean(text), m, st, meta0.depth + 1, { cwd: meta0.cwdRef.v, fromScript: full });
}

function npmScripts(c, st, meta0) {
  const a = c.args;
  let dir = c.cwd;
  for (let i = 0; i < a.length; i++) {
    if (['--prefix', '-C', '--cwd', '--dir'].includes(a[i]) && a[i + 1]) dir = np(a[i + 1], c.cwd);
    else if (/^--(prefix|cwd|dir)=/.test(a[i])) dir = np(a[i].slice(a[i].indexOf('=') + 1), c.cwd);
  }
  const pos = [];
  for (let i = 0; i < a.length; i++) {
    if (['--prefix', '-C', '--cwd', '--dir', '--filter', '-F', '--workspace', '-w'].includes(a[i])) {
      i++;
      continue;
    }
    if (a[i] === '--') break;
    if (!a[i].startsWith('-')) pos.push(a[i]);
  }
  let name = null;
  const sub = pos[0];
  if (['run', 'run-script', 'rum', 'urn', 'task'].includes(sub)) name = pos[1];
  else if (['test', 't', 'tst'].includes(sub) && c.exe !== 'bun') name = 'test';
  else if (['start', 'stop', 'restart'].includes(sub) && c.exe !== 'bun') name = sub;
  else if (sub && ['pnpm', 'yarn', 'bun'].includes(c.exe) && !PKG_BUILTINS.has(sub)) name = sub;
  if (!name || !dir) return;
  try {
    if (fs.statSync(`${dir}/package.json`).size > 4 * MAX_SCRIPT_BYTES) return;
  } catch {
    return;
  }
  const pkg = readJson(`${dir}/package.json`);
  const scripts = pkg && pkg.scripts;
  if (!scripts || typeof scripts !== 'object') return;
  for (const n of [`pre${name}`, name, `post${name}`]) {
    if (typeof scripts[n] === 'string') parseNested(clean(scripts[n]), 'bash', st, meta0.depth + 1, { cwd: dir, fromScript: `${dir}/package.json#${n}` });
  }
}

function scanCode(code, c, st, meta0) {
  if (!code) return;
  c.code += `\n${code}`;
  st.texts.push(code);
  const lits = [];
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  let m;
  while ((m = re.exec(code)) && lits.length < 200) lits.push(m[1] ?? m[2] ?? m[3] ?? '');
  // Perl word lists: system(qw(git push))
  const qw = /\bqw\s*[([{/]([^)\]}/]*)[)\]}/]/g;
  while ((m = qw.exec(code)) && lits.length < 200) pushAll(lits, m[1].split(/\s+/).filter(Boolean));
  pushAll(c.codeStrings, lits);
  for (const s of lits) if (/\S\s+\S/.test(s)) parseNested(s, 'bash', st, meta0.depth + 1, { cwd: meta0.cwdRef.v });
  if (lits.length > 1) parseNested(lits.join(' '), 'bash', st, meta0.depth + 1, { cwd: meta0.cwdRef.v });
  // argument arrays: execFileSync('git', ['push', ...]), subprocess.run(['git', 'push']) after other
  // literals ("pushing", "child_process"): parse from each literal that names a sensitive program
  for (let k = 1; k < lits.length; k++) {
    if (CODE_EXE.test(lits[k])) parseNested(lits.slice(k, k + 40).join(' '), 'bash', st, meta0.depth + 1, { cwd: meta0.cwdRef.v });
  }
}
const CODE_EXE = /^(.*[\\/])?(git|hub|gh|glab|claude|npm|pnpm|yarn|docker|podman|rm|rmdir|del|rd|powershell|pwsh|cmd|bash|sh|zsh|curl|wget|terraform|aws|kubectl|hades)(\.exe|\.cmd)?$/i;

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------
function ruleAllowed(r, c, X, st) {
  if (r.unlessRx && r.unlessRx.test(c.line)) return true;
  if (r.allowRoles && r.allowRoles.includes(X.agent)) return true;
  if (r.when === 'agent' && !X.agent) return true;
  if (r.okCaptured && c.captured) return true;
  if (r.pipeRx) {
    const next = stage(st, c.pipe, c.idx + 1);
    if (next.some((o) => r.pipeRx.test(o.line))) return true;
  }
  return false;
}

function checkRules(c, X, st) {
  const lines = [c.line];
  if (c.exeDynamic) lines.push(['git', ...c.args].join(' '));
  for (const line of lines) {
    for (const r of X.rules()) {
      if (r.rx.test(line) && !ruleAllowed(r, { ...c, line }, X, st)) return new Block(r.id, line.slice(0, 120));
    }
  }
  return null;
}

function checkGit(c) {
  const isGit = c.exe === 'git' || c.exe === 'hub';
  if (c.assigns.some((a) => /^GIT_CONFIG_(PARAMETERS|COUNT|KEY_\d+|VALUE_\d+|GLOBAL|SYSTEM)\+?=/i.test(a))) return new Block('git.config', 'GIT_CONFIG_* environment');
  if (!isGit) {
    if (c.exeDynamic && /^(push|send-pack|rebase|reset|clean|filter-branch|filter-repo|update-ref|reflog|gc|prune)$/.test(c.args[0] || '')) return new Block('git.dynamic', c.line);
    return null;
  }
  for (const [k, v] of c.gitGlobals || []) {
    if ((k === '-c' || k === '--config-env') && /^(alias|include|includeif)\.|^core\.hookspath(=|$)/i.test(v || '')) return new Block('git.config', `${k} ${v}`);
  }
  const sub = c.gitSub;
  if (sub === undefined) return c.viaArgs ? new Block('git.dynamic', `${c.line} (arguments from xargs)`) : null;
  // only builtins: an alias or git-<name> program could be anything
  if (isDynamic(sub) || !/^[a-z][a-z0-9-]*$/.test(sub) || !(GIT_SUBCOMMANDS.has(sub) || (c.exe === 'hub' && HUB_SUBCOMMANDS.has(sub)))) return new Block('git.dynamic', c.line);
  if (c.viaArgs && !GIT_READ.has(sub)) return new Block('git.dynamic', `${c.line} (arguments from xargs)`);
  return null;
}

// Vault files staged or committed by a repository that is not the vault's own (the engine repository
// when the vault is <engine>/.vault): "git add .vault/registry.json", "git -c core.excludesFile=x add
// .vault", "git commit -- .vault/x". Inside the vault (git -C <vault> add ...) is the vault's own repo.
const GIT_STAGING = new Set(['add', 'stage', 'update-index', 'commit']);
function checkGitVault(c, X) {
  if ((c.exe !== 'git' && c.exe !== 'hub') || !GIT_STAGING.has(c.gitSub || '')) return null;
  const repo = c.cwd ? longName(c.cwd) : null;
  const work = (c.gitGlobals || []).find(([k]) => k === '--work-tree' || k === '--git-dir');
  const args = c.args.slice(1);
  const valueOpt = /^(-m|-F|-C|-c|-t|--message|--file|--author|--date|--template|--reuse-message|--reedit-message|--fixup|--squash|--cleanup|--trailer|--pathspec-from-file|--chmod)$/;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valueOpt.test(a)) {
      i++;
      continue;
    }
    if (!a || (a.startsWith('-') && a !== '-')) continue;
    // pathspec magic: ":(top)x", ":/x", ":!x" (exclusions add nothing)
    let s = a;
    const magic = /^:(\([^)]*\)|[/!^]*)/.exec(s);
    if (magic && /[!^]/.test(magic[1])) continue;
    let base = repo;
    if (magic) {
      s = s.slice(magic[0].length);
      if (/top|\//.test(magic[1])) base = null; // relative to the top of the repository: judge by name below
    }
    const p = base ? np(s, base) : null;
    const lp = p ? longName(p) : null;
    const hit = lp ? X.vaultRoots().find((v) => isInside(lp, v)) : null;
    if (hit && (work || !repo || !isInside(repo, hit))) return new Block('git.vault', a);
    if (!p && /(^|\/)\.?vault(\/|$)/i.test(slash(s)) && repo && !X.inVault(repo) && isInside(repo, X.engine)) return new Block('git.vault', a);
  }
  return null;
}

function checkSession(c, X, st) {
  const sessionVar = (a) => SESSION_ENV.test((/^([A-Za-z_]\w*)\+?=/.exec(a) || [])[1] || '');
  const launches = c.exe === 'claude' || (c.exe === 'hades' && c.args[0] === 'run');
  if (launches && c.assigns.some(sessionVar)) return new Block('self.session', c.line);
  // the home or config dir moved anywhere in the same command line (export, $env:, set, setx, ...)
  if (launches && st) {
    const moved = [...st.envSet].find((n) => SESSION_ENV.test(n));
    if (moved) return new Block('self.session', `${c.line} (${moved} changed)`);
  }
  if (c.exe === 'hades' && /^init( |$)/.test(c.args.join(' '))) {
    if (fs.existsSync(X.configFile)) return new Block('self.protect', 'hades.config.json');
  }
  return null;
}

// b) recursive deletes / moves / re-permissions of protected paths
function deleteTargets(c) {
  const out = [];
  const e = c.exe;
  const recursive = c.args.some((a) => /^-[a-zA-Z]*R[a-zA-Z]*$/.test(a) || a === '--recursive' || /^\/[TRS]$/i.test(a));
  if (DELETE.has(e)) pushAll(out, positionalFor(c).map((t) => ({ t, kind: 'delete' })));
  else if (MOVE.has(e)) {
    const p = positionalFor(c);
    const { named } = c.exe.includes('-') ? psParams(c.args) : { named: {} };
    const src = typeof named.path === 'string' || typeof named.literalpath === 'string' ? p : p.length > 1 ? p.slice(0, -1) : p;
    pushAll(out, src.map((t) => ({ t, kind: 'move' })));
  } else if (PERM.has(e) && recursive) {
    const p = positionalFor(c);
    pushAll(out, (['chmod', 'chown', 'chgrp'].includes(e) ? p.slice(1) : p).map((t) => ({ t, kind: 'perm' })));
  } else if (e === 'robocopy' && c.args.some((a) => /^\/(mir|purge)$/i.test(a))) {
    const p = positionalFor(c);
    if (p[1]) out.push({ t: p[1], kind: 'delete' });
  } else if (e === 'rsync' && c.args.some((a) => a.startsWith('--delete'))) {
    const p = posixPositional(c.args);
    if (p.length > 1) out.push({ t: p[p.length - 1], kind: 'delete' });
  } else if (e === 'find' && c.findDelete) {
    const starts = [];
    for (const a of c.args) {
      if (/^[-(!]/.test(a)) break;
      starts.push(a);
    }
    const selective = findSelective(c.args);
    pushAll(out, (starts.length ? starts : ['.']).map((t) => ({ t, kind: selective ? 'find' : 'delete' })));
  }
  for (const v of [c.exeWord, ...c.args]) {
    const m = /\]::delete\(\s*['"]?([^'",)]+)/i.exec(v || '');
    if (m) out.push({ t: m[1], kind: 'delete' });
  }
  if (c.code) pushAll(out, codeDeleteTargets(c.code).map((t) => ({ t, kind: 'delete' })));
  if (c.exeDynamic && c.args.some((a) => /^-[a-zA-Z]*r[a-zA-Z]*$/i.test(a))) pushAll(out, posixPositional(c.args).map((t) => ({ t, kind: 'delete' })));
  return out;
}

// A find/Get-ChildItem filter that really narrows what is deleted: a name/path pattern with at least
// two literal characters, or -empty. Not "-name '*'", "-Filter *", "-mtime -99999", negations or "-o".
function findSelective(args) {
  if (args.some((a) => ['!', '-not', '-o', '-or'].includes(a) || /^-exclude$/i.test(a))) return false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-(i?name|i?path|i?regex|i?wholename|filter|include)$/i.test(a)) {
      const v = String(args[i + 1] || '').replace(/^['"]|['"]$/g, '');
      const lit = v.replace(/\[[^\]]*\]/g, '').replace(/\.\*|\\./g, '').replace(/[*?^$]/g, '');
      if (lit.length >= 2) return true;
    }
    if (a === '-empty') return true;
  }
  return false;
}

// Paths deleted by inline code: rmtree(r'C:\x'), rmSync(String.raw`x`), Path('x').unlink(), ...
function codeDeleteTargets(code) {
  const out = [];
  const lit = /(?:\b[rRbBuUfF]{1,2}|String\.raw)?(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  const call = /\b(rmtree|rmSync|rmdirSync|removeSync|remove|unlinkSync|unlink|rmdir|rm|Delete|deleteSync|emptyDirSync|emptyDir|remove_dir_all|RemoveAll|delete_tree|rimraf|sync)\s*\(/g;
  let m;
  while ((m = call.exec(code)) && out.length < 200) {
    const from = m.index + m[0].length;
    let depth = 1;
    let j = from;
    for (; j < code.length && j < from + 600 && depth > 0; j++) {
      if (code[j] === '(') depth++;
      else if (code[j] === ')') depth--;
    }
    const inner = code.slice(from, j);
    let s;
    lit.lastIndex = 0;
    while ((s = lit.exec(inner))) out.push(s[2]);
  }
  const chained = /(?:\b[rRbBuUfF]{1,2}|String\.raw)?(['"`])((?:\\.|(?!\1)[^\\\n])*)\1\s*\)\s*\.\s*(rmdir|unlink|rmtree|delete|remove)\s*\(/g;
  while ((m = chained.exec(code)) && out.length < 200) out.push(m[2]);
  return out;
}

// A registered project's own Claude files (.claude/, CLAUDE.md, CLAUDE.local.md, AGENTS.md) may be
// removed (onboarding moves them to the vault's legacy folder); never those of the workspace root,
// the home, the Claude config dir, the engine or the vault.
function projectOwned(p, X) {
  if (!p) return false;
  const k = K(p);
  const segs = k.split('/');
  const i = segs.lastIndexOf('.claude');
  let owner;
  if (i > 0) owner = segs.slice(0, i).join('/');
  else if (/^(claude\.md|claude\.local\.md|agents\.md)$/.test(segs[segs.length - 1])) owner = segs.slice(0, -1).join('/');
  else return false;
  if ([X.workspace(), X.home, X.engine, X.claudeDir, X.vault()].some((d) => K(d) === owner)) return false;
  if ([X.claudeDir, `${X.home}/.claude`, X.engine, X.vault(), `${X.workspace()}/.claude`].some((d) => isInside(k, d))) return false;
  if (X.selfCoreRes().some((r) => r.test(k))) return false;
  return X.projects().some((pr) => isInside(owner, pr) && K(pr) !== K(X.workspace()) && K(pr) !== K(X.home));
}

// Literal (glob-free) checks of one normalised path.
function hitAt(p, kind, c, X, long = true) {
  if (long && !c.remote) {
    // A short name is judged as its long form only: every root it is compared with is long.
    const L = longName(p);
    if (L !== p) return hitAt(L, kind, c, X, false);
  }
  let base = p;
  while (/\/(\*|\.\*|\*\.\*|\*\*)$/.test(base)) base = base.replace(/\/(\*|\.\*|\*\.\*|\*\*)$/, '') || '/';
  if (/^[a-z]:$/i.test(base)) base += '/';
  if (isRoot(base)) return 'filesystem root';
  const kb = K(base);
  const segs = kb.split('/');
  if (segs.includes('.git') && !(kind === 'delete' && /\.lock$/.test(kb))) return '.git';
  if (segs[segs.length - 1] === '.claude' && kind !== 'perm' && !((kind === 'delete' || kind === 'move') && projectOwned(base, X))) return '.claude';
  const prot = c.remote || kind === 'find' ? X.protectedCore() : X.protected();
  for (const q of prot) if (K(q) === kb || isInside(q, kb)) return q;
  return null;
}

function protectedHit(target, kind, c, X, st, depth = 0) {
  if (!target) return null;
  let t = target;
  if (st && st.vars.size) t = t.replace(/\$\{?([A-Za-z_]\w*)\}?|%([A-Za-z_]\w*)%|!([A-Za-z_]\w*)!/g, (m, a, b, d) => (st.vars.has(a || b || d) ? st.vars.get(a || b || d) : m));
  t = expandKnown(t, c.remote ? null : c.cwd);
  // brace alternatives: each one is a target (the parser expands unquoted words; this covers the rest)
  if (c.mode !== 'ps' && depth < 2 && hasBrace(t)) {
    const alts = braceExpand(t);
    if (alts.length > 1 || alts[0] !== t) {
      for (const a of alts) {
        const h = protectedHit(a, kind, c, X, st, depth + 1);
        if (h) return h;
      }
      return null;
    }
  }
  if (isDynamic(t)) {
    if (c.fromScript) return null; // project scripts delete via variables all the time; literal targets still count
    const rest = stripDynamic(t).replace(/["']/g, '');
    if (/^[\\/]*(\*|\.\*|\*\.\*|\.)?[\\/]*$/.test(rest)) return `unresolved ${t.replace(new RegExp(`${MARK}\\d+${MARK}`, 'g'), '$(...)')}`;
    return null;
  }
  const remote = c.remote;
  const p = np(t, remote ? null : c.cwd);
  if (!p) {
    if (/^(\.|\.\/|\*|\.\/\*|\.\*)$/.test(t) && !c.fromScript) return `${t} in an unknown directory`;
    if (remote && /^(~|\$HOME)/.test(t)) return 'remote home';
    return null;
  }
  const lit = hitAt(p, kind, c, X);
  if (lit) return lit;
  const kp = K(p);
  if (hasGlob(kp)) {
    if (!remote && shortGlob(p)) return `unverifiable short-name glob ${t}`;
    // the pattern against every protected path and its ancestors
    let base = kp;
    while (/\/(\*|\.\*|\*\.\*|\*\*)$/.test(base)) base = base.replace(/\/(\*|\.\*|\*\.\*|\*\*)$/, '') || '/';
    const rx = safeGlobRe(base);
    if (!rx) return `unverifiable glob ${t}`;
    const prot = remote || kind === 'find' ? X.protectedCore() : X.protected();
    if (hasGlob(base)) {
      for (const q of prot) {
        let cur = K(q);
        for (let i = 0; i < 64 && cur; i++) {
          if (rx.test(cur)) return q;
          const parent = cur.replace(/\/[^/]*$/, '');
          if (parent === cur || !parent) break;
          cur = parent;
        }
      }
    }
    for (const seg of kp.split('/')) {
      if (seg.startsWith('.') && hasGlob(seg)) {
        const sr = safeGlobRe(seg);
        if (!sr || sr.test('.git')) return '.git';
      }
    }
    // every existing match, checked like a literal target
    if (!remote) {
      const g = fsGlob(p, { dot: c.mode !== 'bash', deadline: X.deadline });
      if (g.invalid) return `unverifiable glob ${t}`;
      if (g.overflow) return `too many matches for ${t}`;
      for (const m of g.paths) {
        const h = hitAt(m, kind, c, X);
        if (h) return h;
      }
    }
  }
  return null;
}

// Targets fed by a pipe: "find ~ | xargs rm -rf", "gci C:\x -Recurse | Remove-Item -Recurse"
function pipedTargets(c, st) {
  if (!DELETE.has(c.exe) || c.idx === 0 || positionalFor(c).length) return [];
  const prev = stage(st, c.pipe, c.idx - 1);
  const out = [];
  for (const p of prev) {
    let starts;
    if (p.exe === 'find') {
      starts = [];
      for (const a of p.args) {
        if (/^[-(!]/.test(a)) break;
        starts.push(a);
      }
    } else if (['get-childitem', 'get-item', 'ls', 'dir', 'resolve-path'].includes(p.exe)) starts = positionalFor(p);
    else if (PRINTERS.has(p.exe)) starts = p.args;
    else continue;
    const selective = findSelective(p.args);
    pushAll(out, (starts.length ? starts : ['.']).map((t) => ({ t: PRINTERS.has(p.exe) ? t : `${t.replace(/[\\/]+$/, '')}/*`, kind: selective ? 'find' : 'delete', cwd: p.cwd })));
  }
  return out;
}

function checkDelete(c, X, st) {
  for (const { t, kind, cwd } of [...deleteTargets(c), ...pipedTargets(c, st)]) {
    if (cwd !== undefined && cwd !== c.cwd) c = { ...c, cwd };
    const hit = protectedHit(t, kind, c, X, st);
    if (hit === '.git') return new Block('fs.git', t);
    if (hit === '.claude') return new Block('self.protect', t);
    if (hit) return new Block('fs.delete', `${hit}: ${t}`);
  }
  for (const r of c.redirs) {
    if ((r.op === '>' || r.op === '>>') && /^(\/dev\/(sd|hd|nvme|disk|rdisk|mmcblk|vd|xvd|dm-|md)|\\\\\.\\physicaldrive|\/\/\.\/physicaldrive)/i.test(r.target.v)) return new Block('fs.device', r.target.v);
  }
  return null;
}

// Path-like strings in words: the word, its raw form, values after "=", "@" or "rev:", list items,
// and (when st is given) the arguments of commands inside its substitutions ("cat $(echo .env)").
// Paths are short: longer strings (inline code, messages) are checked through their string literals.
const MAX_PATH_CHARS = 4096;

function candidates(c, words, st = null) {
  const out = new Set();
  const add = (s) => {
    if (s && s.length <= MAX_PATH_CHARS && !s.includes('\n')) out.add(s);
  };
  for (const w of words) {
    const v = typeof w === 'string' ? w : w.v;
    if (v.length > MAX_PATH_CHARS) continue;
    add(v);
    if (typeof w !== 'string' && w.raw && c.mode === 'bash' && w.raw.includes('\\')) add(slash(w.raw));
    if (v.includes('=')) {
      add(v.slice(v.indexOf('=') + 1));
      add(v.slice(v.lastIndexOf('=') + 1));
    }
    if (v.includes('@')) add(v.slice(v.lastIndexOf('@') + 1));
    const colon = v.lastIndexOf(':');
    if (colon > 1) add(v.slice(colon + 1));
    if (/[,;]/.test(v)) for (const piece of v.split(/[,;]/)) add(piece);
    if (st && typeof w !== 'string') {
      for (const id of w.subs || []) {
        for (const s of (st.subs[id] && st.subs[id].cmds) || []) {
          add(s.exeWord); // a PowerShell (expression) is a value: ('.e'+'nv')
          for (const a of s.args) add(a);
        }
      }
    }
  }
  return [...out];
}

function isReaderCmd(c) {
  if (c.exe === 'hades' || c.exe === '') return c.exe === 'hades';
  if (c.exe === 'git' || c.exe === 'hub') return GIT_READ.has(c.gitSub || '');
  if (c.exe === 'sed' || c.exe === 'perl') return !c.args.some((a) => /^(-i|--in-place)/.test(a) || /^-[a-zA-Z]*i/.test(a));
  if (c.exe === 'awk' || c.exe === 'gawk') return !c.args.some((a) => /inplace/.test(a));
  return READERS.has(c.exe);
}

const COPIERS = set('cp copy copy-item cpi xcopy robocopy rsync scp install');

// The words a shell command may write, create, move or delete, each with del=true when the path is
// removed (rm, git rm, the sources of mv) rather than written. Copy sources are only read.
function writeWords(c) {
  const all = (c.argWords || []).filter((w) => !(c.script && w.v === c.script && INTERP.has(c.exe)));
  const isGit = c.exe === 'git' || c.exe === 'hub';
  if (DELETE.has(c.exe) || (isGit && c.gitSub === 'rm')) return all.map((w) => ({ w, del: true }));
  const copy = COPIERS.has(c.exe);
  const move = MOVE.has(c.exe) || (isGit && c.gitSub === 'mv');
  if (!copy && !move) return all.map((w) => ({ w, del: false }));
  const args = isGit ? c.args.slice(1) : c.args;
  let dest = null;
  let srcs = [];
  if (PS_CMDLET.test(c.exe)) {
    const { named, positional } = psParams(args);
    const p = ['path', 'literalpath', 'lp'].map((k) => named[k]).filter((v) => typeof v === 'string');
    srcs = p.length ? p : positional.slice(0, 1);
    dest = typeof named.destination === 'string' ? named.destination : typeof named.newname === 'string' ? named.newname : positional[p.length ? 0 : 1];
  } else {
    const t = args.findIndex((a) => a === '-t' || a === '--target-directory');
    const tj = args.find((a) => a.startsWith('--target-directory='));
    const pos = CMD_STYLE.has(c.exeBase) || c.exe === 'robocopy' || c.exe === 'xcopy' ? positionalFor({ ...c, args }) : posixPositional(args.filter((a, i) => i !== t + 1 || t < 0));
    if (t >= 0) dest = args[t + 1];
    else if (tj) dest = tj.slice(tj.indexOf('=') + 1);
    if (dest) srcs = pos;
    else if (c.exe === 'robocopy') {
      srcs = pos.slice(0, 1);
      dest = pos[1];
    } else {
      srcs = pos.slice(0, -1);
      dest = pos[pos.length - 1];
    }
  }
  const out = [];
  if (dest) {
    out.push({ w: mkWord(dest), del: false });
    // copying or moving into an existing directory creates <dest>/<basename of each source>
    const dp = np(dest, c.cwd);
    let isDir = /[\\/]$/.test(dest);
    try {
      isDir = isDir || (dp && !isUnc(dp) && fs.statSync(dp).isDirectory());
    } catch {
      /* new path */
    }
    if (isDir && dp) for (const s of srcs) out.push({ w: mkWord(`${dp}/${slash(s).replace(/\/+$/, '').split('/').pop()}`), del: false });
  }
  if (move) for (const s of srcs) out.push({ w: mkWord(s), del: true });
  return out;
}

const gitInternal = (k) => {
  const segs = k.split('/');
  const i = segs.indexOf('.git');
  return i >= 0 && i < segs.length - 1;
};

// f) self-protection, git internals, git config files and h) CLI-owned state files, for shell commands
function checkWriteProtected(c, X, st) {
  if (c.exe === 'hades') return null;
  const reader = isReaderCmd(c);
  const isGit = c.exe === 'git' || c.exe === 'hub';
  const items = [];
  for (const r of c.redirs) if (r.op === '>' || r.op === '>>') items.push({ w: r.target, del: false });
  if (!reader) {
    pushAll(items, writeWords(c));
    const dels = new Set(c.code ? codeDeleteTargets(c.code) : []);
    for (const s of c.codeStrings) items.push({ w: mkWord(s), del: dels.has(s), code: true });
  }
  const inLegacy = (k) => X.legacyRes().some((r) => r.test(k));
  const exempt = (k, del) => inLegacy(k) || (del && projectOwned(k, X));
  const names = X.selfNames();
  // substring check on the full text, so protected names inside inline code are found too
  for (const { w, del } of items) {
    const low = K(slash(w.v));
    const hit = names.find((n) => low.includes(n));
    if (!hit) continue;
    const p = w.v.length <= MAX_PATH_CHARS ? longName(np(w.v, c.cwd)) : null;
    if (p && !/\s/.test(w.v) && exempt(K(p), del) && !X.selfCoreRes().some((r) => r.test(K(p)))) continue;
    return new Block('self.protect', hit);
  }
  let reals = 0;
  for (const { w, del, code } of items) {
    const strs = code ? (w.v.length <= MAX_PATH_CHARS ? [w.v] : []) : candidates(c, [w]);
    for (const s of strs) {
      const r = checkWriteTarget(s, del, c, X, { inLegacy, exempt, isGit, real: reals++ < 64 });
      if (r) return r;
    }
  }
  return null;
}

// One target path of a shell write/delete: braces and globs expanded against the filesystem (every
// match and the pattern itself are checked), symlinks resolved, unknown directories handled by name.
function checkWriteTarget(s, del, c, X, o) {
  if (!s || /^[a-z][a-z0-9+.-]+:\/\//i.test(s)) return null;
  const forms = [];
  const alts = c.mode === 'bash' && hasBrace(s) ? braceExpand(s) : [s];
  for (const a of alts) {
    const p = longName(np(a, c.cwd));
    if (!p) {
      if (c.cwd || c.remote || /^[a-z][a-z0-9+.-]+:/i.test(a)) continue;
      // directory unknown ("cd" into a variable or an ambiguous glob): judge by name
      const rel = K(slash(a)).replace(/^\.\//, '');
      const base = rel.slice(rel.lastIndexOf('/') + 1);
      if (PROTECTED_BASENAME.test(base) || X.selfRes().some((r) => r.test(rel))) return new Block('self.protect', a);
      if (X.stateShell().test(rel)) return new Block('state.direct-edit', a);
      if (!del && !o.isGit && c.exe !== 'find' && gitInternal(rel)) return new Block('git.internals', a);
      continue;
    }
    forms.push(p);
    if (hasGlob(p)) {
      const rx = safeGlobRe(K(p));
      if (!rx) return new Block('guard.limit', `unverifiable glob ${a}`);
      const probe = X.selfProbes().find((f) => rx.test(f));
      if (probe && !o.exempt(probe, del)) return new Block('self.protect', a);
      const g = fsGlob(p, { dot: c.mode !== 'bash', deadline: X.deadline });
      if (g.invalid) return new Block('guard.limit', `unverifiable glob ${a}`);
      if (g.overflow) return new Block('guard.limit', `too many matches for ${a}`);
      pushAll(forms, g.paths);
    }
  }
  for (const p of forms) {
    const ks = [K(p)];
    if (o.real) {
      const r = realOf(p);
      if (r && K(r) !== ks[0]) ks.push(K(r));
    }
    for (const k of ks) {
      if (X.selfCoreRes().some((r) => r.test(k))) return new Block('self.protect', s);
      if (X.selfRes().some((r) => r.test(k)) && !o.exempt(k, del)) return new Block('self.protect', s);
      if (X.stateShell().test(k) || X.isRegistry(k)) return new Block('state.direct-edit', s);
      if (!del && X.gitConfigRes().some((r) => r.test(k))) return new Block('git.config', s);
      if (!del && !o.isGit && c.exe !== 'find' && gitInternal(k)) return new Block('git.internals', s);
      // creating or replacing a .claude folder (cp/mv of a prepared folder) outside the legacy copies
      if (!del && k.slice(k.lastIndexOf('/') + 1) === '.claude' && !o.inLegacy(k) && c.exe !== 'find') return new Block('self.protect', s);
    }
  }
  return null;
}

// d) secret files and secret-looking variables
function checkSecrets(c, X, st) {
  const S = X.secret();
  if (PRINTERS.has(c.exe) || /^\$\{?env:/i.test(c.exeWord)) {
    const vals = c.exe === 'printenv' ? c.args.map((a) => `$${a}`) : [c.exeWord, ...(c.argWords || []).filter((w) => !w.sq).map((w) => w.v)];
    for (const v of vals) {
      const re = /\$\{?(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}?|%([A-Za-z_][A-Za-z0-9_]*)%/gi;
      let m;
      while ((m = re.exec(v))) {
        const name = m[1] || m[2];
        if (S.varName.test(name)) return new Block('secrets.env-print', name);
      }
    }
  }
  // Printers only print their arguments; files are read by other commands.
  if (PRINTERS.has(c.exe) || S.use.has(c.exe) || ((c.exe === 'git' || c.exe === 'hub') && S.gitUse.has(c.gitSub || ''))) return null;
  const flags = S.flags[c.exe] || [];
  if (flags.includes('*')) return null;
  const words = [];
  const aw = c.argWords || [];
  for (let k = 0; k < aw.length; k++) {
    const a = aw[k].v;
    const prev = k > 0 ? aw[k - 1].v : '';
    if (prev && flags.includes(prev)) continue;
    if (flags.some((f) => a.startsWith(`${f}=`))) continue;
    if ((c.exe === 'git' || c.exe === 'hub') && (['-m', '--message'].includes(prev) || a.startsWith('--message='))) continue;
    // exclusion patterns name secrets in order to skip them (grep --exclude=.env*, rg -g '!.env')
    if (/^--exclude(-dir)?=/.test(a) || ['--exclude', '--exclude-dir'].includes(prev) || /^--i?glob=!/.test(a) || /^-g!/.test(a) || (['-g', '--glob', '--iglob'].includes(prev) && a.startsWith('!'))) continue;
    // The HADES CLI only reads files named by --request-file / --from; other arguments are text.
    if (c.exe === 'hades' && !['--request-file', '--from'].includes(prev)) continue;
    words.push(aw[k]);
  }
  const inputs = c.redirs.filter((r) => r.op === '<').map((r) => r.target);
  const cands = [...candidates(c, words, st), ...candidates(c, inputs, st), ...c.codeStrings];
  let globs = 0;
  for (const s of cands) {
    if (isSentence(s)) continue;
    for (const a of c.mode === 'bash' && hasBrace(s) ? braceExpand(s) : [s]) {
      const p = np(a, c.cwd || X.cwd);
      if (!p) continue;
      if (secretOrDirHit(p, X) || secretGlobHit(p, X)) return new Block('secrets.file', s);
      // the files a glob really matches (PowerShell and cmd wildcards also match dotfiles)
      if (hasGlob(p) && globs++ < 32) {
        const g = fsGlob(p, { dot: c.mode !== 'bash', deadline: X.deadline });
        const hit = g.paths.find((m) => secretHit(m, X));
        if (hit) return new Block('secrets.file', `${s} (${hit.slice(hit.lastIndexOf('/') + 1)})`);
      }
    }
  }
  return recursiveRead(c, X, st);
}

// Readers that walk directories: grep -r, rg/ag --hidden|-uu|--no-ignore, ack, findstr /s,
// git grep --no-index|--untracked, Get-ChildItem -Recurse | Select-String|Get-Content, and
// find ... | xargs cat|grep. Blocked when a searched directory holds a secret file the command's own
// include/exclude filters do not leave out.
const VALUE_FLAGS = {
  grep: ['-A', '-B', '-C', '-m', '--max-count', '-d', '--directories', '-D', '--devices', '--label', '--color', '--colour', '--context', '--after-context', '--before-context', '--binary-files', '--exclude-from'],
  rg: ['-A', '-B', '-C', '-m', '--max-count', '-t', '--type', '-T', '--type-not', '--type-add', '--type-clear', '-j', '--threads', '-M', '--max-columns', '--max-depth', '-d', '-E', '--encoding', '-r', '--replace', '--sort', '--sortr', '--pre', '--pre-glob', '--ignore-file', '--path-separator', '--context-separator', '--field-match-separator', '--field-context-separator', '--max-filesize', '--colors', '--color', '--engine', '--dfa-size-limit', '--regex-size-limit', '-g', '--glob', '--iglob'],
};
function globMatches(g, rel, base) {
  const pats = hasBrace(g) ? braceExpand(g) : [g];
  return pats.some((p0) => {
    const p = K(p0.replace(/^\.\//, '').replace(/^\*\*\//, ''));
    const rx = safeGlobRe(p);
    if (!rx) return true;
    return p.includes('/') ? rx.test(K(rel)) : rx.test(K(base));
  });
}

function recursiveRead(c, X, st) {
  const a = c.args;
  const e = c.exe;
  let roots = null;
  const incl = [];
  const excl = [];
  const exclDir = [];
  const positional = (valueFlags, patternFlags) => {
    const pos = [];
    let explicit = false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '--') {
        pushAll(pos, a.slice(i + 1));
        break;
      }
      if (patternFlags.includes(x)) {
        explicit = true;
        i++;
        continue;
      }
      if (patternFlags.some((f) => f.startsWith('--') && x.startsWith(`${f}=`))) {
        explicit = true;
        continue;
      }
      const kv = /^(--include|--exclude|--exclude-dir|--glob|--iglob|-g)(?:=([\s\S]*))?$/.exec(x);
      if (kv) {
        const v = kv[2] !== undefined ? kv[2] : a[++i];
        if (v !== undefined) {
          if (kv[1] === '--include') incl.push(v);
          else if (kv[1] === '--exclude') excl.push(v);
          else if (kv[1] === '--exclude-dir') exclDir.push(v);
          else if (v.startsWith('!')) excl.push(v.slice(1));
          else incl.push(v);
        }
        continue;
      }
      if (valueFlags.includes(x)) {
        i++;
        continue;
      }
      if (x.startsWith('-') && x.length > 1) continue;
      pos.push(x);
    }
    return explicit ? pos : pos.slice(1);
  };
  if (['grep', 'egrep', 'fgrep'].includes(e)) {
    const rec = a.some((x, i) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(x) || x === '--recursive' || x === '--dereference-recursive' || x === '--directories=recurse' || (x === '-d' && a[i + 1] === 'recurse'));
    if (!rec) return null;
    roots = positional(VALUE_FLAGS.grep, ['-e', '--regexp', '-f', '--file']);
  } else if (['rg', 'ag', 'ack'].includes(e)) {
    const unrestricted = e === 'ack' || a.some((x) => x === '--hidden' || x === '--unrestricted' || x === '--all-types' || /^--no-ignore/.test(x) || /^-[a-zA-Z]*[u.]/.test(x));
    roots = positional(VALUE_FLAGS.rg, ['-e', '--regexp', '-f', '--file']);
    // an explicit glob overrides ripgrep's hidden/ignore filtering
    const bad = incl.find((g) => secretHit(np(g.replace(/^\*\*\//, ''), '/'), X) || secretGlobHit(np(g, '/'), X, { dot: true }));
    if (bad) return new Block('secrets.file', `${e} glob ${bad}`);
    if (!unrestricted) return null;
  } else if (e === 'findstr') {
    if (!a.some((x) => /^\/s$/i.test(x))) return null;
    const pos = a.filter((x) => !/^\//.test(x));
    const specs = a.some((x) => /^\/c:/i.test(x)) ? pos : pos.slice(1);
    roots = [];
    for (const s of specs) {
      const n = slash(s);
      roots.push(n.includes('/') ? n.slice(0, n.lastIndexOf('/')) || '/' : '.');
      incl.push(n.slice(n.lastIndexOf('/') + 1));
    }
  } else if ((e === 'git' || e === 'hub') && c.gitSub === 'grep') {
    if (!a.some((x) => x === '--no-index' || x === '--untracked')) return null;
    roots = ['.'];
  } else if (c.idx > 0 && ['select-string', 'get-content', 'cat', 'type', 'grep', 'egrep', 'fgrep', 'head', 'tail', 'less', 'more', 'strings', 'sed', 'awk', 'findstr', 'rg', 'xxd', 'od'].includes(e)) {
    // fed a file list by the previous pipeline stage
    for (const p of stage(st, c.pipe, c.idx - 1)) {
      if (p.exe === 'get-childitem' && p.args.some((x) => /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i.test(x))) {
        const { named, positional: pos } = psParams(p.args);
        roots = [...(typeof named.path === 'string' ? [named.path] : []), ...pos];
        for (const k of ['filter', 'include']) if (typeof named[k] === 'string') pushAll(incl, named[k].split(','));
        if (typeof named.exclude === 'string') pushAll(excl, named.exclude.split(','));
      } else if (p.exe === 'find' && (c.viaArgs || e === 'select-string')) {
        roots = [];
        for (const x of p.args) {
          if (/^[-(!]/.test(x)) break;
          roots.push(x);
        }
        if (!p.args.some((x) => ['!', '-not', '-o', '-or'].includes(x))) {
          p.args.forEach((x, i) => {
            if (/^-i?name$/.test(x) && p.args[i + 1]) incl.push(p.args[i + 1]);
          });
        }
      } else continue;
      if (!roots.length) roots = ['.'];
      break;
    }
    if (!roots) return null;
  } else return null;
  for (const r of roots && roots.length ? roots : ['.']) {
    if (isDynamic(r)) continue;
    const p = np(r, c.cwd || X.cwd);
    if (!p) continue;
    for (const f of secretsBelow(p, X, st)) {
      const rel = f.replace(/\/$/, '');
      const base = rel.slice(rel.lastIndexOf('/') + 1);
      const dirs = rel.split('/').slice(0, -1);
      if (incl.length && !incl.some((g) => globMatches(g, rel, base))) continue;
      if (excl.some((g) => globMatches(g, rel, base))) continue;
      if (exclDir.some((g) => dirs.some((d) => globMatches(g, d, d)))) continue;
      return new Block('secrets.file', `${rel} under ${r} (recursive ${e})`);
    }
  }
  return null;
}

// e) paste and file-sharing hosts
function checkPaste(c, X) {
  const rx = X.pasteRx();
  if (!rx || PASTE_SAFE.has(c.exe)) return null;
  for (const s of [...c.args, ...c.codeStrings]) {
    const m = rx.exec(s);
    if (m) return new Block('publish.paste', m[2]);
  }
  return null;
}

// c) remote code execution
function hasDownloader(c, st, seen = new Set()) {
  if (DOWNLOADERS.has(c.exe)) return true;
  if (c.exe === 'certutil' && c.args.some((a) => /^[-/]urlcache$/i.test(a))) return true;
  if (c.exe === 'bitsadmin' && c.args.some((a) => /^\/transfer$/i.test(a))) return true;
  if ([c.exeWord, ...c.args].some((a) => /download(string|data|file)\s*\(|net\.webclient|system\.net\.http\.httpclient/i.test(a))) return true;
  return subsDownload([...(c.exeSubs || []), ...(c.argWords || []).flatMap((w) => w.subs || [])], st, seen);
}

function subsDownload(ids, st, seen) {
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (st.subs[id].cmds.some((s) => hasDownloader(s, st, seen))) return true;
  }
  return false;
}

const EVALUATORS = set('eval invoke-expression source . bash sh zsh dash ksh fish ash mksh csh tcsh yash python node nodejs bun deno perl ruby php lua luajit osascript powershell cmd');

function refsTainted(words, st) {
  if (!st.tainted.size) return false;
  return words.some((w) => {
    const re = /\$\{?([A-Za-z_]\w*)/g;
    let m;
    while ((m = re.exec(w.v || ''))) if (st.tainted.has(m[1].toLowerCase())) return true;
    return false;
  });
}

function checkRce(c, st) {
  // "$(curl ...)" or `curl ...` in command position executes the download
  if (c.exeDynamic && subsDownload(c.exeSubs || [], st, new Set())) return new Block('rce.subst', c.line);
  if (c.exeDynamic && refsTainted([{ v: c.exeWord }], st)) return new Block('rce.subst', c.line);
  if (EVALUATORS.has(c.exe)) {
    const ids = (c.argWords || []).flatMap((w) => w.subs || []);
    if (subsDownload(ids, st, new Set())) return new Block('rce.subst', c.line);
    if (refsTainted(c.argWords || [], st)) return new Block('rce.subst', c.line);
    if (c.stdinExec && (c.stdinWords || []).length) {
      if (subsDownload(c.stdinWords.flatMap((w) => w.subs || []), st, new Set()) || refsTainted(c.stdinWords, st)) return new Block('rce.subst', c.line);
    }
  }
  if (st.downloads.size) {
    const cands = [];
    if (!c.exeDynamic) cands.push(c.exeWord);
    if (EVALUATORS.has(c.exe) || c.exe === 'chmod') pushAll(cands, posixPositional(c.args));
    if (c.script) cands.push(c.script);
    for (const s of cands) {
      const p = np(s, c.cwd);
      if (p && st.downloads.has(K(p)) && !DOWNLOADERS.has(c.exe)) return new Block('rce.download-exec', s);
    }
  }
  return null;
}

function checkPipelines(st) {
  const pipes = new Map();
  for (const c of st.cmds) {
    if (!pipes.has(c.pipe)) pipes.set(c.pipe, []);
    pipes.get(c.pipe).push(c);
  }
  for (const list of pipes.values()) {
    if (list.length < 2) continue;
    const dl = list.filter((c) => hasDownloader(c, st)).map((c) => c.idx);
    const firstDl = dl.reduce((a, b) => Math.min(a, b), Infinity);
    for (const c of list) {
      if ((c.stdinExec || c.exeDynamic) && c.idx > firstDl) return new Block('rce.pipe', c.line);
    }
    // echo/printf/base64 text or a file piped into a shell: scan that text as commands
    if (list.length > 64) continue;
    for (const c of list) {
      if (!c.stdinExec) continue;
      const mode = c.exe === 'powershell' || c.exe === 'invoke-expression' ? 'ps' : c.exe === 'cmd' ? 'cmd' : 'bash';
      for (const s of list) {
        if (s.idx >= c.idx) continue;
        if (['cat', 'type', 'get-content', 'gc'].includes(s.exe)) {
          const sub = newState(st.X);
          for (const f of posixPositional(s.args)) scanScript(f, mode, sub, { cwdRef: { v: s.cwd }, depth: 0 });
          const b = checkState(sub);
          if (b) return b;
          continue;
        }
        if (!PRINTERS.has(s.exe)) continue;
        let text = s.args.join(' ');
        if (list.some((d) => d.idx > s.idx && d.idx < c.idx && d.exe === 'base64' && d.args.some((a) => /^(-d|--decode|-D)$/.test(a)))) {
          try {
            text = clean(Buffer.from(text.trim(), 'base64').toString('utf8'));
          } catch {
            /* not base64 */
          }
        }
        const sub = newState(st.X);
        parseNested(text, mode, sub, 1, { cwd: c.cwd });
        const b = checkState(sub);
        if (b) return b;
      }
    }
  }
  return null;
}

function checkState(st) {
  const X = st.X;
  if (st.overflow) return new Block('guard.limit', `${st.cmds.length} commands, ${st.tokens} tokens`);
  for (const text of st.texts) {
    for (const r of X.rawRules()) if (r.rx.test(text)) return new Block(r.id, '');
  }
  for (const c of st.cmds) {
    const b = checkRules(c, X, st) || checkGit(c) || checkGitVault(c, X) || checkSession(c, X, st) || checkDelete(c, X, st) || checkWriteProtected(c, X, st) || checkSecrets(c, X, st) || checkPaste(c, X) || checkRce(c, st);
    if (b) return b;
    if (Date.now() > X.deadline) return new Block('guard.limit', 'time budget exceeded');
  }
  const p = checkPipelines(st);
  if (p) return p;
  // a bounded walk or expansion that ran out of time may have stopped early: never allow on that
  return Date.now() > X.deadline ? new Block('guard.limit', 'time budget exceeded') : null;
}

function checkShellText(command, mode, X) {
  if (command.length > MAX_INPUT_CHARS) return new Block('guard.limit', `${command.length} characters`);
  // the guard's internal markers are never legitimate input (and would confuse the parser)
  if (/[\u0001\u0002]/.test(command)) return new Block('guard.limit', 'control character U+0001/U+0002 in the command');
  for (const r of X.rawRules()) if ((r.scope !== 'code' || mode === 'ps') && r.rx.test(command)) return new Block(r.id, '');
  const st = newState(X);
  parseNested(command, mode, st, 0, { cwd: X.cwd });
  return checkState(st);
}

// ---------------------------------------------------------------------------------------------
// File tools: Read, Write, Edit, MultiEdit, NotebookEdit, Grep
// ---------------------------------------------------------------------------------------------
function checkFileTool(tool, ti, X) {
  const raw = ti.file_path || ti.notebook_path || ti.path;
  if (tool === 'Grep') {
    const p = raw ? np(raw, X.cwd) : null;
    if (p && (secretOrDirHit(p, X) || secretOrDirHit(realOf(p), X))) return new Block('secrets.file', raw);
    // ripgrep globs: {a,b} alternatives, and wildcards match dotfiles
    if (typeof ti.glob === 'string' && ti.glob) {
      for (const g of braceExpand(ti.glob)) {
        const gp = np(g.replace(/^!/, ''), X.cwd);
        if (!g.startsWith('!') && (secretHit(gp, X) || secretGlobHit(gp, X, { dot: true }))) return new Block('secrets.file', ti.glob);
      }
    }
    return null;
  }
  if (!raw) return null;
  const p = longName(np(raw, X.cwd)); // both forms below must be long: the roots they are judged against are
  if (!p) return null;
  const real = realOf(p);
  const forms = [p, real].filter(Boolean);
  if (tool === 'Read') {
    if (forms.some((f) => secretHit(f, X))) return new Block('secrets.file', raw);
    return null;
  }
  const kforms = forms.map(K);
  const inLegacy = (k) => X.legacyRes().some((r) => r.test(k));
  if (kforms.some((k) => X.selfCoreRes().some((r) => r.test(k)))) return new Block('self.protect', raw);
  if (kforms.some((k) => X.selfRes().some((r) => r.test(k)) && !inLegacy(k))) return new Block('self.protect', raw);
  if (kforms.some((k) => X.gitConfigRes().some((r) => r.test(k)))) return new Block('git.config', raw);
  if (kforms.some((k) => X.neverRes().some((r) => r.test(k)))) return new Block('scope.vendored', raw);
  if (kforms.some((k) => k.split('/').includes('.git'))) return new Block('git.internals', raw);
  if (forms.some((f) => secretHit(f, X))) return new Block('secrets.file', raw);
  if (forms.some((f) => (X.inVault(f) && X.stateTools().test(K(f))) || X.isRegistry(f))) return new Block('state.direct-edit', raw);
  if (X.agent.startsWith('hades-')) {
    const roles = X.policy.roles || {};
    const scope = Object.prototype.hasOwnProperty.call(roles, X.agent) ? roles[X.agent] : roles.default || [];
    if (!scope.length) return new Block('scope.readonly', X.agent);
    const roots = X.pathList(scope);
    const inScope = (f) => roots.some((r) => isInside(f, r));
    if (!forms.every(inScope)) {
      const names = scope.map((s) => s.replace(/[{}]/g, '')).join(', ');
      return new Block('scope.write', `${X.agent} may not write ${raw}${SEP}${names}`);
    }
    const inEngine = forms.some((f) => isInside(f, X.engine));
    const allowedThere = (f) => isInside(f, X.vault()) || X.projects().some((pr) => isInside(f, pr)) || X.temp().some((t) => isInside(f, t));
    if (inEngine && !forms.every(allowedThere)) return new Block('scope.engine', raw);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Public API and entry point
// ---------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------
// Serena MCP tools (matcher "mcp__serena__.*"). Paths are relative to the Serena project root, which
// the guard cannot see: they are resolved against the session cwd (Serena's default root) and, being
// relative, also judged by name (protected file names, state files, .git internals).
// ---------------------------------------------------------------------------------------------
const SERENA_EDIT = /^(create_text_file|replace_content|replace_in_files|delete_lines|replace_lines|insert_at_line|replace_symbol_body|insert_after_symbol|insert_before_symbol|rename_symbol|safe_delete_symbol|jet_brains_(move|safe_delete|inline_symbol|rename))$/;
const SERENA_READ = /^(read_file|search_for_pattern|get_symbols_overview|find_symbol|find_referencing_symbols|find_implementations|find_declaration|get_diagnostics_for_file|get_diagnostics_for_symbol|list_dir|find_file|jet_brains_[a-z_]+)$/;

function protectedBelow(dir, X) {
  const found = [];
  let level = [dir];
  let entries = 0;
  for (let depth = 0; depth < 8 && level.length && !found.length; depth++) {
    const next = [];
    for (const d of level) {
      if (Date.now() > X.deadline || entries > 20000) return found;
      let list;
      try {
        list = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of list) {
        entries++;
        const p = `${d}/${e.name}`;
        const k = K(p);
        if (e.isDirectory()) {
          if (!WALK_SKIP.has(e.name)) next.push(p);
          continue;
        }
        if (X.selfCoreRes().some((r) => r.test(k)) || X.selfRes().some((r) => r.test(k)) || X.stateShell().test(k)) found.push(p);
      }
    }
    level = next;
  }
  return found;
}

function checkSerena(name, ti, X) {
  const relCheck = (rel) => {
    if (typeof rel !== 'string' || !rel || np(rel, null)) return null; // absolute paths are checked as paths
    const r = K(slash(rel)).replace(/^\.\//, '');
    const base = r.slice(r.lastIndexOf('/') + 1);
    if (PROTECTED_BASENAME.test(base) || X.selfRes().some((x) => x.test(r)) || X.selfCoreRes().some((x) => x.test(r))) return new Block('self.protect', rel);
    if (X.stateShell().test(r)) return new Block('state.direct-edit', rel);
    if (gitInternal(r) || r === '.git') return new Block('git.internals', rel);
    return null;
  };
  if (name === 'execute_shell_command') {
    if (typeof ti.cwd === 'string' && ti.cwd) X.cwd = np(ti.cwd, X.cwd) || X.cwd;
    return typeof ti.command === 'string' && ti.command ? checkShellText(ti.command, WIN ? 'cmd' : 'bash', X) : null;
  }
  if (name === 'serena_repl') {
    if (typeof ti.code !== 'string' || !ti.code) return null;
    const st = newState(X);
    const meta = { mode: 'bash', depth: 0, cwdRef: { v: X.cwd }, pipe: st.pipeSeq++, idx: 0 };
    const c = pushCmd(st, meta, mkWord('python'), [], { exe: 'python' });
    scanCode(clean(ti.code), c, st, meta);
    return checkState(st);
  }
  if (name === 'activate_project') {
    const p = typeof ti.project === 'string' && /[\\/]/.test(ti.project) ? longName(np(ti.project, X.cwd)) : null;
    if (!p) return null;
    if (X.projects().some((pr) => K(pr) === K(p))) return null;
    const bad = [X.engine, ...X.vaultRoots(), X.home, X.claudeDir, X.workspace()].find((d) => K(d) === K(p) || isInside(d, p));
    if (bad) return new Block('scope.write', `Serena may not be rooted at ${ti.project} (contains ${bad})${SEP}a registered project path`);
    // inside the engine or a vault: only a vault team folder (<vault>/**/teams/<team>)
    const teamRoot = X.vaultRoots().some((v) => isInside(p, v) && /\/teams\/[^/]+(\/|$)/.test(K(p).slice(K(v).length)));
    if ((isInside(p, X.engine) || X.inVault(p)) && !teamRoot) return new Block('scope.write', `Serena may not be rooted at ${ti.project} (inside the HADES engine or vault)${SEP}a registered project path`);
    return null;
  }
  if (SERENA_READ.test(name)) {
    for (const rel of [ti.relative_path, ti.target_relative_path]) {
      if (typeof rel !== 'string' || !rel) continue;
      const p = np(rel, X.cwd);
      if (p && (secretOrDirHit(p, X) || secretOrDirHit(realOf(p), X))) return new Block('secrets.file', rel);
    }
    if (name === 'search_for_pattern') {
      for (const g of braceExpand(String(ti.paths_include_glob || ''))) {
        if (g && (secretHit(np(g, X.cwd), X) || secretGlobHit(np(g, X.cwd), X, { dot: true }))) return new Block('secrets.file', ti.paths_include_glob);
      }
      if (ti.skip_ignored_files === false) {
        const root = np(ti.relative_path || '.', X.cwd);
        const hit = root && secretsBelow(root, X, null).find((f) => !(ti.paths_exclude_glob && globMatches(String(ti.paths_exclude_glob), f, f.slice(f.lastIndexOf('/') + 1))));
        if (hit) return new Block('secrets.file', `${hit} (search with skip_ignored_files=false)`);
      }
    }
    return null;
  }
  if (!SERENA_EDIT.test(name)) return null; // memories, onboarding, config: inside Serena's own folders
  if (ti.dry_run === true) return null;
  const rels = [ti.relative_path === undefined || ti.relative_path === null ? '' : ti.relative_path];
  if (ti.target_relative_path !== undefined && ti.target_relative_path !== null) rels.push(ti.target_relative_path);
  for (const rel of rels) {
    if (typeof rel !== 'string') continue;
    const b = relCheck(rel);
    if (b) return b;
    const p = np(rel || '.', X.cwd);
    if (!p) continue;
    const fb = checkFileTool('Edit', { file_path: p }, X);
    if (fb) return fb;
    if (name === 'replace_in_files' || name.startsWith('jet_brains_')) {
      // a directory: everything below it may change
      const lp = longName(p);
      const big = [X.engine, ...X.vaultRoots(), X.home, X.claudeDir, X.workspace()].find((d) => K(d) === K(lp) || isInside(d, lp));
      if (big && !X.projects().some((pr) => K(pr) === K(p) || isInside(p, pr))) return new Block('scope.write', `${name} over ${rel || '(project root)'} reaches ${big}${SEP}one registered project folder`);
      const hit = protectedBelow(p, X).find((f) => {
        const r = slash(path.posix.relative(K(X.cwd), K(f)));
        const b = r.slice(r.lastIndexOf('/') + 1);
        if (ti.paths_exclude_glob && globMatches(String(ti.paths_exclude_glob), r, b)) return false;
        if (ti.paths_include_glob && !globMatches(String(ti.paths_include_glob), r, b)) return false;
        return true;
      });
      if (hit) return new Block('self.protect', `${hit.slice(hit.lastIndexOf('/', hit.lastIndexOf('/') - 1) + 1)} below ${rel || 'the project root'} (narrow relative_path or use paths_exclude_glob)`);
      if (Date.now() > X.deadline) return new Block('guard.limit', `${name} over ${rel || 'the project root'}: too large to verify`);
    }
  }
  return null;
}

export function evaluate(input, env = process.env) {
  if (!input || typeof input !== 'object') return null;
  const tool = input.tool_name;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const X = makeContext(input, env);
  let b = null;
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = typeof ti.command === 'string' ? ti.command : '';
    if (cmd) b = checkShellText(cmd, tool === 'PowerShell' ? 'ps' : 'bash', X);
  } else if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep'].includes(tool)) {
    b = checkFileTool(tool, ti, X);
  } else if (typeof tool === 'string' && tool.startsWith('mcp__serena__')) {
    b = checkSerena(tool.slice('mcp__serena__'.length), ti, X);
  }
  return b ? { id: b.id, detail: b.detail, message: message(b) } : null;
}

// For the CLI: check a command line it is about to run (team.json commands). shell: bash|powershell|cmd.
export function checkShell(command, { shell = 'bash', cwd = process.cwd(), agentType = '' } = {}, env = process.env) {
  const mode = shell === 'powershell' || shell === 'ps' ? 'ps' : shell === 'cmd' ? 'cmd' : 'bash';
  const X = makeContext({ cwd, agent_type: agentType }, env);
  const b = checkShellText(String(command || ''), mode, X);
  return b ? { id: b.id, detail: b.detail, message: message(b) } : null;
}

// ---------------------------------------------------------------------------------------------
// Adapters for other coding agents: "guard.mjs --format <platform>" (registered by "hades export").
// adaptInput() maps the platform's documented pre-tool hook payload to the Claude-style inputs that
// evaluate() reads (one platform call can become several checks: every file of a patch, a shell
// command read as Bash and PowerShell where the platform's Windows shell is not documented);
// adapterOutput() maps the decision to the platform's documented output and exit contract.
// Tools the guard does not check map to no input (allowed). Docs: docs/other-agents.md.
// ---------------------------------------------------------------------------------------------
export const GUARD_FORMATS = ['claude', 'codex', 'cursor', 'gemini', 'copilot', 'windsurf', 'cline', 'opencode'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Parameters some platforms pass JSON-encoded (Cursor MCP arguments, Cline tool parameters).
function decoded(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!/^[[{]/.test(t)) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

function strOf(o, keys) {
  if (!isObj(o)) return null;
  for (const k of keys) if (typeof o[k] === 'string' && o[k]) return o[k];
  return null;
}

// A command given as an argument vector (["bash", "-lc", "..."]) becomes one quoted command line.
function commandText(v) {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return '';
  return v.map((a) => (/^[\w@%+=:,./\\-]+$/.test(String(a)) ? String(a) : `'${String(a).replace(/'/g, "'\\''")}'`)).join(' ');
}

// File paths of an apply_patch text ("*** Add File: x" envelope of Codex, OpenCode, Devin) or of a
// unified diff ("+++ b/x"). op: add | update | delete.
export function patchPaths(text) {
  const out = [];
  const seen = new Set();
  const add = (p, op) => {
    const v = String(p).trim().replace(/^"(.*)"$/, '$1');
    if (!v || v === '/dev/null' || seen.has(`${op}\u0000${v}`)) return;
    seen.add(`${op}\u0000${v}`);
    out.push({ path: v, op });
  };
  const s = String(text || '');
  const envelope = /^\*\*\* (Begin Patch|(Add|Update|Delete) File:)/m.test(s);
  for (const line of s.split(/\r?\n/)) {
    let m = /^\*\*\* (Add|Update|Delete) File:\s*(.+)$/.exec(line);
    if (m) {
      add(m[2], m[1].toLowerCase());
      continue;
    }
    m = /^\*\*\* Move to:\s*(.+)$/.exec(line);
    if (m) {
      add(m[1], 'add');
      continue;
    }
    if (envelope) continue; // envelope bodies are +/-/space lines: "--- x" there is content
    m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      add(m[1], 'update');
      add(m[2], 'update');
      continue;
    }
    m = /^(?:\+\+\+|---) (?:[ab]\/)?([^\t]+?)(?:\t.*)?$/.exec(line);
    if (m) add(m[1], 'update');
  }
  return out;
}

// One platform call -> Claude-style guard inputs.
export function adaptInput(format, payload, { win = WIN, env = process.env } = {}) {
  const p = isObj(payload) ? payload : {};
  if (format === 'claude') return [p];
  const roots = (v) => (Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null);
  const base = {
    hook_event_name: 'PreToolUse',
    session_id: String(p.session_id || p.sessionId || p.conversation_id || p.taskId || ''),
    cwd: strOf(p, ['cwd']) || roots(p.workspace_roots) || roots(p.workspaceRoots) || (format === 'windsurf' ? env.DEVIN_PROJECT_DIR : null) || process.cwd(),
  };
  if (typeof p.agent_type === 'string' && p.agent_type) base.agent_type = p.agent_type;
  const out = [];
  // shell: bash | ps | auto (Windows shell not documented: both the Bash and the PowerShell reading must pass)
  const shell = (cmd, mode, extra = {}) => {
    const command = commandText(cmd);
    if (!command) return;
    const tools = mode === 'ps' ? ['PowerShell'] : mode === 'auto' && win ? ['Bash', 'PowerShell'] : ['Bash'];
    for (const t of tools) out.push({ ...base, ...extra, tool_name: t, tool_input: { command } });
  };
  const file = (tool, filePath, extra = {}) => {
    if (typeof filePath === 'string' && filePath) out.push({ ...base, tool_name: tool, tool_input: { ...extra, file_path: filePath } });
  };
  const patch = (text) => {
    for (const f of patchPaths(text)) file(f.op === 'add' ? 'Write' : 'Edit', f.path, { content: '' });
  };
  const grep = (dir, glob) => out.push({ ...base, tool_name: 'Grep', tool_input: { pattern: '', path: typeof dir === 'string' && dir ? dir : undefined, glob: typeof glob === 'string' ? glob : undefined } });
  const serena = (tool, args) => out.push({ ...base, tool_name: `mcp__serena__${tool}`, tool_input: isObj(decoded(args)) ? decoded(args) : {} });
  const PATH_KEYS = ['file_path', 'filePath', 'path', 'target_file', 'absolute_path', 'absolutePath', 'notebook_path'];
  const PATCH_KEYS = ['patch', 'patchText', 'input', 'diff', 'command', 'content'];
  const editOrPatch = (tool, ti) => {
    const f = strOf(ti, PATH_KEYS);
    if (f) file(tool, f);
    else patch(strOf(ti, PATCH_KEYS));
  };
  const name = String(p.tool_name || p.toolName || '');
  const ti = decoded(p.tool_input !== undefined ? p.tool_input : p.toolArgs);
  const t = isObj(ti) ? ti : {};

  if (format === 'codex') {
    // PreToolUse; Bash and apply_patch carry the command or the patch text in tool_input.command.
    if (name === 'Bash') shell(t.command !== undefined ? t.command : t.cmd, 'auto');
    else if (['apply_patch', 'Edit', 'Write'].includes(name)) editOrPatch(name === 'Write' ? 'Write' : 'Edit', t);
    else if (name.startsWith('mcp__serena__')) serena(name.slice('mcp__serena__'.length), t);
  } else if (format === 'copilot') {
    // PascalCase PreToolUse: snake_case payload with Claude tool names (powershell is reported as Bash);
    // camelCase preToolUse: {toolName, toolArgs} with runtime names.
    const lower = name.toLowerCase();
    const mcp = /^(?:mcp__serena__|serena\/|serena-)(.+)$/.exec(name);
    if (['bash', 'shell'].includes(lower)) shell(t.command, 'auto');
    else if (lower === 'powershell') shell(t.command, 'ps');
    else if (['read', 'view'].includes(lower)) file('Read', strOf(t, PATH_KEYS));
    else if (['write', 'create'].includes(lower)) file('Write', strOf(t, PATH_KEYS));
    else if (['edit', 'multiedit', 'str_replace_editor', 'apply_patch', 'notebookedit'].includes(lower)) editOrPatch('Edit', t);
    else if (['grep', 'rg'].includes(lower)) grep(strOf(t, ['path']), strOf(t, ['glob', 'include']));
    else if (mcp) serena(mcp[1], t);
  } else if (format === 'cursor') {
    const ev = String(p.hook_event_name || '');
    if (ev === 'beforeShellExecution' || (!name && typeof p.command === 'string' && ev !== 'beforeMCPExecution')) shell(p.command, 'auto');
    else if (ev === 'beforeReadFile') file('Read', strOf(p, ['file_path', 'path']));
    else if (ev === 'beforeMCPExecution') {
      const tool = name.replace(/^MCP:/, '').replace(/^mcp__serena__/, '');
      if (p.mcp_server_name === 'serena' || name.startsWith('mcp__serena__')) serena(tool, p.tool_input);
    } else if (name === 'Shell') shell(t.command, 'auto');
    else if (name === 'Read') file('Read', strOf(t, PATH_KEYS));
    else if (name === 'Write' || name === 'Delete') editOrPatch(name === 'Write' ? 'Write' : 'Edit', t);
    else if (name === 'Grep') grep(strOf(t, ['path', 'target_directory']), strOf(t, ['glob', 'include']));
  } else if (format === 'gemini') {
    // BeforeTool. The shell tool runs "powershell.exe -NoProfile -Command" on Windows, bash -c elsewhere.
    const mcp = /^mcp_serena_(.+)$/.exec(name);
    if (name === 'run_shell_command') {
      const dir = strOf(t, ['dir_path', 'directory']);
      shell(t.command, win ? 'ps' : 'bash', dir ? { cwd: path.resolve(base.cwd, dir) } : {});
    } else if (name === 'write_file') file('Write', strOf(t, PATH_KEYS));
    else if (name === 'replace' || name === 'edit') file('Edit', strOf(t, PATH_KEYS));
    else if (name === 'read_file') file('Read', strOf(t, PATH_KEYS));
    else if (name === 'read_many_files') {
      for (const f of [].concat(t.paths || [], t.include || [])) if (typeof f === 'string') file('Read', f);
    } else if (name === 'grep_search' || name === 'search_file_content') grep(strOf(t, ['dir_path', 'path']), strOf(t, ['include', 'glob']));
    else if (mcp) serena(mcp[1], t);
  } else if (format === 'windsurf') {
    // Devin Local / Devin CLI PreToolUse (Windsurf is now Devin Desktop).
    if (name === 'exec') shell(t.command !== undefined ? t.command : t.cmd, 'auto');
    else if (name === 'write_to_process') shell(strOf(t, ['input', 'text', 'data']), 'auto');
    else if (name === 'read' || name === 'notebook_read') file('Read', strOf(t, PATH_KEYS));
    else if (name === 'write') file('Write', strOf(t, PATH_KEYS));
    else if (name === 'edit' || name === 'notebook_edit') editOrPatch('Edit', t);
    else if (name === 'apply_patch') editOrPatch('Edit', t);
    else if (name === 'grep') grep(strOf(t, ['path']), strOf(t, ['glob', 'include']));
    else if (name.startsWith('mcp__serena__')) serena(name.slice('mcp__serena__'.length), t);
  } else if (format === 'cline') {
    // File hook "PreToolUse": {preToolUse: {toolName, parameters}}; the CLI also sends tool_call.
    const pre = isObj(p.preToolUse) ? p.preToolUse : isObj(p.tool_call) ? { toolName: p.tool_call.name, parameters: p.tool_call.input } : {};
    const tool = String(pre.toolName || '');
    const raw = decoded(pre.parameters);
    const params = {};
    if (isObj(raw)) for (const [k, v] of Object.entries(raw)) params[k] = decoded(v);
    const each = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
    if (['execute_command', 'run_commands', 'run_command'].includes(tool)) {
      for (const c of [...each(params.command), ...each(params.commands)]) shell(isObj(c) ? c.command : c, 'auto');
    } else if (['write_to_file', 'new_file'].includes(tool)) file('Write', strOf(params, PATH_KEYS));
    else if (['replace_in_file', 'editor', 'edit_file', 'apply_patch'].includes(tool)) editOrPatch('Edit', params);
    else if (['read_file', 'read_files'].includes(tool)) {
      for (const f of [...each(params.path), ...each(params.paths), ...each(params.files), ...each(params.file_path)]) file('Read', isObj(f) ? f.path : f);
    } else if (['search_files', 'search_codebase'].includes(tool)) grep(strOf(params, ['path']), strOf(params, ['file_pattern', 'glob']));
    else if (tool === 'use_mcp_tool' && params.server_name === 'serena' && typeof params.tool_name === 'string') serena(params.tool_name, params.arguments);
  } else if (format === 'opencode') {
    // Payload written by the exported plugin: {tool_name: input.tool, tool_input: output.args, cwd}.
    const mcp = /^serena_(.+)$/.exec(name);
    if (name === 'bash') shell(t.command, 'auto');
    else if (name === 'write') file('Write', strOf(t, PATH_KEYS));
    else if (['edit', 'multiedit'].includes(name)) file('Edit', strOf(t, PATH_KEYS));
    else if (['patch', 'apply_patch'].includes(name)) editOrPatch('Edit', t);
    else if (name === 'read') file('Read', strOf(t, PATH_KEYS));
    else if (name === 'grep') grep(strOf(t, ['path']), strOf(t, ['include', 'glob']));
    else if (mcp) serena(mcp[1], t);
  }
  return out;
}

// The platform's answer for a decision (message: null = allow). warn: an optional stderr note.
export function adapterOutput(format, message, { warn = '' } = {}) {
  const deny = message !== null && message !== undefined;
  const line = deny ? `${message}\n` : '';
  switch (format) {
    case 'cursor': // permission hooks must print valid JSON; exit 2 also denies
      return deny
        ? { stdout: `${JSON.stringify({ permission: 'deny', user_message: message, agent_message: message })}\n`, stderr: line, code: 2 }
        : { stdout: '{"permission":"allow"}\n', stderr: warn, code: 0 };
    case 'gemini': // exit 2 = system block, stderr is the reason; {} = no decision (normal confirmations apply)
      return deny ? { stdout: '', stderr: line, code: 2 } : { stdout: '{}\n', stderr: warn, code: 0 };
    case 'windsurf': // exit 2 blocks; "approve" would skip Devin's own permission check, so allow prints nothing
      return deny ? { stdout: `${JSON.stringify({ decision: 'block', reason: message })}\n`, stderr: line, code: 2 } : { stdout: '', stderr: warn, code: 0 };
    case 'cline': // stdout JSON is required; cancel: true blocks
      return deny ? { stdout: `${JSON.stringify({ cancel: true, errorMessage: message })}\n`, stderr: '', code: 0 } : { stdout: '{"cancel":false}\n', stderr: warn, code: 0 };
    default: // claude, codex, copilot, opencode: exit 2 + one stderr line blocks; exit 0 allows
      return { stdout: '', stderr: deny ? line : warn, code: deny ? 2 : 0 };
  }
}

function logBlock(res, input, format = 'claude') {
  try {
    const file = process.env.HADES_GUARD_LOG || path.join(ENGINE_DIR, '.hades', 'guard.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const ti = (input && input.tool_input) || {};
    const subject = String(ti.command || ti.file_path || ti.notebook_path || ti.path || '')
      .replace(/(bearer\s+|token[=:]\s*|password[=:]\s*|secret[=:]\s*)\S+/gi, '$1***')
      .replace(/[A-Za-z0-9+/_=-]{32,}/g, '***')
      .slice(0, 300);
    const line = { at: new Date().toISOString(), rule: res.id, tool: input && input.tool_name, agent: (input && input.agent_type) || null, session: (input && input.session_id) || null, cwd: (input && input.cwd) || null, subject };
    if (format !== 'claude') line.format = format;
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
  } catch {
    /* best effort */
  }
}

// A configured vault without registry.json (stale hades.config.json after a rename or a move): the
// guard keeps protecting the default locations, and says so on allowed calls.
export function vaultWarning(env = process.env) {
  try {
    const X = makeContext({ cwd: ENGINE_DIR }, env);
    const v = X.vaultConfigured();
    if (fs.existsSync(`${v}/registry.json`)) return '';
    const used = X.vault();
    return `HADES guard: warning: the configured vault ${v} has no registry.json${K(used) !== K(v) ? `; using ${used}` : ''}. Run "hades doctor".\n`;
  } catch {
    return '';
  }
}

export function policyFileText() {
  const comment = 'HADES guard policy, merged over the built-in defaults in guard.mjs: objects merge, arrays and scalars replace. Placeholders: {home} {engine} {vault} {workspace} {config} {projects} {orgs} {ostmp} (OS temp dirs) {temp} (tempDirs) {claude} (CLAUDE_CONFIG_DIR or ~/.claude) {policy} (this file). The guard\'s own files, this policy file, the HADES config and the Claude settings/agents/skills/hooks stay protected whatever this file says. Rule ids: hooks/README.md. Regenerate the shipped copy with: node hooks/guard.mjs --print-policy > hooks/guard-policy.json';
  return `${JSON.stringify({ $comment: comment, ...DEFAULT_POLICY }, null, 2)}\n`;
}

function main() {
  if (process.argv.includes('--print-policy')) {
    process.stdout.write(policyFileText());
    return;
  }
  // --format <platform> (or --format=<platform>): the stdin/stdout contract of another coding agent.
  const argv = process.argv.slice(2);
  const fi = argv.indexOf('--format');
  const fe = argv.find((a) => a.startsWith('--format='));
  const format = fi >= 0 ? String(argv[fi + 1] || '') : fe ? fe.slice('--format='.length) : 'claude';
  if (!GUARD_FORMATS.includes(format)) {
    // A misregistered hook must not silently allow everything.
    process.stderr.write(`HADES guard: guard.config: unknown --format "${format}" (one of ${GUARD_FORMATS.join(', ')}); call blocked. Re-run "hades export <target>".\n`);
    process.exitCode = 2;
    return;
  }
  const respond = (msg, warn = '') => {
    const o = adapterOutput(format, msg, { warn });
    if (o.stdout) process.stdout.write(o.stdout);
    if (o.stderr) process.stderr.write(o.stderr);
    process.exitCode = o.code;
  };
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  if (String(process.env.HADES_GUARD || '').toLowerCase() === 'off') {
    respond(null, 'HADES guard: off (HADES_GUARD=off); no checks applied. Owner-only debugging aid.\n');
    return;
  }
  let input = null;
  let calls = [];
  try {
    input = JSON.parse(raw.replace(/^\uFEFF/, ''));
    calls = format === 'claude' ? [input] : adaptInput(format, input);
    for (const call of calls) {
      const res = evaluate(call);
      if (res) {
        logBlock(res, call, format);
        respond(res.message);
        return;
      }
    }
    respond(null, vaultWarning());
  } catch (err) {
    // Fail closed when the call could touch something the guard protects (high-risk keyword in the
    // command or path); fail open otherwise so a guard bug cannot brick ordinary work.
    const fields = (ti) => (ti && typeof ti === 'object' ? [ti.command, ti.file_path, ti.notebook_path, ti.path, ti.glob, ti.relative_path, ti.target_relative_path, ti.code, ti.project].filter((v) => typeof v === 'string').join(' ') : '');
    let subject;
    if (format === 'claude') {
      const ti = input && input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : null;
      subject = ti ? fields(ti) : input ? '' : raw;
    } else {
      subject = calls.length ? calls.map((c) => fields(c && c.tool_input)).join(' ') : input ? JSON.stringify(input) : raw;
    }
    if (HIGH_RISK.test(subject)) {
      respond(`HADES guard: guard.error: internal error (${String((err && err.message) || err).slice(0, 120)}) while checking a call that may touch protected data; blocked to stay safe. Retry with a simpler command; report the guard error to the owner.`.replace(/\s+/g, ' ').trim());
      return;
    }
    respond(null, `HADES guard: warning: internal error (${String((err && err.message) || err).slice(0, 200)}); call allowed (fail-open).\n`);
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && (WIN ? invoked.toLowerCase() === SELF_FILE.toLowerCase() : invoked === SELF_FILE)) main();
