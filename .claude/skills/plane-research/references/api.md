# Research graph — v1 API reference

Base: `{PLANE_BASE_URL}/api/v1/workspaces/{slug}/`. Header `X-API-Key: <token>`. JSON in and out. Rate limit 60 requests/min per key by default (429 with `Retry-After`).

`P` below = `projects/{project_id}/`.

## Nodes (regular work item endpoints)

| Method      | Path                          | Notes                                                                                                                                                               |
| ----------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET         | `projects/`                   | find the project id by `identifier`                                                                                                                                 |
| POST        | `P work-items/`               | `{name, research_type, research_status?, description_html?, state?, parent?, external_id?, external_source?}`; 409 with `{"id"}` if that external id already exists |
| GET / PATCH | `P work-items/{id}/`          | PATCH `research_status` to set a verdict; changing `research_type` resets the status                                                                                |
| GET         | `work-items/{IDENT}-{n}/`     | look up by `RND-12`                                                                                                                                                 |
| POST        | `P work-items/{id}/comments/` | `{comment_html}`                                                                                                                                                    |
| POST        | `P work-items/{id}/links/`    | `{url, title?}`; 400 if the URL is already linked                                                                                                                   |
| GET         | `P states/`                   | state ids by name                                                                                                                                                   |

Response fields of a work item include `id`, `sequence_id`, `name`, `research_type`, `research_status`, `needs_review` (read only).

## Research details

`GET / PATCH P work-items/{id}/research/` — `statement`, `success_criteria`, `conclusion_html`, `confidence` (0–100), `repo_url`, `branch`, `commit_sha`, `artifact_url`; read only: `verdict_at`, `verdict_by_id`, plus the node's `research_type`, `research_status`, `needs_review`. 400 if the work item has no `research_type`.

## Relations

| Method | Path                                      | Body / query                                                                                                              |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| GET    | `P work-items/{id}/relations/`            | `{relation_name: [{issue_id, project_id}]}` from this item's point of view                                                |
| POST   | `P work-items/{id}/relations/`            | `{relation_type, issues: [ids], weight?}` — reverse names allowed; 400 grammar / cycle / weight, 409 pair already related |
| PATCH  | `P work-items/{id}/relations/{other_id}/` | `{weight?, relation_type?}` — only supports ↔ opposes and their weights                                                   |
| DELETE | `P work-items/{id}/relations/{other_id}/` | `?relation_type=` to delete only that type                                                                                |

## Graph, matrix, merge

To list research nodes by type or status use `research-graph/` with filters (the plain work item list does not filter by research fields).

- `GET P research-graph/?scope_type=project|cycle|module&scope_id=&research_type=a,b&research_status=a,b` →
  `{project_identifier, nodes: [{id, sequence_id, name, research_type, research_status, needs_review, state_id, parent_id, is_ghost, …}], edges: [{id, source, target, relation_type, weight}], truncated}`.
  `is_ghost` nodes are neighbours outside the filter, included so the graph stays connected. Edges are stored forward (`source relation_type target`). Up to 2000 nodes.
- `GET P work-items/{question_id}/research-matrix/` →
  `{question, hypotheses: [{id, name, sequence_id, research_status, needs_review, inconsistency, support, rank}], evidence: [{…, diagnostic}], cells: [{evidence_id, hypothesis_id, relation_type, weight}]}`.
  Only `valid` evidence counts towards the scores.
- `POST P research/merge/` `{hypothesis_ids: [2..20 ids], name}` → 201 `{issue, derived_from, addresses}`.

Guests have read-only access; restricted guests see only items they created.
