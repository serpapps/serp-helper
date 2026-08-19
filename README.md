# SERP Helper

SERP Helper creates a privacy-bounded diagnostic ZIP for a structured SERP support case. It does not upload by itself and contains no remote upload credential.

## Customer flow

1. Open the website where the problem occurs and reproduce the issue.
2. Open SERP Helper and review the selected origin and collection categories.
3. Give explicit consent and click **Create support.zip**.
4. Open the structured SERP support form, describe the problem, and attach `support.zip`.
5. The Store creates the case and Agentic Inbox attaches the diagnostic to that exact case.

The helper excludes cookie values, authorization material, request and response bodies, installed-extension inventory, full private URLs, and cross-origin network activity.

## Development

```sh
npm test
npm run build:staging
```

Production release and browser-store publication require separate approval.
