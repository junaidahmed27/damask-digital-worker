# Organizational Memory and Workflow Specification for the First Credit Pilot

Confidential. September 18, 2026. Two questions answered operationally: how the firm's organizational memory is processed and built from the sources the CTO described, and how the first two workflows, Deal Origination and the SuperAnalyst, are specified so that people and agents execute them from the same definition. This document is the bridge between the context layer architecture and the Work Ledger build plan; the workflow definitions below are the `workflows/*.yaml` files the ledger loads.

## Part A. The organizational memory

### A.1 What memory means here

Organizational memory is not one store. It is four things kept in one substrate, each answering a different question a worker asks before it acts:

1. The record: immutable events (every document, email, CRM change, feed item, database snapshot) and the typed, bi temporal facts extracted from them, each fact carrying its source and span. Answers what was true when, on whose authority.
2. The retrieval projection: passages of every event with lexical and vector indexes, filtered by entity and scope. Answers where to look when the record does not have a typed fact.
3. Workflow knowledge: the firm's processes as state machines, its goals as live numbers, its decisions as records with rationale, its themes and rules. Answers what happens next and why the firm did what it did.
4. Learned defaults: the signals people leave (validations, corrections, accepted and rejected leads) turned into confidence, rules and templates. Answers how this firm, specifically, wants the work done.

Agents read all four through one call, the context compiler, which returns a small, cited bundle for a given task, state, scope and as of instant. People read the same four through the sheet, the deal page and the ask surface.

### A.2 The sources, as described, and what each contributes

