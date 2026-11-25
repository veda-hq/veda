# pariksha's standards

The best-practice rules pariksha's checks enforce, each beside its check. A
repository that runs the check holds itself to the rule; its ids keep the
`BP-<CATEGORY>-NNN` form they were given in the product repository where they
started.

| ID          | Rule                                                                         | Check                   |
| ----------- | ---------------------------------------------------------------------------- | ----------------------- |
| BP-ARCH-015 | [Authority claims must resolve to a real artifact](authority-claim-citations.md) | `authority-citations` |
| BP-ARCH-017 | [Deleting a public export requires a stated justification](export-deletion-justification.md) | `export-deletions` |

A rule moves here when it is generic and its check is pariksha's. A rule a
product repository writes for its own code stays in that repository.
