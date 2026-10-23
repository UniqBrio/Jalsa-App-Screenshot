# Where the flow scripts are

This folder holds only the shared reference, [`_SCHEMA.md`](_SCHEMA.md). Each app keeps
its own flow scripts in its profile: **`apps/<app-id>/flows/<module>.<flow>.yaml`**, and its
run guide beside them. A flow file placed here is not loaded.

Single-app capture projects keep their flows in a top-level `flows/` folder instead; the
YAML format (schema v2) is the same. The registered apps are listed in
[`docs/REGISTERED-APPS.md`](../docs/REGISTERED-APPS.md).
