---
name: plane-research
description: Work with the R&D research graph in Plane (this fork) — questions, hypotheses, experiments and evidence linked by typed relations — through the v1 API with an API key. Use it whenever the user wants to add or update a hypothesis, record an experiment or its result, set a verdict (confirmed / rejected), raise a follow-up question, merge hypotheses, look at the research graph or the competing hypotheses matrix, name a branch for an experiment, or migrate an existing hypothesis graph (from a GitHub repo, markdown notes, mermaid diagrams, issues) into Plane. Also use it when an agent finishes an experiment and should report what it found back to Plane, even if the user does not say "Plane" or "research graph" explicitly.
---

# Plane research graph

R&D work in this Plane fork is a typed graph, not a task list. Every node is an ordinary work item (it has a number like `RND-42`, a state, assignees, comments, links) with a `research_type`, and nodes are connected by typed relations. The model follows Discourse Graphs, IBIS and Analysis of Competing Hypotheses (ACH): several hypotheses compete to answer a question, experiments test them, evidence supports or opposes them, and verdicts must be backed by evidence.

Your job with this skill is to keep that graph an honest record of the research: what is being asked, what is believed and why, what was tried, and what came out. Prefer adding evidence and links over editing history — a rejected hypothesis with the evidence against it is valuable, a deleted one is lost knowledge.

## Setup

Everything goes through `scripts/plane_research.py` (Python 3, standard library only). It reads:

| Variable          | Example                                                   |
| ----------------- | --------------------------------------------------------- |
| `PLANE_BASE_URL`  | `http://localhost:8090` (the host only, no `/api`)        |
| `PLANE_API_KEY`   | `plane_api_…` — Profile settings → Personal access tokens |
| `PLANE_WORKSPACE` | workspace slug from the URL                               |
| `PLANE_PROJECT`   | project identifier (`RND`) or UUID                        |

If any is missing, ask the user for it — do not guess a URL or a key. Start with `check`: it confirms the connection and tells you whether the project has the Research graph view enabled (Project settings → Features → Research; the API works either way, but the user will want the map).

```bash
S=.claude/skills/plane-research/scripts/plane_research.py
python3 $S check
python3 $S graph                       # whole graph, one line per node and per edge
python3 $S graph --type hypothesis --status testing,proposed
python3 $S show RND-12                 # details, relations, suggested branch name
```

Nodes can be given as `RND-12`, `12` (in the configured project) or a UUID. The API key is rate limited (60 requests/min by default); the script waits and retries on 429, so long runs are slow rather than broken.

## The model

| Type         | Letter | What it is                                   | `research_status`                                                                              |
| ------------ | ------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `question`   | Q      | An open research question                    | `open` → `answered` (computed: some hypothesis is confirmed) / `closed` (manual)               |
| `hypothesis` | H      | A testable answer to a question              | `proposed` → `testing` → `confirmed` / `rejected` / `inconclusive`; `superseded` after a merge |
| `experiment` | E      | Work that tests hypotheses; has a git branch | none — progress uses normal states (Todo / In progress / Done)                                 |
| `evidence`   | R      | A result or observation                      | `valid` / `invalidated`                                                                        |

Relations (`SOURCE relation TARGET`); each also has a reverse name you can use from the other end:

| Relation       | Source → target        | Reverse name   | Notes                                                    |
| -------------- | ---------------------- | -------------- | -------------------------------------------------------- |
| `addresses`    | H → Q                  | `addressed_by` | a hypothesis answers a question                          |
| `tests`        | E → H (one or several) | `tested_by`    |                                                          |
| `produces`     | E → R                  | `produced_by`  |                                                          |
| `supports`     | R → H                  | `supported_by` | weight 1–3 required                                      |
| `opposes`      | R → H                  | `opposed_by`   | weight 1–3 required                                      |
| `informs`      | R → Q                  | `informed_by`  | evidence relevant to a question without a hypothesis yet |
| `raises`       | any → Q                | `raised_by`    | a node opens a new question                              |
| `derived_from` | H → H                  | `derives`      | refinement; a hypothesis may derive from several         |

Weights: 1 = weak / circumstantial, 2 = clear, 3 = decisive. Pick the weight from how strongly the evidence discriminates, not from how much you like the result.

### Rules the server enforces

Knowing these saves round trips; the server rejects violations with a 400/409 and a readable message, which the script prints.

