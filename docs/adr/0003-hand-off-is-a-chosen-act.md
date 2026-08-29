# A hand off is a chosen act, never an automatic one

Decided 2026-08-29, during overhaul prep. When a profile's plan runs out, Artemis
could move the conversation to another profile automatically — the plumbing
supports it (shared session store, re-attributing ownership ledger, usage
thresholds). We decided it never moves on its own: hitting a limit opens an
informed picker — what happened (which window, its reset time), which profiles
could take the work, each with its live plan usage — and the user chooses the
target. No standing auto-move setting ships, not even buried behind a warning;
the alternative was rejected because the account ranker cannot yet judge
workload fit (`drain-v1` is unimplemented), and an automatic move to a target
that immediately stalls would spend the user's trust along with their quota.

The same consent rule covers both hand-off axes — another profile (who runs it)
and another machine (where it runs). When a live transfer is impossible, the
hand off degrades to today's continuity note.
