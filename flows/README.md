# Where the flow scripts are

This repository runs the multi-app engine, so each app keeps its own flows:

| App | Flow scripts | How to run |
|---|---|---|
| Jalsa | [`apps/jalsa/flows/`](../apps/jalsa/flows/) — 30 files, `<module>.<flow>.yaml` | [`apps/jalsa/RUN-LOCAL.md`](../apps/jalsa/RUN-LOCAL.md) |

They use the same YAML format as the RosiFit project's top-level `flows/` folder
(schema v2: `goto` + `assert`, `label`, `expect_screen`, `screenshot`). This folder
holds only the shared reference, [`_SCHEMA.md`](_SCHEMA.md). A flow file placed
here is not loaded; the engine reads `apps/<app-id>/flows/`.
