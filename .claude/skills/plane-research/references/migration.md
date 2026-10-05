# Migrating an existing research graph into Plane

The goal is a faithful copy of the research as it stands: every question, hypothesis, experiment and result, how they connect, and what was concluded — with links back to the original files so nothing is lost. After migration the team keeps working in Plane, so the graph should be one they recognise.

## Procedure

1. **Read the source end to end before writing anything.** Typical layouts:
   - a folder per hypothesis (`hypotheses/H1-cold-cache/README.md`, `results/…`);
   - one big markdown file or wiki page with headings and links;
   - a mermaid / graphviz / drawio diagram plus notes;
   - GitHub issues with labels (`hypothesis`, `experiment`) and cross references;
   - branches named after experiments, notebooks, CSV results.
     Note how nodes are identified (ids like `H3`, file names, headings), how links are expressed (`→`, "tests H2", "based on", diagram arrows), and where verdicts live (status lines, emojis, ✅/❌, "rejected" headings).

2. **Map the source vocabulary to the four types and eight relations.** Write the mapping down; you will show it to the user. Common cases:

   | Source                                               | Plane                                                |
   | ---------------------------------------------------- | ---------------------------------------------------- |
   | goal, problem, research question, "why …?"           | `question`                                           |
   | hypothesis, idea, assumption, "we think …"           | `hypothesis`                                         |
   | experiment, spike, run, notebook, branch             | `experiment`                                         |
   | result, finding, measurement, observation, benchmark | `evidence`                                           |
   | sub-hypothesis, refinement, "H2b based on H2"        | `derived_from` (child → parent)                      |
   | hypothesis under a question / goal                   | `addresses`                                          |
   | "confirmed by", "result supports"                    | `supports` + weight                                  |
   | "refuted by", "didn't work", "no effect"             | `opposes` + weight                                   |
   | "new question", "open issue", "follow-up"            | `raises` → new `question`                            |
   | done / validated / ✅                                | hypothesis `confirmed` (needs a supporting evidence) |
   | failed / refuted / ❌                                | hypothesis `rejected` (needs an opposing evidence)   |
   | unclear / mixed                                      | `inconclusive`                                       |
   | in progress                                          | `testing`                                            |
   | merged into another, replaced                        | `superseded` + `derived_from` from the replacement   |

   A refinement (`derived_from`) usually answers the same question as its parent; also give it `addresses` to that question, otherwise it drops out of the question's competing hypotheses matrix. A parent that was only refined (not replaced) keeps its own status rather than `superseded`.

   Where the source has something the model lacks (e.g. a hypothesis hanging directly under another hypothesis with no question), prefer the closest faithful structure (`derived_from`) over inventing nodes. Invent a node only when a rule requires it, and say so — the most common case is a verdict with no recorded result: the server will not accept `confirmed`/`rejected` without evidence. Then either create an evidence node that quotes where the verdict came from (name it after the observation, link the source file, weight 1–2), or import the hypothesis as `inconclusive` / `testing` and list it for the user. Ask the user which they prefer if there are many.

3. **Write the spec** (format below) to a file outside the repo you are reading, e.g. the scratchpad. Keys should be stable ids from the source (`H3`, the file slug) — they become `external_id` in Plane, which is what makes re-runs idempotent. Keep names short (they are titles, max 255 chars); put the body in `description` and link the original file in `links`.

4. **Validate**: `python3 $S validate spec.json`. Fix every error; read the warnings (unattached hypotheses are usually a mapping mistake).

5. **Show the user before importing**: counts per type, the vocabulary mapping, invented nodes and downgraded verdicts, and anything you could not place. This is the moment they can correct the mapping cheaply. Then `import --dry-run`.

6. **Import**: `python3 $S import spec.json`. It writes `spec.plane-map.json` (spec key → `RND-n`) next to the spec; keep it. If it stops (network, rate limit, a rejected relation), fix the cause and re-run the same command — existing nodes and relations are detected and skipped. The report lists `problems`; each is a relation or status the server refused, with the reason.

7. **Verify**: `python3 $S graph` and `python3 $S matrix <question>` for the main questions; compare against the source. Report to the user the mapping file, the counts, and the remaining problems.

To import into a project different from day-to-day work (a dry rehearsal), point `PLANE_PROJECT` at a scratch project first.

## Spec format

```json
{
  "source": "github:owner/repo", // external_source tag; keep it stable between runs
  "nodes": [
    {
      "key": "H3", // unique, stable; becomes external_id
      "type": "hypothesis", // question | hypothesis | experiment | evidence
      "name": "Cold cache after deploy", // title
      "status": "rejected", // optional; defaults to the initial status of the type
      "description": "Plain text; blank lines separate paragraphs",
      "description_html": "<p>…</p>", // alternative to description
      "state": "Done", // optional workflow state name (mostly for experiments)
      "links": ["https://…", { "url": "https://…", "title": "Notebook" }],
      "statement": "If …, then …", // research details, all optional:
      "success_criteria": "…",
      "conclusion": "Plain text", // stored as conclusion_html
      "confidence": 70, // 0-100
      "repo_url": "…",
      "branch": "…",
      "commit_sha": "…",
      "artifact_url": "…"
    }
  ],
  "edges": [
    { "from": "H3", "type": "addresses", "to": "Q1" },
    { "from": "R7", "type": "opposes", "to": "H3", "weight": 3 },
    { "from": "Q1", "type": "addressed_by", "to": "H4" } // reverse names are fine
  ]
}
```

(Comments above are for explanation only; the file must be plain JSON.)

What the importer does, in order: creates nodes (statuses that need relations are deferred), fills research details and links, creates edges, then sets deferred statuses — `invalidated` evidence first, then `confirmed`/`rejected`, then `superseded`, then `closed` questions. `answered` is never set; it is computed.

Not covered by the importer (do these with the regular CLI commands or ask the user): assignees, labels, cycles/modules, comments history, attachments. If the source has meaningful discussion threads, a short summary in `description` plus a link to the original is usually enough.
