# Vue 3 + Vite

This template should help get you started developing with Vue 3 in Vite. The template uses Vue 3 `<script setup>` SFCs, check out the [script setup docs](https://v3.vuejs.org/api/sfc-script-setup.html#sfc-script-setup) to learn more.

Learn more about IDE Support for Vue in the [Vue Docs Scaling up Guide](https://vuejs.org/guide/scaling-up/tooling.html#ide-support).

## Budget security tests

Use Node.js 24 and a process-local JDK 21 for the verified local test profile:

```sh
pnpm test
JAVA_HOME="/path/to/jdk-21" PATH="/path/to/jdk-21/bin:$PATH" pnpm test:budgets:security
```

`pnpm test` retains application unit tests and includes the budget-runner configuration regressions. The security command starts only Firestore for `demo-vault-b2` using `firebase.budgets.test.json`; ports 8185, 4415, 4515 and 9150 must be free. It never selects the production project.

Security files remain process-isolated but run one at a time (`--test-concurrency=1`), with a 15-second default test-execution bound (`--test-timeout=15000`). All security cases, SDK actors and fixture assertions are unchanged. See the [Node.js test-runner options](https://nodejs.org/docs/latest-v24.x/api/cli.html#--test-concurrency).

These controls reduce overlapping clients and expose stalled tests; they are not a proven fix for emulator gRPC framing faults. A separate overall supervisor is still needed to bound emulator startup and teardown. A timeout is a failed/incomplete check, not a reason to retry automatically.