| Source | Access | Contributes to the record | Contributes to workflow knowledge |
|---|---|---|---|
| Local Windows file server, investment team folder first | Read only crawl over SMB from inside the network; nothing moved | Credit agreements, amendments, compliance certificates, IC memos, pass memos, models, decks, data room exports, NDAs, side letters, KYC | Decisions and rationale from memos; the graveyard of deals |
| Microsoft 365 mail | Graph API, read only, scoped mailboxes; privileged and personal quarantined by rule | Attachments, counterparty claims, terms discussed in operations, relationship signals | Pass and pursue reasoning in threads; who introduced whom |
| Affinity | API, read and, after human accept, write | Organizations, people, interactions, email derived contacts, lists | Pipeline stages, sourcing history, the network |
| Azure SQL and Snowflake | Read only; MCP for agents | Positions, financials, P&L, portfolio metrics; the liquidity and projection models | Deployment targets, pipeline expected close, the gap, return and leverage constraints |
| Security master | Database or API | Deal identifiers for every deal, the spine | Deal lifecycle status |
| Closing application | Database or API | Closing checklist items and their state | The closing process as a state machine |
| Octus | Feed ingestion | Structured financials, credit agreement terms (cross check for the firm's own extraction), credit news | Sector and issuer events that trigger monitoring |
| Public web and filings | Curated source list plus research agents | Counterparty announcements, syndication news, filings | Sourcing signals |

Every source row carries a data policy, `allowed`, `blocked` or `pending_review`. Sources under privacy review (portfolio company data, land banking data) can be inventoried and left unreadable by every agent until legal clears them; the refusal is in the connector, not in a prompt.

### A.3 The processing pipeline, stage by stage

The pipeline is identical for the historical backfill and for the live tail, and it is lazy: everything is landed and projected because that is cheap and lossless; facts are extracted only for the attributes the active workflows read.

Stage 0, inventory. Crawl the investment team folder read only, hash every file, deduplicate, record type, size, dates and path, and estimate deal linkage from paths and names. Output: the map of the graveyard, counts by type and age, duplicate ratio, orphan estimate. Decides scope. Acceptance: every file accounted for, nothing moved.

Stage 1, land. Each file, email, CRM record and feed item becomes an event: source, source identifier, content hash, occurred at, recorded at, blob pointer, metadata. Append only; a replayed export is a no op on the unique key. Blobs in the customer's object store under per source keys.

Stage 2, parse. Docling for PDF and Office documents with character offsets preserved; MIME parsing for mail with attachments landed as their own events linked to the thread; spreadsheet models parsed to cell tables with sheet and cell references kept as offsets, because a covenant model's cell is a legitimate provenance span. Output: structured text per event with offsets that survive into every downstream fact.

Stage 3, classify. A cheap first pass classifies document type against the pack taxonomy (credit agreement, amendment, compliance certificate, IC memo, pass memo, financial statements, model, deck, NDA, side letter, board materials, KYC, correspondence, other), sensitivity (privileged counsel, personal, HR, compliance), and candidate deals; a stronger model handles only the ambiguous residue. Output: a classification with confidence on every event; low confidence to a review queue.

Stage 4, resolve. The ladder: exact identifiers (security master deal ID in a path or header, Affinity organization ID or domain, filing number), inherited context (a thread or folder already bound to a deal), aliases and fuzzy names against the registry (Project Meridian, Meridian Holdco II), then a model judgment for the residue, which goes to quarantine for a person rather than being guessed. Entity birth is gated: a new deal, borrower or sponsor exists because an identifier or a person said so. Output: every event linked to entities or explicitly orphaned, with the evidence for the link.

Stage 5, extract. For each classified event, run the extractors for the attributes the credit pack declares, and only those, writing typed facts through `write_fact` with the two clocks and a provenance span:
- terms from credit agreements and amendments: facility, pricing, maturity, financial covenants and their definitions, baskets, mandatory prepayments, change of control, MFN, cross checked against Octus term extraction, with disagreements flagged rather than resolved silently;
- observations from Snowflake and Octus: revenue, EBITDA, leverage, coverage, liquidity, positions, marks, as of their period;
- relationships from Affinity and mail: sponsor, arranger, agent bank, counsel, introducer, board seat;
- claims from borrower and sponsor materials: projections, addbacks, management assertions, kept distinct from the firm's view;
- decisions from IC memos, pass memos and threads: pursued or passed, by whom, on what date, with the rationale as a span;
- rules from mandate documents and sourcing themes: sector, size, structure, geography, exclusions, the themes in force.
Output: the fact table, complete where the workflows read and empty where they do not.

Stage 6, project. Build chunks with entity tags and scopes and their lexical and vector indexes; generate the human views: a deal page per identifier listing documents, facts and decisions; a proposed folder tree and Box migration manifest with hot and cold tiers by usage; Affinity enrichment for organizations and people.

Stage 7, loops. The maintenance sweep re resolves recent and low confidence entities, proposes merges with evidence, retires facts whose validity passed, and surfaces contradictions for review. The integrity suite runs on every change: every fact's provenance resolves, no dangling edges, no unscoped chunks, no contradictions on clean fixtures, and the provenance gap reported as a number. Feedback signals from the workflows adjust confidence and become rules.

Stage 8, governance. Scopes mirrored from the firm's permissions through Microsoft Graph and enforced as one predicate in every read; privileged and personal content quarantined by rule; every agent action traced; nothing crosses a scope except by a logged promotion.

### A.4 The entity kinds and vocabulary for the credit pack

Entities: deal (keyed by security master ID), borrower or company, sponsor, lender and arranger, fund or vehicle (core lending funds, private funds, the BDC), person (internal and external), document, event (filing, news item, closing, covenant test date), theme.

Attribute vocabulary, the closed list the extractors produce: facility_type, commitment, drawn, pricing_spread, pricing_floor, maturity, covenant_leverage_max, covenant_coverage_min, covenant_definitions, basket_general, basket_restricted_payments, basket_investments, mfn_terms, change_of_control, prepayment_terms, revenue, ebitda, leverage, coverage, liquidity, position_size, mark, sponsor_of, arranged_by, agent_bank, counsel_to, introduced_by, board_seat, projection, addback, decision_outcome, decision_rationale, theme, mandate_rule. New attributes are added to the pack, and extraction re runs over events already landed.

### A.5 Sequence and gates

Weeks 1 to 3: inventory, land, parse, classify, resolve for the investment team folder and a mailbox sample; deliver the map of the graveyard, the organized view and the deal pages. Gate: 95 percent of documents linked or explicitly orphaned, 90 percent linkage precision on a reviewed sample, every link with evidence.

Weeks 3 to 6: extract the credit vocabulary, ingest the goals loop, encode the sourcing funnel and the closing process, reconstruct decision records for the historical pipeline. Gate: forty as of questions across an amended deal answered correctly with citations, citation resolvability at 100 percent, sourcing team validates reconstructed pipeline history for a sample.

Weeks 6 onward: the two workflows below consume the memory; the document intake agent keeps it fresh; the feedback loop begins; the frozen evaluation set is the firm's own.

## Part B. Specifying workflows

### B.1 How a workflow is specified

A workflow is data the ledger executes, and it has one canonical form, the workflow definition, which the sheet renders and the runtime runs. It is produced three ways, all landing in the same form: a forward deployed engineer and the people who do the work draft it in a working session; the planner drafts it from a plain language ask; or a person edits an existing sheet and contracts a new version. The definition has these parts:

- metadata: name, version, pack, shape (plan or batch), owner;
- records: the table the rows are, with typed columns (the schema people see);
- inputs: goals and parameters the workflow reads at run time, with their sources;
- workers: the people and agents that may own rows, with tools, places and guardrails;
- columns: the work, each a typed column with an owner kind, a check, evidence requirements and blockers;
- states: the row lifecycle with the criteria and checklist at each transition;
- checks: the registry ids the columns reference, with parameters;
- invariants: what must never happen on this sheet;
- rules: data driven triggers and reminders;
- approvals: who may resolve which human checks;
- outputs: what is written back to which systems, and under what condition;
- signals: what feedback is recorded and what it trains;
- bench: the frozen tasks that grade any change to this workflow;
- simulators: the stand ins for external systems used in rehearsal.

The two workflows below are written in that form. They are complete enough to run on the ledger with simulators today and on the firm's connectors as they are cleared.

### B.2 Workflow 1: Deal Origination (sourcing)

Shape: batch. One row per candidate opportunity. The columns are the steps; agents fill their columns for every row; the sourcing person owns the decision column. The goals gap from the liquidity model sets how many rows the workflow tries to fill.

```yaml
metadata:
  name: deal_origination
  version: 1
  pack: credit
  shape: batch
  owner: sourcing_lead

records:
  table: candidate_opportunity
  columns:
    - {name: company, type: entity, kind: borrower}
    - {name: sector, type: text}
    - {name: source, type: text}            # where it was found: news, counterparty site, filing, referral, CRM
    - {name: size_estimate_usd, type: number}
    - {name: theme, type: entity, kind: theme}
    - {name: found_at, type: date}

inputs:
  - {name: themes_in_force, source: memory.rules, filter: {kind: rule, attribute: theme, current: true}}
  - {name: mandate_rules, source: memory.rules, filter: {attribute: mandate_rule}}
  - {name: deployment_gap_usd, source: connector.snowflake, query: liquidity_model.gap_current_quarter, as_of: today}
  - {name: pipeline_expected_close_usd, source: connector.snowflake, query: pipeline.expected_close}

workers:
  - {name: Scout, kind: agent, places: [sheet, teams], tools: [web.search, feeds.octus_news, feeds.edgar, crm.affinity.lookup, memory.compile_context],
     never_without_human: [crm.write, outreach.send]}
  - {name: Profiler, kind: agent, places: [sheet], tools: [web.fetch, memory.compile_context, feeds.octus_financials]}
  - {name: Screener, kind: agent, places: [sheet], tools: [memory.compile_context, engines.mandate_fit]}
  - {name: Writer, kind: agent, places: [sheet, gdoc], tools: [memory.compile_context, docs.write_section]}
  - {name: CRMWriter, kind: agent, places: [sheet], tools: [crm.affinity.create, crm.affinity.update]}
  - {name: sourcing_lead, kind: person, role: approver}
  - {name: sourcing_analyst, kind: person}

columns:
  - {name: discovery, owner: Scout, type: agent_step, check: source_cited,
     evidence: [source_url_or_filing], note: "runs per theme until the gap is covered by rows at expected conversion"}
  - {name: crm_history, owner: Scout, type: agent_step, check: crm_lookup_recorded,
     evidence: [affinity_record_or_none], note: "known, passed before with reason and date, or new"}
  - {name: profile, owner: Profiler, type: agent_step, check: citations_resolve,
     evidence: [facts_cited, sources], blocked_by: [discovery]}
  - {name: mandate_fit, owner: Screener, type: agent_step, check: mandate_fit_rules,
     evidence: [rule_evaluations], blocked_by: [profile], note: "deterministic first: sector, size, structure, geography, exclusions; agent explains only the borderline"}
  - {name: gap_contribution, type: formula, formula: "=IF(mandate_fit.pass, size_estimate_usd * expected_conversion(theme), 0)"}
  - {name: lead_memo, owner: Writer, type: agent_step, check: memo_has_considerations,
     evidence: [facts_cited, decision_records_cited], blocked_by: [mandate_fit],
     note: "considerations, downsides, comparable history, pitch angle drawn from the firm's own passes and pursues; no recommendation section"}
  - {name: decision, owner: sourcing_lead, type: approval, check: human_accepted_lead,
     options: [accept, park, reject], requires_reason: true, blocked_by: [lead_memo]}
  - {name: crm_write, owner: CRMWriter, type: agent_step, check: crm_record_created,
     evidence: [affinity_record_id], blocked_by: [decision], condition: "decision == accept"}
  - {name: outreach_draft, owner: Writer, type: agent_step, check: evidence_present,
     evidence: [draft_text, facts_cited], blocked_by: [crm_write], note: "drafted for the person; the person sends"}

states:
  - {name: candidate, entry: "row created by discovery", next: [researched]}
  - {name: researched, criteria: "profile verified", next: [screened]}
  - {name: screened, criteria: "mandate_fit verified", next: [memo_ready, rejected_by_rules]}
  - {name: memo_ready, criteria: "lead_memo verified", next: [awaiting_decision]}
  - {name: awaiting_decision, approver: sourcing_lead, next: [accepted, parked, rejected]}
  - {name: accepted, next: [in_crm]}
  - {name: in_crm, criteria: "crm_write verified", next: [outreach]}
  - {name: outreach, criteria: "outreach_draft verified; person marks sent", terminal: true}
  - {name: parked, terminal: false, rule: "resurface on material change"}
  - {name: rejected, terminal: true}
  - {name: rejected_by_rules, terminal: true, note: "mandate hard exclusions; visible, never hidden"}

checks:
  - {id: source_cited, params: {min_sources: 1}}
  - {id: crm_lookup_recorded}
  - {id: citations_resolve}
  - {id: mandate_fit_rules, params: {rules_input: mandate_rules}}
  - {id: memo_has_considerations, params: {forbidden_sections: [recommendation, verdict], required_sections: [considerations, downsides, comparable_history]}}
  - {id: human_accepted_lead}
  - {id: crm_record_created}
  - {id: evidence_present}

invariants:
  - {name: no_crm_write_without_accept, expr: "crm_write.state != verified OR decision == accept", severity: block}
  - {name: no_outreach_by_agent, expr: "outreach.sent_by.kind == person", severity: block}
  - {name: no_recommendation_language, expr: "NOT lead_memo.contains(['we should invest', 'recommend investing'])", severity: escalate}
  - {name: passed_before_is_visible, expr: "crm_history.passed_before => lead_memo.cites(decision_record)", severity: block}

rules:
  - {name: refill_to_gap, trigger: schedule.weekly, condition: "SUM(gap_contribution WHERE state IN [memo_ready, awaiting_decision, accepted]) < deployment_gap_usd", action: run_column(discovery)}
  - {name: resurface_parked, trigger: memory.fact_changed, condition: "state == parked AND fact.attribute IN [revenue, ebitda, sponsor_of, maturity]", action: transition(researched)}
  - {name: nudge_decision, trigger: days_since(memo_ready) > 5, action: remind(sourcing_lead)}

approvals:
  - {check: human_accepted_lead, by: [sourcing_lead]}

outputs:
  - {target: crm.affinity, when: "decision == accept", payload: [company, source, profile_summary, memo_link, theme]}
  - {target: memory.decision_record, when: "decision IN [accept, reject, park]", payload: [company, decision, reason, decided_by, facts_cited]}

signals:
  - {kind: accept_reject_reason, trains: [ranking_reward, theme_defaults]}
  - {kind: memo_edit, trains: [writer_defaults]}

bench:
  - {name: historical_leads, source: "Affinity history with outcomes", grade: "top decile of ranked candidates contains the converted deals; passed before flagged 100 percent"}
  - {name: anti_portfolio, source: "past passes", grade: "considerations cite the recorded pass rationale"}
  - {name: citation_resolvability, grade: "100 percent of memo citations reopen from source"}

simulators:
  - {connector: crm.affinity, mode: fixtures}
  - {connector: feeds.octus_news, mode: recorded}
  - {connector: web.search, mode: recorded}
```

What this specifies in plain language: the workflow watches the deployment gap, fills the sheet with candidates on the themes in force, checks each against the CRM so no one chases a borrower the firm already passed on without seeing why, screens deterministically against the mandate, writes a cited memo with considerations rather than a verdict, and stops for the sourcing lead's decision. Only after a person accepts does anything touch Affinity, and only a person sends outreach. Every accept and reject with its reason trains the ranking and the defaults.

### B.3 Workflow 2: the SuperAnalyst (monitoring and analysis on the active book)

Shape: batch across the book, with a plan sheet per flagged deal. One row per active position. Deterministic engines compute the numbers; agents assemble the analysis and considerations; the analyst owns every decision. The sheet sorted by materiality is the decision queue.

```yaml
metadata:
  name: superanalyst_monitoring
  version: 1
  pack: credit
  shape: batch
  owner: portfolio_manager

records:
  table: active_position
  columns:
    - {name: deal, type: entity, kind: deal}
    - {name: borrower, type: entity, kind: borrower}
    - {name: fund, type: entity, kind: fund}
    - {name: position_size, type: number, source: memory.observation.position_size, as_of: today}
    - {name: next_covenant_test, type: date, source: memory.term.covenant_test_dates}

inputs:
  - {name: terms, source: memory.facts, filter: {kind: term, entity: deal, current: true}}
  - {name: financials, source: memory.facts, filter: {kind: observation, entity: borrower, latest_period: true}}
  - {name: octus_terms, source: feeds.octus_terms, note: "cross check only"}
  - {name: materiality_terms, source: pack.credit.reward_terms}

workers:
  - {name: Watcher, kind: agent, places: [sheet, teams], tools: [feeds.octus_news, feeds.edgar, mail.capture.read, memory.compile_context]}
  - {name: Calculator, kind: agent, places: [sheet], tools: [engines.covenant_tests, engines.basket_capacity, engines.headroom, memory.compile_context]}
  - {name: Analyst, kind: agent, places: [sheet, gdoc], tools: [memory.compile_context, docs.write_section]}
  - {name: credit_analyst, kind: person, role: owner}
  - {name: portfolio_manager, kind: person, role: approver}

columns:
  - {name: signals, owner: Watcher, type: agent_step, check: evidence_present,
     evidence: [source_items], note: "new financials, compliance certificate, amendment, news, sector move, counterparty communication; each an event with a span"}
  - {name: covenant_tests, owner: Calculator, type: agent_step, check: engine_recompute,
     evidence: [inputs_cited, engine_trace], blocked_by: [signals],
     note: "leverage, coverage, liquidity against definitions in the agreement as of today; the verifier recomputes from the cited inputs"}
  - {name: basket_capacity, owner: Calculator, type: agent_step, check: engine_recompute, evidence: [inputs_cited, engine_trace]}
  - {name: headroom_trend, type: formula, formula: "=covenant_tests.headroom - AS_OF(covenant_tests.headroom, last_quarter)"}
  - {name: materiality, type: formula, formula: "=SCORE(materiality_terms, signals, covenant_tests, headroom_trend, position_size)"}
  - {name: analysis, owner: Analyst, type: agent_step, check: analysis_is_grounded,
     evidence: [facts_cited, engine_traces, decision_records_cited], blocked_by: [covenant_tests, basket_capacity],
     condition: "materiality >= threshold", note: "what changed, why it matters, what the firm did last time, considerations and questions; no recommendation section"}
  - {name: analyst_review, owner: credit_analyst, type: approval, check: human_reviewed,
     options: [no_action, monitor_closely, escalate_to_pm, request_information], requires_reason: true, blocked_by: [analysis]}
  - {name: pm_decision, owner: portfolio_manager, type: approval, check: human_reviewed,
     condition: "analyst_review == escalate_to_pm", options: [hold, engage_borrower, waiver_discussion, reduce, other], requires_reason: true}
  - {name: decision_record, type: output, target: memory.decision_record, blocked_by: [analyst_review]}

states:
  - {name: watching, next: [flagged]}
  - {name: flagged, criteria: "materiality >= threshold", next: [computed]}
  - {name: computed, criteria: "covenant_tests and basket_capacity verified", next: [analyzed]}
  - {name: analyzed, criteria: "analysis verified", next: [awaiting_analyst]}
  - {name: awaiting_analyst, approver: credit_analyst, next: [actioned, escalated, watching]}
  - {name: escalated, approver: portfolio_manager, next: [actioned]}
  - {name: actioned, criteria: "decision recorded", next: [watching]}

checks:
  - {id: evidence_present}
  - {id: engine_recompute, params: {tolerance: 0}}
  - {id: analysis_is_grounded, params: {every_number_cites: true, forbidden_sections: [recommendation, verdict]}}
  - {id: human_reviewed}
  - {id: facts_as_of_current, note: "every fact used is current at run time; a superseded fact fails the row"}

invariants:
  - {name: analysts_own_decisions, expr: "decision_record.decided_by.kind == person", severity: block}
  - {name: no_stale_terms, expr: "covenant_tests.inputs.all_current", severity: block}
  - {name: breach_risk_escalates, expr: "covenant_tests.any_breach_risk => state IN [awaiting_analyst, escalated] within 1h", severity: escalate}
  - {name: term_disagreement_visible, expr: "octus_terms != terms => analysis.cites(disagreement)", severity: block}

rules:
  - {name: on_new_document, trigger: memory.event_ingested, condition: "event.entities CONTAINS deal AND event.type IN [financials, compliance_certificate, amendment]", action: run_column(signals)}
  - {name: on_feed, trigger: feeds.octus_news, condition: "item.entities CONTAINS borrower OR item.sector == borrower.sector", action: run_column(signals)}
  - {name: on_test_date, trigger: schedule.daily, condition: "next_covenant_test <= today + 14", action: run_column(covenant_tests)}
  - {name: queue_order, trigger: cell_changed(materiality), action: sort_sheet(materiality, desc)}

approvals:
  - {check: human_reviewed, by: [credit_analyst, portfolio_manager]}

outputs:
  - {target: memory.decision_record, when: "analyst_review OR pm_decision recorded", payload: [deal, decision, reason, decided_by, facts_cited, as_of]}
  - {target: teams.channel, when: "state == escalated", payload: [deal, analysis_link, headroom, breach_risk]}

signals:
  - {kind: analyst_review_reason, trains: [materiality_reward]}
  - {kind: analysis_edit, trains: [analyst_defaults]}
  - {kind: ignored_alert, trains: [materiality_reward, denoising]}

bench:
  - {name: replay_quarters, source: "last four quarters of the book", grade: "every flag that preceded a real event is raised; false flags below threshold; every number recomputes"}
  - {name: as_of_questions, grade: "forty questions across an amended deal, answered as of the amendment and after, with citations"}
  - {name: history_errors, grade: "known errors in the historical record are caught and cited"}

simulators:
  - {connector: feeds.octus_news, mode: recorded}
  - {connector: snowflake, mode: fixtures}
  - {connector: mail.capture, mode: fixtures}
```

What this specifies in plain language: the book sits on the sheet, every position is a row, and the sheet is the decision queue. New documents, feeds and test dates trigger the watcher; the calculator recomputes covenant tests and basket capacity from cited inputs and a verifier recomputes them again; the analyst agent writes what changed, why it matters and what the firm did in comparable situations, with considerations and questions and no verdict; the credit analyst owns the review and the portfolio manager owns escalations. A superseded term fails the row rather than producing a confident wrong number, a disagreement with Octus is surfaced rather than resolved silently, and every human decision becomes a decision record the memory keeps for the next time.

### B.4 How the two workflows and the memory improve together

Deal Origination writes decision records and accept or reject reasons into the memory; the SuperAnalyst writes review outcomes; the document intake agent keeps the record current between them. The signals adjust the ranking reward, the writer defaults and the materiality weights, and the benches, built from the firm's own history, are the gate every change must pass. The memory makes the workflows possible; the workflows make the memory worth keeping.
