# Web Access

Web Access owns Pi's public `web_search`, `x_search`, and `fetch_content` tools.

## Workspace Language

**Web Access Source**:
A named backend that can offer search, fetch, or both. The sources are `openai`, `xai`, `exa`, `firecrawl`, and `cdp`.
_Avoid_: Search backend name, treating an Extraction Kernel as a source

**Answering Search Source**:
A Web Access Source whose search result is model-written answer text plus citations. V2 answering sources are `openai` and `xai`.
_Avoid_: Treating Exa or Firecrawl as answering sources

**Retrieval Search Source**:
A Web Access Source whose search result is ranked URLs and excerpts. V2 retrieval sources are `exa` and `firecrawl`.
_Avoid_: Treating openai or xai as retrieval sources

**Fetch Source**:
A Web Access Source that can obtain page content for `fetch_content`. V2 fetch sources are `cdp`, `exa`, and `firecrawl`.
_Avoid_: Fetch Acquisition as a separate taxonomy, public fetch provider as a kind distinct from Source

**Source Selection**:
The explicit choice of exactly one Web Access Source for a `web_search` call: `openai`, `xai`, `exa`, or `firecrawl`. There is no default selection, automatic switch to another source, or all-source mode.
_Avoid_: Implicit provider routing, Source Fallback, All-Provider Search

**CLIProxyAPI xAI Route**:
The only supported xAI path: a Pi Model Registry model that already points at CLIProxyAPI. Web Access does not read xAI keys, OAuth tokens, cookies, or credential files.
_Avoid_: Direct xAI client, xAI OAuth

**X Search Success**:
An `x_search` result that includes assistant text and either an `x_search_call` output item or an x.com/twitter.com citation.
_Avoid_: Web search fallback, tweet-count heuristic

**Exa Source**:
The hosted Exa Search and Contents APIs. It is configured only when `EXA_API_KEY` is present.
_Avoid_: Treating Exa as a Model Registry model

**Firecrawl Source**:
The hosted Firecrawl Search and Scrape APIs. Keyless access counts as configured; an optional `FIRECRAWL_API_KEY` raises limits.
_Avoid_: Identifying this source with the html-extractor kernel

**Fetch Source Selection**:
The effective `fetch_content` selection from the per-call `provider`, then `webAccess.fetch.defaultProvider`, then `cdp`. There is no fetch fallback across sources.
_Avoid_: cdp → hosted fallback, silent public scrape when CDP fails

**CDP Attach**:
Connect to a configured CDP endpoint, reuse the default browser context, open a background tab, wait for bounded dynamic readiness (main-frame load milestone, relevant-network quiet, semantic main-content DOM stability), perform bounded incremental lazy-load scrolling, capture HTML under a hard size limit, and close only that tab. This is how the `cdp` Fetch Source obtains HTML.
_Avoid_: Launching Chrome, reading cookie databases, closing the remote browser, unbounded infinite-scroll, networkidle-only readiness, transferring oversized HTML through CDP

**Extraction Kernel**:
How CDP-captured HTML becomes markdown. Selected by `webAccess.fetch.extract.kernel` (`defuddle` | `html-extractor` | `llm`). Default is Defuddle. Kernel Fallback starts at the selected kernel: `defuddle → html-extractor → configured llm`, `html-extractor → configured llm`, or `llm` only. The llm kernel is a tool-free OpenAI Responses completion over bounded untrusted page data using `webAccess.fetch.extract.model` (must resolve to `openai-responses` or `custom-response`; optional `provider/model:level` thinking suffix, clamped with Pi-native capability rules). Hosted fetch sources return already-extracted text and do not use an Extraction Kernel. The html-extractor kernel is the local `@firecrawl/html-extractor` package; it is not the Firecrawl Source.
_Avoid_: Calling an Extraction Kernel a Web Access Source, identifying html-extractor with the Firecrawl Source, session-model extract

**Kernel Fallback**:
The fixed attempt order that starts at the selected Extraction Kernel and continues only after empty normalized markdown or a local-kernel exception. An unconfigured llm is skipped when reached from a local selection; direct `llm` selection fails clearly without a model. Abort and operation timeout stop the chain immediately. Every kernel shares the original call deadline.
_Avoid_: Quality scores, minimum-length heuristics, site-specific fallback rules, fresh per-kernel timeouts
