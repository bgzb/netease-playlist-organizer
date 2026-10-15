# Runtime integration contract

The public page namespace is `window.__ncmOrganizerV1`. It contains `show():void`, `remove():void`, and `status(): OrganizerStatus`. Repeated injection reuses a live instance; remove tears down event handlers and stops scheduling. After removing, reinjection creates a new instance.

`OrganizerStatus` JSON contains `installed:boolean`, `adapterVersion:string`, `readReady:boolean`, `writeVerification:"unverified"|"verified"`, and optional `scan:{phase:string,processed:number,total:number,coverage:{artists:number,genres:number,bpm:number,language:number}}`. Do not return account responses, credentials, raw errors or whole collections through status. Swift's loading flow injects the bundle, then evaluates `window.__ncmOrganizerV1.status()` with returnByValue. Actual rendering and client capability checks occur in the page. Swift never reads signing keys or account credentials.

The packaging script requires the actual compiled panel bundle. It fails if that bundle is absent and verifies that the application resource matches the compiled output.

`verify-read.mjs` can use a separately built read-only verification expression from client adapters, injected only into the already running validated local target. This expression returns counts and validation status, not credentials, and never enables write paths.

Read/write confirmations are local UI state, are not persisted, and are invalidated on changes to filters, chosen songs, target or account. Source collection remains protected. Unknown creation results require a user-selected candidate or a new explicitly confirmed plan; there is no blind automatic recreation.

Automated tests use synthetic fixtures and must not operate real accounts or currently running applications. Live use requires the explicit confirmations provided by the UI.
