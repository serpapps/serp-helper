# SERP Helper Agent Map

SERP Helper is the customer-facing diagnostic producer for SERP support cases.

Working rules:

1. Diagnostics must be generated only for an explicitly selected `http(s)` tab.
2. Never serialize cookie values, authorization material, request/response bodies, installed-extension inventory, customer email, or unredacted private URLs.
3. Remote upload credentials do not belong in extension source or release artifacts.
4. The helper produces a local diagnostic ZIP; Agentic Inbox owns case-bound upload, storage, access, audit, and retention.
5. Production releases and store publishing require separate explicit approval.
6. Run `npm test` and both staging build checks before committing changes.
