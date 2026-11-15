# Unit tests

These tests use Node.js built-ins and do not connect to WeChat, CloudBase, model providers, or payment gateways.

Run with Node.js 20 or newer:

```sh
npm test
```

The suite covers membership quota boundaries, usage accounting, virtual payment order validation, and web account scoping. Live WeChat Developer Tools checks are intentionally separate.
