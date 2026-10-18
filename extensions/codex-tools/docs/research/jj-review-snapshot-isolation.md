# JJ review snapshot isolation

## Recommendation

For a review that must include the working-copy contents *once* but must not
absorb anything written afterwards, create an unintegrated snapshot operation and
pin every inspection to it:

```sh
# Save the operation ID or unambiguous prefix printed by this command.
jj util snapshot --no-integrate-operation
op_prefix='<the printed operation ID or prefix>'

# Expand the prefix to a full ID while remaining pinned and read-only.
op=$(jj --at-operation="$op_prefix" --ignore-working-copy op log -n 1 \
  --no-graph -T 'self.id()')

jj --at-operation="$op" --ignore-working-copy status
jj --at-operation="$op" --ignore-working-copy log -r '@ | @-'
jj --at-operation="$op" --ignore-working-copy diff -r @
jj --at-operation="$op" --ignore-working-copy file show -r @ path/to/file
```

`--no-integrate-operation` is the most reliable one-command way to obtain the
resulting operation identity: JJ documents that it prints an ID which may be
passed to `--at-op`, while it does not integrate the operation or update the
working copy. JJ 0.43 prints an unambiguous short prefix, so automation can pin
a follow-up `op log` command to that prefix and expand it to the full ID as shown
above. `jj util snapshot` itself snapshots changed working-copy contents
into the working-copy commit. Thus `$op` identifies a fixed repository view,
including its working-copy commit. Use the complete printed ID in automation
(an unambiguous prefix is accepted, but is less robust).

`--ignore-working-copy` is redundant with a non-head `--at-operation`, but is
included as an explicit guard. `--at-operation` loads that operation and implies
it; subsequent filesystem edits are neither scanned nor committed. In that
view, `@` resolves to the working-copy commit recorded in the operation view;
`@-` resolves to its parent(s) in that fixed view.

If an unintegrated operation is unsuitable (for example, the snapshot must
become the shared repository head), the weaker two-step alternative is:

```sh
jj util snapshot
op=$(jj --at-operation=@ --ignore-working-copy operation log --limit 1 \
  --no-graph --template 'id')
```

Do **not** use ordinary `jj operation log` to capture `op`: it normally
snapshots the working copy and can therefore create a second observation. This
alternative also has a race: another JJ operation between the two commands can
become current, so its `op` need not be the snapshot operation. The
`--no-integrate-operation` form avoids that identification race.

## Why ordinary review commands are unsafe

By default, nearly every JJ command snapshots at startup. That includes
otherwise read-only-looking `status`, `log`, `diff`, `file show`, and `op log`.
Consequently, `jj diff -r <full-immutable-commit-id>` can still snapshot and
record current working-copy changes before it reads the explicitly named commit.
The immutable commit ID fixes the selected revision, not the command's
working-copy side effect. Add `--ignore-working-copy`, or preferably pin the
whole command with `--at-operation="$op"` as above.

An operation records a view: refs, heads, and the current working-copy commit
per workspace. It is therefore the appropriate evidence anchor, rather than a
commit ID alone. `--at-operation` is not a read-only permission mode: JJ permits
mutating commands at an old operation and treats them like concurrent commands.
Limit the pinned session to inspection commands.

## Caveats

- **Colocated Git workspaces:** normal snapshots acquire JJ's Git
  import/export lock and import Git `HEAD` and refs. The source explicitly says
  this protects against races during that cycle. Therefore the initial snapshot
  can incorporate Git-side changes already visible at that instant; the pinned
  reads do not re-import them. Do not run Git/JJ writers concurrently if the
  evidence boundary must be externally coordinated.
- **Concurrent edits and commands:** the snapshot is a point-in-time best
  effort over the filesystem; a program changing files while JJ scans them may
  yield a mixed tree. Quiesce editors, generators, and Git writers first. JJ's
  operation log supports concurrent JJ commands, but concurrent operations can
  diverge and later be reconciled; this is why a printed unintegrated operation
  ID is preferable to querying the moving head afterwards.
- **Conflicts:** a conflicted working copy is represented on disk with conflict
  markers and reconstructed when scanned. The anchor preserves JJ's resulting
  conflict state, but `file show`/`diff` output may show conflict material rather
  than a single resolved file. Record the conflict status as evidence.
- **Parents and merges:** `@-` means the parent set. For a merge, it can name
  multiple parents, not a unique baseline; enumerate them (for example,
  `jj --at-op="$op" log -r '@-'`) and select a particular parent commit ID when
  making a one-parent diff claim.
- **Paths:** `file show` accepts fileset expressions, not merely raw filenames.
  Shell-quote paths, and use the documented inner JJ string quoting when names
  contain whitespace or expression metacharacters (for example,
  `jj --at-op="$op" file show -r @ '"Foo(1)"'`). A simple path such as
  `path/to/file` needs no inner quotes.
- **Retention:** operation IDs are local operation-log objects, not a portable
  substitute for exporting evidence. Preserve the ID, JJ version, command
  output, and (if review must remain reproducible after cleanup) the repository
  storage/backup.

## Primary sources

- [JJ CLI reference: global options (`--ignore-working-copy`, `--no-integrate-operation`, and `--at-operation`)](https://docs.jj-vcs.dev/latest/cli-reference/#global-options)
- [JJ CLI reference: `jj util snapshot`](https://docs.jj-vcs.dev/latest/cli-reference/#jj-util-snapshot)
- [JJ CLI reference: `jj operation log`](https://docs.jj-vcs.dev/latest/cli-reference/#jj-operation-log)
- [JJ documentation: Operation log](https://docs.jj-vcs.dev/latest/operation-log/)
- [JJ documentation: Working copy](https://docs.jj-vcs.dev/latest/working-copy/)
- [JJ documentation: Filesets—quoting file names](https://docs.jj-vcs.dev/latest/filesets/#quoting-file-names)
- [Upstream source: `util snapshot` command](https://github.com/jj-vcs/jj/blob/main/cli/src/commands/util/snapshot.rs)
- [Upstream source: snapshot eligibility and colocated-Git import/export locking](https://github.com/jj-vcs/jj/blob/main/cli/src/cli_util.rs)