- Only the source/target pairs in the table are allowed (`Q tests H` is rejected).
- One relation per pair of nodes. To turn `supports` into `opposes` or change a weight, use `reweigh`, not a second `link` (that returns 409).
- No cycles through `raises` or `derived_from`.
- `confirmed` needs at least one **valid** evidence that `supports` the hypothesis; `rejected` needs one that `opposes` it. So link the evidence first, then set the verdict.
- `answered` cannot be set by hand; it follows from a confirmed hypothesis.
- When the basis of a verdict disappears (evidence invalidated, relation removed, evidence deleted) the hypothesis gets `needs_review`. Treat `needs_review` as a to-do: look at it, then either re-confirm with new evidence or change the verdict.

### Soft rules worth following

These are not enforced, but they are the point of the method:

- Give a question at least two competing hypotheses before putting one into `testing` — a lone hypothesis tends to get confirmed by default.
- Value disconfirmation: the matrix ranks hypotheses by the weight of valid evidence **against** them.
- Evidence that supports every hypothesis equally is "not diagnostic" — it does not help choose. Prefer experiments that would split the hypotheses.
- Record reproducibility on evidence: `--commit-sha`, `--branch`, `--repo-url`, `--artifact-url`. A result without a commit is hard to trust later.

## Everyday workflows

**New question with competing hypotheses**

```bash
python3 $S create question "Why does recall drop on long documents?" --description "Context, where it was seen, links."
python3 $S create hypothesis "Chunking splits key sentences" --link addresses:RND-20 \
  --statement "If chunks break sentences, then sentence-aware chunking restores recall" \
  --success-criteria "recall@10 within 2 pts of short docs"
python3 $S create hypothesis "Embedding model truncates at 512 tokens" --link addresses:RND-20
```

**Plan and run an experiment**

```bash
python3 $S create experiment "Sentence-aware chunking on the long-doc set" --link tests:RND-21
python3 $S branch RND-23          # -> exp/rnd-23-sentence-aware-chunking-long-doc
```

Use exactly that branch name for the git work (it follows `.claude/skills/branch-name`, type `exp`, lowercase). Titles can be in any language — Cyrillic is transliterated (`Прогрев кэша` → `exp/rnd-57-progrev-kesha`), so name nodes in the team's language rather than translating them for the sake of the branch. Experiment branches are usually not merged; they stay for reproducibility. Put the PR or notebook on the node with `add-link`.

**Record a result and a verdict** — evidence first, then the relation with a weight, then the verdict:

```bash
python3 $S create evidence "recall@10 +0.4 pts with sentence chunking" --link produced_by:RND-23 \
  --commit-sha 3f2a9c1 --branch exp/rnd-23-sentence-aware-chunking-long-doc --artifact-url https://…/results.csv
python3 $S link RND-24 opposes RND-21 --weight 2
python3 $S status RND-21 rejected
python3 $S update RND-21 --conclusion "Chunking is not the cause: +0.4 pts is within noise (RND-24)." --confidence 75
```

If the result surprised you, raise the follow-up instead of leaving it in a comment: `python3 $S create question "Is the drop specific to tables?" --link raised_by:RND-24`.

**Compare hypotheses**: `python3 $S matrix RND-20` prints the ACH matrix — ranking, which evidence is diagnostic, invalidated evidence.

**Merge overlapping hypotheses**: `python3 $S merge RND-21 RND-22 --name "Long inputs lose content before embedding"`. The new hypothesis derives from both and inherits their questions; the sources become `superseded`.

**Fix mistakes**: `unlink A B [--relation type]`, `reweigh EVIDENCE HYPOTHESIS --weight 3 [--relation opposes]`, `status RND-24 invalidated` (when a result turns out wrong — keeps it in the record and flags dependent verdicts).

When you report back to the user, name nodes by identifier (`RND-21`) so they can find them, and mention any `needs_review` flags you created or noticed.

## Migrating an existing workflow

To bring an existing hypothesis graph (a GitHub repo of notes, a mermaid/graphviz diagram, a spreadsheet, GitHub issues) into Plane, read `references/migration.md` and follow it. In short: read the source, write a JSON spec of nodes and edges (format in that file, example in `assets/spec-example.json`), `validate` it, show the user a summary and the mapping decisions, `import --dry-run`, then `import`. The import is idempotent — re-running it after fixing the spec or after an interruption adds only what is missing — so prefer re-running over manual patching.

## Reference

- `references/api.md` — raw v1 endpoints, request/response shapes, for anything the script does not cover.
- `references/migration.md` — spec format and migration procedure.
- `assets/spec-example.json` — a small complete spec.
