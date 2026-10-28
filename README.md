```text
$ committide --help

                           .:=+*********+=:.
                       .:=******************+-
                     :=************************-
                   :+***************************+.
                 .+*******************************
                -**********************=:.   ..:=*=
               =*********************-            :
              =*********************-
             =**********************.
            -***********************-
           .*************************-
           ****************************-.
          +******************************+-.
        .+**********************************=.
       -*********************+=++=+***********=.
     :+*********************+%#=-+%#+***********-
#%%%%%%%%%%%%%%%%%%%%%%%%%%%%+    :%%%%%%%%%%%%%%%%#
:---------------------------%%-..:+%=--------------:
                            .=#%%%#-

CommitTide
Good commits. Clear history.

Usage: committide [options] [command]
```

CommitTide validates Conventional Commits messages, checks Git history, helps
compose messages from staged changes, and generates release notes.

[`lint`](#message-format) · [`suggest`](#write-a-commit-message) · [`check`](#check-git-history) · [`changelog`](#release-notes)

## Quick start

With Node.js 22.12.0 or newer and npm:

```sh
git clone https://github.com/S-Adnan-11/committide.git
cd committide
npm ci
npm run build
node dist/cli.js --help
node dist/cli.js lint --message "feat(cli): add message linting"
```

For example, linting a fictional tide forecast change produces:

```text
$ committide lint --message "feat(forecast): add tide times"
Message is valid.

$ committide lint --message "updated stuff"
error [header-format] line 1: Use type(scope)!: description; scope and ! are optional, and the description must be nonempty.
```

The example uses the executable from a locally installed archive. Message linting
accepts text, a UTF-8 file, or piped standard input, with JSON type configuration.
No account, credentials, network request, or Git repository is needed for linting.

This is a local development package. Registry installation has not been verified.
The package remains marked private; local archive installation is supported.

## Build and try

After the quick start, try a file or inspect the version:

```sh
node dist/cli.js --version
node dist/cli.js lint --file message.txt
```

Pipe a message in a shell:

```sh
printf 'fix: handle empty input\n' | node dist/cli.js lint
```

PowerShell equivalent:

```powershell
'fix: handle empty input' | node dist/cli.js lint
```

Explicit top-level help (`committide --help`, `committide -h`, or `committide help`)
shows the wave in an interactive terminal: full size at 56 columns, compact at
44–55, and the name alone at smaller or unknown widths. The tagline appears when
it fits. Bare-command help, subcommand help, errors, CI, and `TERM=dumb` omit the
banner. Redirected help stays plain. A nonempty `NO_COLOR` or `FORCE_COLOR=0`
disables colour; `FORCE_COLOR` cannot override these terminal and stream checks.
Command output and generated messages or notes stay undecorated for piping.

Choose exactly one input source. Piped data conflicts with `--message` or `--file`;
an empty redirected stdin does not. A terminal with no explicit input returns an
error immediately. A pipe is read until EOF. `--message ""` is a lint rejection.
Explicitly empty stdin is a missing-input error.

After `npm pack`, install the tarball in another project with
`npm install --save-dev /path/to/committide-0.1.0.tgz` and use
`npm exec -- committide --help`. Consumers run compiled JavaScript through the
`committide` executable; they do not need TypeScript or build tools.

## Message format

```text
feat(parser)!: support a new input format

Explain the reason and relevant details.
Bodies can contain multiple paragraphs.

BREAKING CHANGE: replace the old input format
Include migration details on subsequent lines.
Reviewed-by: Alex
Refs: #123
```

The [Conventional Commits 1.0.0 specification](https://www.conventionalcommits.org/en/v1.0.0/)
defines a type, optional scope, optional `!`, a colon and space, and a nonempty
description. Separate the body or first footer from the header with a blank line.
Separate the first footer from the body with a blank line. Further footer tokens
end the previous footer's value, which may span lines. Footers use `Token: value`
or `Token #value`. Tokens use letters, numbers, underscores, or hyphens; Unicode
tokens and descriptions are accepted. Scopes may include Unicode and punctuation
other than parentheses. Indented token-like lines stay in the body or preceding
footer value. Token-like lines without a paragraph boundary stay in the body.

Breaking changes use `!`, `BREAKING CHANGE:`, or `BREAKING-CHANGE:`. Breaking footer
markers must be uppercase with a space after the colon and a nonempty value;
misspelled casing produces a diagnostic. Other tokens and type matching are case
insensitive. There are no lowercase-description or line-length restrictions.
CRLF input is normalized to LF. Trailing blank lines are ignored. NUL characters
and bare carriage returns are rejected. Direct linting does not strip Git comment
lines or special-case merge, revert, fixup, or squash messages.

Default types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`, and `revert`. `style` describes formatting changes without behavior
changes; visual features and fixes usually use `feat` or `fix`.

A valid structure does not establish whether a message accurately describes code.

## Configuration

Create `committide.config.json`:

```json
{
  "extendTypes": ["release", "security"]
}
```

`extendTypes` adds types to the defaults. `allowedTypes` replaces the defaults;
when both are present, extensions are added to that replacement:

```json
{
  "allowedTypes": ["feat", "fix"],
  "extendTypes": ["release"]
}
```

Types must be nonempty tokens of letters, numbers, underscores, or hyphens.
`allowedTypes` must contain at least one type; `extendTypes` may be empty.
Duplicates are collapsed case insensitively. Unknown keys, invalid values, and
malformed JSON produce an error; configuration never silently falls back.

Discovery starts in the current working directory and walks upward. The nearest
configuration wins; files are never merged. The search includes and stops at the
first directory containing `.git` (directory or worktree file) or `package.json`,
or at the filesystem root. This keeps a nested project from inheriting an unrelated
parent project's configuration. Without those markers, ancestors up to the root
are searched. Discovery follows the working directory, not the message file path.

`--config PATH` selects one file relative to the current directory and disables
discovery. It can appear before or after `lint`:

```sh
node dist/cli.js lint --config ./custom.json --message "release: prepare build"
```

## Results and exit codes

Success prints `Message is valid.` to stdout. Diagnostics go to stderr with a
rule identifier, correction, and message line where applicable. Help and version
also use stdout. Message content is not echoed in diagnostics.

| Code | Meaning |
| --- | --- |
| 0 | Successful operation, valid message, help, or version |
| 1 | Message or checked history rejected by format or type policy |
| 2 | Usage, input, configuration, or operational error |
| 130 | Interactive cancellation, EOF, or interruption (Ctrl+C) |

Local message composition is available through `suggest`, with an optional remote
draft described below. npm installation never installs a Git hook; hook setup is
an explicit command.

## Check Git history

```sh
node dist/cli.js check --from v1.0.0 --to HEAD
```

For a locally installed dependency, use `npm exec -- committide check --from REF --to REF`.
Both boundaries are required and must resolve to single commits; annotated tags
are peeled. The range is Git's two-dot reachability difference: commits reachable
from `--to` excluding everything reachable from `--from`. Nonancestor boundaries
are supported. Neither boundary is a date filter. Whitespace, option-like refs,
ranges, and operators expanding to multiple revisions are rejected.

Complete UTF-8 messages are checked in deterministic reverse topological order.
The command reports checked/failed/skipped counts, commit IDs, and rule diagnostics.
No commits are skipped. An empty range succeeds with an explicit empty-range
message. Any message failure returns 1; missing Git/repository/refs/objects or
invalid configuration returns 2. Shallow repositories are refused: obtain full
history first, for example with `git fetch --unshallow`. The command itself never
fetches, changes refs, checks out files, or edits the index/worktree/configuration.
Git replacement objects are ignored, and partial-clone lazy fetching is disabled.
Non-UTF-8 history is an operational error rather than silently recoded text.
Git integration has been verified with Git 2.56.0. A Git installation supporting
`--no-lazy-fetch`, `--path-format`, and `--end-of-options` is required; unsupported
options produce an operational error rather than permitting an implicit fetch.

Configuration uses the current working directory and `--config` precedence above;
configuration from historical commits is never executed or loaded automatically.
All messages are checked strictly, including Git-generated merge/revert subjects
and unresolved `fixup!`, `squash!`, or `amend!` subjects. Use conventional messages
for finished history; a prefix alone never grants an exemption.

A CI step after checkout and `npm ci`/`npm run build` can reuse the command:

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0
- uses: actions/setup-node@v7
  with:
    node-version: 24
    cache: npm
- run: npm ci
- run: npm run build
- run: node dist/cli.js check --from "$BASE_SHA" --to "$HEAD_SHA"
  env:
    BASE_SHA: ${{ github.event.pull_request.base.sha }}
    HEAD_SHA: ${{ github.event.pull_request.head.sha }}
```

Use this fragment in a pull-request workflow; both SHAs must be locally available.
It is a usage example, not a claim that hosted CI or another OS has been tested.

## Commit-message hooks

First install a reviewed CommitTide tarball or version as a dependency of the
consuming repository root, committing its npm lockfile with that project:

```sh
npm install --save-dev --save-exact /path/to/committide-0.1.0.tgz
node node_modules/committide/dist/cli.js hooks install
node node_modules/committide/dist/cli.js hooks uninstall
```

Installation is explicit; npm installation never installs a hook. The installer
does not create a Node project or change package files, Git configuration, or
existing hooks. It requires root package.json/package-lock.json to declare the
same dependency selection and the installed package version to match the lock.
Linked packages, workspaces, and other lockfile formats need manual integration.

The generated shell hook invokes the root's real compiled local executable with
Git's message-file argument. It requires Node >=22.12.0 on PATH and a matching
installed dependency/lockfile at commit time. Missing runtime/dependency, invalid
configuration, or a lint error rejects the commit. No package download, AI request,
message rewrite, index change, or commit is performed by CommitTide. A failed
commit leaves your changes available for correction and retry.

Installation/removal use Git's effective hook location, including linked
worktrees and commands launched below the root. Default common hooks apply to
all worktrees of that repository; each worktree needs its own local dependency.
Locally configured relative or absolute hooks paths in a direct child directory
of the working-tree root are supported (as is the default hooks directory).
Nested repository layouts require manual integration. Inherited/global paths,
external/shared directories, symlinks/junctions,
bare repositories, and recognized managed paths such as `.husky` are refused
with manual integration guidance. Hook and package paths must be real local paths.

Existing hooks are preserved byte for byte. Ownership requires the complete
unchanged generated content (and executable mode on POSIX), not a marker string.
Reinstalling an unchanged hook is a no-op; uninstall only removes an unchanged
owned hook and is harmless when it is absent. Edited/foreign hooks require manual
integration. Inspect the reported hook file before changing it. A lock coordinates
installers, exclusive file creation avoids replacement, and removal verifies a
quarantined snapshot before deletion. Concurrent external edits can require manual
recovery; diagnostics identify preserved content. If a process is interrupted,
inspect stale `.committide-lock` or `.committide-install-*` files before retrying.

For an existing shell hook, a minimal manual integration from the repository root
is the following. Keep its existing logic and propagate the validation failure:

```sh
node node_modules/committide/dist/cli.js lint --file "$1" || exit $?
```

Adjust the real local package path for your layout. Do not use network-downloading
`npx` inside a hook. Manual integrations are maintained by the consuming project;
automatic uninstall will preserve them.

Hook validation uses root configuration discovery. `--config` is rejected for
automatic installation/removal because it would not persist into future Git
invocations; an existing manual hook can pass `--config` explicitly to lint.
Direct lint behavior is unchanged. Hook inputs are read without changing or
stripping Git template comments: keep a conventional header on the first line.

The policy is strict and has no configurable generated-message exemptions.
Default `Merge ...`, `Revert ...`, `fixup! ...`, `squash! ...`, and `amend! ...`
subjects fail the common rules. Use `git merge -m "chore: merge branch"` or compose
a conventional revert message. For temporary fixups/squashes, intentionally use
`git commit --no-verify --fixup REF` / `--squash REF`, finish autosquashing, then
run `check` on the finished range. In the tested Git version, `git revert --no-edit`
bypasses commit-msg and its generated subject fails history checking. Prefer
`git revert --no-commit REF` followed by `git commit -m "revert: describe reversal"`.
Git operations that do not invoke commit-msg
cannot be enforced by this hook. Local hooks are bypassable with `--no-verify`;
run range checking in CI for an additional enforcement boundary. Passing format
checks still does not establish whether a message accurately describes changes.

## Write a commit message

```sh
node dist/cli.js suggest
node dist/cli.js suggest --output commit-message.txt
```

Run `suggest` in a terminal with changes already staged. It shows repository-root
paths, Git status and mode changes, then offers a staged patch before asking for
a configured type, optional scope, and your description. Additional unstaged edits
in the same files are excluded. An initial commit is supported. Nothing staged
means no draft. File count alone does not tell you whether changes belong in one
logical commit; review the staged set and describe its purpose yourself.

The review menu offers `accept`, `edit`, `advanced`, `patch`, `refresh`, and
`cancel`. Edit any field, or use advanced fields for a multiline body, an explicit
breaking change with migration details, neutral `Refs` references, and other
footers. End multiline entry with `.done` alone; an empty entry clears that field.
The complete message is shown after each edit. Invalid fields are retained and
reported by the same validator used by lint, history checking, and hooks. They
must be corrected before acceptance. Standard types have short explanations;
configured custom types remain available. Formatting success does not establish
semantic accuracy or detect API compatibility.

Prompts, patch review, and diagnostics go to stderr. Only the accepted UTF-8
message goes to stdout. Both stdin and stderr must be interactive terminals;
piped answers are rejected immediately with exit 2. Stdout can be redirected,
although the shell then controls file creation/truncation. Prefer `--output` for
guarded creation: it resolves relative to the invocation directory, requires a
new filename and real existing parent directories, and refuses Git metadata,
symlinks/junctions, and existing files. It writes only after acceptance and a final
snapshot check, using a complete synced temporary file and a non-overwriting
hard link. A destination appearing concurrently is preserved. Hard-link support
is required; interruption can leave `.committide-message-*.tmp` for inspection.
After reviewing a deliberately saved file, you can commit it yourself:

```sh
git commit -F commit-message.txt
```

The command never stages, commits, pushes, or changes hooks/configuration.
Default local composition needs no AI credentials and makes no provider request.
`/cancel` at any prompt, the cancel menu, Ctrl+C, and EOF end without an accepted
message (exit 130). Usage/configuration/Git/output failures use exit 2. Help and
version work without opening a prompt session or finding a repository.

### Optional remote draft

```sh
node dist/cli.js suggest --ai
node dist/cli.js suggest --ai --output commit-message.txt
```

This mode offers one foreground request to **Groq**, using
`openai/gpt-oss-20b` at Groq's HTTPS chat-completions endpoint. Each developer
supplies their own `GROQ_API_KEY` through the process environment. Never put keys
in arguments, URLs, commit messages, or repository configuration. No key is read
by local writing, help/version, lint, hooks, history checks, or changelogs.
For temporary masked input in your own Windows PowerShell session:

```powershell
$secureKey = Read-Host 'Groq API key' -AsSecureString
$env:GROQ_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
try { node dist/cli.js suggest --ai }
finally { Remove-Item Env:GROQ_API_KEY; $secureKey.Dispose() }
```

Only that shell and child processes launched while the variable is set inherit
it. Do not paste a key into a recorded command or share it in chat.

Before sending, the CLI shows the provider/model, exact staged patch to be sent,
request size, and omissions. Choose `send`, local writing, keeping the existing
draft, or cancellation. Only the captured staged patch (including filenames,
object IDs, modes and context), configured types, instructions and schema are
submitted. Binary/submodule contents are omitted. Unstaged changes and additional
repository/author/remote context are excluded. Staged data can itself contain
secrets: inspect it before sending; no secret-filtering guarantee is made.

The entire serialized JSON request is capped at 5,500 UTF-8 bytes, including
escaped patch data, instructions, and schema. The completion cap is 1,536 tokens,
including reasoning, with low reasoning effort and reasoning output hidden.
Using one byte as a conservative token allowance plus 512 tokens for provider
overhead gives a planning allowance of 7,548 tokens. This is a local estimate,
not exact tokenization or a free-quota guarantee. Oversized or incomplete text
patches refuse before submission; use local writing or a smaller staged logical
change. There is no automatic staging or partial-text submission.

Groq currently documents a Free plan for this model, subject to account access
and organization-specific limits. Check your account's tier, billing settings
and current [rate limits](https://console.groq.com/docs/rate-limits); a key alone
does not establish free access. Availability and limits can change. The CLI
does not enable billing, upgrade accounts or switch models/providers.
See [Groq billing information](https://console.groq.com/docs/billing-faqs).

The total request deadline is 30 seconds and response retention is capped at
32 KiB. Requests do not follow redirects or retry automatically. Quota errors
show safe retry-after/limit metadata when available. A timeout or cancellation
cannot prove the server stopped processing. Choose local writing or deliberately
try later. Errors retain an existing draft. `ai` in the review menu starts a new
disclosure and send choice; `local` rejects the draft and starts local fields.

An index/HEAD change before sending invalidates consent. A change while awaiting
the response discards the stale result and requires refresh without another
request. Remote structured fields are checked defensively and then pass through
the same local validator and editable review as local writing. Acceptance and
output-file protections still apply. Valid format does not prove factual accuracy.

Groq documents no default inference-content retention, with exceptions for
reliability/abuse investigation and features requiring retained state. Usage
metadata is retained; account data controls also apply. Review the current
[Groq data policy](https://console.groq.com/docs/your-data) before submitting code.
This is not a universal zero-retention promise.

The review fingerprint covers HEAD and every index path, stage, mode, and object
ID. Changes detected before showing/accepting the draft or publishing its file
require refresh and renewed review; typed fields are retained. A refreshed empty
index cancels. Snapshot checks do not lock other Git processes: a change after
the last check can still happen, so review again before committing later.

Overview retention is limited to 256 KiB and at most 100 displayed entries;
patch retention is 64 KiB, with explicit truncation notices. Git output is drained
with bounded memory and a 30-second inspection timeout. Unusual paths are quoted,
terminal controls are made visible, and binary/submodule contents are not
interpreted. Symlink targets are not traversed. Rename detection is Git's
similarity heuristic with an exhaustive-search limit of 1000; some changes may
appear as additions/deletions. External diff and text-conversion helpers are
disabled. Omitted material has not received a complete content review; use your
usual Git tools to inspect it before accepting a message.

## Release notes

```sh
node dist/cli.js changelog
node dist/cli.js changelog --from v1.0.0 --to HEAD
node dist/cli.js changelog --include-maintenance
node dist/cli.js changelog --write
```

Without `--write`, the command prints an Unreleased Markdown section to stdout
and does not create or change any file. Boundary information, counts, and skipped-message
diagnostics go to stderr, so redirecting stdout produces usable Markdown.
The default target is HEAD. Explicit boundaries use the same two-dot reachability
semantics and safe single-commit ref rules as `check`.

Without `--from`, the baseline is the nearest commit on the selected target's
first-parent chain carrying a stable [SemVer](https://semver.org/) tag, optionally
prefixed with lowercase `v`. Lightweight and annotated tags (including nested
annotated tags) are peeled to their commit targets. Build metadata is allowed;
prerelease/custom/malformed tags and tags pointing to noncommits are excluded.
Tag creation dates and version magnitude do not select the boundary. Multiple
stable tags at that nearest commit are an error; use explicit `--from` to resolve
the ambiguity. A tag on the target selects an empty range. With no applicable
tag, all reachable history is included, including the root commit. First-parent
selection determines only the boundary: relevant merged commits still appear in
the resulting reachability difference. Shallow/missing history fails without
fetching, and operational errors do not print partial Markdown.

Groups have a stable order: Breaking Changes, Features, Fixes, Performance
Improvements, and optional Maintenance. Within each group, commits retain Git's
reverse topological order. A breaking commit appears once in Breaking Changes,
with its scope, description, and multiline breaking details. Empty headings are
omitted. There are no current timestamps or generated links.

Historical syntax is parsed independently of today's type allowlist. Custom types
with breaking information are included; other conforming custom/maintenance types
are filtered by default and grouped as Maintenance with `--include-maintenance`.
Current configuration discovery and `--config` are still validated consistently;
the type allowlist does not hide historical breaking changes.

Nonconforming messages are reported as skipped with commit IDs/rules/counts.
Native nonconforming merge/revert/fixup/squash messages are skipped, not silently
treated as valid or irrelevant. Conventional revert messages follow their type;
there is no automatic cancellation of reverted commit pairs. An empty range or
no qualifying entries produces `No qualifying changes.` rather than invented notes.
Notes summarize recorded commit intent, not verified net behavior or release prose.

Commit-controlled Markdown/HTML punctuation is encoded as numeric entities so
headings, links, HTML, and generated-marker injection render as text. Unicode
remains readable; terminal controls/bidi formatting are replaced by visible code
point labels. Multiline breaking details retain their order. Review the output
for semantic accuracy before sharing it. The command never fetches, stages,
commits, tags, bumps versions, pushes, publishes, or calls an AI service.

### Managed file updates

`--write` explicitly creates or updates `CHANGELOG.md` at the repository root,
including when invoked from a subdirectory. It emits status/diagnostics to stderr
and leaves stdout empty. Writing requires a non-bare working repository. A new
file receives a title, Unreleased heading, and one managed block:

```markdown
# Changelog

## Unreleased

<!-- committide:unreleased:start -->
No qualifying changes.
<!-- committide:unreleased:end -->
```

In an existing UTF-8 document, only bytes between those two standalone marker
lines are replaced. Handwritten notes, marker lines, previous releases, outside
line endings, and an optional UTF-8 BOM are preserved byte for byte. Generated
lines follow the start marker's LF or CRLF ending. Changes inside the managed
block are replaced on the next generation. Identical output does not rewrite the
file or change its modification time.

Existing documents require exactly one unambiguous level-two Unreleased heading
(`## Unreleased` or a bracketed/linked Unreleased heading) and one correctly
ordered managed block before the next level-one/two section. Missing, duplicated,
reversed, inline, or misplaced markers/sections are refused. HTML section headings,
decorated Unreleased headings containing comments, setext headings, and
other ambiguous layouts require manual repair. Fenced/indented code and HTML examples
do not establish ownership; ambiguous examples can cause refusal. To initialize
an existing file, obtain a block with the read-only preview, review the document,
and manually place one Unreleased heading and standalone marker pair before the
previous releases. There is no force-overwrite option.

Before history generation, the writer captures the existing file snapshot. It
builds complete candidate bytes, coordinates other CommitTide writers with
`CHANGELOG.md.committide-lock`, prepares/syncs a same-directory temporary file,
then rechecks the destination. Detected edits are refused. Existing files use a
rename replacement; new files use a non-overwriting hard-link publication so a
newly appeared destination is preserved. Directory/symlink/junction/shared
hard-link targets are refused. A filesystem supporting these operations is
required. Interrupted operations can leave an owned `.committide-changelog-*.tmp`
or lock directory; inspect those before retrying. The destination is never
truncated in place or deleted first.

Replacement atomicity and edit detection are separate: the snapshot checks and
lock prevent competing cooperative writers from overwriting one another, but
portable filesystem APIs do not provide compare-and-swap against an uncooperative
external editor between the final check and rename. Review and retry a detected
conflict. These safeguards have been exercised on Windows local storage and
Linux/macOS hosted runners. Other filesystems and configurations remain unverified.

## Contributing and verification

```sh
npm ci
npm run check
npm test
npm run verify:package
```

The strict TypeScript check covers production code; Node's built-in test runner
exercises message parsing, policy, configuration boundaries, and executable
channels and exit codes. Git integration tests create disposable repositories and
pack/install the local dependency to exercise actual commits, worktrees, merge,
revert, and autosquash behavior. They require npm registry/cache access and never
install hooks into the source repository. See [Git's hook documentation](https://git-scm.com/docs/githooks)
and [revision range semantics](https://git-scm.com/docs/gitrevisions) for the
underlying Git contracts. Package verification checks actual archive bytes, installs
the tarball in a temporary directory outside the source tree, and exercises the
installed JavaScript and npm executable shim. It needs registry access to install
the production dependency and removes its temporary directory afterward.
On Windows, the file-symlink fixture is skipped if the host lacks symlink creation
privilege or Developer Mode; directory-junction and other path checks still run.

Runtime requirements follow [Commander 15](https://github.com/tj/commander.js)'s
Node 22.12.0 minimum. Actual platform/runtime verification is recorded below;
other configurations have not been verified.

The [verification workflow](https://github.com/S-Adnan-11/committide/actions/workflows/verify.yml) runs type checking,
tests, and installed-package checks on standard Windows, Linux, and macOS runners
with Node 22.12.0, 24, and 26. It runs for pushes to `main`, pull requests, and
manual dispatch in public repositories. No provider credentials are required;
remote drafting tests use synthetic responses. The workflow does not publish
packages or create releases. A configured matrix is not evidence of a passing run;
inspect the completed jobs before extending the compatibility claims below.

| Platform | Node | Verification |
| --- | --- | --- |
| Windows x64 | 22.12.0 | 205 tests and installed tarball checks, including mocked AI drafting, passed |
| Windows x64 | 24.22.1 | 205 tests and installed tarball checks, including mocked AI drafting, passed |
| Windows x64 | 26.12.1 | 205 tests and installed tarball checks, including mocked AI drafting, passed |
| Ubuntu 24.04 hosted runner | 22.12.0, 24.21.0, 26.12.1 | 205 tests and installed tarball checks passed on each runtime |
| macOS 26 arm64 hosted runner | 22.12.0, 24.21.0, 26.12.1 | 205 tests and installed tarball checks passed on each runtime |

The [completed verification run](https://github.com/S-Adnan-11/committide/actions/runs/40404902469)
passed all nine Windows/Linux/macOS jobs, including type checking, all 205 tests
without skips, and installed executable checks. The Node 24 jobs resolved to
24.22.1 on Windows and 24.21.0 on Linux/macOS. A fresh remote clone also passed
dependency installation, type checking, tests, and packed-install checks on Windows.

The test suite simulates the terminal flag for its missing-input check. A separate
real terminal invocation also confirmed immediate missing-input feedback.
The guided writer has also been exercised through a Windows PTY. Stream tests
simulate terminal flags for deterministic EOF/cancellation and output assertions;
they are separate from real terminal evidence. A physical Windows keyboard
cancellation check passed with exit 130, empty stdout, no saved message, unchanged
fixture files, and normal input afterward.

Groq drafting has also been exercised once with a small synthetic staged change
through the installed CLI, including editing, validation, and accepted output.
Automated adapter and flow tests use synthetic HTTP responses and need no provider
credential. One live example does not establish general draft quality.

Production dependency: Commander (MIT), for command routing and help.
Development dependencies: TypeScript (Apache-2.0) and Node type definitions (MIT).
The message parser and type rules live in `src/message.ts`; JSON discovery is in
`src/config.ts`, and executable input/output is in `src/cli.ts`. The parser uses
line state for body and footer boundaries, independent of the configured type list.

<details>
<summary>Brand artwork</summary>

<img src="https://raw.githubusercontent.com/S-Adnan-11/committide/main/assets/brand/readme-banner.svg" alt="CommitTide — a curling ocean wave over a Git commit node. Good commits. Clear history." width="900">

</details>

## License

[MIT](LICENSE). Copyright (c) 2026 S. Adnan.

Author: [S. Adnan](https://s-adnan.dev) ([GitHub](https://github.com/S-Adnan-11)).
