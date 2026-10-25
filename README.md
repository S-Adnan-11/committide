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

Hooks, history checking, changelog generation, and writing assistance are not
implemented in this version. No installation hook is registered.

## Contributing and verification

```sh
npm ci
npm run check
npm test
npm run verify:package
```

The strict TypeScript check covers production code; Node's built-in test runner
exercises message parsing, policy, configuration boundaries, and executable
channels and exit codes. Package verification checks actual archive bytes, installs
the tarball in a temporary directory outside the source tree, and exercises the
installed JavaScript and npm executable shim. It needs registry access to install
the production dependency and removes its temporary directory afterward.

Runtime requirements follow [Commander 15](https://github.com/tj/commander.js)'s
Node 22.12.0 minimum. Actual platform/runtime verification is recorded below;
other platforms are not yet verified.

| Platform | Node | Verification |
| --- | --- | --- |
| Windows x64 | 22.12.0 | 89 tests and installed tarball checks passed |
| Windows x64 | 24.22.1 | 89 tests and installed tarball checks passed |
| Windows x64 | 26.12.1 | 89 tests and installed tarball checks passed |

The test suite simulates the terminal flag for its missing-input check. A separate
real terminal invocation also confirmed immediate missing-input feedback.
Interactive Ctrl+C behavior has not yet been verified with a real terminal.

Production dependency: Commander (MIT), for command routing and help.
Development dependencies: TypeScript (Apache-2.0) and Node type definitions (MIT).
The message parser and type rules live in `src/message.ts`; JSON discovery is in
`src/config.ts`, and executable input/output is in `src/cli.ts`. The parser uses
line state for body and footer boundaries, independent of the configured type list.
