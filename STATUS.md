# Status and how to resume

**Paused 2026-09-10.** The connector is deployed and working. One manual step, a single sandbox
sign-in, has not been done yet, and that step is what proves the half of the system nothing has
exercised.

## Where it runs

| | |
| --- | --- |
| Service | Cloud Run `mychart-mcp`, revision `mychart-mcp-00003-r99`, us-central1 |
| Project | `lewis-personal-finance-mcp` (personal, **not** a Griot project) |
| Base URL | `https://mychart-mcp-911994982173.us-central1.run.app` |
| Connector URL for Claude | that, plus `/mcp` |
| Epic app | `fhir.epic.com/Developer/Edit?appId=60538`, "Nolan NF Care Tracker" |
| Environment | `sandbox` (Epic's synthetic data) |

Deploying needs the Lewis account: `gcloud ... --account=ben.lewis@lewisconsultation.com`.
`deploy/deploy.sh` carries the right defaults; see the env block at the top of it.

## The single next action

In a Claude conversation with the connector added, run **`mychart_status`**. It returns a
ready-to-use `linkUrl` carrying a one-time token. Open that in a browser and sign in with one of
Epic's sandbox MyChart test patients (credentials are listed on Epic's authenticated
`Documentation?docId=testpatients` page; use the patient that has both lab results and diagnostic
reports).

That one sign-in exercises everything still unproven, in order:

1. the authorization-code exchange
2. **refresh-token issuance** (the entire reason the app is a confidential client)
3. refresh-token rotation and persistence
4. the Cloud KMS encrypt/decrypt round trip
5. Firestore link storage
6. the FHIR read tools

Expect `mychart_patient` to return the sandbox test patient, not a real person. Sandbox data is
synthetic. Expect `mychart_documents`, `mychart_attachment` and `mychart_appointments` to return
**empty**: no sandbox patient has both a MyChart login and document/attachment/appointment data.
Empty results there are missing test data, not broken code.

## Already verified against live Epic

- Sandbox authorize accepts the client id, redirect URI, PKCE S256, scopes and `aud`
- **The client secret is correct.** Controlled test on the token endpoint: our stored secret gives
  `invalid_grant` on a bogus code, a wrong secret gives `invalid_client`
- `/health` 200; a garbage bearer on `/mcp` returns **401**, not 500
- Endpoint discovery reads the live SMART configuration and sees `launch-standalone`,
  `permission-offline`, `permission-patient`, `client-confidential-symmetric`

## What blocks real data

**St. Jude does not recognise the production client id.** Their authorize endpoint returns
`OAuth2 Error` before any login page appears, so no MRN, username or password can get past it. The
app was registered with Automatic Client Distribution set to **None**, which buys the full 68
scopes (radiology attachments, appointments) at the cost of requiring St. Jude's IT to distribute
the client id manually.

Two asks belong in one conversation with them:

1. manually distribute client id `aba2bd22-ce05-497e-b8e3-33d7d28c698a`
2. does their MyChart let a **proxy** link a third-party app to a dependent's chart?

The second matters more than it looks. Epic documents the dependent picker as standard behaviour in
its own patient guide, but an organisation can disable it, and Epic's sandbox has no pediatric or
proxy test scenario, so it cannot be proven beforehand. It is the assumption the whole design rests
on.

### Switching to production later

Redeploy with `EPIC_ENVIRONMENT=stjude`,
`EPIC_FHIR_BASE_URL=https://rp.stjude.org/oauth2-prd/api/FHIR/R4/`, the production client id, and a
new production client secret. Nothing else changes; the Epic record already lists the correct Cloud
Run callback.

### Fallback if St. Jude declines

Register a **second** Epic app with Automatic Client Distribution = **USCDI v3**. That
auto-distributes to every Epic customer with nobody's approval, and reuses this codebase unchanged
apart from the client id and secret. The cost is real: it strips radiology-result
`DocumentReference`/`Binary`, every appointment scope, genomics, phenotype and DICOM. All twelve of
Epic's appointment and schedule APIs are marked `autodownload-types: None`, so **appointments are
categorically incompatible with automatic distribution**. That fact is what forced the original
choice.

## Design decisions you would otherwise re-litigate

- **Confidential client, not public.** Epic only offers "Requires Persistent Access", i.e. refresh
  tokens, to confidential clients. A public client with PKCE cannot get one, so unattended sync
  would be impossible. This is visible in Epic's own `AppCreate.js`.
- **Rolling refresh tokens.** Each refresh returns a new token and retires the old one. Persisting
  the new one is mandatory or the link breaks on the next call.
- **No tool accepts a patient id.** The token's patient context decides whose chart is readable, so
  the model cannot be argued into reading another person's record.
- **`ALLOWED_EMAILS`, not a domain gate.** "Anyone holding an address at this domain" is too weak a
  promise for a child's medical records. The server refuses all logins if neither is configured.
- **`mychart_unlink` deletes the credential only, never saved records**, and needs `confirm=true`.
  That is the published Terms in code: unlinking revokes access, deletion happens on request.

## Traps that already cost time

- **`/epic/link` cannot be bearer-protected.** It is opened in a browser, which sends no
  Authorization header. Identity arrives as a single-use `?t=` token minted by a tool. Seven tests
  passed while this was broken, because each asserted the route *rejects* unauthenticated callers.
  Testing the guard is not testing the path a person walks.
- **MCP clients cache the tool list.** A newly added tool can be invisible to a client whose tool
  *calls* already reach the new code. `mychart_status` therefore mints the link URL itself, since it
  is in every cached list. Prefer extending an existing tool over adding one when the user needs it
  to work now.
- **gcloud `--set-env-vars` splits on commas**, so a comma-containing value like `ALLOWED_EMAILS`
  fails with an unhelpful usage dump and no error line. `deploy/deploy.sh` uses the `^@@^` custom
  delimiter.
- **A trailing newline in the Epic client secret** surfaces as `invalid_client`. Always check the
  byte length after `gcloud secrets versions add --data-file=-`.
- **Google Cloud Console may demand a passkey** if Chrome is signed in as the wrong account.
  Appending `&authuser=ben.lewis@lewisconsultation.com` to a console URL switches accounts and
  skips the challenge.

## Not yet run

`test/refresh-rotation.test.mjs` is an integration test that needs a live Firestore and
`gcloud auth application-default login`. Point it at a throwaway `FIRESTORE_COLLECTION_PREFIX`.
