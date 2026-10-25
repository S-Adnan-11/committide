# CommitTide

CommitTide validates Conventional Commits messages locally. It accepts message
text, a UTF-8 file, or piped standard input, and supports JSON type configuration.
No account, credentials, network request, or Git repository is needed for linting.

This is a local development package. Registry installation has not been verified.
The package is marked private and unlicensed while distribution details are settled.

## Build and try

Use Node.js 22.12.0 or newer and npm:

```sh
npm ci
npm run build
node dist/cli.js --help
node dist/cli.js --version
node dist/cli.js lint --message "feat(cli): add message linting"
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
| 0 | Valid message, help, or version |
| 1 | Message rejected by format or type policy |
| 2 | Usage, input, configuration, or operational error |
| 130 | Interactive interruption (Ctrl+C) |

Commit-writing assistance is not implemented in this version.
No installation hook is registered.

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

## Preview release notes

```sh
node dist/cli.js changelog
node dist/cli.js changelog --from v1.0.0 --to HEAD
node dist/cli.js changelog --include-maintenance
```

The command prints an Unreleased Markdown section to stdout. It does not create
or change a changelog file. Boundary information, counts, and skipped-message
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
File updates are not yet available; the current command is a read-only preview.

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

Runtime requirements follow [Commander 15](https://github.com/tj/commander.js)'s
Node 22.12.0 minimum. Actual platform/runtime verification is recorded below;
other platforms are not yet verified.

| Platform | Node | Verification |
| --- | --- | --- |
| Windows x64 | 22.12.0 | 106 tests and installed tarball checks passed |
| Windows x64 | 24.22.1 | 106 tests and installed tarball checks passed |
| Windows x64 | 26.12.1 | 106 tests and installed tarball checks passed |

The test suite simulates the terminal flag for its missing-input check. A separate
real terminal invocation also confirmed immediate missing-input feedback.
Interactive Ctrl+C behavior has not yet been verified with a real terminal.

Production dependency: Commander (MIT), for command routing and help.
Development dependencies: TypeScript (Apache-2.0) and Node type definitions (MIT).
The message parser and type rules live in `src/message.ts`; JSON discovery is in
`src/config.ts`, and executable input/output is in `src/cli.ts`. The parser uses
line state for body and footer boundaries, independent of the configured type list.
