# MyChart Care Record Connector

A remote [MCP](https://modelcontextprotocol.io) connector that reads a patient's own health
records from an Epic MyChart portal over the official patient-facing FHIR API, so an AI assistant
the patient authorizes can help them keep those records organized.

Built for personal family use by an independent developer. Not affiliated with, or endorsed by,
Epic Systems Corporation or any health system.

**[Terms and Conditions](https://beenlouis.github.io/mychart-mcp/terms.html)**

## What it does

- Signs in to MyChart with a SMART on FHIR **standalone patient launch** (PKCE, confidential
  client), and keeps a refresh token so it can sync without a browser round-trip every time.
- Reads labs, diagnostic reports, clinical documents, **attachments** (`Binary`), appointments and
  patient demographics.
- Exposes those as MCP tools over an OAuth 2.1 endpoint that Claude can connect to as a Custom
  Connector.

It is **read-only**. It holds no scopes that can write to, change, or delete anything in a medical
record.

## Design notes

A few decisions that are not obvious and are easy to get wrong:

- **Confidential client, not public.** Epic only offers "Requires Persistent Access" (refresh
  tokens) to confidential clients. A public client with PKCE cannot get a refresh token at all,
  which means no unattended sync. The client secret lives in Secret Manager.
- **Rolling refresh tokens.** Each refresh returns a new refresh token and retires the old one.
  Persisting the new one is mandatory or the link breaks on the next call. See
  `src/epic-session.ts`.
- **Endpoints are discovered, not hardcoded.** `.well-known/smart-configuration` is read from the
  FHIR base at runtime, so moving between the sandbox and a real organization is a config change.
- **A dead credential is not a server error.** When a refresh token is rejected, the link is marked
  invalid and tools return an actionable "re-link" message rather than a generic failure. Reporting
  a credential problem as a server fault makes clients retry forever instead of prompting the user.
- **The Epic refresh token is encrypted at rest** with Cloud KMS (`src/crypto.ts`). It is never
  written in plaintext and never logged.

## Layout

| Path | Purpose |
| --- | --- |
| `src/epic.ts` | Epic SMART client: discovery, PKCE, token exchange, FHIR + Binary reads |
| `src/epic-session.ts` | Turns a stored refresh token into a usable access token |
| `src/crypto.ts` | KMS envelope encryption for the stored refresh token |
| `src/store.ts` | Firestore persistence, including the per-user MyChart link |
| `src/auth-provider.ts` | The OAuth 2.1 server this connector runs *for Claude* |
| `src/idp.ts` | Federated login used to establish who is calling |
| `docs/terms.html` | Terms and Conditions (published via GitHub Pages) |
| `STATUS.md` | Where this stands and how to resume |

Two separate OAuth flows meet in this codebase, which is the main thing to hold in your head:

```
Claude            --OAuth-->   this connector      (auth-provider.ts)
this connector    --OAuth-->   Epic / MyChart      (epic.ts)
```

## Configuration

See `.env.example`. Nothing secret is committed; secrets come from Secret Manager at deploy time.

## Status

**Paused 2026-09-10.** Deployed to Cloud Run and working; the Epic sandbox sign-in that proves the
token exchange, refresh tokens, encryption and FHIR reads has not been run yet. Not pointed at a
production health system: the target organisation has not distributed the client id.

**See [STATUS.md](STATUS.md)** for exactly where things stand, the single next action, what blocks
real data, and the traps that already cost time.

## License

Provided as-is, with no warranty. See the Terms and Conditions linked above.
