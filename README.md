# amplitude-cli (`amp`)

CLI for querying Amplitude analytics data via Amplitude's MCP server. OAuth only — single auth method, no API keys needed. Designed for AI agents and humans alike.

## Install

```bash
npm install -g amplitude-cli
```

From a clone:

```bash
npm install        # the `prepare` script builds dist/ via tsc
npm link           # puts `amp` on your PATH
```

`dist/` is gitignored, so a fresh clone must be installed/built before `amp` will run.

## Authentication

All commands use OAuth (via Amplitude's MCP server). Two ways to authenticate:

### Option 1: Environment variable (recommended for agents)

Set `AMPLITUDE_ACCESS_TOKEN` — typically injected via Nango:

```bash
export AMPLITUDE_ACCESS_TOKEN="your-oauth-token"
```

### Option 2: Interactive login (for humans)

```bash
amp auth login           # opens browser for OAuth
amp auth login --region eu
```

Tokens are saved to `~/.amplituderc` and auto-refreshed. The login flow binds a local callback server on port 8900.

## Projects

Most tools require a project ID (Amplitude calls it `appId`). Resolution order:

1. `amp --project-id <id> <command>`
2. `AMPLITUDE_PROJECT_ID`
3. Auto-discovery from `get_amplitude_context` — your default project

```bash
amp auth context         # org, user, and every project you can access
```

Chart/dashboard/cohort reads are ID-based and work across projects. Queries and taxonomy lookups are project-scoped, so replaying a chart from another project needs an explicit `--project-id`.

## Usage

```bash
# Auth & context
amp auth status
amp auth context

# Tool discovery — the source of truth for the live surface
amp tools list
amp tools describe query_amplitude_data

# Events & taxonomy
amp events list --limit 50                     # tracking-plan events
amp events get "Purchase Completed"            # hydrate by exact name
amp events search "user completes a purchase"  # semantic discovery
amp events props "[Amplitude] Page Viewed"     # properties for one event
amp events props                               # all event properties, paginated
amp events user-props
amp events values platform --event "Purchase"  # observed values for a property

# Segmentation
amp query segment -e "[Amplitude] Page Viewed" -r "Last 30 Days"
amp query segment -e "Purchase" --from 2026-01-01 --to 2026-03-01 -m totals -g user:platform
# --formula refers to the events as A, B, C in the order they are listed
amp query segment -e "Modal Viewed" "Modal Accepted" \
  --metric formula --formula "UNIQUES(B)/UNIQUES(A)" -r "Last 30 Days"

# Funnels
amp query funnel -e signup onboarding purchase -r "Last 30 Days" -w 7 -u day

# Retention
amp query retention --start-event _new --return-event _active -r "Last 30 Days"

# Sessions
amp query sessions -r "Last 30 Days" -m average

# Revenue (LTV — cumulative revenue from users NEW in the window)
amp query revenue -r "Last 90 Days" -m arpu

# Chart-type reference: params, valid enums, a working example
amp query guide                 # list supported types
amp query guide funnels

# Charts
amp charts search "DAU"
amp charts get abc123           # raw definition
amp charts typed abc123         # typed params — editable and replayable
amp charts link abc123          # just the URL
amp charts query abc123         # run it, return data
amp charts create --definition '{"kind":"segmentation", ...}'

# Dashboards
amp dashboards search "KPIs"
amp dashboards get abc123
amp dashboards create --name "Weekly KPIs" --definition '[...]'

# Users
amp users search "user@example.com"
amp users activity 12345678 --limit 100 --props
amp users org

# Cohorts
amp cohorts list -s "power users"
amp cohorts get abc123
amp cohorts membership abc123 --email user@example.com
amp cohorts create --name "Power users" --definition '{...}'

# Experiments
amp experiments search "onboarding"
amp experiments get abc123
amp experiments results abc123

# Direct MCP tool calls (escape hatch)
amp call get_amplitude_context '{}'
amp call get_from_url '{"url": "https://app.amplitude.com/..."}'

# Output formats
amp query segment -e signup -r "Last 30 Days" -f csv > signups.csv
amp query segment -e purchase -r "Last 30 Days" -f compact | jq '.data'
```

### Time windows

Every `query` subcommand takes either a relative window or an absolute range, never both:

```bash
-r "Last 30 Days"                  # relative
--from 2026-01-01 --to 2026-03-01  # absolute; --to is inclusive of that whole day
--from 2026-01-01                  # open-ended "since" window
```

`--from`/`--to` accept `YYYY-MM-DD`, ISO 8601, or epoch seconds, and are anchored to UTC unless you pass `--timezone`.

## Output Formats

All commands support `-f` / `--format`:

- `json` — pretty-printed (default)
- `compact` — single-line JSON (for piping)
- `csv` — CSV output

## Architecture

```
amp CLI → Amplitude MCP server (OAuth)
```

The CLI is a thin layer over Amplitude's MCP server. That surface is a small set of
multiplexer tools that take an `action`/`include` discriminator rather than one tool per
verb, so several `amp` subcommands map to different modes of the same tool:

| Area | Tool |
|---|---|
| context | `get_amplitude_context` |
| entity search | `search_amp_entities` |
| event/property discovery | `search_amp_data_taxonomy` |
| tracking-plan events | `manage_amp_events` |
| properties | `get_properties` |
| chart reads | `get_amplitude_charts` (`include`: link/typed/definition/data/guide) |
| ad-hoc queries | `query_amplitude_data` (typed `chart`, or raw `definition`) |
| dashboards | `use_amp_dashboards` (`action`) |
| cohorts | `use_amplitude_cohorts` (`action`) |
| experiments | `use_amp_experiments` (`action`) |
| users | `get_amp_user_data` (`include`) |

`amp tools list` is always authoritative — if a command starts failing with
`Tool <name> not found`, the surface moved and `src/mcp-client.ts` is the only
place that needs updating.

### Known server-side quirks

- **Saving charts.** There is no standalone "save this chart edit" tool. `amp charts create` and the `amp query` commands return a `chartEditId`; edits are persisted by referencing that id from `rows[].chartId` in `amp dashboards create`.
- **`measured_as.as_`.** `amp charts typed` (i.e. `get_amplitude_charts include='typed'`) emits `measured_as.as_`, but `query_amplitude_data` only reads `measured_as.as` — and it ignores the unknown key silently instead of erroring, which would quietly downgrade the metric to unique users on a read-edit-replay round-trip. The client normalizes `as_` → `as` so round-trips stay faithful.
- **Revenue.** `query_amplitude_data` has no typed `revenue` variant, so `amp query revenue` uses the raw `definition` fallback with type `revenueLtv`. Revenue LTV only counts users *first seen* in the window; an empty result usually means no new users were acquired, not broken instrumentation.

## License

MIT
