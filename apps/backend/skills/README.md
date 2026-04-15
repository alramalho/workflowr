# Skills

`.md` files in this folder define skills the agent can execute.

## Secret references

Use `{{secrets.<name>}}` in skill files to reference secrets stored via `/set-secret`.
These are resolved at runtime from the `secrets` table (scoped per team).
