# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information. A reporter (or maintainer) reply re-opens triage automatically (router-driven), provided no build has started yet. |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Notes for this repo

- All five labels exist in `nearform/lastlight`. `needs-info` and `wontfix`
  predate this setup; `needs-triage`, `ready-for-agent`, and `ready-for-human`
  were created during `/setup-matt-pocock-skills`.
- The repo also carries a separate `needs-review` label (used for
  design-heavy issues a human should look at before an agent grabs them, e.g.
  the architecture-deepening backlog #93–#100). It is **not** one of the five
  canonical triage roles — don't use it as the AFK-ready/human-ready signal.
