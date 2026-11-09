# Renovate preset

[`default.json`](default.json) is a shared [Renovate](https://docs.renovatebot.com/)
preset:

- updates come weekly, on Monday morning (UTC);
- majors wait until approved on the Dependency Dashboard;
- patches go in one pull request, and minor updates of development
  dependencies in another;
- nothing younger than a day is proposed.

A repository extends it at a release, and lists it first, so a preset of its
own listed after it can override it:

```json
{
  "extends": ["github>veda-hq/veda//renovate/default#v0.5.4"]
}
```

Renovate bumps that `#vX.Y.Z` itself when Veda releases. The first release
that carries this preset is v0.5.4.
